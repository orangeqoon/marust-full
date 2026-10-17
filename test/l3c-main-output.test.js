'use strict';

/**
 * 計画 L 段 L3c: メイン出力（OBS が自分の設定で持つ配信の出力）を配信先の 1 つにする（核の側）。
 * 偽の OBS（l1-stop-all の作り方）で、特別なターゲット main・destination.setMain・配信開始・配信前チェック・全部止めるを確かめる。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createObsLocalEngine, REQUIRED } = require('../host/core/engine/obs-local');
const { createBroadcast } = require('../host/core/engine/broadcast');
const { createPreflight } = require('../host/core/engine/preflight');
const { createApi } = require('../host/layer1/api');
const { createStateStore } = require('../host/core/state-store');
const { createCore } = require('../host/core/core-bridge');
const { WINDOW_ID } = require('../host/layer1/clients');

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

// 偽の OBS。StartStream / StopStream と vendor の呼び出しを数える。stickyMain なら StopStream しても止まらない。
function makeWorld(options) {
  const opt = options || {};
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l3c-'));
  const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
  const store = createStateStore({ core, logger: () => {} });
  let outputActive = opt.outputActive === true;
  const calls = { startStream: 0, stopStream: 0, vendor: [] };
  let handler = null;
  const targets = [{ id: 't1', name: 'T1', state: 'stopped' }];
  const connection = {
    start: async () => ({ connected: true }),
    reconnect: async () => ({ connected: true }),
    stop: () => {},
    getStatus: () => ({ connected: opt.connected !== false }),
    call: (method) => {
      if (method === 'GetStreamStatus') return Promise.resolve({ outputActive, outputReconnecting: false });
      return Promise.resolve({});
    },
    controlStream: (cmd) => {
      if (cmd === 'start') { calls.startStream += 1; outputActive = true; }
      if (cmd === 'stop') { calls.stopStream += 1; if (!opt.stickyMain) outputActive = false; }
      return Promise.resolve();
    },
    vendor: (tier, type, data) => {
      calls.vendor.push(type + ':' + (data && data.id != null ? data.id : ''));
      if (type === 'list_capabilities') return Promise.resolve({ requests: REQUIRED.slice() });
      if (type === 'get_api_version') return Promise.resolve({ apiVersion: 1 });
      if (type === 'list_targets') {
        return Promise.resolve({ targets: targets.map((t) => ({ id: t.id, name: t.name, protocol: 'RTMP', state: t.state, enabled: true })) });
      }
      if (type === 'get_target_status') {
        const t = targets.find((row) => row.id === (data && data.id));
        return Promise.resolve(t ? { id: t.id, state: t.state } : { error: 'target_not_found' });
      }
      if (type === 'start_target') {
        const t = targets.find((row) => row.id === data.id);
        if (t) {
          t.state = 'live';
          // 本物の OBS は状態の変化を vendor イベントで知らせる
          if (handler) handler({ id: t.id, name: t.name, protocol: 'RTMP', state: 'live', enabled: true });
        }
        return Promise.resolve({ success: true });
      }
      if (type === 'stop_all_targets') {
        targets.forEach((t) => { t.state = 'stopped'; });
        return Promise.resolve({ success: true, count: targets.length });
      }
      return Promise.resolve({ success: true });
    },
    onVendorEvent: (fn) => { handler = fn; }
  };
  const engine = createObsLocalEngine({
    connection,
    store,
    orchestrator: { modeFor: () => opt.mode || 'live' },
    bus: { publish: () => {}, subscribe: () => () => {} },
    sleep: async () => {},
    pollMs: 0,
    stopVerifyTries: 2,
    stopVerifyMs: 0
  });
  const registry = {
    get: (id) => (id === 'obs-local' ? engine : null),
    getRunning: () => [],
    snapshot: () => []
  };
  const api = createApi({ registry, store, engine });
  const ctx = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  return {
    dir, store, engine, registry, api, calls, connection, targets,
    call: (method, params) => api.call(method, params || {}, ctx),
    setOutput: (v) => { outputActive = v; },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

async function ready(world) {
  await world.engine.connect();
  await world.engine.whenReady();
}

async function main() {
  await test('listTargets の先頭は main。GetStreamStatus が active なら live、でなければ idle', async () => {
    const a = makeWorld({ outputActive: true });
    const b = makeWorld({ outputActive: false });
    try {
      await ready(a);
      await ready(b);
      const rowsA = a.engine.listTargets();
      assert.strictEqual(rowsA[0].id, 'main');
      assert.strictEqual(rowsA[0].main, true);
      assert.strictEqual(rowsA[0].state, 'live');
      assert.strictEqual(rowsA[0].name, 'メイン出力');
      assert.strictEqual(rowsA[1].id, 't1');
      assert.strictEqual(b.engine.listTargets()[0].state, 'idle');
    } finally { a.cleanup(); b.cleanup(); }
  });

  await test('未接続のときは main の行を出さない', async () => {
    const w = makeWorld({ connected: false });
    try {
      await ready(w);
      assert.strictEqual(w.engine.listTargets().some((row) => row.id === 'main'), false);
    } finally { w.cleanup(); }
  });

  await test('start(main) は StartStream を 1 回、stop(main) は StopStream を 1 回。vendor の start_target などは呼ばない', async () => {
    const w = makeWorld();
    try {
      await ready(w);
      const before = w.calls.vendor.length;
      assert.deepStrictEqual(await w.engine.start('main'), { ok: true });
      assert.strictEqual(w.calls.startStream, 1);
      assert.strictEqual(w.engine.listTargets()[0].state, 'live');
      assert.deepStrictEqual(await w.engine.stop('main'), { ok: true });
      assert.strictEqual(w.calls.stopStream, 1);
      assert.strictEqual(w.engine.listTargets()[0].state, 'idle');
      const sent = w.calls.vendor.slice(before).filter((row) => /^(start_target|stop_target|set_|create_|delete_)/.test(row));
      assert.deepStrictEqual(sent, []);
    } finally { w.cleanup(); }
  });

  await test('setKey・setEnabled・remove は main-output で断り、OBS に何も送らない', async () => {
    const w = makeWorld();
    try {
      await ready(w);
      const before = w.calls.vendor.length;
      assert.deepStrictEqual(await w.engine.setKey('main', { server: 's', key: 'k' }), { ok: false, error: 'main-output' });
      assert.deepStrictEqual(await w.engine.setEnabled('main', true), { ok: false, error: 'main-output' });
      assert.deepStrictEqual(await w.engine.remove('main'), { ok: false, error: 'main-output' });
      assert.strictEqual(w.calls.vendor.length, before);
      assert.strictEqual(w.calls.startStream + w.calls.stopStream, 0);
    } finally { w.cleanup(); }
  });

  await test('destination.setMain: 行ができて list に main:true で出る。use:false で enabled:false、site は残る', async () => {
    const w = makeWorld();
    try {
      await ready(w);
      const made = await w.call('destination.setMain', { use: true, site: 'x' });
      assert.deepStrictEqual(made, { ok: true, destination: { id: 'obs-main', site: 'x', enabled: true } });
      const row = w.store.snapshot().destinations.find((item) => item.id === 'obs-main');
      assert.deepStrictEqual(row.engine, { id: 'obs-local', targetId: 'main' });
      assert.strictEqual(row.accountId, 'obs-main');
      assert.strictEqual(row.enabled, true);
      const list = await w.call('destination.list');
      const listed = list.destinations.find((item) => item.id === 'obs-main');
      assert.strictEqual(listed.main, true);
      assert.strictEqual(listed.site, 'x');
      list.destinations.filter((item) => item.id !== 'obs-main').forEach((item) => assert.strictEqual('main' in item, false));
      const off = await w.call('destination.setMain', { use: false, site: 'x' });
      assert.deepStrictEqual(off, { ok: true, destination: { id: 'obs-main', site: 'x', enabled: false } });
      const kept = w.store.snapshot().destinations.find((item) => item.id === 'obs-main');
      assert.strictEqual(kept.enabled, false);
      assert.strictEqual(kept.site, 'x');
    } finally { w.cleanup(); }
  });

  await test('destination.setMain: use:false で行が無ければ何もしないで ok。送信中は streaming で断る', async () => {
    const w = makeWorld();
    try {
      await ready(w);
      const none = await w.call('destination.setMain', { use: false });
      assert.strictEqual(none.ok, true);
      assert.strictEqual(w.store.snapshot().destinations.length, 0);
      await w.call('destination.setMain', { use: true, site: 'x' });
      w.setOutput(true);
      await w.engine.syncNow('test');
      assert.deepStrictEqual(await w.call('destination.setMain', { use: false }), { ok: false, error: 'streaming' });
      assert.deepStrictEqual(await w.call('destination.setMain', { use: true, site: 'y' }), { ok: false, error: 'streaming' });
      assert.strictEqual(w.store.snapshot().destinations[0].site, 'x');
    } finally { w.cleanup(); }
  });

  function makeBroadcast(w, preflight) {
    return createBroadcast({
      preflight,
      registry: w.registry,
      engines: { get: (id) => w.registry.get(id) },
      store: w.store,
      sessions: { view: () => ({ active: false }), start: () => ({ ok: true }), end: () => ({ ok: true }) },
      bus: { publish: () => {}, subscribe: () => () => {} },
      orchestrator: { modeFor: () => 'live' },
      now: () => Date.now(),
      sleep: async () => {}
    });
  }

  function preflightOf(w) {
    return createPreflight({
      registry: w.registry,
      engines: { get: (id) => w.registry.get(id), list: () => ['obs-local'] },
      store: w.store,
      secrets: { describe: () => Promise.resolve({ ok: true }), get: () => Promise.resolve({ ok: true }) },
      orchestrator: { modeFor: () => 'live' }
    });
  }

  await test('broadcast.start に obs-main とふつうの配信先を渡すと、StartStream と start_target が両方呼ばれて両方 ok', async () => {
    const w = makeWorld();
    try {
      await ready(w);
      w.store.putDestination({ id: 'd1', site: '', accountId: 'd1', engine: { id: 'obs-local', targetId: 't1' }, enabled: true });
      await w.call('destination.setMain', { use: true, site: '' });
      const ids = w.store.snapshot().destinations.filter((row) => row.enabled === true).map((row) => row.id);
      assert.deepStrictEqual(ids.slice().sort(), ['d1', 'obs-main']);
      const broadcast = makeBroadcast(w, { run: () => ({ ok: true, items: [] }) });
      const result = await broadcast.start({ destinationIds: ['obs-main', 'd1'], confirmed: true });
      assert.deepStrictEqual(result.items.map((row) => [row.destinationId, row.ok]), [['obs-main', true], ['d1', true]]);
      assert.strictEqual(w.calls.startStream, 1);
      assert.ok(w.calls.vendor.indexOf('start_target:t1') !== -1);
      assert.ok(w.calls.vendor.indexOf('start_target:main') === -1);
    } finally { w.cleanup(); }
  });

  await test('preflight: obs-main は target-missing にならない。OBS 未接続なら global の engine-disconnected', async () => {
    const w = makeWorld();
    const off = makeWorld({ connected: false });
    try {
      await ready(w);
      await ready(off);
      await w.call('destination.setMain', { use: true });
      await off.call('destination.setMain', { use: true });
      const report = await preflightOf(w).run(['obs-main']);
      assert.strictEqual(report.items.some((item) => item.code === 'target-missing'), false);
      assert.strictEqual(report.items.some((item) => item.level === 'error'), false);
      const down = await preflightOf(off).run(['obs-main']);
      const item = down.items.find((row) => row.code === 'engine-disconnected');
      assert.ok(item);
      assert.strictEqual(item.scope, 'global');
    } finally { w.cleanup(); off.cleanup(); }
  });

  await test('モードの門: legacy は read-only、shadow は dryRun:true で StartStream を呼ばない。live は呼ぶ', async () => {
    const legacy = makeWorld({ mode: 'legacy' });
    const shadow = makeWorld({ mode: 'shadow' });
    const live = makeWorld({ mode: 'live' });
    try {
      for (const w of [legacy, shadow, live]) await ready(w);
      assert.deepStrictEqual(await legacy.engine.start('main'), { ok: false, error: 'read-only' });
      assert.deepStrictEqual(await legacy.engine.stop('main'), { ok: false, error: 'read-only' });
      assert.deepStrictEqual(await shadow.engine.start('main'), { ok: true, dryRun: true });
      assert.strictEqual(legacy.calls.startStream + legacy.calls.stopStream + shadow.calls.startStream + shadow.calls.stopStream, 0);
      assert.deepStrictEqual(await live.engine.start('main'), { ok: true });
      assert.strictEqual(live.calls.startStream, 1);
    } finally { legacy.cleanup(); shadow.cleanup(); live.cleanup(); }
  });

  await test('stopAll: targetsStillActive に main が入らない（メイン出力が止まらないときは mainStillActive:true）', async () => {
    const w = makeWorld({ outputActive: true, stickyMain: true });
    try {
      await ready(w);
      const result = await w.engine.stopAll();
      assert.strictEqual(result.mainStillActive, true);
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.targetsStillActive, []);
      assert.strictEqual(w.calls.vendor.some((row) => /:main$/.test(row) && /^(stop_|start_)/.test(row)), false);
    } finally { w.cleanup(); }
  });

  if (failed) {
    console.error('[marust] l3c main output tests failed: ' + failed);
    process.exit(1);
  }
  console.log('[marust] l3c main output tests passed');
}

main();
