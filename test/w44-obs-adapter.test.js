'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createObsLocalEngine, REQUIRED } = require('../host/core/engine/obs-local');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w44-'));
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

function fakeConnection() {
  let connected = false;
  let handler = function () { return {}; };
  const handlers = [];
  const calls = [];
  const conn = {
    calls,
    async start() {
      connected = true;
      return conn.getStatus();
    },
    stop() { connected = false; },
    getStatus() { return { connected: connected, detail: connected ? 'ok' : 'no' }; },
    onVendorEvent(fn) {
      handlers.push(fn);
      return function () {
        const index = handlers.indexOf(fn);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit(data) {
      handlers.slice().forEach((fn) => fn(data));
    },
    async vendor(_tier, requestType, requestData) {
      calls.push({ type: requestType, data: requestData || {} });
      return handler(requestType, requestData || {});
    },
    setHandler(fn) { handler = fn; }
  };
  return conn;
}

function typesOf(conn) {
  return conn.calls.map((row) => row.type);
}

function link(store) {
  store.putDestination({
    id: 'youtube-main',
    site: 'youtube',
    enabled: true,
    engine: { id: 'obs-local', targetId: 't1' }
  });
}

function make(bag, opts) {
  const options = opts || {};
  const logs = [];
  const payloads = [];
  const bus = createEventBus({ logger() {} });
  bus.subscribe('*', (name, payload) => {
    payloads.push({ name: name, payload: payload });
  });
  const store = createStateStore({ core: bag.core, bus: bus, logger() {}, now: options.now });
  const connection = fakeConnection();
  connection.setHandler(options.reply);
  const engine = createObsLocalEngine({
    core: bag.core,
    store: store,
    bus: bus,
    connection: connection,
    logger: (_level, message) => logs.push(String(message)),
    now: options.now,
    pollMs: 0,
    orchestrator: {
      modeFor() { return options.mode || 'legacy'; },
      dispatchObs() { return []; }
    }
  });
  return { engine, bus, store, logs, payloads, connection };
}

function replyFor(version, snapshot) {
  return function (type) {
    if (type === 'list_capabilities') return { requests: REQUIRED.map((name) => ({ name: name })) };
    if (type === 'get_api_version') {
      if (version === 'fail') throw new Error('no-version');
      if (version === 'missing') return { pluginVersion: '0.7.0' };
      return { apiVersion: version, pluginVersion: '0.8.0' };
    }
    if (type === 'list_targets') {
      return { targets: [{ id: 't1', name: 'YouTube', protocol: 'RTMP', state: 'stopped', enabled: true, sync_start: false, sync_stop: false }] };
    }
    if (type === 'get_target_status') return { id: 't1', state: 'stopped', enabled: true, last_error_code: 0 };
    if (type === 'get_snapshot') return snapshot || { apiVersion: 3, observedAt: '2026-10-05T02:00:00.000Z', targets: [] };
    return { success: true };
  };
}

function actualOf(store) {
  return store.snapshot().destinations[0].actual;
}

async function main() {
  await test('version 3 refresh uses get_snapshot and keeps the engine observedAt', async () => {
    const bag = tempCore();
    try {
      const observedAt = '2026-10-05T02:00:00.000Z';
      const ctx = make(bag, {
        now: () => new Date('2026-10-05T09:00:00.000Z'),
        reply: replyFor(3, {
          apiVersion: 3,
          observedAt: observedAt,
          targets: [{
            id: 't1',
            name: 'YouTube',
            enabled: true,
            state: 'live',
            reconnects: 2,
            lastError: 'handshake-failed',
            service: { type: 'RTMP', server: 'rtmp://example/live' }
          }]
        })
      });
      link(ctx.store);
      await ctx.engine.connect();
      const types = typesOf(ctx.connection);
      assert.ok(types.includes('get_api_version'));
      assert.ok(types.includes('get_snapshot'));
      assert.ok(!types.includes('list_targets'));
      assert.ok(!types.includes('get_target_status'));
      assert.ok(!types.includes('start_target'));
      const actual = actualOf(ctx.store);
      assert.strictEqual(actual.engineState, 'live');
      assert.strictEqual(actual.lastError, 'handshake-failed');
      assert.strictEqual(actual.reconnects, 2);
      assert.strictEqual(actual.observed.engineState.at, observedAt);
      assert.strictEqual(actual.observed.lastError.at, observedAt);
      assert.strictEqual(actual.observed.reconnects.at, observedAt);
      const listed = ctx.engine.listTargets().filter((r) => !r.main)[0];
      assert.strictEqual(listed.reconnects, 2);
      assert.strictEqual(listed.protocol, 'RTMP');
      assert.strictEqual(ctx.engine.status().apiVersion, 3);
      assert.strictEqual(ctx.engine.capabilities().apiVersion, 3);
      assert.strictEqual(ctx.engine.status().capabilities.apiVersion, 3);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('versions 1 and 2 and a failed or missing probe keep list_targets', async () => {
    const cases = [1, 2, 'fail', 'missing'];
    for (const version of cases) {
      const bag = tempCore();
      try {
        const ctx = make(bag, { reply: replyFor(version) });
        link(ctx.store);
        await ctx.engine.connect();
        const types = typesOf(ctx.connection);
        assert.ok(types.includes('list_targets'), String(version));
        assert.ok(types.includes('get_target_status'), String(version));
        assert.ok(!types.includes('get_snapshot'), String(version));
        const expected = version === 'fail' || version === 'missing' || version === 1 ? 1 : 2;
        assert.strictEqual(ctx.engine.status().apiVersion, expected);
        assert.strictEqual(ctx.engine.capabilities().apiVersion, expected);
        assert.strictEqual(actualOf(ctx.store).engineState, 'stopped');
      } finally {
        rimraf(bag.dir);
      }
    }
  });

  await test('target_state_changed copies reconnects and lastError onto state', async () => {
    const bag = tempCore();
    try {
      const ctx = make(bag, { reply: replyFor(2) });
      link(ctx.store);
      await ctx.engine.connect();
      ctx.connection.emit({ id: 't1', state: 'reconnecting', reconnects: 5, lastError: 'server-refused' });
      if (typeof ctx.bus.flush === 'function') await ctx.bus.flush();
      assert.strictEqual(actualOf(ctx.store).reconnects, 5);
      assert.strictEqual(actualOf(ctx.store).lastError, 'server-refused');
      assert.strictEqual(actualOf(ctx.store).engineState, 'reconnecting');
      ctx.connection.emit({ eventType: 'target_state_changed', eventData: { id: 't1', state: 'live', reconnect_count: 1, last_error_code: -2 } });
      if (typeof ctx.bus.flush === 'function') await ctx.bus.flush();
      assert.strictEqual(actualOf(ctx.store).engineState, 'live');
      assert.strictEqual(actualOf(ctx.store).reconnects, 1);
      assert.strictEqual(actualOf(ctx.store).lastError, 'connect-failed');
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('emergency_stop publishes engine.emergencyStop and refreshes', async () => {
    const bag = tempCore();
    try {
      const ctx = make(bag, {
        reply: replyFor(3, {
          apiVersion: 3,
          observedAt: '2026-10-05T02:00:00.000Z',
          targets: [{ id: 't1', name: 'YouTube', enabled: true, state: 'stopped', reconnects: 0, lastError: null }]
        })
      });
      link(ctx.store);
      await ctx.engine.connect();
      const before = typesOf(ctx.connection).filter((type) => type === 'get_snapshot').length;
      ctx.connection.emit({
        eventType: 'emergency_stop',
        eventData: {
          time: '2026-10-05T02:50:00+09:00',
          stopped_ids: ['t1'],
          count: 1
        }
      });
      await waitUntil(() => typesOf(ctx.connection).filter((type) => type === 'get_snapshot').length >= before + 1, 1000);
      if (typeof ctx.bus.flush === 'function') await ctx.bus.flush();
      const events = ctx.payloads.filter((row) => row.name === EVENTS.ENGINE_EMERGENCY_STOP);
      assert.strictEqual(events.length, 1);
      assert.deepStrictEqual(events[0].payload, { engineId: 'obs-local', at: '2026-10-05T02:50:00+09:00' });
      assert.ok(!typesOf(ctx.connection).includes('list_targets'));
      assert.strictEqual(EVENTS.ENGINE_EMERGENCY_STOP, 'engine.emergencyStop');
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('secret-like fields in snapshot and emergency_stop do not appear in logs or events', async () => {
    const bag = tempCore();
    const secrets = ['w44-stream-key-SECRET', 'w44-password-SECRET', 'w44-token-SECRET'];
    try {
      const ctx = make(bag, {
        reply: replyFor(3, {
          apiVersion: 3,
          observedAt: '2026-10-05T02:00:00.000Z',
          password: secrets[1],
          targets: [{
            id: 't1',
            name: 'YouTube',
            enabled: true,
            state: 'live',
            reconnects: 4,
            lastError: 'token=' + secrets[2],
            service: { type: 'RTMP', server: 'rtmp://example/live', key: secrets[0] },
            streamKey: secrets[0],
            password: secrets[1]
          }]
        })
      });
      link(ctx.store);
      await ctx.engine.connect();
      ctx.connection.emit({
        eventType: 'emergency_stop',
        eventData: {
          time: '2026-10-05T02:50:00+09:00',
          stopped_ids: ['t1'],
          count: 1,
          token: secrets[2],
          key: secrets[0]
        }
      });
      await waitUntil(() => typesOf(ctx.connection).filter((type) => type === 'get_snapshot').length >= 2, 1000);
      if (typeof ctx.bus.flush === 'function') await ctx.bus.flush();
      const dumped = [];
      dumped.push(ctx.logs.join('\n'));
      dumped.push(JSON.stringify(ctx.payloads));
      dumped.push(JSON.stringify(ctx.engine.listTargets()));
      dumped.push(JSON.stringify(ctx.engine.status()));
      function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else dumped.push(fs.readFileSync(full, 'utf8'));
        }
      }
      walk(bag.dir);
      const blob = dumped.join('\n');
      for (const secret of secrets) assert.ok(!blob.includes(secret), secret);
      assert.strictEqual(actualOf(ctx.store).reconnects, 4);
      assert.ok(!actualOf(ctx.store).lastError.includes(secrets[2]));
      const emergency = ctx.payloads.filter((row) => row.name === 'engine.emergencyStop');
      assert.strictEqual(emergency.length, 1);
      assert.deepStrictEqual(Object.keys(emergency[0].payload).sort(), ['at', 'engineId']);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('hub shows the emergency toast from engine.emergencyStop', async () => {
    const hub = hubSource();
    const text = 'OBS \u5074\u3067\u975E\u5E38\u505C\u6B62\u304C\u62BC\u3055\u308C\u307E\u3057\u305F';
    assert.ok(hub.includes(text));
    assert.strictEqual((hub.split('engine-emergency-toast').length - 1) >= 2, true);
    const marker = hub.indexOf('engine.emergencyStop');
    assert.ok(marker >= 0);
  });

  if (failed) {
    console.error('[marust] w44 failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] w44 tests passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
