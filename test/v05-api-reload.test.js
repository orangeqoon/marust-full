'use strict';
require('./_ui-inline');

/**
 * V0.5 S2: plugin.reload / plugins.reloadAll / plugin.logs / plugin.status / ui.reload / app.restart。
 * 一時フォルダの偽のプラグイン・偽の状態だけ。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApi, parsePluginMethod } = require('../host/layer1/api');
const { createCore } = require('../host/core/core-bridge');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { WINDOW_ID } = require('../host/layer1/clients');
const { EVENTS } = require('../host/core/events');
const mcp = require('../plugins/ai-connect/mcp/server');
const { WINDOW_ID: _W } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const real = createCore();
const OK_SRC = 'module.exports = { load(ctx) { ctx.logger("info", "hello"); }, start() {}, stop() {}, destroy() {} };\n';

function setup(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v05-api-'));
  const builtin = path.join(root, 'builtin');
  const external = path.join(root, 'state', 'plugins');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  const modes = {};
  const registry = createRegistry({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: builtin,
    authorRoot: path.join(root, 'no-author'),
    externalRoot: external,
    logger() {},
    modeFor: (id) => modes[id] || 'legacy'
  });
  const put = (where, id, source) => {
    const dir = path.join(where, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'] }));
    fs.writeFileSync(path.join(dir, 'index.js'), source || OK_SRC);
  };
  const events = [];
  const restarts = [];
  const state = { devMode: o.devMode !== false, liveCount: o.liveCount || 0 };
  const core = { STATE_DIR: root, SERVICES_DIR: path.join(root, 'services'), COOKIES_DIR: path.join(root, 'cookies'), DATA_DIR: path.join(root, 'data'), atomicWriteJsonSync: real.atomicWriteJsonSync };
  const api = createApi({
    core,
    pluginRegistry: registry,
    bus: { publish(name, payload) { events.push({ name, payload }); } },
    audit: { write() {} },
    devMode: { get: () => ({ devMode: state.devMode, source: 'default' }) },
    getState() {
      if (state.stateBroken) throw new Error('state-unavailable');
      return { product: 'marust', plugins: [], destinations: { liveCount: state.liveCount }, engineStatus: { connected: true } };
    },
    restartApp() { restarts.push(1); }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const mcpCtx = { clientId: 'mcp-1', kind: 'native', permissions: ['read', 'write'], requiresApproval: true, via: 'ws' };
  return { root, registry, put, builtin, external, modes, api, win, mcpCtx, events, restarts, state, done() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const noLeak = (value, root) => !JSON.stringify(value).toLowerCase().includes(root.toLowerCase().replace(/\\/g, '\\\\'));

(async () => {
  await test('plugin.reload / plugin.logs / plugin.status はドット 1 つで plugin.<id>.<action> とぶつからない', () => {
    for (const m of ['plugin.reload', 'plugin.logs', 'plugin.status']) assert.strictEqual(parsePluginMethod(m), null);
    assert.ok(parsePluginMethod('plugin.abc.ping'));
  });

  await test('EVENTS に plugin.reloaded / ui.reloadRequested がある', () => {
    assert.strictEqual(EVENTS.PLUGIN_RELOADED, 'plugin.reloaded');
    assert.strictEqual(EVENTS.UI_RELOAD_REQUESTED, 'ui.reloadRequested');
  });

  await test('MCP の道具に plugin.reload・plugin.logs・plugin.status・ui.reload が出る', async () => {
    const t = setup();
    try {
      const described = await t.api.call('api.describe', {}, t.win);
      const tools = mcp.buildTools(described.methods);
      const names = tools.map((tool) => tool.method);
      for (const m of ['plugin.reload', 'plugin.logs', 'plugin.status', 'ui.reload', 'plugins.reloadAll', 'app.restart']) assert.ok(names.indexOf(m) !== -1, m);
    } finally { t.done(); }
  });

  await test('開発者モードでないと reload 系は dev-only（logs / status は読めてよい）', async () => {
    const t = setup({ devMode: false });
    try {
      t.put(t.builtin, 'demo');
      await t.registry.loadAll();
      for (const [m, p] of [['plugin.reload', { id: 'demo' }], ['plugins.reloadAll', {}], ['ui.reload', { target: 'all' }], ['app.restart', {}]]) {
        assert.strictEqual((await t.api.call(m, p, t.win)).error, 'dev-only', m);
      }
      assert.strictEqual((await t.api.call('plugin.status', { id: 'demo' }, t.win)).ok, true);
    } finally { t.done(); }
  });

  await test('配信中でも普通のプラグインは reload できる。OBS を握るものだけ承認待ち・reloadAll はそれを飛ばす・restart は承認待ち', async () => {
    const t = setup({ liveCount: 1 });
    try {
      t.put(t.builtin, 'demo');
      t.put(t.builtin, 'obs-holder', OK_SRC.replace('start() {}', 'start() {}, onObsEvent() {}'));
      const dir = path.join(t.builtin, 'obs-holder');
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      m.capabilities = ['obs-start', 'obs-stop'];
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
      await t.registry.loadAll();
      assert.ok(t.registry.snapshot().some((r) => r.id === 'obs-holder' && r.status === 'running'), 'obs-holder が読み込まれる');
      const ok = await t.api.call('plugin.reload', { id: 'demo' }, t.mcpCtx);
      assert.strictEqual(ok.ok, true, JSON.stringify(ok));
      assert.strictEqual(ok.result, 'ok');
      const heldReload = await t.api.call('plugin.reload', { id: 'obs-holder' }, t.mcpCtx);
      assert.strictEqual(heldReload.pending, true);
      assert.strictEqual((await t.api.call('approval.approve', { id: heldReload.approvalId }, t.win)).result.result, 'ok');
      const all = await t.api.call('plugins.reloadAll', {}, t.mcpCtx);
      assert.strictEqual(all.ok, true);
      const byId = {};
      all.results.forEach((row) => { byId[row.id] = row; });
      assert.strictEqual(byId['obs-holder'].result, 'skip');
      assert.strictEqual(byId['obs-holder'].message, 'streaming-slot');
      assert.strictEqual(byId.demo.result, 'ok');
      const held = await t.api.call('app.restart', {}, t.mcpCtx);
      assert.strictEqual(held.pending, true);
      const direct = await t.api.call('app.restart', {}, t.win);
      assert.strictEqual(direct.ok, true);
      assert.strictEqual(direct.whileStreaming, true);
      // 配信していなければ obs-holder も読み直せる
      t.state.liveCount = 0;
      assert.strictEqual((await t.api.call('plugin.reload', { id: 'obs-holder' }, t.mcpCtx)).result, 'ok');
    } finally { t.done(); }
  });

  await test('配信中か分からない（getState が throw）ときは、OBS を握るものだけ承認待ち', async () => {
    const t = setup();
    try {
      t.put(t.builtin, 'demo');
      t.put(t.builtin, 'obs-holder', OK_SRC.replace('start() {}', 'start() {}, onObsEvent() {}'));
      const dir = path.join(t.builtin, 'obs-holder');
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      m.capabilities = ['obs-start'];
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
      await t.registry.loadAll();
      t.state.stateBroken = true;
      assert.strictEqual((await t.api.call('plugin.reload', { id: 'obs-holder' }, t.win)).pending, true);
      assert.strictEqual((await t.api.call('plugin.reload', { id: 'demo' }, t.win)).result, 'ok');
      const all = await t.api.call('plugins.reloadAll', {}, t.win);
      const byId = {};
      all.results.forEach((row) => { byId[row.id] = row; });
      assert.strictEqual(byId['obs-holder'].message, 'streaming-slot');
      assert.strictEqual(byId.demo.result, 'ok');
    } finally { t.done(); }
  });

  await test('本物の形: sites/<x> の slot の役目と、同じサイトの site の役目は、配信中は slot だけ承認待ち・site は単品で読み直せる', async () => {
    const t = setup({ liveCount: 1 });
    try {
      const siteDir = path.join(t.builtin, 'sites', 'demo-site');
      fs.mkdirSync(siteDir, { recursive: true });
      const noop = 'module.exports = { load() {}, start() {}, stop() {}, destroy() {}, health() { return { ok: true }; }, isConfigured() { return false; }, updateMetadata() { return { ok: true }; }, acquire() { return { ok: true }; } };\n';
      fs.writeFileSync(path.join(siteDir, 'site.js'), noop);
      fs.writeFileSync(path.join(siteDir, 'slot.js'), noop);
      fs.writeFileSync(path.join(siteDir, 'manifest.json'), JSON.stringify({
        manifestVersion: 2, id: 'demo-site', name: 'demo', version: '1.0.0', runtime: 'inproc', kind: 'site',
        site: { id: 'demo-site', name: 'demo', tier: 'extra', login: 'none' },
        roles: {
          site: { main: 'site.js', provides: ['stream.site@1'], actions: {}, timeouts: {} },
          slot: { main: 'slot.js', provides: ['stream.slot@1'], actions: {}, timeouts: {} }
        }
      }));
      t.put(t.builtin, 'demo');
      await t.registry.loadAll();
      const rows = t.registry.snapshot().filter((r) => r.siteId === 'demo-site');
      if (rows.length < 2) {
        // この形が今の manifest の書き方と合わないときは、試験の側を直す（本物の plugins/sites/youtube/manifest.json を見本にする）
        throw new Error('サイトの役目が読み込まれていない: ' + JSON.stringify(t.registry.snapshot().map((r) => [r.id, r.status, r.reason])));
      }
      const slot = rows.find((r) => r.role === 'slot');
      const site = rows.find((r) => r.role === 'site');
      assert.ok(slot && site);
      const originalSlot = t.registry.getRunning().find((r) => r.id === slot.id).instance;
      assert.strictEqual((await t.api.call('plugin.reload', { id: slot.id }, t.win)).pending, true);
      assert.strictEqual((await t.api.call('plugin.reload', { id: site.id }, t.win)).result, 'ok');
      assert.strictEqual(t.registry.getRunning().find((r) => r.id === slot.id).instance, originalSlot, 'site reload must not touch the slot instance');
      const all = await t.api.call('plugins.reloadAll', {}, t.win);
      const skipped = all.results.filter((row) => row.message === 'streaming-slot').map((row) => row.id).sort();
      assert.deepStrictEqual(skipped, [site.id, slot.id].sort());
      assert.strictEqual(all.results.find((row) => row.id === 'demo').result, 'ok');
    } finally { t.done(); }
  });

  await test('plugin.logs は知らない id に unknown-id・MCP の道具の説明は承認の要らないものに「承認待ち」と書かない', async () => {
    const t = setup();
    try {
      t.put(t.builtin, 'demo');
      await t.registry.loadAll();
      assert.strictEqual((await t.api.call('plugin.logs', { id: 'nobody' }, t.win)).error, 'unknown-id');
      assert.strictEqual((await t.api.call('plugin.logs', { id: 'demo' }, t.win)).ok, true);
      const described = await t.api.call('api.describe', {}, t.win);
      const tools = mcp.buildTools(described.methods);
      const byMethod = {};
      tools.forEach((tool) => { byMethod[tool.method] = tool; });
      assert.strictEqual(byMethod['plugin.reload'].description.indexOf('承認待ち'), -1);
      assert.strictEqual(byMethod['ui.reload'].description.indexOf('承認待ち'), -1);
      assert.ok(byMethod['app.restart'].description.indexOf('承認待ち') !== -1);
    } finally { t.done(); }
  });

  await test('MCP 相当（requiresApproval）でも reload / ui.reload は承認待ちにならず、app.restart は承認待ち', async () => {
    const t = setup();
    try {
      t.put(t.builtin, 'demo');
      await t.registry.loadAll();
      const r = await t.api.call('plugin.reload', { id: 'demo' }, t.mcpCtx);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.result, 'ok');
      assert.notStrictEqual(r.pending, true);
      assert.strictEqual((await t.api.call('ui.reload', { target: 'theme' }, t.mcpCtx)).sent, true);
      assert.strictEqual((await t.api.call('plugins.reloadAll', {}, t.mcpCtx)).ok, true);
      const held = await t.api.call('app.restart', {}, t.mcpCtx);
      assert.strictEqual(held.pending, true, JSON.stringify(held));
      assert.strictEqual(t.restarts.length, 0);
    } finally { t.done(); }
  });

  await test('app.restart は窓からなら 300ms 後に restartApp を呼ぶ', async () => {
    const t = setup();
    try {
      const r = await t.api.call('app.restart', {}, t.win);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(t.restarts.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.strictEqual(t.restarts.length, 1);
    } finally { t.done(); }
  });

  await test('壊れたプラグイン: reload の答えに where があり、絶対パスが無い。直すと ok・イベントが出る', async () => {
    const t = setup();
    try {
      t.put(t.builtin, 'demo');
      await t.registry.loadAll();
      t.put(t.builtin, 'demo', 'module.exports = {\n  load() {\n    throw new Error("boom");\n  }, start() {}, stop() {}, destroy() {}\n};\n');
      const bad = await t.api.call('plugin.reload', { id: 'demo' }, t.mcpCtx);
      assert.strictEqual(bad.ok, true);
      assert.strictEqual(bad.result, 'error');
      assert.strictEqual(bad.error.where, 'index.js:3');
      assert.ok(noLeak(bad, t.root));
      const status = await t.api.call('plugin.status', { id: 'demo' }, t.mcpCtx);
      assert.strictEqual(status.status, 'load-failed');
      assert.strictEqual(status.lastError.where, 'index.js:3');
      assert.ok(noLeak(status, t.root));
      const logs = await t.api.call('plugin.logs', { id: 'demo', n: 5 }, t.mcpCtx);
      assert.ok(logs.lines.length >= 1 && noLeak(logs, t.root));
      t.put(t.builtin, 'demo');
      const good = await t.api.call('plugin.reload', { id: 'demo' }, t.mcpCtx);
      assert.strictEqual(good.result, 'ok');
      assert.strictEqual((await t.api.call('plugin.status', { id: 'demo' }, t.mcpCtx)).lastError, null);
      const ev = t.events.filter((e) => e.name === 'plugin.reloaded');
      assert.deepStrictEqual(ev.map((e) => e.payload.result), ['error', 'ok']);
    } finally { t.done(); }
  });

  await test('新しく外の置き場に置いたプラグイン: reload で拾い、legacy なら legacy-not-loaded、live なら ok', async () => {
    const t = setup();
    try {
      await t.registry.loadAll();
      t.put(t.external, 'fresh-one');
      const skip = await t.api.call('plugin.reload', { id: 'fresh-one' }, t.mcpCtx);
      assert.strictEqual(skip.ok, true, JSON.stringify(skip));
      assert.strictEqual(skip.result, 'skip');
      assert.strictEqual(skip.message, 'legacy-not-loaded');
      t.modes['fresh-one'] = 'live';
      const ok = await t.api.call('plugin.reload', { id: 'fresh-one' }, t.mcpCtx);
      assert.strictEqual(ok.result, 'ok', JSON.stringify(ok));
      assert.strictEqual((await t.api.call('plugin.reload', { id: 'nothing-here' }, t.mcpCtx)).error, 'unknown-id');
    } finally { t.done(); }
  });

  await test('id の検査・ui.reload の target の検査', async () => {
    const t = setup();
    try {
      assert.strictEqual((await t.api.call('plugin.reload', { id: '../x' }, t.win)).error, 'bad-id');
      assert.strictEqual((await t.api.call('plugin.logs', { id: 'Bad Id' }, t.win)).error, 'bad-id');
      assert.strictEqual((await t.api.call('plugin.logs', { id: 'demo', n: 999 }, t.win)).error, 'bad-n');
      for (const target of ['all', 'theme', 'plugin:demo']) assert.strictEqual((await t.api.call('ui.reload', { target }, t.win)).sent, true, target);
      for (const target of ['', 'panel', 'plugin:', 'plugin:../x', 'all ']) assert.ok((await t.api.call('ui.reload', { target }, t.win)).ok === false, target);
      assert.deepStrictEqual(t.events.filter((e) => e.name === 'ui.reloadRequested').map((e) => e.payload.target), ['all', 'theme', 'plugin:demo']);
    } finally { t.done(); }
  });

  if (failed) { console.error('\n[v05-api] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] v05 api reload tests passed');
})();
