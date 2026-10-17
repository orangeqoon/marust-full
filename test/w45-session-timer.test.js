'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createSessions } = require('./_k3-parts');
const { createSessionStore } = require('./_k3-parts');
const { createBroadcast } = require('../host/core/engine/broadcast');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w45-'));
  return { dir: dir, core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync } };
}

function fakeConnection() {
  let connected = false;
  let handler = function () { return {}; };
  const handlers = [];
  const conn = {
    async start() {
      connected = true;
      return conn.getStatus();
    },
    stop() { connected = false; },
    setConnected(value) { connected = value === true; },
    getStatus() { return { connected: connected, detail: connected ? 'ok' : 'no' }; },
    onVendorEvent(fn) {
      handlers.push(fn);
      return function () {
        const index = handlers.indexOf(fn);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit(data) {
      handlers.slice().forEach(function (fn) { fn(data); });
    },
    async vendor(_tier, requestType, requestData) {
      return handler(requestType, requestData || {});
    },
    setHandler(fn) { handler = fn; }
  };
  return conn;
}

function target(id, state) {
  return { id: id, name: id, enabled: true, state: state, reconnects: 0, lastError: null };
}

function make(bag) {
  const rows = [];
  const ended = [];
  const bus = createEventBus({ logger: function () {} });
  bus.subscribe(EVENTS.SESSION_ENDED, function (_name, payload) { ended.push(payload); });
  const store = createStateStore({ core: bag.core, bus: bus, logger: function () {} });
  const sessionStore = createSessionStore({ dir: bag.dir });
  const sessions = createSessions({
    store: sessionStore,
    bus: bus,
    recover: false,
    heartbeatMs: 60000,
    setIntervalFn: function () { return { unref: function () {} }; },
    clearIntervalFn: function () {}
  });
  const connection = fakeConnection();
  connection.setHandler(function (type) {
    if (type === 'list_capabilities') return { requests: REQUIRED.map(function (name) { return { name: name }; }) };
    if (type === 'get_api_version') return { apiVersion: 3, pluginVersion: '0.8.0' };
    if (type === 'get_snapshot') {
      return {
        apiVersion: 3,
        observedAt: '2026-10-05T02:00:00.000Z',
        targets: rows.map(function (row) { return Object.assign({}, row); })
      };
    }
    if (type === 'stop_all_targets') {
      rows.forEach(function (row) { row.state = 'stopped'; });
      return { success: true, count: rows.length };
    }
    return { success: true };
  });
  const engine = createObsLocalEngine({
    core: bag.core,
    store: store,
    bus: bus,
    sessions: sessions,
    connection: connection,
    logger: function () {},
    pollMs: 0,
    orchestrator: { modeFor: function () { return 'legacy'; }, dispatchObs: function () { return []; } }
  });
  sessions.attachStreamingProbe(function () { return engine.destinationAggregate(); });
  return { rows: rows, ended: ended, bus: bus, sessions: sessions, connection: connection, engine: engine, store: store };
}

async function sync(ctx, states) {
  ctx.rows.length = 0;
  states.forEach(function (row) { ctx.rows.push(target(row.id, row.state)); });
  await ctx.engine.syncNow('poll');
  await ctx.bus.flush();
}

async function main() {
  await test('successful broadcast.start does not start a session', async function () {
    const bag = tempCore();
    try {
      const bus = createEventBus({ logger: function () {} });
      const store = createStateStore({ core: bag.core, bus: bus, logger: function () {} });
      store.putDestination({
        id: 'yt-main',
        site: 'youtube',
        accountId: 'yt-main',
        enabled: true,
       
        engine: { id: 'obs-local', targetId: 't1' }
      });
      const sessionStore = createSessionStore({ dir: bag.dir });
      const sessions = createSessions({
        store: sessionStore,
        bus: bus,
        recover: false,
        heartbeatMs: 60000,
        setIntervalFn: function () { return { unref: function () {} }; },
        clearIntervalFn: function () {}
      });
      const broadcast = createBroadcast({
        preflight: { run: function () { return { ok: true, items: [] }; } },
        registry: { getRunning: function () { return []; } },
        engines: {
          get: function () {
            return {
              start: function () { return { ok: true }; },
              stop: function () { return { ok: true }; },
              listTargets: function () { return [{ id: 't1', state: 'live' }]; }
            };
          }
        },
        store: store,
        sessions: sessions,
        bus: bus,
        orchestrator: { modeFor: function () { return 'live'; } },
        logger: function () {}
      });
      const result = await broadcast.start({
        destinationIds: ['yt-main'],
        title: 'Tonight',
        category: 'Games',
        confirmed: true
      });
      assert.strictEqual(result.ok, true);
      assert.ok(!('sessionStarted' in result));
      assert.strictEqual(sessions.view().active, false);
      assert.strictEqual(sessionStore.snapshot().session, null);
      sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('streaming then all stopped ends with all-stopped', async function () {
    const bag = tempCore();
    try {
      const ctx = make(bag);
      await ctx.engine.connect();
      await sync(ctx, [{ id: 't1', state: 'live' }, { id: 't2', state: 'stopped' }]);
      assert.strictEqual(ctx.sessions.start({ title: 'live', source: 'manual' }).ok, true);
      await sync(ctx, [{ id: 't1', state: 'stopped' }, { id: 't2', state: 'stopped' }]);
      assert.strictEqual(ctx.sessions.view().active, false);
      assert.strictEqual(ctx.ended.length, 1);
      assert.strictEqual(ctx.ended[0].reason, 'all-stopped');
      assert.strictEqual(ctx.ended[0].state, 'ended');
      ctx.sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('a paused session also ends when everything stops', async function () {
    const bag = tempCore();
    try {
      const ctx = make(bag);
      await ctx.engine.connect();
      await sync(ctx, [{ id: 't1', state: 'live' }]);
      ctx.sessions.start({ title: 'paused', source: 'manual' });
      assert.strictEqual(ctx.sessions.pause().ok, true);
      await sync(ctx, [{ id: 't1', state: 'stopped' }]);
      assert.strictEqual(ctx.sessions.view().active, false);
      assert.strictEqual(ctx.ended.length, 1);
      assert.strictEqual(ctx.ended[0].reason, 'all-stopped');
      ctx.sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('emergency stop that stops everything ends with emergency-stop', async function () {
    const bag = tempCore();
    try {
      const ctx = make(bag);
      await ctx.engine.connect();
      await sync(ctx, [{ id: 't1', state: 'live' }, { id: 't2', state: 'connecting' }]);
      ctx.sessions.start({ title: 'panic', source: 'manual' });
      const stopped = await ctx.engine.emergencyStop();
      assert.strictEqual(stopped.ok, true);
      await ctx.engine.syncNow('poll');
      await ctx.bus.flush();
      assert.strictEqual(ctx.sessions.view().active, false);
      assert.strictEqual(ctx.ended.length, 1);
      assert.strictEqual(ctx.ended[0].reason, 'emergency-stop');
      ctx.sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('OBS emergency_stop that stops everything ends with emergency-stop', async function () {
    const bag = tempCore();
    try {
      const ctx = make(bag);
      await ctx.engine.connect();
      await sync(ctx, [{ id: 't1', state: 'live' }]);
      ctx.sessions.start({ title: 'obs', source: 'manual' });
      ctx.rows[0].state = 'stopped';
      ctx.connection.emit({
        eventType: 'emergency_stop',
        eventData: { time: '2026-10-05T03:00:00Z', stopped_ids: ['t1'], count: 1 }
      });
      const start = Date.now();
      while (ctx.ended.length < 1 && Date.now() - start < 1000) {
        await new Promise(function (resolve) { setTimeout(resolve, 10); });
      }
      await ctx.bus.flush();
      assert.strictEqual(ctx.ended.length, 1);
      assert.strictEqual(ctx.ended[0].reason, 'emergency-stop');
      assert.strictEqual(ctx.sessions.view().active, false);
      ctx.sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('reconnecting or connecting does not end the session', async function () {
    const bag = tempCore();
    try {
      const ctx = make(bag);
      await ctx.engine.connect();
      await sync(ctx, [{ id: 't1', state: 'live' }, { id: 't2', state: 'live' }]);
      ctx.sessions.start({ title: 'retry', source: 'manual' });
      await sync(ctx, [{ id: 't1', state: 'reconnecting' }, { id: 't2', state: 'stopped' }]);
      assert.strictEqual(ctx.sessions.view().active, true);
      assert.strictEqual(ctx.ended.length, 0);
      await sync(ctx, [{ id: 't1', state: 'stopped' }, { id: 't2', state: 'connecting' }]);
      assert.strictEqual(ctx.sessions.view().active, true);
      assert.strictEqual(ctx.ended.length, 0);
      ctx.sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('engine disconnect alone does not end the session', async function () {
    const bag = tempCore();
    try {
      const ctx = make(bag);
      await ctx.engine.connect();
      await sync(ctx, [{ id: 't1', state: 'live' }]);
      ctx.sessions.start({ title: 'drop', source: 'manual' });
      ctx.connection.setConnected(false);
      assert.strictEqual(ctx.sessions.view().active, true);
      ctx.connection.emit({ id: 't1', state: 'stopped' });
      await ctx.bus.flush();
      assert.strictEqual(ctx.sessions.view().active, true);
      assert.strictEqual(ctx.ended.length, 0);
      ctx.sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('a session that has never been streaming does not end', async function () {
    const bag = tempCore();
    try {
      const ctx = make(bag);
      assert.strictEqual(ctx.sessions.start({ title: 'early', source: 'manual' }).ok, true);
      await ctx.engine.connect();
      await sync(ctx, [{ id: 't1', state: 'stopped' }, { id: 't2', state: 'stopped' }]);
      await ctx.engine.syncNow('poll');
      await ctx.bus.flush();
      assert.strictEqual(ctx.sessions.view().active, true);
      assert.strictEqual(ctx.ended.length, 0);
      await sync(ctx, [{ id: 't1', state: 'live' }]);
      assert.strictEqual(ctx.sessions.view().active, true);
      await sync(ctx, [{ id: 't1', state: 'stopped' }]);
      assert.strictEqual(ctx.sessions.view().active, false);
      assert.strictEqual(ctx.ended.length, 1);
      assert.strictEqual(ctx.ended[0].reason, 'all-stopped');
      ctx.sessions.stop();
    } finally {
      rimraf(bag.dir);
    }
  });

  if (failed) {
    console.error('[marust] w45 failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] w45 tests passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
