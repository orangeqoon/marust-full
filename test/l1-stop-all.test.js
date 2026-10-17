'use strict';

const assert = require('assert');
const { createObsLocalEngine } = require('../host/core/engine/obs-local');
const { createBroadcast } = require('../host/core/engine/broadcast');
const { createApi } = require('../host/layer1/api');
const { EVENTS } = require('../host/core/events');

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function makeFakeConnection(options) {
  const opt = options || {};
  let outputActive = opt.outputActive === true;
  const calls = { stop: 0, getStreamStatus: 0 };
  const targets = (opt.targets || []).map((t) => Object.assign({}, t));
  const vendor = function (tier, type) {
    if (type === 'stop_all_targets') {
      if (opt.stopAllError) {
        if (opt.stopAllError === 'timeout') {
          const err = new Error('timeout'); err.code = 'OBS_TIMEOUT'; throw err;
        }
        return Promise.resolve({ success: false, error: opt.stopAllError });
      }
      targets.forEach((t) => {
        if (!opt.stickyIds || !opt.stickyIds.includes(t.id)) {
          t.state = 'stopped';
        }
      });
      return Promise.resolve({ success: true, count: targets.length });
    }
    if (type === 'list_targets') {
      const rows = targets.map((t) => ({ id: t.id, name: t.name || t.id, protocol: 'RTMP', state: t.state, enabled: true }));
      return Promise.resolve({ targets: rows });
    }
    if (type === 'get_api_version') return Promise.resolve({ apiVersion: 1 });
    if (type === 'get_target_status') {
      const id = arguments[2] && arguments[2].id;
      const t = targets.find((row) => row.id === id);
      return Promise.resolve(t ? { id: t.id, state: t.state } : { error: 'target_not_found' });
    }
    return Promise.resolve({});
  };
  const connection = {
    getStatus: () => ({ connected: opt.connected !== false }),
    call: (method) => {
      calls.getStreamStatus += 1;
      if (method === 'GetStreamStatus') return Promise.resolve({ outputActive });
      return Promise.resolve({});
    },
    controlStream: (cmd) => {
      if (cmd === 'stop') {
        calls.stop += 1;
        outputActive = false;
      }
      return Promise.resolve();
    },
    vendor,
    onVendorEvent: () => {}
  };
  connection._setOutputActive = (v) => { outputActive = v; };
  connection._setTargets = (arr) => { targets.splice(0, targets.length, ...arr); };
  return { connection, calls };
}

function makeObsEngine(connection, extra) {
  return createObsLocalEngine(Object.assign({
    connection,
    orchestrator: { modeFor: () => 'live' },
    bus: { publish: () => {} },
    now: () => new Date(),
    sleep: async () => {},
    stopVerifyTries: 5,
    stopVerifyMs: 0
  }, extra || {}));
}

function makeBroadcastHarness(config) {
  const cfg = config || {};
  const events = [];
  const bus = { publish: (name, payload, info) => events.push({ name, payload, info: info || {} }), subscribe: () => () => {} };
  const slot = {
    prepareBroadcast: () => ({ ok: true, server: 'rtmp://x', key: 'k' }),
    verifyLive: () => ({ ok: true, live: true }),
    endBroadcast: () => ({ ok: true })
  };
  if (cfg.slotOverrides) Object.assign(slot, cfg.slotOverrides);
  const registry = {
    getRunning: () => (cfg.slots === null ? [] : [{ id: 'slot1', manifest: { provides: ['stream.slot@1'], slotFor: ['site1'], timeouts: {} }, instance: slot }])
  };
  const engines = cfg.engines || {
    emergencyStop: () => ({ ok: true, results: [{ id: 'obs-local', ok: true }] }),
    get: (id) => ({ setKey: () => ({ ok: true }), start: () => ({ ok: true }), stop: () => ({ ok: true }), listTargets: () => [{ id: 't1', state: 'live' }] })
  };
  const destinations = cfg.destinations || [
    { id: 'd1', site: 'site1', accountId: 'd1', engine: { id: 'obs-local', targetId: 't1' }, enabled: true }
  ];
  const store = { snapshot: () => ({ destinations, session: null }) };
  const broadcast = createBroadcast({
    preflight: cfg.preflight || { run: () => ({ ok: true, items: [] }) },
    registry,
    engines,
    store,
    sessions: { view: () => ({ active: false }) },
    bus,
    orchestrator: { modeFor: () => cfg.mode || 'live' },
    now: () => 0,
    sleep: async () => {}
  });
  return { broadcast, events, bus, slot };
}

