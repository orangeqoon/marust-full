'use strict';

// L6b: セッションと desired（出したいか）・題名・カテゴリを核から外した。
// 核の合図は broadcast.started（配信を始めた）と broadcast.stopped の all（全部止めた）だけ。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createPreflight } = require('../host/core/engine/preflight');
const { createBroadcast } = require('../host/core/engine/broadcast');
const { EVENTS } = require('../host/core/events');
const { sessionPlugin } = require('./_k3-parts');

const ROOT = path.join(__dirname, '..');
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

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'test') return;
      walk(full, out);
    } else if (/\.js$/.test(ent.name)) out.push(full);
  });
  return out;
}

async function main() {
  await test('作者の今の形の state.json を読んでも壊れず、保存し直すと session・desired・題名の actual が消える', function () {
    const real = createCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l6b-'));
    try {
      const file = path.join(dir, 'data', 'marust', 'state.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        destinations: [
          { id: 'nico', site: 'niconico', accountId: 'nico', enabled: true, keyPolicy: 'static', desired: { title: 'DESIRED-T', category: 'DESIRED-C', live: true }, engine: { id: 'obs-local', targetId: 't1' }, actual: { engineState: 'live', siteLive: true, title: 'ACTUAL-T', category: 'ACTUAL-C', lastError: '', updatedAt: null, observed: {} } },
          { id: 'yt', site: 'youtube', accountId: 'yt', enabled: false, desired: { live: false }, engine: null, actual: {} }
        ],
        session: { id: 's-1', title: 'SESSION-T', state: 'running' }
      }));
      const store = createStateStore({ core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync }, bus: createEventBus(), logger: function () {} });
      const snap = store.snapshot();
      assert.deepStrictEqual(snap.destinations.map((r) => r.id), ['nico', 'yt']);
      assert.ok(!('session' in snap));
      assert.strictEqual(typeof store.setSession, 'undefined');
      snap.destinations.forEach((r) => {
        assert.ok(!('desired' in r), r.id);
        assert.ok(!('title' in r.actual) && !('category' in r.actual), r.id);
      });
      assert.strictEqual(snap.destinations[0].actual.engineState, 'live');
      assert.strictEqual(snap.destinations[0].actual.siteLive, true);
      assert.deepStrictEqual(snap.destinations[0].engine, { id: 'obs-local', targetId: 't1' });
      store.putDestination({ id: 'nico', enabled: false, desired: { title: 'NEW' }, actual: { title: 'NEW-A' } });
      const saved = fs.readFileSync(file, 'utf8');
      assert.ok(!/desired|"session"|DESIRED|ACTUAL-T|SESSION-T|NEW/.test(saved), saved);
      assert.ok(saved.indexOf('"nico"') !== -1 && saved.indexOf('"yt"') !== -1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('broadcast.start に title を渡しても核は覚えず、返す形・合図に題名と sessionStarted が無い', async function () {
    const events = [];
    const engine = {
      modeId: 'obs-engine',
      status: function () { return { connected: true, supported: true, mode: 'live', missing: [] }; },
      listTargets: function () { return [{ id: 'ta', state: 'live' }]; },
      start: function () { return { ok: true }; },
      stop: function () { return { ok: true }; }
    };
    const engines = { get: function (id) { return id === 'obs' ? engine : null; }, list: function () { return ['obs']; } };
    const store = { snapshot: function () { return { destinations: [{ id: 'A', site: 'youtube', enabled: true, engine: { id: 'obs', targetId: 'ta' } }] }; } };
    const orchestrator = { modeFor: function () { return 'live'; } };
    const registry = { getRunning: function () { return []; }, snapshot: function () { return []; } };
    const pf = createPreflight({ registry: registry, engines: engines, store: store, secrets: { describe: function () { return Promise.resolve({ ok: true }); } }, orchestrator: orchestrator });
    const clock = { t: 0 };
    const broadcast = createBroadcast({
      preflight: pf, registry: registry, engines: engines, store: store,
      bus: { publish: function (name, payload) { events.push({ name: name, payload: payload }); return 0; }, subscribe: function () { return function () {}; } },
      orchestrator: orchestrator, logger: function () {},
      now: function () { return clock.t; }, sleep: async function (ms) { clock.t += ms; }
    });
    const r = await broadcast.start({ destinationIds: ['A'], title: 'SECRET-TITLE', category: 'SECRET-CAT', confirmed: true });
    assert.strictEqual(r.ok, true);
    assert.ok(!('sessionStarted' in r));
    assert.ok(!JSON.stringify(events).includes('SECRET'));
    assert.ok(events.some((e) => e.name === EVENTS.BROADCAST_STARTED));
    events.forEach((e) => assert.ok(!('sessionStarted' in e.payload) && !('title' in e.payload), e.name));
    assert.ok(!JSON.stringify(broadcast.status()).includes('SECRET'));
  });

  await test('「配信を始めた」「全部止めた」の合図でセッションのプラグインが記録を始め、終える', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l6b-sess-'));
    try {
      const bus = createEventBus();
      const seen = [];
      const ctx = {
        dataDir: dir,
        events: { NAMES: EVENTS },
        bus: {
          publish: function (name, payload) { seen.push(name); return bus.publish(name, payload); },
          subscribe: function () { return function () {}; }
        },
        api: { register: function () {} },
        destinations: { aggregate: function () { return { known: false, streaming: false }; } }
      };
      sessionPlugin.load(ctx);
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'session', 'manifest.json'), 'utf8'));
      assert.deepStrictEqual(manifest.subscribes.slice().sort(), ['broadcast.started', 'broadcast.stopped']);
      assert.strictEqual(sessionPlugin.controller.view().active, false);
      sessionPlugin.onEvent('broadcast.started', { destinationIds: ['A'], mode: 'live' });
      assert.strictEqual(sessionPlugin.controller.view().active, true);
      // 個別に止めた合図（all なし）では終えない
      sessionPlugin.onEvent('broadcast.stopped', { ok: true, destinationIds: ['A'] });
      assert.strictEqual(sessionPlugin.controller.view().active, true);
      sessionPlugin.onEvent('broadcast.stopped', { ok: true, all: true });
      assert.strictEqual(sessionPlugin.controller.view().active, false);
      assert.ok(seen.includes(EVENTS.SESSION_STARTED) && seen.includes(EVENTS.SESSION_ENDED));
      // 保存はプラグイン自身の 1 か所
      assert.ok(fs.existsSync(path.join(dir, 'session.json')));
      sessionPlugin.destroy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('本体（host/）に desired・setSession・sessionStarted が残っていない（legacy-drop の行は除く）', function () {
    const hits = [];
    walk(path.join(ROOT, 'host'), []).forEach((file) => {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (line.indexOf('legacy-drop') !== -1) return;
        if (/desired|setSession|sessionStarted/.test(line)) hits.push(path.relative(ROOT, file) + ':' + (i + 1));
      });
    });
    assert.deepStrictEqual(hits, []);
  });

  if (failed) {
    console.error('[marust] l6b tests failed: ' + failed);
    process.exit(1);
  }
  console.log('[marust] l6b tests passed');
}

main();
