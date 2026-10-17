'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { createBroadcast, LIVE_WAIT_MS, VERIFY_WAIT_MS, VERIFY_INTERVAL_MS } = require('../host/core/engine/broadcast');
const { createApi } = require('../host/layer1/api');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createSessionStore } = require('./_k3-parts');
const { createSessions } = require('./_k3-parts');
const { createCore } = require('../host/core/core-bridge');
const { EVENTS } = require('../host/core/events');
const { WINDOW_ID } = require('../host/layer1/clients');

const CLI = path.join(__dirname, '..', 'cli', 'marust.js');
const SECRET = 'rk_live_DO_NOT_LEAK_9912';
const SERVER = 'rtmp://slot.example/app';

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

function ops(calls) {
  return calls.map(function (row) { return row.op; }).filter(function (op) {
    return op !== 'poll';
  });
}

function harness(config) {
  const cfg = config || {};
  const calls = [];
  const events = [];
  const logs = [];
  const handlers = [];
  const clock = { t: typeof cfg.time === 'number' ? cfg.time : 0 };
  const bus = {
    publish: function (name, payload, info) {
      events.push({ name: name, payload: payload, info: info || {} });
      const list = handlers.slice();
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].pattern === name || list[i].pattern === '*') list[i].handler(name, payload, info || {});
      }
      return list.length;
    },
    subscribe: function (pattern, handler) {
      const sub = { pattern: pattern, handler: handler };
      handlers.push(sub);
      return function () {
        const index = handlers.indexOf(sub);
        if (index >= 0) handlers.splice(index, 1);
      };
    }
  };
  const slot = {
    prepareBroadcast: cfg.prepare || function (_dest, _session, meta) {
      calls.push({ op: 'prepare', dryRun: meta && meta.dryRun === true });
      if (meta && meta.dryRun === true) return { ok: true, dryRun: true };
      return { ok: true, server: SERVER, key: SECRET, slotId: 'slot-1', reused: false };
    },
    verifyLive: cfg.verify || function (_dest, meta) {
      calls.push({ op: 'verify', dryRun: meta && meta.dryRun === true });
      if (meta && meta.dryRun === true) return { ok: true, dryRun: true };
      return { ok: true, live: true };
    },
    endBroadcast: cfg.end || function (_dest, meta) {
      calls.push({ op: 'end', dryRun: meta && meta.dryRun === true });
      return { ok: true };
    }
  };
  let handed = false;
  const engine = {
    setKey: function (id, settings, flags) {
      calls.push({ op: 'setKey', id: id, restart: !!(flags && flags.restartIfActive === true) });
      if (cfg.onSetKey) return cfg.onSetKey(id, settings, flags, function () { handed = true; });
      handed = !!(settings && settings.key === SECRET && settings.server === SERVER && flags && flags.restartIfActive === false);
      return { ok: true };
    },
    start: function (id) {
      calls.push({ op: 'start', id: id });
      if (cfg.onStart) return cfg.onStart(id);
      return { ok: true };
    },
    stop: function (id) {
      calls.push({ op: 'stop', id: id });
      if (cfg.onStop) return cfg.onStop(id);
      return { ok: true };
    },
    listTargets: function () {
      calls.push({ op: 'poll' });
      if (cfg.targets) return cfg.targets();
      return [
        { id: 't-rumble', state: 'live' },
        { id: 't-yt', state: 'live' }
      ];
    }
  };
  const destinations = cfg.destinations || [{
    id: 'rumble-main',
    site: 'rumble',
    accountId: 'rumble-main',
    engine: { id: 'obs-local', targetId: 't-rumble' },
    enabled: true,
  }];
  let active = cfg.sessionActive === true;
  const sessions = cfg.sessions || {
    start: function (input) {
      calls.push({
        op: 'session',
        source: input && input.source,
        title: input && input.title,
        category: input && input.category
      });
      active = true;
      return { ok: true };
    },
    view: function () {
      return { active: active, title: '', state: active ? 'running' : 'none' };
    }
  };
  const broadcast = createBroadcast({
    preflight: cfg.preflight || {
      run: function (ids) {
        calls.push({ op: 'preflight', ids: ids.slice() });
        return { ok: true, items: [] };
      }
    },
    registry: {
      getRunning: function () {
        if (cfg.slots === null) return [];
        return [{
          id: 'rumble-slot',
          manifest: {
            provides: ['stream.slot@1'],
            slotFor: cfg.slotFor || ['rumble'],
            timeouts: { prepareBroadcast: 5000, verifyLive: 5000, endBroadcast: 5000 }
          },
          instance: slot
        }];
      }
    },
    engines: {
      get: function (id) { return id === 'obs-local' ? engine : null; }
    },
    store: cfg.store || {
      snapshot: function () { return { destinations: destinations, session: null }; }
    },
    sessions: sessions,
    bus: cfg.bus || bus,
    orchestrator: {
      modeFor: function (id) {
        assert.strictEqual(id, 'broadcast');
        return cfg.mode || 'live';
      }
    },
    logger: function (_level, message) { logs.push(String(message)); },
    now: function () { return clock.t; },
    sleep: async function (ms) {
      clock.t += ms;
      if (cfg.onSleep) await cfg.onSleep(ms, clock, bus);
    }
  });
  return { calls: calls, events: events, logs: logs, clock: clock, broadcast: broadcast, handed: function () { return handed; } };
}