async function main() {
  await test('obs-local stopAll stops main output when active', async () => {
    const { connection, calls } = makeFakeConnection({ outputActive: true, targets: [] });
    const engine = makeObsEngine(connection);
    const result = await engine.stopAll();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.stop, 1);
    assert.strictEqual(result.mainStillActive, false);
    assert.strictEqual(result.mainStopped, true);
    assert.deepStrictEqual(result.targetsStillActive, []);
  });

  await test('obs-local stopAll does not call controlStream when main inactive', async () => {
    const { connection, calls } = makeFakeConnection({ outputActive: false, targets: [] });
    const engine = makeObsEngine(connection);
    const result = await engine.stopAll();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.stop, 0);
    assert.strictEqual(result.mainStopped, false);
    assert.strictEqual(result.mainStillActive, false);
  });

  await test('obs-local stopAll reports still-active target', async () => {
    const { connection } = makeFakeConnection({ outputActive: false, targets: [{ id: 't1', state: 'live' }], stickyIds: ['t1'] });
    const engine = makeObsEngine(connection);
    const result = await engine.stopAll();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'still-active');
    assert.deepStrictEqual(result.targetsStillActive, ['t1']);
    assert.strictEqual(result.mainStillActive, false);
  });

  await test('obs-local stopAll continues to main output when stop_all_targets fails', async () => {
    const { connection, calls } = makeFakeConnection({ outputActive: true, targets: [], stopAllError: 'rejected' });
    const engine = makeObsEngine(connection);
    const result = await engine.stopAll();
    assert.strictEqual(calls.stop, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.error, 'rejected');
    assert.strictEqual(result.mainStillActive, false);
  });

  await test('obs-local stopAll not-connected', async () => {
    const { connection } = makeFakeConnection({ connected: false });
    const engine = makeObsEngine(connection);
    const result = await engine.stopAll();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'not-connected');
  });

  await test('broadcast.stopAll is not busy while start running and stops remaining', async () => {
    let releasePreflight;
    const gate = new Promise((resolve) => { releasePreflight = resolve; });
    const events = [];
    const bus = { publish: (name, payload, info) => events.push({ name, payload, info: info || {} }), subscribe: () => () => {} };
    const engines = {
      emergencyStop: () => ({ ok: true, results: [{ id: 'obs-local', ok: true }] }),
      get: () => ({ setKey: () => ({ ok: true }), start: () => ({ ok: true }), stop: () => ({ ok: true }), listTargets: () => [{ id: 't1', state: 'live' }] })
    };
    const destinations = [
      { id: 'd1', site: 'site1', engine: { id: 'obs-local', targetId: 't1' }, enabled: true },
      { id: 'd2', site: 'site2', engine: { id: 'obs-local', targetId: 't2' }, enabled: true }
    ];
    const broadcast = createBroadcast({
      preflight: { run: () => gate.then(() => ({ ok: true, items: [] })) },
      registry: { getRunning: () => [] },
      engines,
      store: { snapshot: () => ({ destinations, session: null }) },
      sessions: { view: () => ({ active: false }) },
      bus,
      orchestrator: { modeFor: () => 'live' },
      now: () => 0,
      sleep: async () => {}
    });
    const startPromise = broadcast.start({ destinationIds: ['d1', 'd2'], title: 'x', confirmed: true });
    const stopResult = await broadcast.stopAll({});
    assert.strictEqual(stopResult.ok, true);
    releasePreflight();
    const startResult = await startPromise;
    const failedItems = startResult.items.filter((row) => row.step === 'start' && row.error === 'stopped');
    assert.strictEqual(failedItems.length, 2);
    assert.deepStrictEqual(failedItems.map((row) => row.destinationId).sort(), ['d1', 'd2']);
  });

  await test('broadcast.stopAll legacy calls engines.emergencyStop and no endBroadcast', async () => {
    let emergencyCalled = false;
    let endCalled = false;
    const engines = {
      emergencyStop: () => { emergencyCalled = true; return { ok: true, results: [{ id: 'obs-local', ok: true }] }; },
      get: () => ({ setKey: () => ({}), start: () => ({}), stop: () => ({}) })
    };
    const slot = {
      endBroadcast: () => { endCalled = true; return { ok: true }; }
    };
    const registry = { getRunning: () => [{ id: 'slot1', manifest: { provides: ['stream.slot@1'], slotFor: ['site1'], timeouts: {} }, instance: slot }] };
    const broadcast = createBroadcast({
      engines,
      registry,
      store: { snapshot: () => ({ destinations: [{ id: 'd1', site: 'site1', engine: { id: 'obs-local', targetId: 't1' }, enabled: true }], session: null }) },
      sessions: { view: () => ({ active: false }) },
      bus: { publish: () => {}, subscribe: () => () => {} },
      orchestrator: { modeFor: () => 'legacy' }
    });
    const result = await broadcast.stopAll({});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(emergencyCalled, true);
    assert.strictEqual(endCalled, false);
  });

  await test('BROADCAST_STOPPED has all true', async () => {
    const events = [];
    const bus = { publish: (name, payload, info) => events.push({ name, payload, info }), subscribe: () => () => {} };
    const engines = { emergencyStop: () => ({ ok: true, results: [{ id: 'obs-local', ok: true }] }) };
    const broadcast = createBroadcast({
      engines,
      registry: { getRunning: () => [] },
      store: { snapshot: () => ({ destinations: [], session: null }) },
      sessions: { view: () => ({ active: false }) },
      bus,
      orchestrator: { modeFor: () => 'live' },
      now: () => 0,
      sleep: async () => {}
    });
    await broadcast.stopAll({});
    const stopped = events.find((row) => row.name === EVENTS.BROADCAST_STOPPED);
    assert.ok(stopped);
    assert.strictEqual(stopped.payload.all, true);
  });

  await test('preflight error does not emit BROADCAST_STARTED', async () => {
    const events = [];
    const bus = { publish: (name, payload, info) => events.push({ name, payload, info }), subscribe: () => () => {} };
    const engine = { setKey: () => ({ ok: true }), start: () => ({ ok: true }), listTargets: () => [{ id: 't1', state: 'live' }] };
    const broadcast = createBroadcast({
      preflight: { run: () => ({ ok: false, items: [{ id: 'c', destinationId: 'd1', level: 'error', code: 'x', message: 'no' }] }) },
      engines: { get: () => engine },
      registry: { getRunning: () => [] },
      store: { snapshot: () => ({ destinations: [{ id: 'd1', site: 'site1', engine: { id: 'obs-local', targetId: 't1' }, enabled: true }], session: null }) },
      sessions: { view: () => ({ active: false }) },
      bus,
      orchestrator: { modeFor: () => 'live' },
      now: () => 0,
      sleep: async () => {}
    });
    await broadcast.start({ destinationIds: ['d1'], title: 'x', confirmed: true });
    assert.strictEqual(events.some((row) => row.name === EVENTS.BROADCAST_STARTED), false);
  });

  await test('BROADCAST_STARTED emitted once after first ok', async () => {
    const events = [];
    const bus = { publish: (name, payload, info) => events.push({ name, payload, info }), subscribe: () => () => {} };
    const slot = {
      prepareBroadcast: () => ({ ok: true, server: 'rtmp://x', key: 'k' }),
      verifyLive: () => ({ ok: true, live: true }),
      endBroadcast: () => ({ ok: true })
    };
    const registry = { getRunning: () => [{ id: 'slot1', manifest: { provides: ['stream.slot@1'], slotFor: ['site1'], timeouts: {} }, instance: slot }] };
    const engine = {
      setKey: () => ({ ok: true }),
      start: () => ({ ok: true }),
      listTargets: () => [{ id: 't1', state: 'live' }]
    };
    const destinations = [
      { id: 'd1', site: 'site1', accountId: 'd1', engine: { id: 'obs-local', targetId: 't1' }, enabled: true },
      { id: 'd2', site: 'site2', accountId: 'd2', engine: { id: 'obs-local', targetId: 't2' }, enabled: true }
    ];
    const broadcast = createBroadcast({
      preflight: { run: () => ({ ok: true, items: [] }) },
      registry,
      engines: { get: () => engine },
      store: { snapshot: () => ({ destinations, session: null }) },
      sessions: { view: () => ({ active: false }) },
      bus,
      orchestrator: { modeFor: () => 'live' },
      now: () => 0,
      sleep: async () => {}
    });
    await broadcast.start({ destinationIds: ['d1', 'd2'], title: 'x', confirmed: true });
    const startedEvents = events.filter((row) => row.name === EVENTS.BROADCAST_STARTED);
    assert.strictEqual(startedEvents.length, 1);
    assert.deepStrictEqual(startedEvents[0].payload.destinationIds, ['d1', 'd2']);
  });

  await test('no ok items does not emit BROADCAST_STARTED', async () => {
    const events = [];
    const bus = { publish: (name, payload, info) => events.push({ name, payload, info }), subscribe: () => () => {} };
    const engine = {
      setKey: () => ({ ok: true }),
      start: () => ({ ok: false, error: 'failed' }),
      listTargets: () => [{ id: 't1', state: 'stopped' }]
    };
    const broadcast = createBroadcast({
      preflight: { run: () => ({ ok: true, items: [] }) },
      registry: { getRunning: () => [] },
      engines: { get: () => engine },
      store: { snapshot: () => ({ destinations: [{ id: 'd1', site: 'site1', engine: { id: 'obs-local', targetId: 't1' }, enabled: true }], session: null }) },
      sessions: { view: () => ({ active: false }) },
      bus,
      orchestrator: { modeFor: () => 'live' },
      now: () => 0,
      sleep: async () => {}
    });
    await broadcast.start({ destinationIds: ['d1'], title: 'x', confirmed: true });
    assert.strictEqual(events.some((row) => row.name === EVENTS.BROADCAST_STARTED), false);
  });

  await test('engine.setKey via API forces restartIfActive false', async () => {
    let receivedFlags;
    const engine = {
      setKey: (id, settings, flags) => { receivedFlags = flags; return { ok: true }; }
    };
    const api = createApi({
      engine: engine,
      getState: () => ({}),
      fanout: async () => ({ sent: false }),
      forceLegacy: () => ({ mode: 'legacy' })
    });
    const result = await api.call('engine.setKey', { id: 't1', key: 'k', restartIfActive: true });
    assert.strictEqual(result.ok, true, result.error || 'API call failed');
    assert.deepStrictEqual(receivedFlags, { restartIfActive: false });
  });

  await test('L8g: engine.setKey は送信中（live・connecting・reconnecting）の配信先を streaming で断り、止まっている配信先は通す', async () => {
    const calls = [];
    const rows = [
      { id: 'main', main: true, state: 'live' },
      { id: 'on', state: 'live' },
      { id: 'cn', state: 'connecting' },
      { id: 'rc', state: 'reconnecting' },
      { id: 'off', state: 'stopped' }
    ];
    const engine = {
      listTargets: () => rows,
      setKey: (id) => { calls.push(id); return { ok: true }; }
    };
    const api = createApi({ engine: engine, getState: () => ({}), fanout: async () => ({ sent: false }), forceLegacy: () => ({ mode: 'legacy' }) });
    for (const id of ['on', 'cn', 'rc']) {
      assert.deepStrictEqual(await api.call('engine.setKey', { id: id, key: 'k' }), { ok: false, error: 'streaming' }, id);
    }
    assert.strictEqual((await api.call('engine.setKey', { id: 'off', key: 'k' })).ok, true);
    assert.deepStrictEqual(calls, ['off']);
  });

  if (failed) process.exit(1);
  console.log('l1-stop-all ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});