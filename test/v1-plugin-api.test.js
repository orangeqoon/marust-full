'use strict';
require('./_ui-inline');

/**
 * V1 C3: 内蔵プラグインの ctx.api.register（本物の registry ＋ createApi ＋ attachApi）。
 * 一時フォルダの偽のプラグインだけ。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApi } = require('../host/layer1/api');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { WINDOW_ID } = require('../host/layer1/clients');
const { attachDevShadow } = require('./_dev-shadow');
const mcpServer = require('../plugins/ai-connect/mcp/server');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-papi-'));
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
  const api = createApi({
    core: { STATE_DIR: path.join(root, 'state') },
    pluginRegistry: registry,
    audit: { write() {} },
    devMode: { get: () => ({ devMode: true, source: 'default' }) },
    getState() { return { product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
  });
  registry.attachApi(api);
  const put = (where, id, source, manifest) => {
    const dir = path.join(where, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'] }, manifest || {})));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
  };
  return { root, builtin, external, modes, registry, api, put, done() { fs.rmSync(root, { recursive: true, force: true }); } };
}

// ns を 'demoNs' にした、ping を 1 つ出すプラグインのソース
const plugin = (answer, extra) => 'globalThis.__v1 = globalThis.__v1 || {};\n'
  + 'module.exports = {\n'
  + '  load(ctx) { ' + (extra && extra.beforeRegister || '') + 'globalThis.__v1.load = ctx.api.register("demoNs.ping", () => (' + answer + '), { access: "read" }); ' + (extra && extra.afterRegister || '') + '},\n'
  + '  start(ctx) { setTimeout(() => { globalThis.__v1.start = ctx.api.register("demoNs.late", () => ({ ok: true }), { access: "read" }); }, 10); },\n'
  + '  stop() {}, destroy() {}\n};\n';
const API = { api: { namespaces: ['demoNs'] } };

(async () => {
  await test('load で登録 → running になって呼べる。start のあとの登録は register-closed', async () => {
    const t = setup();
    try {
      globalThis.__v1 = {};
      t.put(t.builtin, 'demo', plugin('{ ok: true, v: 1 }'), API);
      await t.registry.loadAll();
      assert.strictEqual(t.registry.snapshot().find((r) => r.id === 'demo').status, 'running');
      assert.deepStrictEqual(globalThis.__v1.load, { ok: true });
      assert.deepStrictEqual(await t.api.call('demoNs.ping', {}, win), { ok: true, v: 1 });
      await new Promise((r) => setTimeout(r, 60));
      assert.deepStrictEqual(globalThis.__v1.start, { ok: false, error: 'register-closed' });
      assert.strictEqual((await t.api.call('demoNs.late', {}, win)).error, 'unknown-method');
      const d = (await t.api.call('api.describe', {}, win)).methods.find((m) => m.method === 'demoNs.ping');
      assert.strictEqual(d.owner, 'demo');
    } finally { t.done(); }
  });

  await test('load が失敗 → 何も登録されない', async () => {
    const t = setup();
    try {
      t.put(t.builtin, 'demo', plugin('{ ok: true }', { afterRegister: 'throw new Error("boom"); ' }), API);
      await t.registry.loadAll();
      assert.strictEqual(t.registry.snapshot().find((r) => r.id === 'demo').status, 'load-failed');
      assert.strictEqual((await t.api.call('demoNs.ping', {}, win)).error, 'unknown-method');
    } finally { t.done(); }
  });

  await test('reload: 中身を変えたハンドラの答えに変わる。load が壊れたら外れて unknown-method', async () => {
    const t = setup();
    try {
      t.put(t.builtin, 'demo', plugin('{ ok: true, v: 1 }'), API);
      await t.registry.loadAll();
      assert.strictEqual((await t.api.call('demoNs.ping', {}, win)).v, 1);
      fs.writeFileSync(path.join(t.builtin, 'demo', 'index.js'), plugin('{ ok: true, v: 2 }'));
      assert.strictEqual((await t.registry.reload('demo')).result, 'ok');
      assert.strictEqual((await t.api.call('demoNs.ping', {}, win)).v, 2);
      fs.writeFileSync(path.join(t.builtin, 'demo', 'index.js'), 'module.exports = { load() { throw new Error("x"); }, start() {}, stop() {}, destroy() {} };\n');
      assert.strictEqual((await t.registry.reload('demo')).result, 'error');
      assert.strictEqual((await t.api.call('demoNs.ping', {}, win)).error, 'unknown-method');
      fs.writeFileSync(path.join(t.builtin, 'demo', 'index.js'), plugin('{ ok: true, v: 3 }'));
      assert.strictEqual((await t.registry.reload('demo')).result, 'ok');
      assert.strictEqual((await t.api.call('demoNs.ping', {}, win)).v, 3);
    } finally { t.done(); }
  });

  await test('L8d: 外から入れた形（source: external）にも ctx.api が渡り、api 欄が残る', async () => {
    const t = setup();
    try {
      globalThis.__v1 = {};
      const src = 'module.exports = { load(ctx) { globalThis.__v1.extApi = typeof ctx.api; }, start() {}, stop() {}, destroy() {} };\n';
      t.put(t.external, 'ext-demo', src, API);
      t.modes['ext-demo'] = 'shadow';
      await t.registry.loadAll();
      const row = t.registry.snapshot().find((r) => r.id === 'ext-demo');
      assert.strictEqual(row.status, 'running');
      assert.strictEqual(globalThis.__v1.extApi, 'object');
      assert.ok(row.manifest.api);
      assert.deepStrictEqual(row.manifest.api.namespaces, ['demoNs']);
    } finally { t.done(); }
  });

  await test('manifest の api 欄の違反（本体の名前空間・形違い・6 個以上）は捨てられ、ctx.api は無い', async () => {
    const t = setup();
    try {
      globalThis.__v1 = {};
      const src = 'module.exports = { load(ctx) { globalThis.__v1[ctx.id] = typeof ctx.api; }, start() {}, stop() {}, destroy() {} };\n';
      t.put(t.builtin, 'bad-core', src, { api: { namespaces: ['engine'] } });
      t.put(t.builtin, 'bad-shape', src, { api: { namespaces: 'demoNs' } });
      t.put(t.builtin, 'bad-many', src, { api: { namespaces: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] } });
      await t.registry.loadAll();
      for (const id of ['bad-core', 'bad-shape', 'bad-many']) {
        assert.strictEqual(globalThis.__v1[id], 'undefined', id);
        assert.strictEqual(t.registry.snapshot().find((r) => r.id === id).manifest.api, undefined, id);
      }
    } finally { t.done(); }
  });

  await test('2 つのプラグインが同じ名前空間 → 先の方だけ。後の方のログに api-taken', async () => {
    const t = setup();
    try {
      t.put(t.builtin, 'aaa', plugin('{ ok: true, who: "aaa" }'), API);
      t.put(t.builtin, 'bbb', plugin('{ ok: true, who: "bbb" }'), API);
      await t.registry.loadAll();
      assert.strictEqual((await t.api.call('demoNs.ping', {}, win)).who, 'aaa');
      assert.ok(t.registry.logsOf('bbb').some((row) => row.text.indexOf('api-taken demoNs.ping') !== -1), JSON.stringify(t.registry.logsOf('bbb')));
    } finally { t.done(); }
  });

  await test('宣言に無い名前空間への登録は undeclared-namespace', async () => {
    const t = setup();
    try {
      globalThis.__v1 = {};
      const src = 'module.exports = { load(ctx) { globalThis.__v1.r = ctx.api.register("otherNs.x", () => ({ ok: true }), { access: "read" }); globalThis.__v1.bad = ctx.api.register("engine.x", () => ({ ok: true }), { access: "read" }); }, start() {}, stop() {}, destroy() {} };\n';
      t.put(t.builtin, 'demo', src, API);
      await t.registry.loadAll();
      assert.deepStrictEqual(globalThis.__v1.r, { ok: false, error: 'undeclared-namespace' });
      assert.deepStrictEqual(globalThis.__v1.bad, { ok: false, error: 'undeclared-namespace' });
      assert.strictEqual((await t.api.call('otherNs.x', {}, win)).error, 'unknown-method');
    } finally { t.done(); }
  });

  await test('ハンドラが投げる → failed・plugin のログに api-error（絶対パスは出ない）', async () => {
    const t = setup();
    try {
      const src = 'module.exports = { load(ctx) { ctx.api.register("demoNs.boom", () => { throw new Error(__filename + " broke"); }, { access: "read" }); }, start() {}, stop() {}, destroy() {} };\n';
      t.put(t.builtin, 'demo', src, API);
      await t.registry.loadAll();
      assert.deepStrictEqual(await t.api.call('demoNs.boom', {}, win), { ok: false, error: 'failed' });
      const logs = t.registry.logsOf('demo');
      assert.ok(logs.some((row) => row.text.indexOf('api-error demoNs.boom') !== -1), JSON.stringify(logs));
      assert.ok(!JSON.stringify(logs).toLowerCase().includes(t.root.toLowerCase().replace(/\\/g, '\\\\')));
    } finally { t.done(); }
  });

  await test('holdsObs: capabilities / slot の役目 / needs の obs.streamControl、まとまりの別の役目でも true・どれも無ければ false', async () => {
    const t = setup();
    try {
      const noop = 'module.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n';
      const v1 = (extra) => Object.assign({ kind: 'integration', capabilities: [] }, extra);
      t.put(t.builtin, 'plain', noop);
      t.put(t.builtin, 'cap-holder', noop, { manifestVersion: 1, runtime: undefined, provides: undefined, kind: 'integration', capabilities: ['obs-stop'] });
      t.put(t.builtin, 'needs-holder', noop, { needs: ['obs.read', 'obs.streamControl'] });
      const siteDir = path.join(t.builtin, 'sites', 'demo-site');
      fs.mkdirSync(siteDir, { recursive: true });
      const site = 'module.exports = { load() {}, start() {}, stop() {}, destroy() {}, health() { return { ok: true }; }, isConfigured() { return false; }, updateMetadata() { return { ok: true }; }, acquire() { return { ok: true }; } };\n';
      fs.writeFileSync(path.join(siteDir, 'site.js'), site);
      fs.writeFileSync(path.join(siteDir, 'slot.js'), site);
      fs.writeFileSync(path.join(siteDir, 'manifest.json'), JSON.stringify({
        manifestVersion: 2, id: 'demo-site', name: 'demo', version: '1.0.0', runtime: 'inproc', kind: 'site',
        site: { id: 'demo-site', name: 'demo', tier: 'extra', login: 'none' },
        roles: { site: { main: 'site.js', provides: ['stream.site@1'], actions: {}, timeouts: {} }, slot: { main: 'slot.js', provides: ['stream.slot@1'], actions: {}, timeouts: {} } }
      }));
      await t.registry.loadAll();
      void v1;
      assert.strictEqual(t.registry.holdsObs('plain'), false);
      assert.strictEqual(t.registry.holdsObs('nope'), false);
      assert.strictEqual(t.registry.holdsObs('needs-holder'), true);
      const ids = t.registry.snapshot().map((r) => r.id);
      const siteRole = ids.find((id) => /site/.test(id) && id !== 'demo-site' && /^site-/.test(id));
      const slotRole = ids.find((id) => /^slot-/.test(id));
      assert.ok(siteRole && slotRole, JSON.stringify(ids));
      assert.strictEqual(t.registry.holdsObs(slotRole), true);
      assert.strictEqual(t.registry.holdsObs(siteRole), true, '同じサイトの別の役目でも true');
      if (ids.indexOf('cap-holder') !== -1) assert.strictEqual(t.registry.holdsObs('cap-holder'), true);
    } finally { t.done(); }
  });

  await test('互換: dev-shadow を読んだ describe の shadow.report が移す前と同じ行・MCP に read の道具で出る', async () => {
    const t = setup();
    const shadow = await attachDevShadow(t.api, { STATE_DIR: t.root });
    try {
      const rows = (await t.api.call('api.describe', {}, win)).methods;
      const row = rows.find((m) => m.method === 'shadow.report');
      assert.strictEqual(row.permission, 'read');
      assert.strictEqual(row.windowOnly, false);
      assert.strictEqual(row.noApproval, false);
      assert.strictEqual(row.owner, 'dev-shadow');
      assert.deepStrictEqual(row.params, { days: { type: 'number', required: false, min: 1, max: 30 }, site: { type: 'string', required: false, max: 64 } });
      assert.strictEqual(row.description, 'shadow の記録を日数とサイトでまとめる。値や秘密は含めない');
      const tool = mcpServer.buildTools(rows).find((x) => x.method === 'shadow.report');
      assert.ok(tool, 'MCP の道具に出る');
    } finally { shadow.done(); t.done(); }
  });

  if (failed) { console.error('\n[v1-plugin-api] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] v1 plugin api tests passed');
})();
