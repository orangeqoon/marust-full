'use strict';

// L3a: 一部がだめでも残りを出す（核）・送信中と配信中を分ける。
// ext-receiver の「siteLive だけの行は送信中に数えない」は w10-ext-receiver.test.js（siteonly-main）で見る。

const assert = require('assert');
const { createPreflight } = require('../host/core/engine/preflight');
const { createBroadcast, sanitizePreflight } = require('../host/core/engine/broadcast');
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

function dests() {
  return [
    { id: 'A', site: 'youtube', enabled: true, engine: { id: 'obs', targetId: 'ta' } },
    { id: 'B', site: 'youtube', enabled: true, engine: { id: 'obs', targetId: 'tb' } }
  ];
}

function world(opts) {
  const cfg = opts || {};
  const calls = [];
  const events = [];
  const engine = {
    modeId: 'obs-engine',
    status: function () { return { connected: cfg.connected !== false, supported: true, mode: 'live', missing: [] }; },
    listTargets: function () {
      const rows = [{ id: 'tb', state: 'live' }, { id: 'ta', state: 'live' }];
      return cfg.missingA ? rows.filter(function (r) { return r.id !== 'ta'; }) : rows;
    },
    start: function (id) {
      calls.push('start:' + id);
      return cfg.failStart === id ? { ok: false, error: 'boom' } : { ok: true };
    },
    stop: function (id) { calls.push('stop:' + id); return { ok: true }; }
  };
  const engines = {
    get: function (id) { return id === 'obs' ? engine : null; },
    list: function () { return ['obs']; }
  };
  const store = { snapshot: function () { return { destinations: dests() }; } };
  const orchestrator = { modeFor: function () { return 'live'; } };
  const registry = { getRunning: function () { return []; }, snapshot: function () { return []; } };
  const secrets = { describe: function () { return Promise.resolve({ ok: true }); } };
  const pf = createPreflight({ registry: registry, engines: engines, store: store, secrets: secrets, orchestrator: orchestrator });
  const clock = { t: 0 };
  const broadcast = createBroadcast({
    preflight: cfg.preflight || pf,
    registry: registry,
    engines: engines,
    store: store,
    sessions: { start: function () { return { ok: true }; }, view: function () { return { active: false }; } },
    bus: {
      publish: function (name) { events.push(name); return 0; },
      subscribe: function () { return function () {}; }
    },
    orchestrator: orchestrator,
    logger: function () {},
    now: function () { return clock.t; },
    sleep: async function (ms) { clock.t += ms; }
  });
  return { pf: pf, broadcast: broadcast, calls: calls, events: events };
}

const GO = { destinationIds: ['A', 'B'], title: 't', category: 'c', confirmed: true };

async function main() {
  await test('preflight: disconnected engine is one global item', async function () {
    const w = world({ connected: false });
    const r = await w.pf.run(['A', 'B']);
    const rows = r.items.filter(function (i) { return i.code === 'engine-disconnected'; });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].scope, 'global');
    assert.strictEqual(rows[0].destinationId, undefined);
    assert.strictEqual(r.globalOk, false);
    assert.strictEqual(r.ok, false);
  });

  await test('preflight: target-missing blocks only that destination', async function () {
    const w = world({ missingA: true });
    const r = await w.pf.run(['A', 'B']);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.globalOk, true);
    assert.deepStrictEqual(r.blocked, ['A']);
    const row = r.items.find(function (i) { return i.code === 'target-missing'; });
    assert.strictEqual(row.scope, 'destination');
  });

  await test('start: blocked destination is skipped, the rest start', async function () {
    const w = world({ missingA: true });
    const r = await w.broadcast.start(GO);
    assert.deepStrictEqual(w.calls, ['start:tb']);
    assert.strictEqual(r.error, '');
    assert.deepStrictEqual(r.skipped, ['A']);
    assert.strictEqual(r.items.length, 2);
    assert.deepStrictEqual(
      { ok: r.items[0].ok, step: r.items[0].step, error: r.items[0].error },
      { ok: false, step: 'preflight', error: 'target-missing' }
    );
    assert.strictEqual(r.items[1].ok, true);
    assert.strictEqual(w.events.filter(function (n) { return n === EVENTS.BROADCAST_STARTED; }).length, 1);
  });

  await test('start: global error stops everything', async function () {
    const w = world({ connected: false });
    const r = await w.broadcast.start(GO);
    assert.strictEqual(w.calls.length, 0);
    assert.strictEqual(r.error, 'preflight');
  });

  await test('start: all blocked gives preflight error', async function () {
    const pf = {
      run: function () {
        return {
          ok: false,
          items: [
            { id: 'x1', level: 'error', code: 'target-missing', destinationId: 'A', message: '', scope: 'destination' },
            { id: 'x2', level: 'error', code: 'destination-disabled', destinationId: 'B', message: '', scope: 'destination' }
          ]
        };
      }
    };
    const w = world({ preflight: pf });
    const r = await w.broadcast.start(GO);
    assert.strictEqual(r.error, 'preflight');
    assert.strictEqual(w.calls.length, 0);
    assert.deepStrictEqual(r.skipped, ['A', 'B']);
    assert.strictEqual(w.events.indexOf(EVENTS.BROADCAST_STARTED), -1);
  });

  await test('start: a failure does not roll back the others', async function () {
    const w = world({ failStart: 'tb' });
    const r = await w.broadcast.start(GO);
    assert.strictEqual(r.error, '');
    assert.strictEqual(r.items[0].ok, true);
    assert.strictEqual(r.items[1].ok, false);
    assert.strictEqual(w.calls.filter(function (c) { return c.indexOf('stop:') === 0; }).length, 0);
  });

  await test('sanitizePreflight does not trust globalOk', function () {
    const r = sanitizePreflight({
      ok: true,
      globalOk: true,
      blocked: [],
      items: [{ id: 'g', level: 'error', code: 'engine-disconnected', scope: 'global' }]
    });
    assert.strictEqual(r.globalOk, false);
    const n = sanitizePreflight(null);
    assert.strictEqual(n.globalOk, false);
    assert.deepStrictEqual(n.blocked, []);
    assert.strictEqual(n.items[0].scope, 'global');
  });

  await test('destination.list: siteLive without engineState', async function () {
    const api = createApi({
      store: { snapshot: function () { return { destinations: [{ id: 'A', site: 's', actual: { siteLive: true } }] }; } }
    });
    const res = await api.call('destination.list', {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.destinations[0].status, '');
    assert.strictEqual(res.destinations[0].siteLive, true);
  });

  if (failed) process.exit(1);
}

main();
