'use strict';
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createSessions } = require('./_k3-parts');
const { createSessionStore } = require('./_k3-parts');
const { createOrchestrator } = require('./_orch');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createObsConnection, VENDOR_BIT } = require('../host/core/engine/obs-connection');
const { createObsLocalEngine, REQUIRED } = require('../host/core/engine/obs-local');
const { createEngineRegistry } = require('../host/core/engine');
const { createApi } = require('../host/layer1/api');
const { emergencyButtonState } = require('../host/core/engine/emergency-button');
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

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function tempCore() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-stage2-'));
  return { dir, core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync } };
}

function waitUntil(fn, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ready = false;
      try { ready = !!fn(); } catch (_) { ready = false; }
      if (ready) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function vendorCalls(calls) {
  return calls.filter((row) => row.name === 'CallVendorRequest').map((row) => ({
    type: row.data && row.data.requestType,
    data: row.data && row.data.requestData
  }));
}

function defaultReply(name, data) {
  if (name === 'GetStreamStatus' || name === 'GetVersion') return { outputActive: false };
  const type = data && data.requestType;
  const body = data && data.requestData ? data.requestData : {};
  if (type === 'list_capabilities') return { requests: REQUIRED.map((item) => ({ name: item })) };
  if (type === 'list_targets') {
    return { targets: [{ id: 't1', name: 'YouTube', protocol: 'RTMP', state: 'stopped', enabled: true, sync_start: true, sync_stop: false }] };
  }
  if (type === 'get_target_status') return { id: body.id, state: 'stopped', enabled: true, last_error_code: 0, success: true };
  if (type === 'stop_all_targets') return { success: true, count: 1 };
  return { success: true, dry_run: body.dry_run === true };
}

function mockObs(reply) {
  const handlers = {};
  const calls = [];
  const client = {
    on(name, fn) { handlers[name] = fn; },
    async connect(_url, _password, opts) { calls.push({ name: 'connect', opts: opts }); },
    async call(name, data) {
      calls.push({ name: name, data: data });
      return (reply || defaultReply)(name, data, calls);
    },
    async disconnect() { calls.push({ name: 'disconnect' }); }
  };
  return { client, handlers, calls };
}

function makeEngine(bag, opts) {
  const options = opts || {};
  const logs = [];
  const bus = createEventBus({ logger() {} });
  const store = createStateStore({ core: bag.core, bus, logger() {}, now: options.now });
  const mocked = mockObs(options.reply);
  let mode = options.mode || 'legacy';
  const engine = createObsLocalEngine({
    core: bag.core,
    store,
    bus,
    client: mocked.client,
    logger: (_level, message) => logs.push(String(message)),
    now: options.now,
    pollMs: 0,
    reconnectMs: options.reconnectMs || 60000,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
    orchestrator: {
      modeFor(id) { return id === 'obs-engine' ? mode : 'legacy'; },
      dispatchObs() { return []; }
    }
  });
  return {
    engine,
    bus,
    store,
    logs,
    calls: mocked.calls,
    handlers: mocked.handlers,
    setMode(next) { mode = next; }
  };
}

function link(store) {
  store.putDestination({
    id: 'youtube-main',
    site: 'youtube',
    enabled: true,
    engine: { id: 'obs-local', targetId: 't1' }
  });
}

async function main() {
  const real = createCore();
  const modesPath = path.join(real.STATE_DIR, 'services', 'marust-modes.json');
  const fanPath = path.join(real.STATE_DIR, 'services', 'marust-fanout.json');
  const modesBefore = fs.existsSync(modesPath);
  const fanBefore = fs.existsSync(fanPath);

  await test('connection allow list rejects writes, start_all, StartStream and reveal_secrets', async () => {
    const bag = tempCore();
    try {
      let internal = null;
      const mocked = mockObs();
      const seen = [];
      const conn = createObsConnection({
        core: bag.core,
        client: mocked.client,
        logger() {},
        reconnectMs: 60000,
        orchestrator: { dispatchObs(input) { seen.push(input.outputState); return []; } },
        bindInternal(api) { internal = api; }
      });
      assert.strictEqual(typeof conn.callWrite, 'undefined');
      assert.strictEqual(typeof conn.vendor, 'undefined');
      assert.ok(internal && typeof internal.vendor === 'function');
      await conn.start();
      const bits = mocked.calls[0].opts.eventSubscriptions;
      assert.strictEqual((bits & VENDOR_BIT) === VENDOR_BIT, true);
      const status = await conn.call('GetStreamStatus');
      assert.strictEqual(status.outputActive, false);
      await assert.rejects(conn.call('StartStream'), (err) => err && err.code === 'OBS_REQUEST_FORBIDDEN');
      await assert.rejects(conn.call('StopStream'), (err) => err && err.code === 'OBS_REQUEST_FORBIDDEN');
      await assert.rejects(conn.call('CallVendorRequest', {
        vendorName: 'obs-multi-rtmp',
        requestType: 'start_target',
        requestData: { id: 't1' }
      }), (err) => err && err.code === 'OBS_REQUEST_FORBIDDEN');
      await assert.rejects(conn.call('CallVendorRequest', {
        vendorName: 'obs-multi-rtmp',
        requestType: 'start_all_targets',
        requestData: {}
      }), (err) => err && err.code === 'OBS_REQUEST_FORBIDDEN');
      await assert.rejects(conn.call('CallVendorRequest', {
        vendorName: 'obs-multi-rtmp',
        requestType: 'stop_all_targets',
        requestData: {}
      }), (err) => err && err.code === 'OBS_REQUEST_FORBIDDEN');
      await assert.rejects(conn.call('CallVendorRequest', {
        vendorName: 'obs-multi-rtmp',
        requestType: 'get_target_config',
        requestData: { id: 't1', reveal_secrets: true }
      }), (err) => err && err.code === 'OBS_REQUEST_FORBIDDEN');
      const types = vendorCalls(mocked.calls).map((row) => row.type);
      assert.ok(!types.includes('start_target'));
      assert.ok(!types.includes('stop_all_targets'));
      mocked.handlers.StreamStateChanged({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
      await waitUntil(() => seen.length === 1, 500);
      assert.strictEqual(seen[0], 'OBS_WEBSOCKET_OUTPUT_STARTING');
      let vendor = null;
      conn.onVendorEvent((data) => { vendor = data; });
      mocked.handlers.VendorEvent({ vendorName: 'other', eventType: 'target_state_changed', eventData: { id: 'no' } });
      mocked.handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'other', eventData: { id: 'no' } });
      mocked.handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'target_state_changed', eventData: { id: 't1', state: 'live' } });
      assert.strictEqual(vendor.id, 't1');
      assert.strictEqual(vendor.state, 'live');
      await conn.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('missing capability disables writes but list_targets still runs', async () => {
    const bag = tempCore();
    try {
      const ctx = makeEngine(bag, {
        mode: 'live',
        reply(name, data) {
          if (data && data.requestType === 'list_capabilities') {
            return { requests: REQUIRED.filter((item) => item !== 'start_target').map((item) => ({ name: item })) };
          }
          return defaultReply(name, data);
        }
      });
      await ctx.engine.connect();
      const status = ctx.engine.status();
      assert.strictEqual(status.supported, false);
      assert.ok(status.missing.includes('start_target'));
      assert.strictEqual(status.detail.indexOf('足りない') >= 0, true);
      const types = vendorCalls(ctx.calls).map((row) => row.type);
      assert.ok(types.includes('list_targets'));
      const before = ctx.calls.length;
      const result = await ctx.engine.start('t1');
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'unsupported');
      assert.strictEqual(ctx.calls.length, before);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('connect and reconnect never start or stop a target', async () => {
    const bag = tempCore();
    try {
      let timer = null;
      const ctx = makeEngine(bag, {
        mode: 'live',
        reconnectMs: 25,
        setTimeoutFn(fn) { timer = fn; return 1; },
        clearTimeoutFn() { timer = null; }
      });
      await ctx.engine.connect();
      ctx.handlers.ConnectionClosed();
      assert.strictEqual(typeof timer, 'function');
      timer();
      await waitUntil(() => ctx.calls.filter((row) => row.name === 'connect').length >= 2, 500);
      const types = vendorCalls(ctx.calls).map((row) => row.type);
      assert.ok(!types.includes('start_target'));
      assert.ok(!types.includes('stop_target'));
      assert.ok(!types.includes('stop_all_targets'));
      ctx.engine.shutdown();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('legacy sends no writes, shadow sends dry_run only, live sends dry_run then the real call', async () => {
    const bag = tempCore();
    try {
      const ctx = makeEngine(bag, { mode: 'legacy' });
      link(ctx.store);
      await ctx.engine.connect();
      const legacy = await ctx.engine.start('t1');
      assert.strictEqual(legacy.ok, false);
      assert.strictEqual(legacy.error, 'read-only');
      ctx.setMode('shadow');
      const shadowStart = await ctx.engine.start('t1');
      assert.strictEqual(shadowStart.dryRun, true);
      const shadowKey = await ctx.engine.setKey('t1', { server: 'rtmp://example/live', key: 'shadow-key' }, {});
      assert.strictEqual(shadowKey.ok, true);
      assert.strictEqual(shadowKey.dryRun, true);
      ctx.setMode('live');
      const liveKey = await ctx.engine.setKey('t2', { server: 'rtmp://example/live', key: 'live-key' }, { restartIfActive: false });
      assert.strictEqual(liveKey.ok, true);
      const keys = vendorCalls(ctx.calls).filter((row) => row.type === 'set_target_service_settings');
      assert.strictEqual(keys.length, 3);
      assert.strictEqual(keys[0].data.dry_run, true);
      assert.strictEqual(keys[0].data.id, 't1');
      assert.strictEqual(keys[1].data.dry_run, true);
      assert.strictEqual(keys[1].data.id, 't2');
      assert.ok(keys[2].data.dry_run !== true);
      assert.strictEqual(keys[2].data.id, 't2');
      assert.strictEqual(keys[2].data.merge, true);
      assert.strictEqual(keys[2].data.restart_if_active, false);
      const starts = vendorCalls(ctx.calls).filter((row) => row.type === 'start_target');
      assert.strictEqual(starts.length, 0);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('setKey does not put the key in the log, state file, or event payload', async () => {
    const bag = tempCore();
    try {
      const secret = 'super-secret-key-xyz';
      const ctx = makeEngine(bag, { mode: 'live' });
      link(ctx.store);
      const payloads = [];
      ctx.bus.subscribe('*', (_name, payload) => payloads.push(JSON.stringify(payload)));
      await ctx.engine.connect();
      await ctx.engine.setKey('t1', { server: 'rtmp://example/live', key: secret }, { restartIfActive: true });
      assert.ok(JSON.stringify(ctx.calls).includes(secret));
      assert.ok(!ctx.logs.join('\n').includes(secret));
      const walked = [];
      function walk(dir) {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else walked.push(fs.readFileSync(full, 'utf8'));
        }
      }
      walk(bag.dir);
      assert.ok(!walked.join('\n').includes(secret));
      assert.ok(!payloads.join('\n').includes(secret));
      const only = vendorCalls(ctx.calls).filter((row) => row.type === 'set_target_service_settings');
      assert.ok(only.every((row) => row.data.id === 't1'));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('sync updates actual and emits target and stream events only when they change', async () => {
    const bag = tempCore();
    try {
      const ctx = makeEngine(bag, { mode: 'legacy' });
      link(ctx.store);
      const names = [];
      ctx.bus.subscribe('engine.target.changed', () => names.push('target'));
      ctx.bus.subscribe('stream.started', (_n, payload) => names.push('started:' + payload.reason));
      ctx.bus.subscribe('stream.stopped', (_n, payload) => names.push('stopped:' + payload.reason));
      await ctx.engine.connect();
      await ctx.bus.flush();
      assert.strictEqual(ctx.store.snapshot().destinations[0].actual.engineState, 'stopped');
      assert.ok(!names.some((item) => item.indexOf('started') === 0));
      ctx.handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'target_state_changed', eventData: { id: 't1', name: 'YouTube', state: 'live', last_error_code: 0 } });
      ctx.handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'target_state_changed', eventData: { id: 't1', name: 'YouTube', state: 'live', last_error_code: 0 } });
      await ctx.bus.flush();
      assert.strictEqual(names.filter((item) => item === 'started:event').length, 1);
      assert.strictEqual(ctx.store.snapshot().destinations[0].actual.engineState, 'live');
      ctx.handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'target_state_changed', eventData: { id: 't1', state: 'stopped', last_error_code: -2 } });
      await ctx.bus.flush();
      assert.strictEqual(names.filter((item) => item.indexOf('stopped:') === 0).length, 1);
      assert.strictEqual(ctx.store.snapshot().destinations[0].actual.lastError, 'connect-failed');
      const again = names.slice();
      await ctx.engine.syncNow('poll');
      await ctx.bus.flush();
      assert.deepStrictEqual(names, again);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('a stale refresh does not overwrite a newer live event', async () => {
    const bag = tempCore();
    try {
      let release = null;
      const gate = new Promise((resolve) => { release = resolve; });
      let clock = Date.parse('2026-10-04T00:00:00.000Z');
      const ctx = makeEngine(bag, {
        mode: 'legacy',
        now: () => new Date(clock),
        reply(name, data) {
          if (data && data.requestType === 'list_targets') {
            return gate.then(() => ({ targets: [{ id: 't1', name: 'YouTube', state: 'stopped', enabled: true }] }));
          }
          if (data && data.requestType === 'get_target_status') return { state: 'stopped', last_error_code: 0 };
          return defaultReply(name, data);
        }
      });
      link(ctx.store);
      const pending = ctx.engine.connect();
      await waitUntil(() => vendorCalls(ctx.calls).some((row) => row.type === 'list_targets'), 1000);
      clock += 5000;
      ctx.handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'target_state_changed', eventData: { id: 't1', state: 'live', last_error_code: 0 } });
      release();
      await pending;
      assert.strictEqual(ctx.store.snapshot().destinations[0].actual.engineState, 'live');
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('external stop does not make the engine call start', async () => {
    const bag = tempCore();
    try {
      const ctx = makeEngine(bag, { mode: 'live' });
      link(ctx.store);
      await ctx.engine.connect();
      ctx.handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'target_state_changed', eventData: { id: 't1', state: 'stopped', last_error_code: 0 } });
      const types = vendorCalls(ctx.calls).map((row) => row.type);
      assert.ok(!types.includes('start_target'));
      assert.strictEqual(ctx.store.snapshot().destinations[0].actual.engineState, 'stopped');
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('emergency stop works in legacy and sends only stop_all_targets', async () => {
    const bag = tempCore();
    try {
      const ctx = makeEngine(bag, { mode: 'legacy' });
      link(ctx.store);
      const reasons = [];
      ctx.bus.subscribe(EVENTS.STREAM_STOPPING, (_name, payload) => reasons.push(payload.reason));
      await ctx.engine.connect();
      const before = vendorCalls(ctx.calls).map((row) => row.type);
      const result = await ctx.engine.stopAll();
      assert.strictEqual(result.ok, true);
      const after = vendorCalls(ctx.calls).map((row) => row.type).slice(before.length);
      assert.strictEqual(after[0], 'stop_all_targets');
      assert.ok(after.slice(1).every((type) => type === 'list_targets' || type === 'get_target_status'));
      await ctx.bus.flush();
      assert.deepStrictEqual(reasons, ['emergency']);
      const logs = fs.readdirSync(path.join(bag.dir, 'logs', 'marust'));
      assert.ok(logs.some((name) => name.indexOf('emergency-') === 0));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('emergencyButtonState covers empty, stopped, live, reconnecting and disconnected', async () => {
    assert.deepStrictEqual(emergencyButtonState([], false), { color: 'gray', label: 'OBS 未接続', hold: false, count: 0 });
    assert.deepStrictEqual(emergencyButtonState([], true), { color: 'blue', label: '全部止める', hold: false, count: 0 });
    assert.deepStrictEqual(emergencyButtonState([{ state: 'stopped' }], true), { color: 'blue', label: '全部止める', hold: false, count: 0 });
    const live = emergencyButtonState([{ state: 'stopped' }, { state: 'live' }], true);
    assert.strictEqual(live.color, 'blue');
    assert.strictEqual(live.count, 1);
    assert.strictEqual(live.hold, false);
    assert.strictEqual(live.label, '全部止める（送信中 1 件）');
    assert.strictEqual(emergencyButtonState([{ state: 'reconnecting' }], true).color, 'blue');
    assert.strictEqual(emergencyButtonState([{ state: 'connecting' }, { state: 'live' }], true).count, 2);
    assert.strictEqual(emergencyButtonState([{ state: 'connecting' }, { state: 'live' }], true).label, '全部止める（送信中 2 件）');
  });

  await test('live plugin missing from allowedLiveIds is skipped', async () => {
    const bag = tempCore();
    try {
      fs.mkdirSync(path.join(bag.dir, 'services'), { recursive: true });
      fs.writeFileSync(path.join(bag.dir, 'services', 'marust-modes.json'), JSON.stringify({
        plugins: { twitch: 'live', youtube: 'live' }
      }));
      const calls = [];
      const registry = {
        isLoaded: () => true,
        loadAll: async () => {},
        getRunning: () => ['twitch', 'youtube'].map((id) => ({
          id,
          manifest: { fanout: { requires: 'title', method: 'updateTitle' } },
          instance: {
            isConfigured() { return true; },
            updateTitle(_title, meta) { calls.push({ id, dryRun: meta.dryRun }); return { ok: true }; }
          }
        }))
      };
      const host = createOrchestrator({ registry, core: bag.core, logger() {} });
      const rows = await host.fanout({ title: 't', category: '', source: 'hub-ui', allowedLiveIds: ['twitch'] });
      const youtube = rows.find((row) => row.id === 'youtube');
      const twitch = rows.find((row) => row.id === 'twitch');
      assert.strictEqual(youtube.message, 'live-not-confirmed');
      assert.strictEqual(twitch.result, 'ok');
      assert.deepStrictEqual(calls.map((row) => row.id), ['twitch']);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('recover ends a timer session and keeps an obs session while output is live', async () => {
    const bag = tempCore();
    try {
      const bus = createEventBus({ logger() {} });
      const store = createSessionStore({ dir: bag.dir });
      const ended = [];
      bus.subscribe(EVENTS.SESSION_ENDED, (_n, payload) => ended.push(payload.source));
      const sessions = createSessions({ store, bus, recover: false, heartbeatMs: 30000 });
      sessions.start({ title: 'timer-one', source: 'timer' });
      const timerResult = sessions.recover({ anyOutputLive: true });
      assert.strictEqual(timerResult.continued, false);
      assert.strictEqual(store.snapshot().session.state, 'ended');
      assert.strictEqual(store.snapshot().session.source, 'timer');
      const denied = sessions.start({ title: 'nope', source: 'obs' });
      assert.strictEqual(denied.reason, 'source-not-enabled');
      sessions.stop();
      const file = path.join(bag.dir, 'session.json');
      const saved = { schemaVersion: 1 };
      saved.session = {
        id: 's-obs',
        title: 'from-obs',
        category: '',
        plannedSec: null,
        source: 'obs',
        state: 'running',
        startedAt: '2026-10-04T00:00:00.000Z',
        lastAliveAt: '2026-10-04T00:10:00.000Z',
        segments: [{ startedAt: '2026-10-04T00:00:00.000Z' }]
      };
      fs.writeFileSync(file, JSON.stringify(saved));
      const bus2 = createEventBus({ logger() {} });
      const resumed = [];
      bus2.subscribe(EVENTS.SESSION_RESUMED, (_n, payload) => resumed.push(payload));
      bus2.subscribe(EVENTS.SESSION_ENDED, () => resumed.push('ended'));
      const store2 = createSessionStore({ dir: bag.dir });
      store2.load();
      const again = createSessions({ store: store2, bus: bus2, recover: false, heartbeatMs: 30000 });
      const kept = again.recover({ anyOutputLive: true });
      await bus2.flush();
      assert.strictEqual(kept.continued, true);
      assert.strictEqual(store2.snapshot().session.state, 'running');
      assert.strictEqual(resumed.length, 1);
      assert.strictEqual(resumed[0].recovered, true);
      assert.strictEqual(resumed[0].source, 'obs');
      again.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('a fake engine is called by id and an old state file is readable', async () => {
    const registry = createEngineRegistry();
    const calls = [];
    registry.register('fake-engine', {
      capabilities() {
        return { createTarget: false, setKey: false, perTargetQuality: false, emergencyStop: true };
      },
      stopAll() { calls.push('fake-engine'); return { ok: true }; }
    });
    const stopped = await registry.emergencyStop();
    assert.deepStrictEqual(calls, ['fake-engine']);
    assert.strictEqual(stopped.results[0].id, 'fake-engine');
    const apiSrc = require('./_api-source').read();
    const electron = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
    assert.ok(!apiSrc.includes('obs-local'));
    assert.ok(!electron.includes('engines/obs-local'));
    assert.ok(electron.includes('allowedLiveIds'));
    const bag = tempCore();
    try {
      const file = path.join(bag.dir, 'data', 'marust', 'state.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        destinations: [{
          id: 'old-yt',
          site: 'youtube',
          obsTargetId: 'obs-9',
          enabled: true,
         
          desired: { live: false, title: 'Old', category: '' },
          actual: { obsState: 'live', siteLive: false, title: 'Old', category: '', lastError: '', updatedAt: null }
        }],
        session: null
      }));
      const store = createStateStore({ core: bag.core, logger() {} });
      const row = store.snapshot().destinations[0];
      assert.deepStrictEqual(row.engine, { id: 'obs-local', targetId: 'obs-9' });
      assert.strictEqual(row.actual.engineState, 'live');
      assert.ok(!Object.prototype.hasOwnProperty.call(row, 'obsTargetId'));
      assert.strictEqual(row.accountId, 'old-yt');
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('manifest requires keeps role versions and api rejects unknown or oversized calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-req-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-req-state-'));
    const logs = [];
    try {
      const dir = path.join(root, 'needs');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: 'needs',
        name: 'Needs',
        version: '1.0.0',
        manifestVersion: 2,
        runtime: 'inproc',
        main: 'index.js',
        provides: ['ui.panel@1'],
        requires: ['session.controller@1', 'NOT A ROLE', 4]
      }));
      fs.writeFileSync(path.join(dir, 'index.js'), "'use strict'; module.exports = { health() { return { ok: true }; } };");
      const registry = createRegistry({
        core: { STATE_DIR: state },
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(state, 'plugins'),
        logger: (_level, message) => logs.push(message)
      });
      const rows = await registry.loadAll();
      const row = rows.find((item) => item.id === 'needs');
      assert.deepStrictEqual(row.manifest.requires, ['session.controller@1']);
      assert.ok(logs.some((line) => line.indexOf('ignore requires') >= 0));
      const engines = createEngineRegistry();
      engines.register('fake-engine', {
        capabilities() { return { emergencyStop: true, createTarget: true, setKey: true, perTargetQuality: false }; },
        status() { return { ok: true }; },
        listTargets() { return []; },
        start(id) { return { ok: true, id: id }; },
        stopAll() { return { ok: true, via: 'fake' }; }
      });
      const api = createApi({
        registry: engines,
        getState: () => ({ product: 'marust' }),
        fanout: async () => ({ sent: false }),
        forceLegacy: () => ({ mode: 'legacy' }),
        timer: { getState() { return { running: false }; } },
        timerCommand: () => ({ running: false })
      });
      assert.strictEqual((await api.call('nope.method', {})).error, 'unknown-method');
      assert.strictEqual((await api.call('engine.start', { id: 't' }, { permissions: ['read'] })).error, 'forbidden');
      assert.strictEqual((await api.call('engine.create', { name: 'n'.repeat(101), protocol: 'RTMP', server: 's', key: 'k' })).error, 'name-length');
      assert.strictEqual((await api.call('engine.create', { name: 'n', protocol: 'HLS', server: 's', key: 'k' })).error, 'protocol');
      const started = await api.call('engine.start', { id: 'only-this' });
      assert.strictEqual(started.id, 'only-this');
      const emergency = await api.call('engine.emergencyStop', {});
      assert.strictEqual(emergency.results[0].via, 'fake');
    } finally {
      rimraf(root);
      rimraf(state);
    }
  });

  await test('empty or whitespace setKey is rejected and sends nothing to OBS', async () => {
    const bag = tempCore();
    try {
      const ctx = makeEngine(bag, { mode: 'live' });
      await ctx.engine.connect();
      const before = ctx.calls.length;
      const directEmpty = await ctx.engine.setKey('t1', { server: '', key: '' }, { restartIfActive: true });
      const directBlank = await ctx.engine.setKey('t1', { key: '   ' }, { restartIfActive: true });
      assert.strictEqual(directEmpty.ok, false);
      assert.strictEqual(directEmpty.error, 'empty-settings');
      assert.strictEqual(directBlank.error, 'empty-settings');
      const partial = await ctx.engine.setKey('t1', { server: 'rtmp://example/live', key: '' }, { restartIfActive: true });
      assert.strictEqual(partial.ok, true);
      const api = createApi({
        engine: ctx.engine,
        getState() { return {}; },
        fanout: async () => ({ sent: false }),
        forceLegacy() { return { mode: 'legacy' }; },
        timer: { getState() { return {}; } },
        timerCommand() { return {}; }
      });
      const viaEmpty = await api.call('engine.setKey', { id: 't1', key: '', restartIfActive: true });
      const viaBlank = await api.call('engine.setKey', { id: 't1', server: '', key: '  ', restartIfActive: true });
      const viaServer = await api.call('engine.setKey', { id: 't1', server: '   ', key: 'kept-key', restartIfActive: false });
      assert.strictEqual(viaEmpty.error, 'key-empty');
      assert.strictEqual(viaBlank.error, 'key-empty');
      assert.strictEqual(viaServer.error, 'server-empty');
      const sentBeforeOk = vendorCalls(ctx.calls).filter((row) => row.type === 'set_target_service_settings');
      assert.strictEqual(sentBeforeOk.length, 2);
      assert.deepStrictEqual(sentBeforeOk[0].data.settings, { server: 'rtmp://example/live' });
      assert.strictEqual(Object.prototype.hasOwnProperty.call(sentBeforeOk[0].data.settings, 'key'), false);
      assert.strictEqual(sentBeforeOk[0].data.restart_if_active, true);
      const saved = await api.call('engine.setKey', { id: 't1', key: ' real-key ', restartIfActive: true });
      assert.strictEqual(saved.ok, true);
      const sent = vendorCalls(ctx.calls).filter((row) => row.type === 'set_target_service_settings');
      const last = sent[sent.length - 1].data;
      assert.strictEqual(last.settings.key, 'real-key');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(last.settings, 'server'), false);
      assert.strictEqual(last.restart_if_active, false);
      const types = vendorCalls(ctx.calls.slice(before)).map((row) => row.type);
      assert.ok(types.includes('set_target_service_settings'));
      assert.ok(!JSON.stringify(vendorCalls(ctx.calls)).includes('"key":""'));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('list_capabilities failure still lists targets and rejects writes as unsupported', async () => {
    const bag = tempCore();
    try {
      const ctx = makeEngine(bag, {
        mode: 'live',
        reply(name, data) {
          if (data && data.requestType === 'list_capabilities') throw new Error('missing request');
          return defaultReply(name, data);
        }
      });
      await ctx.engine.connect();
      const rows = ctx.engine.listTargets();
      assert.ok(rows.some((row) => row.id === 't1'));
      const status = ctx.engine.status();
      assert.strictEqual(status.supported, false);
      assert.ok(status.missing.includes('list_capabilities'));
      const before = ctx.calls.length;
      const result = await ctx.engine.setKey('t1', { key: 'abc' }, { restartIfActive: true });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'unsupported');
      const after = vendorCalls(ctx.calls.slice(before)).map((row) => row.type);
      assert.ok(!after.includes('set_target_service_settings'));
      assert.ok(vendorCalls(ctx.calls).some((row) => row.type === 'list_targets'));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('confirmed hub fanout without an allowedLiveIds array allows no live plugin', async () => {
    const { allowedLiveIdsForHub } = require('./_orch');
    assert.deepStrictEqual(allowedLiveIdsForHub({ confirmed: true }, ['twitch', 'youtube']), []);
    assert.deepStrictEqual(allowedLiveIdsForHub({ confirmed: true, allowedLiveIds: 'twitch' }, ['twitch']), []);
    assert.deepStrictEqual(allowedLiveIdsForHub({ confirmed: true, allowedLiveIds: null }, ['twitch']), []);
    assert.deepStrictEqual(allowedLiveIdsForHub({ confirmed: true, allowedLiveIds: ['twitch', 1] }, ['youtube']), ['twitch']);
    assert.deepStrictEqual(allowedLiveIdsForHub({ confirmed: false }, ['twitch']), ['twitch']);
    const electron = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
    const gate = electron.slice(electron.indexOf('async function fanoutFromHub'), electron.indexOf('async function startObs'));
    assert.ok(gate.includes('allowedLiveIdsForHub(payload, summary.liveIds)'));
    assert.ok(!gate.includes('summary.liveIds.slice()'));
    const bag = tempCore();
    try {
      fs.mkdirSync(path.join(bag.dir, 'services'), { recursive: true });
      fs.writeFileSync(path.join(bag.dir, 'services', 'marust-modes.json'), JSON.stringify({
        plugins: { twitch: 'live', youtube: 'live' }
      }));
      const calls = [];
      const registry = {
        isLoaded: () => true,
        loadAll: async () => {},
        getRunning: () => ['twitch', 'youtube'].map((id) => ({
          id,
          manifest: { fanout: { requires: 'title', method: 'updateTitle' } },
          instance: {
            isConfigured() { return true; },
            updateTitle() { calls.push(id); return { ok: true }; }
          }
        }))
      };
      const host = createOrchestrator({ registry, core: bag.core, logger() {} });
      const allowed = allowedLiveIdsForHub({ confirmed: true }, ['twitch', 'youtube']);
      const rows = await host.fanout({ title: 't', category: '', source: 'hub-ui', allowedLiveIds: allowed });
      assert.deepStrictEqual(calls, []);
      assert.ok(rows.every((row) => row.message === 'live-not-confirmed'));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('plugins/ui-standard/shell/panels/emergency.js calls broadcast.stopAll on click, no MarustEmergencyHold, and hub.html does not load emergency-hold.js', async () => {
    const emergencySrc = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'panels', 'emergency.js'), 'utf8');
    const html = require('./_ui-source').shellDocument();
    const homeSrc = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'panels', 'home.js'), 'utf8');
    assert.ok(emergencySrc.includes("call('broadcast.stopAll', {})"));
    assert.ok(!emergencySrc.includes('MarustEmergencyHold'));
    assert.ok(!emergencySrc.includes('pointerdown'));
    assert.ok(!emergencySrc.includes('hold.keydown'));
    assert.ok(!html.includes('src="/ui/emergency-hold.js"'));
    assert.ok(!html.includes('emergency-hold.js'));
    assert.ok(homeSrc.includes("call('broadcast.stopAll', {})"));
    assert.ok(!homeSrc.includes("'data-act': 'key-restart'"));
    assert.ok(homeSrc.includes("'data-act': 'key-save'"));
    assert.ok(homeSrc.includes("input.value = ''"), 'キーは送ったらすぐ空にする');
  });

  assert.strictEqual(fs.existsSync(modesPath), modesBefore);
  assert.strictEqual(fs.existsSync(fanPath), fanBefore);
  if (failed) {
    console.error('[marust] stage2 failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] stage2 tests passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
