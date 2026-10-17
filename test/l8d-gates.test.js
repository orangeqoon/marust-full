'use strict';
require('./_ui-inline');

/**
 * L8d: 出どころ別・力別の線引きをやめる（直す所 30）。
 * 検査項目:
 * 1. 外から入れたプラグインにも ctx.core・api の名前空間が渡る
 * 2. 三層目（外から・作者用・一覧に無い builtin）は配信を始められない（layer3-no-start）、止めることはできる
 * 3. 二層目は始められる
 * 4. 全部止めるの最中の start は断る（どの層でも stopping）
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRegistry } = require('../host/layer1/plugin-registry');
const { createBroadcast } = require('../host/core/engine/broadcast');
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

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function pluginSrc(mark) {
  return [
    'const fs = require("fs");',
    'const M = ' + JSON.stringify(mark) + ';',
    'fs.appendFileSync(M, "required\\n");',
    'let ctxSeen = null;',
    'let regResult = null;',
    'module.exports = {',
    '  load(ctx) {',
    '    ctxSeen = ctx;',
    '    fs.appendFileSync(M, "load\\n");',
    '    if (ctx.api && typeof ctx.api.register === "function") {',
    '      regResult = ctx.api.register("extsample.ping", () => ({ ok: true }), { access: "read" });',
    '    }',
    '  },',
    '  start() { fs.appendFileSync(M, "start\\n"); },',
    '  stop() { fs.appendFileSync(M, "stop\\n"); },',
    '  destroy() { fs.appendFileSync(M, "destroy\\n"); },',
    '  get ctxSeen() { return ctxSeen; },',
    '  get regResult() { return regResult; }',
    '};'
  ].join('\n');
}

function manifestOf(id, extra) {
  return Object.assign({
    id,
    name: id,
    version: '1.0.0',
    manifestVersion: 2,
    runtime: 'inproc',
    main: 'index.js',
    kind: 'integration'
  }, extra || {});
}

function mkWorld(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l8d-reg-'));
  const builtin = path.join(root, 'builtin');
  const author = path.join(root, 'author');
  const external = path.join(root, 'state', 'plugins');
  const community = path.join(root, 'community');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(author, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  fs.mkdirSync(community, { recursive: true });
  const modes = {};
  const o = over || {};
  let stoppingFlag = false;
  const calls = [];
  const events = [];
  const bus = {
    publish: (name, payload, info) => events.push({ name, payload, info: info || {} }),
    subscribe: (pattern, handler) => {
      return () => {};
    }
  };
  const apiMethods = {
    'broadcast.start': async () => ({ ok: true, via: 'api-broadcast-start' }),
    'broadcast.stop': async () => ({ ok: true, via: 'api-broadcast-stop' }),
    'engine.start': async () => ({ ok: true, via: 'api-engine-start' }),
    'destination.start': async () => ({ ok: true, via: 'api-destination-start' }),
    'destination.setMain': async () => ({ ok: true, via: 'api-destination-setMain' })
  };
  const apiBind = {
    callAs: async (actor, method, params) => {
      calls.push({ actor, method, params });
      if (apiMethods[method]) return apiMethods[method](params);
      return { ok: true, method };
    },
    registerPluginMethod: () => ({ ok: true }),
    unregisterPlugin: () => {}
  };
  const registry = createRegistry(Object.assign({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: builtin,
    authorRoot: author,
    externalRoot: external,
    communityRoot: community,
    bus,
    obsRead: async () => ({ outputActive: true }),
    obsControl: async (action) => {
      calls.push({ op: 'obsControl', action });
      return { ok: true };
    },
    modeFor: (id) => modes[id] || 'live',
    isStopping: () => stoppingFlag
  }, o.registry || {}));

  registry.attachApi(apiBind);

  const mark = (id) => path.join(root, id + '.marks');
  const put = (where, id, manifest, extraFiles) => {
    const dir = path.join(where, id);
    writeJson(path.join(dir, 'manifest.json'), manifest || manifestOf(id));
    fs.writeFileSync(path.join(dir, 'index.js'), pluginSrc(mark(id)));
    Object.keys(extraFiles || {}).forEach((f) => {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), extraFiles[f]);
    });
    return dir;
  };

  return {
    root,
    builtin,
    author,
    external,
    community,
    modes,
    calls,
    events,
    registry,
    apiMethods,
    put,
    setStopping: (v) => { stoppingFlag = !!v; },
    done() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

(async () => {
  await test('1. 外から入れたプラグインにも ctx.core・api の名前空間が渡る', async () => {
    const w = mkWorld();
    try {
      w.put(w.external, 'ext-sample', manifestOf('ext-sample', {
        needs: ['api.register', 'api.call', 'core', 'app', 'peers'],
        api: {
          namespaces: ['extsample'],
          calls: ['broadcast.start', 'broadcast.stop']
        },
        peers: {
          methods: ['updateTitle']
        }
      }));
      await w.registry.loadAll();
      const rec = w.registry.getRunning().find((r) => r.id === 'ext-sample');
      assert.ok(rec, 'ext-sample が running であること');
      const ctx = rec.instance.ctxSeen;
      assert.ok(ctx, 'ctx が渡っていること');

      // ctx.core が渡ること（以前は delete されていた）
      assert.ok(ctx.core, 'ctx.core が渡ること');
      assert.ok(ctx.core.STATE_DIR, 'ctx.core.STATE_DIR が存在すること');

      // ctx.app が渡ること（以前は delete されていた）
      assert.ok(ctx.app, 'ctx.app が渡ること');

      // ctx.api が渡り、load 中に登録できていること
      assert.ok(ctx.api, 'ctx.api が渡ること');
      assert.strictEqual(typeof ctx.api.register, 'function');
      assert.strictEqual(typeof ctx.api.call, 'function');
      assert.ok(rec.instance.regResult, 'load 中の api.register の結果があること');
      assert.strictEqual(rec.instance.regResult.ok, true, 'api.register が成功すること');

      // ctx.peers が渡ること
      assert.ok(ctx.peers, 'ctx.peers が渡ること');
      assert.strictEqual(typeof ctx.peers.list, 'function');
    } finally {
      w.done();
    }
  });

  await test('2. 三層目（外から・作者用一覧外・一覧外builtin・community）は配信を始められない（layer3-no-start）、止めることはできる', async () => {
    const w = mkWorld();
    try {
      const allCalls = ['broadcast.start', 'broadcast.stop', 'engine.start', 'destination.start', 'destination.setMain'];
      const mExt = manifestOf('ext-t3', { needs: ['obs.read', 'obs.streamControl', 'api.register', 'api.call'], api: { calls: allCalls } });
      const mAuth = manifestOf('author-t3', { needs: ['obs.read', 'obs.streamControl', 'api.register', 'api.call'], api: { calls: allCalls } });
      const mBuiltin = manifestOf('builtin-t3', { needs: ['obs.read', 'obs.streamControl', 'api.register', 'api.call'], api: { calls: allCalls } });
      const mComm = manifestOf('comm-t3', { needs: ['obs.read', 'obs.streamControl', 'api.register', 'api.call'], api: { calls: allCalls } });

      w.put(w.external, 'ext-t3', mExt);
      w.put(w.author, 'author-t3', mAuth);
      w.put(w.builtin, 'builtin-t3', mBuiltin);
      w.put(w.community, 'comm-t3', mComm);

      await w.registry.loadAll();

      const targets = ['ext-t3', 'author-t3', 'builtin-t3', 'comm-t3'];
      for (const id of targets) {
        const rec = w.registry.getRunning().find((r) => r.id === id);
        assert.ok(rec, `${id} が running であること`);
        const ctx = rec.instance.ctxSeen;

        // obs.streamControl による配信開始は拒絶
        const startObs = await ctx.obs.streamControl({ action: 'start' });
        assert.deepStrictEqual(startObs, { ok: false, error: 'layer3-no-start' }, `${id} obs.start refused`);

        // api.call による配信開始は拒絶
        const bStart = await ctx.api.call('broadcast.start', { destinationIds: ['d1'], confirmed: true });
        assert.deepStrictEqual(bStart, { ok: false, error: 'layer3-no-start' }, `${id} broadcast.start refused`);

        const eStart = await ctx.api.call('engine.start', { id: 'e1' });
        assert.deepStrictEqual(eStart, { ok: false, error: 'layer3-no-start' }, `${id} engine.start refused`);

        const dStart = await ctx.api.call('destination.start', { id: 'd1' });
        assert.deepStrictEqual(dStart, { ok: false, error: 'layer3-no-start' }, `${id} destination.start refused`);

        const dMain = await ctx.api.call('destination.setMain', { use: true });
        assert.deepStrictEqual(dMain, { ok: false, error: 'layer3-no-start' }, `${id} destination.setMain refused`);

        // 止める操作は通る
        const stopObs = await ctx.obs.streamControl({ action: 'stop' });
        assert.deepStrictEqual(stopObs, { ok: true }, `${id} obs.stop allowed`);

        const bStop = await ctx.api.call('broadcast.stop', { destinationIds: ['d1'] });
        assert.deepStrictEqual(bStop, { ok: true, via: 'api-broadcast-stop' }, `${id} broadcast.stop allowed`);
      }
    } finally {
      w.done();
    }
  });

  await test('3. 二層目は配信を始められる', async () => {
    const w = mkWorld();
    try {
      const allCalls = ['broadcast.start', 'broadcast.stop', 'engine.start', 'destination.start', 'destination.setMain'];
      // host/layer1/plugin-layers.json の layer2 にある comment-send と bulk-title を使用
      w.put(w.builtin, 'comment-send', manifestOf('comment-send', { needs: ['obs.read', 'obs.streamControl', 'api.register', 'api.call'], api: { calls: allCalls } }));
      w.put(w.author, 'bulk-title', manifestOf('bulk-title', { needs: ['obs.read', 'obs.streamControl', 'api.register', 'api.call'], api: { calls: allCalls } }));

      await w.registry.loadAll();

      for (const id of ['comment-send', 'bulk-title']) {
        const rec = w.registry.getRunning().find((r) => r.id === id);
        assert.ok(rec, `${id} が running であること`);
        const ctx = rec.instance.ctxSeen;

        // obs.streamControl で start できる
        const startObs = await ctx.obs.streamControl({ action: 'start' });
        assert.deepStrictEqual(startObs, { ok: true }, `${id} obs.start succeeded`);

        // api.call で start できる
        const bStart = await ctx.api.call('broadcast.start', { destinationIds: ['d1'], confirmed: true });
        assert.deepStrictEqual(bStart, { ok: true, via: 'api-broadcast-start' }, `${id} broadcast.start succeeded`);

        const eStart = await ctx.api.call('engine.start', { id: 'e1' });
        assert.deepStrictEqual(eStart, { ok: true, via: 'api-engine-start' }, `${id} engine.start succeeded`);

        const dStart = await ctx.api.call('destination.start', { id: 'd1' });
        assert.deepStrictEqual(dStart, { ok: true, via: 'api-destination-start' }, `${id} destination.start succeeded`);

        const dMain = await ctx.api.call('destination.setMain', { use: true });
        assert.deepStrictEqual(dMain, { ok: true, via: 'api-destination-setMain' }, `${id} destination.setMain succeeded`);
      }
    } finally {
      w.done();
    }
  });

  await test('4. 全部止めるの最中の start は断る（どの層でも stopping）', async () => {
    const w = mkWorld();
    try {
      const allCalls = ['broadcast.start'];
      // 二層目のプラグイン（通常なら配信開始できる）
      w.put(w.builtin, 'comment-send', manifestOf('comment-send', { needs: ['obs.read', 'obs.streamControl', 'api.register', 'api.call'], api: { calls: allCalls } }));

      await w.registry.loadAll();
      const rec = w.registry.getRunning().find((r) => r.id === 'comment-send');
      assert.ok(rec);
      const ctx = rec.instance.ctxSeen;

      // 通常時は通る
      assert.deepStrictEqual(await ctx.obs.streamControl({ action: 'start' }), { ok: true });
      assert.deepStrictEqual(await ctx.api.call('broadcast.start', {}), { ok: true, via: 'api-broadcast-start' });

      // stoppingFlag を立てる（全部止めるの最中）
      w.setStopping(true);

      // 全部止めるの最中はどちらも stopping で拒否される
      const startObs = await ctx.obs.streamControl({ action: 'start' });
      assert.deepStrictEqual(startObs, { ok: false, error: 'stopping' });

      const bStart = await ctx.api.call('broadcast.start', {});
      assert.deepStrictEqual(bStart, { ok: false, error: 'stopping' });

      // 解除後は再び通る
      w.setStopping(false);
      assert.deepStrictEqual(await ctx.obs.streamControl({ action: 'start' }), { ok: true });
      assert.deepStrictEqual(await ctx.api.call('broadcast.start', {}), { ok: true, via: 'api-broadcast-start' });
    } finally {
      w.done();
    }
  });

  await test('5. broadcast エンジン単体: stopAll 実行中の start は stopping で断る', async () => {
    let releaseEmergency;
    const hold = new Promise((resolve) => { releaseEmergency = resolve; });
    const broadcast = createBroadcast({
      engines: {
        emergencyStop: async () => {
          await hold;
          return { ok: true, results: [{ id: 'obs-local', ok: true }] };
        }
      },
      registry: { getRunning: () => [] },
      store: { snapshot: () => ({ destinations: [], session: null }) },
      sessions: { view: () => ({ active: false }) },
      bus: { publish: () => {} },
      orchestrator: { modeFor: () => 'live' },
      preflight: { run: async () => ({ ok: true, items: [] }) },
      now: () => Date.now(),
      sleep: async () => {}
    });

    const stopPromise = broadcast.stopAll({});
    // stopAll の最中に start を呼ぶ
    const startResult = await broadcast.start({ destinationIds: ['d1'], confirmed: true });
    assert.deepStrictEqual(startResult.error, 'stopping', 'stopAll 実行中の start は stopping');

    releaseEmergency();
    const stopResult = await stopPromise;
    assert.strictEqual(stopResult.ok, true);

    // stopAll 完了後は stopping でなくなる
    assert.strictEqual(broadcast.isStopping(), false);
  });

  if (failed) {
    console.error(`\n[l8d-gates] ${failed} failed`);
    process.exit(1);
  }
  console.log('\n[marust] l8d-gates tests passed');
})();