function blobOf(parts) {
  return JSON.stringify(parts);
}

function runCli(args, env) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [CLI].concat(args), {
      env: Object.assign({}, process.env, env || {}),
      cwd: path.join(__dirname, '..')
    });
    const out = [];
    const err = [];
    child.stdout.on('data', function (chunk) { out.push(chunk); });
    child.stderr.on('data', function (chunk) { err.push(chunk); });
    child.on('error', reject);
    child.on('close', function (code) {
      resolve({ code: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

function fakeGateway() {
  const seen = [];
  const server = http.createServer(function (_req, res) {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', function (req, socket, head) {
    seen.push({ type: 'upgrade' });
    wss.handleUpgrade(req, socket, head, function (ws) {
      ws.on('message', function (data) {
        const msg = JSON.parse(data.toString());
        seen.push({ type: 'rpc', method: msg.method, params: msg.params || {} });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, items: [] } }));
      });
    });
  });
  return {
    seen: seen,
    listen: function () {
      return new Promise(function (resolve) {
        server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
      });
    },
    close: function () {
      return new Promise(function (resolve) {
        for (const client of wss.clients) {
          try { client.terminate(); } catch (_) { /* already gone */ }
        }
        server.close(function () { resolve(); });
      });
    }
  };
}

async function main() {
  await test('event names are known', async function () {
    assert.strictEqual(EVENTS.BROADCAST_STARTED, 'broadcast.started');
    assert.strictEqual(EVENTS.BROADCAST_RESULT, 'broadcast.result');
    assert.strictEqual(EVENTS.BROADCAST_STOPPED, 'broadcast.stopped');
    const { isKnownEvent } = require('../host/core/events');
    assert.strictEqual(isKnownEvent('broadcast.started'), true);
    assert.strictEqual(isKnownEvent('broadcast.result'), true);
    assert.strictEqual(isKnownEvent('broadcast.stopped'), true);
  });

  await test('steps run in order and broadcast start does not start a session', async function () {
    const world = harness();
    const result = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      category: 'games',
      confirmed: true
    });
    assert.deepStrictEqual(ops(world.calls), ['preflight', 'start', 'verify']);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'session'; }).length, 0);
    assert.strictEqual(result.ok, true);
    assert.ok(!('sessionStarted' in result));
    assert.strictEqual(result.items[0].destinationId, 'rumble-main');
    assert.strictEqual(result.items[0].ok, true);
    assert.strictEqual(world.events[0].name, EVENTS.BROADCAST_STARTED);
    assert.strictEqual(world.events[world.events.length - 1].name, EVENTS.BROADCAST_RESULT);
    assert.strictEqual(world.events[0].info.correlationId, result.correlationId);
    assert.ok(!blobOf(result).includes(SECRET));
  });

  await test('preflight error stops before prepare', async function () {
    const world = harness({
      preflight: {
        run: function () {
          worldCalls.push('preflight');
          return {
            ok: false,
            items: [{ id: 'check', destinationId: 'rumble-main', level: 'error', scope: 'global', code: 'engine-disconnected', message: 'not connected', key: SECRET }]
          };
        }
      }
    });
    const worldCalls = [];
    const result = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'preflight');
    assert.strictEqual(result.items.length, 0);
    assert.ok(!('sessionStarted' in result));
    assert.strictEqual(ops(world.calls).indexOf('prepare'), -1);
    assert.strictEqual(ops(world.calls).indexOf('start'), -1);
    assert.strictEqual(result.preflight.items[0].code, 'engine-disconnected');
    assert.ok(!blobOf({ result: result, events: world.events, logs: world.logs }).includes(SECRET));
    assert.strictEqual(world.events.length, 1);
    assert.strictEqual(world.events[0].name, EVENTS.BROADCAST_RESULT);
    assert.strictEqual(world.events.some(function (row) { return row.name === EVENTS.BROADCAST_STARTED; }), false);
  });

  await test('no destination prepares or sets a key; every enabled destination just starts', async function () {
    const world = harness({
      destinations: [
        { id: 'rumble-main', site: 'rumble', accountId: 'rumble-main', engine: { id: 'obs-local', targetId: 't-rumble' }, enabled: true },
        { id: 'yt-main', site: 'youtube', accountId: 'yt-main', engine: { id: 'obs-local', targetId: 't-yt' }, enabled: true }
      ]
    });
    const result = await world.broadcast.start({
      destinationIds: ['rumble-main', 'yt-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'prepare'; }).length, 0);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'setKey'; }).length, 0);
    const starts = world.calls.filter(function (row) { return row.op === 'start'; });
    assert.deepStrictEqual(starts.map(function (row) { return row.id; }), ['t-rumble', 't-yt']);
  });

  await test('one destination fails without stopping the other and retries once', async function () {
    const world = harness({
      onStart: function (id) { return id === 't-rumble' ? { ok: false, error: 'refused' } : { ok: true }; },
      destinations: [
        { id: 'off-air', site: 'kick', accountId: 'kick', engine: { id: 'obs-local', targetId: 't-kick' }, enabled: false },
        { id: 'rumble-main', site: 'rumble', accountId: 'rumble-main', engine: { id: 'obs-local', targetId: 't-rumble' }, enabled: true },
        { id: 'yt-main', site: 'youtube', accountId: 'yt-main', engine: { id: 'obs-local', targetId: 't-yt' }, enabled: true }
      ]
    });
    const result = await world.broadcast.start({
      destinationIds: ['missing', 'off-air', 'rumble-main', 'yt-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(result.ok, false);
    const byId = {};
    result.items.forEach(function (row) { byId[row.destinationId] = row; });
    assert.strictEqual(byId.missing.ok, false);
    assert.strictEqual(byId.missing.error, 'unknown-destination');
    assert.strictEqual(byId['off-air'].error, 'destination-disabled');
    assert.strictEqual(byId['rumble-main'].step, 'start');
    assert.strictEqual(byId['rumble-main'].error, 'refused');
    assert.strictEqual(byId['yt-main'].ok, true);
    const starts = world.calls.filter(function (row) { return row.op === 'start'; });
    assert.strictEqual(starts.filter(function (row) { return row.id === 't-rumble'; }).length, 2);
    assert.strictEqual(starts.filter(function (row) { return row.id === 't-yt'; }).length, 1);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'session'; }).length, 0);
    assert.ok(!blobOf(result).includes(SECRET));
  });

  await test('live wait times out on a fake clock', async function () {
    const world = harness({
      slots: null,
      targets: function () { return [{ id: 't-yt', state: 'stopped' }]; },
      destinations: [{
        id: 'yt-main',
        site: 'youtube',
        accountId: 'yt-main',
        engine: { id: 'obs-local', targetId: 't-yt' },
        enabled: true,
      }]
    });
    const result = await world.broadcast.start({
      destinationIds: ['yt-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.items[0].step, 'confirm');
    assert.strictEqual(result.items[0].error, 'timeout');
    assert.strictEqual(world.clock.t, LIVE_WAIT_MS * 2);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'start'; }).length, 2);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'verify'; }).length, 0);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'session'; }).length, 0);
  });

  await test('engine.target.changed ends the live wait', async function () {
    let posted = false;
    const world = harness({
      slots: null,
      targets: function () { return [{ id: 't-yt', state: 'stopped' }]; },
      destinations: [{
        id: 'yt-main',
        site: 'youtube',
        accountId: 'yt-main',
        engine: { id: 'obs-local', targetId: 't-yt' },
        enabled: true,
      }],
      onSleep: function (_ms, _clock, bus) {
        if (posted) return;
        posted = true;
        bus.publish(EVENTS.ENGINE_TARGET_CHANGED, { engineId: 'obs-local', targetId: 't-yt', state: 'live' });
      }
    });
    const result = await world.broadcast.start({
      destinationIds: ['yt-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(world.clock.t, 1000);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'start'; }).length, 1);
  });

  await test('verifyLive times out on a fake clock', async function () {
    const world = harness({
      verify: function () {
        world.calls.push({ op: 'verify' });
        return { ok: true, live: false };
      }
    });
    const result = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      confirmed: true
    });
    const verifies = world.calls.filter(function (row) { return row.op === 'verify'; }).length;
    assert.strictEqual(result.items[0].step, 'verify');
    assert.strictEqual(result.items[0].error, 'timeout');
    assert.strictEqual(verifies, Math.ceil(VERIFY_WAIT_MS / VERIFY_INTERVAL_MS) * 2);
    assert.strictEqual(world.clock.t, VERIFY_WAIT_MS * 2);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'session'; }).length, 0);
  });

  await test('stream key stays out of results, events, logs, and state', async function () {
    const real = createCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w6-key-'));
    const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
    const bus = createEventBus({ logger: function () {} });
    const events = [];
    const wrapped = {
      publish: function (name, payload, info) {
        events.push({ name: name, payload: payload, info: info || {} });
        return bus.publish(name, payload, info);
      },
      subscribe: function (pattern, handler) { return bus.subscribe(pattern, handler); }
    };
    const store = createStateStore({ core: core, bus: bus, logger: function () {} });
    store.putDestination({
      id: 'rumble-main',
      site: 'rumble',
      accountId: 'rumble-main',
      engine: { id: 'obs-local', targetId: 't-rumble' },
      enabled: true,
    });
    const sessionStore = createSessionStore({ dir: dir });
    const sessions = createSessions({ store: sessionStore, bus: bus, recover: false, heartbeatMs: 60000 });
    const logs = [];
    let handed = false;
    const world = harness({
      store: store,
      bus: wrapped,
      sessions: sessions,
      preflight: {
        run: function (ids) {
          return {
            ok: true,
            items: [{ id: 'ready', destinationId: ids[0], level: 'ok', code: 'ready', message: 'ready', key: SECRET, server: SERVER }]
          };
        }
      },
      onSetKey: function (_id, settings, flags) {
        handed = settings.key === SECRET && settings.server === SERVER && flags.restartIfActive === false;
        return { ok: true };
      },
      logger: null
    });
    world.broadcast = createBroadcast({
      preflight: {
        run: function (ids) {
          return {
            ok: true,
            items: [{ id: 'ready', destinationId: ids[0], level: 'ok', code: 'ready', message: 'ready', key: SECRET, server: SERVER }]
          };
        }
      },
      registry: {
        getRunning: function () {
          return [{
            id: 'rumble-slot',
            manifest: { provides: ['stream.slot@1'], slotFor: ['rumble'] },
            instance: {
              prepareBroadcast: function () {
                return { ok: true, server: SERVER, key: SECRET, slotId: 'slot-1', reused: false };
              },
              verifyLive: function () { return { ok: true, live: true }; },
              endBroadcast: function () { return { ok: true }; }
            }
          }];
        }
      },
      engines: {
        get: function () {
          return {
            setKey: function (_id, settings, flags) {
              handed = settings.key === SECRET && settings.server === SERVER && flags.restartIfActive === false;
              return { ok: true };
            },
            start: function () { return { ok: true }; },
            stop: function () { return { ok: true }; },
            listTargets: function () { return [{ id: 't-rumble', state: 'live' }]; }
          };
        }
      },
      store: store,
      sessions: sessions,
      bus: wrapped,
      orchestrator: { modeFor: function () { return 'live'; } },
      logger: function (_level, message) { logs.push(String(message)); }
    });
    try {
      const result = await world.broadcast.start({
        destinationIds: ['rumble-main'],
        title: 'Tonight',
        category: 'Games',
        confirmed: true
      });
      assert.strictEqual(result.ok, true);
      assert.ok(!('sessionStarted' in result));
      const status = world.broadcast.status();
      const file = fs.readFileSync(path.join(dir, 'data', 'marust', 'state.json'), 'utf8');
      const packed = blobOf({ result: result, status: status, events: events, logs: logs, file: file, snap: store.snapshot() });
      assert.ok(!packed.includes(SECRET), packed);
      assert.ok(!packed.includes(SERVER), packed);
      assert.strictEqual(sessionStore.snapshot().session, null);
      assert.ok(!('session' in store.snapshot()));
    } finally {
      sessions.stop();
      rimraf(dir);
    }
  });

  await test('legacy does nothing', async function () {
    const world = harness({ mode: 'legacy' });
    const result = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'legacy');
    assert.strictEqual(world.calls.length, 0);
    assert.strictEqual(world.events.length, 0);
    assert.strictEqual(world.logs.length, 0);
    const stopped = await world.broadcast.stop({ destinationIds: ['rumble-main'] });
    assert.strictEqual(stopped.error, 'legacy');
    assert.strictEqual(world.calls.length, 0);
  });

  await test('shadow records a dry run and does not write', async function () {
    const world = harness({ mode: 'shadow' });
    const result = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      category: 'games',
      confirmed: true
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'shadow');
    assert.ok(!('sessionStarted' in result));
    const names = ops(world.calls);
    assert.ok(names.indexOf('verify') !== -1);
    assert.strictEqual(names.indexOf('setKey'), -1);
    assert.strictEqual(names.indexOf('start'), -1);
    assert.strictEqual(names.indexOf('session'), -1);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'verify'; })[0].dryRun, true);
    assert.ok(!blobOf({ result: result, events: world.events, logs: world.logs }).includes(SECRET));
    const stopped = await world.broadcast.stop({ destinationIds: ['rumble-main'] });
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(ops(world.calls).indexOf('stop'), -1);
    assert.strictEqual(world.calls.filter(function (row) { return row.op === 'end'; })[0].dryRun, true);
    assert.strictEqual(world.events.some(function (row) { return row.name === EVENTS.BROADCAST_STOPPED; }), true);
  });

  await test('a second start is busy until the first finishes', async function () {
    let release;
    const gate = new Promise(function (resolve) { release = resolve; });
    const world = harness({
      prepare: function () {
        world.calls.push({ op: 'prepare' });
        return gate.then(function () {
          return { ok: true, server: SERVER, key: SECRET, slotId: 'slot-1', reused: false };
        });
      }
    });
    const first = world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      confirmed: true
    });
    const second = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(second.error, 'busy');
    assert.strictEqual(world.broadcast.status().running, true);
    const stopped = await world.broadcast.stop({ destinationIds: ['rumble-main'] });
    assert.strictEqual(stopped.error, 'busy');
    release();
    const done = await first;
    assert.strictEqual(done.ok, true);
    assert.strictEqual(world.broadcast.status().running, false);
    const third = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(third.ok, true);
  });

  await test('an active session is left alone', async function () {
    let started = 0;
    const world = harness({
      sessions: {
        start: function () { started += 1; return { ok: true }; },
        view: function () { return { active: true, title: 'existing', state: 'running' }; }
      }
    });
    const result = await world.broadcast.start({
      destinationIds: ['rumble-main'],
      title: '今夜',
      confirmed: true
    });
    assert.strictEqual(result.ok, true);
    assert.ok(!('sessionStarted' in result));
    assert.strictEqual(started, 0);
  });

  await test('stop calls the engine and then the slot', async function () {
    const world = harness();
    const result = await world.broadcast.stop({ destinationIds: ['rumble-main', 'missing'] });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(ops(world.calls), ['stop', 'end']);
    assert.strictEqual(world.calls[0].id, 't-rumble');
    assert.strictEqual(result.items[0].ok, true);
    assert.strictEqual(result.items[1].error, 'unknown-destination');
    assert.strictEqual(world.events[0].name, EVENTS.STREAM_STOPPING);
    assert.strictEqual(world.events[0].payload.reason, 'manual');
    assert.strictEqual(world.events[0].info.correlationId, result.correlationId);
    assert.strictEqual(world.events[1].name, EVENTS.BROADCAST_STOPPED);
    assert.ok(!blobOf(result).includes(SECRET));
  });

  await test('start without confirmation does nothing', async function () {
    const world = harness();
    const result = await world.broadcast.start({ destinationIds: ['rumble-main'], title: '今夜' });
    assert.strictEqual(result.error, 'confirm');
    assert.strictEqual(world.calls.length, 0);
    assert.strictEqual(world.events.length, 0);
  });

  await test('api validates params and permissions', async function () {
    let starts = 0;
    let stops = 0;
    const seen = [];
    const api = createApi({
      store: {
        snapshot: function () {
          return {
            destinations: [
              { id: 'rumble-main', site: 'rumble', enabled: true },
              { id: 'off-air', site: 'kick', enabled: false }
            ]
          };
        }
      },
      preflight: {
        run: function (ids) {
          seen.push(ids.slice());
          return { ok: true, items: [{ level: 'ok', code: 'ready', message: 'ready', key: SECRET }] };
        }
      },
      broadcast: {
        start: function (input) { starts += 1; return { ok: true, items: [], confirmed: input.confirmed === true }; },
        stop: function () { stops += 1; return { ok: true, items: [] }; },
        status: function () { return { ok: true, running: false, mode: 'live', last: null, destinations: [] }; }
      },
      getState: function () { return {}; },
      fanout: function () { return { ok: true }; },
      forceLegacy: function () { return { ok: true }; }
    });
    const described = await api.call('api.describe', {});
    const start = described.methods.find(function (row) { return row.method === 'broadcast.start'; });
    const preflight = described.methods.find(function (row) { return row.method === 'broadcast.preflight'; });
    const stop = described.methods.find(function (row) { return row.method === 'broadcast.stop'; });
    const status = described.methods.find(function (row) { return row.method === 'broadcast.status'; });
    assert.strictEqual(start.permission, 'write');
    assert.strictEqual(start.params.destinationIds.type, 'array');
    assert.strictEqual(start.params.destinationIds.required, true);
    assert.strictEqual(start.params.destinationIds.min, 1);
    assert.strictEqual(start.params.destinationIds.max, 20);
    assert.ok(!('title' in start.params) && !('category' in start.params), 'L6b: 題名・カテゴリは受け取らない');
    assert.ok(start.description.length > 0);
    assert.strictEqual(preflight.permission, 'read');
    assert.strictEqual(preflight.params.destinationIds.required, false);
    assert.strictEqual(stop.permission, 'write');
    assert.strictEqual(status.permission, 'read');
    const writeCtx = { permissions: ['read', 'write'], kind: 'native', clientId: 'native-1' };
    const readCtx = { permissions: ['read'], kind: 'native', clientId: 'native-1' };
    assert.strictEqual((await api.call('broadcast.start', {}, writeCtx)).error, 'destination-ids');
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: [] }, writeCtx)).error, 'destination-ids');
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: new Array(21).fill('a') }, writeCtx)).error, 'destination-ids');
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: ['  '] }, writeCtx)).error, 'destination-ids');
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: ['a'.repeat(81)] }, writeCtx)).error, 'destination-ids');
    // L6b: 古い呼び手が title・category を送っても無視する（長さの検査もしない）
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: ['yt'], title: 't'.repeat(201), confirmed: 'yes' }, writeCtx)).error, 'confirmed-type');
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: ['yt'], category: 'c'.repeat(101), confirmed: 'yes' }, writeCtx)).error, 'confirmed-type');
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: ['yt'], confirmed: 'yes' }, writeCtx)).error, 'confirmed-type');
    assert.strictEqual((await api.call('broadcast.start', { destinationIds: ['yt'], confirmed: true }, readCtx)).error, 'forbidden');
    assert.strictEqual(starts, 0);
    const ran = await api.call('broadcast.start', { destinationIds: ['yt'], title: '今夜', confirmed: true }, writeCtx);
    assert.strictEqual(ran.ok, true);
    assert.strictEqual(ran.confirmed, true);
    assert.strictEqual(starts, 1);
    assert.strictEqual((await api.call('broadcast.preflight', { destinationIds: ['rumble-main'] }, readCtx)).ok, true);
    assert.deepStrictEqual(seen[0], ['rumble-main']);
    const all = await api.call('broadcast.preflight', {}, readCtx);
    assert.deepStrictEqual(seen[1], ['rumble-main']);
    assert.ok(!blobOf(all).includes(SECRET));
    assert.strictEqual((await api.call('broadcast.preflight', {}, { permissions: ['write'], kind: 'native', clientId: 'native-1' })).error, 'forbidden');
    assert.strictEqual((await api.call('broadcast.stop', { destinationIds: ['yt'] }, readCtx)).error, 'forbidden');
    assert.strictEqual((await api.call('broadcast.status', {}, readCtx)).ok, true);
    assert.strictEqual(stops, 0);
  });

  await test('requiresApproval queues start and stop', async function () {
    let starts = 0;
    let stops = 0;
    const api = createApi({
      broadcast: {
        start: function () { starts += 1; return { ok: true, items: [{ destinationId: 'yt', ok: true, step: 'done', error: '' }] }; },
        stop: function () { stops += 1; return { ok: true, items: [] }; },
        status: function () { return { ok: true, running: false, mode: 'live', last: null }; }
      },
      preflight: { run: function () { return { ok: true, items: [] }; } },
      getState: function () { return {}; },
      fanout: function () { return { ok: true }; },
      forceLegacy: function () { return { ok: true }; }
    });
    const approvalCtx = { permissions: ['read', 'write'], kind: 'native', clientId: 'native-1', requiresApproval: true };
    const windowCtx = { permissions: ['read', 'write'], kind: 'window', clientId: WINDOW_ID };
    const queued = await api.call('broadcast.start', { destinationIds: ['yt'], title: '今夜', confirmed: true }, approvalCtx);
    assert.strictEqual(queued.pending, true);
    assert.strictEqual(starts, 0);
    const approved = await api.call('approval.approve', { id: queued.approvalId }, windowCtx);
    assert.strictEqual(approved.ok, true);
    assert.strictEqual(approved.result.ok, true);
    assert.strictEqual(starts, 1);
    const halt = await api.call('broadcast.stop', { destinationIds: ['yt'] }, approvalCtx);
    assert.strictEqual(halt.pending, true);
    assert.strictEqual(stops, 0);
    const approvedStop = await api.call('approval.approve', { id: halt.approvalId }, windowCtx);
    assert.strictEqual(approvedStop.ok, true);
    assert.strictEqual(stops, 1);
  });

  await test('cli does not send go or halt without --yes', async function () {
    const fake = fakeGateway();
    const port = await fake.listen();
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w6-cli-'));
    const env = { SCRIPTS_STATE: state };
    try {
      fs.mkdirSync(path.join(state, 'services'), { recursive: true });
      fs.writeFileSync(path.join(state, 'services', 'marust-cli.json'), JSON.stringify({
        token: 'ab'.repeat(32),
        name: 'CLI'
      }));
      const denied = await runCli(['go', 'rumble-main', '--port', String(port)], env);
      assert.notStrictEqual(denied.code, 0);
      assert.ok(denied.stderr.includes('--yes'));
      assert.strictEqual(fake.seen.length, 0);
      const sent = await runCli(['go', 'rumble-main', 'yt-main', '--yes', '--json', '--port', String(port)], env);
      assert.strictEqual(sent.code, 0, sent.stderr);
      const start = fake.seen.find(function (row) { return row.type === 'rpc' && row.method === 'broadcast.start'; });
      assert.ok(start);
      assert.deepStrictEqual(start.params.destinationIds, ['rumble-main', 'yt-main']);
      assert.strictEqual(start.params.confirmed, true);
      const beforeHalt = fake.seen.length;
      const halt = await runCli(['halt', 'rumble-main', '--port', String(port)], env);
      assert.notStrictEqual(halt.code, 0);
      assert.ok(halt.stderr.includes('--yes'));
      assert.strictEqual(fake.seen.length, beforeHalt);
      const checked = await runCli(['preflight', 'rumble-main', '--json', '--port', String(port)], env);
      assert.strictEqual(checked.code, 0, checked.stderr);
      const flight = fake.seen.find(function (row) { return row.type === 'rpc' && row.method === 'broadcast.preflight'; });
      assert.deepStrictEqual(flight.params.destinationIds, ['rumble-main']);
    } finally {
      await fake.close();
      rimraf(state);
    }
  });

  await test('the hub panel is wired for broadcast', async function () {
    const hub = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'panels', 'destinations.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'panels', 'home.js'), 'utf8');
    const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'default-layout.json'), 'utf8'));
    const css = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'hub.css'), 'utf8');
    // 配信開始・停止は配信先パネルの先頭に入った（別のタブではない。W68）
    assert.ok(layout.panels.indexOf('broadcast') === -1);
    assert.ok(hub.includes('STR.sendNone'));
    assert.ok(hub.includes('STR.homeStartConfirm'));
    assert.ok(hub.includes("call('broadcast.start'"));
    assert.ok(hub.includes("call('broadcast.stop'"));
    assert.ok(hub.includes("call('engine.start'") && hub.includes("call('engine.stop'"), '結びつきのない配信先は engine で');
    assert.ok(css.includes('.broadcast-ok'));
    assert.ok(css.includes('.broadcast-ng'));
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w6-broadcast ok');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
