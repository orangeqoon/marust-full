'use strict';
require('./_ui-inline');

/**
 * V2 C1: 内蔵プラグインの ctx.api.call（PLAN-V2 V2-1）。
 * 本物の registry ＋ createApi ＋ attachApi。一時フォルダの偽のプラグインだけ。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApi } = require('../host/layer1/api');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { WINDOW_ID } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

function setup(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-call-'));
  const builtin = path.join(root, 'builtin');
  const external = path.join(root, 'state', 'plugins');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  const modes = {};
  const logs = [];
  const audits = [];
  const registry = createRegistry({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: builtin,
    authorRoot: path.join(root, 'no-author'),
    externalRoot: external,
    logger(level, message) { logs.push(level + ' ' + message); },
    modeFor: (id) => modes[id] || 'legacy'
  });
  const api = createApi({
    core: { STATE_DIR: path.join(root, 'state') },
    pluginRegistry: registry,
    audit: { write(row) { audits.push(row); } },
    devMode: { get: () => ({ devMode: o.dev === true, source: 'default' }) },
    getState() { return { product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
  });
  registry.attachApi(api);
  const put = (where, id, source, manifest) => {
    const dir = path.join(where, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'] }, manifest || {})));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
  };
  return { root, builtin, external, modes, logs, audits, registry, api, put, done() { fs.rmSync(root, { recursive: true, force: true }); } };
}

// 起動したら calls の各名前を呼び、答えを globalThis.__v2call[id] に入れる
const caller = (calls) => 'globalThis.__v2call = globalThis.__v2call || {};\n'
  + 'module.exports = {\n'
  + '  async load(ctx) {\n'
  + '    const out = { api: typeof ctx.api, call: ctx.api && typeof ctx.api.call };\n'
  + '    if (ctx.api && ctx.api.call) { for (const m of ' + JSON.stringify(calls) + ') out[m] = await ctx.api.call(m, {}); }\n'
  + '    globalThis.__v2call[ctx.id] = out;\n'
  + '  },\n'
  + '  start() {}, stop() {}, destroy() {}\n};\n';

(async () => {
  await test('api.calls に書いた read は呼べる。書いていない名前は not-declared', async () => {
    const t = setup();
    try {
      globalThis.__v2call = {};
      t.put(t.builtin, 'caller', caller(['hub.getState', 'devmode.get', 'api.describe']), { api: { calls: ['hub.getState', 'api.describe'] } });
      await t.registry.loadAll();
      const out = globalThis.__v2call.caller;
      assert.strictEqual(out.call, 'function');
      assert.strictEqual(out['hub.getState'].product, 'marust');
      assert.strictEqual(out['api.describe'].ok, true);
      assert.deepStrictEqual(out['devmode.get'], { ok: false, error: 'not-declared' });
    } finally { t.done(); }
  });

  await test('呼べないもの: clients・approval・modes・devmode・plugins・plugin は読み込みで捨てられ、呼べば not-declared（L8g: secrets・vault は一覧から外した）', async () => {
    const t = setup();
    try {
      globalThis.__v2call = {};
      const bad = ['clients.list', 'approval.list', 'modes.list', 'devmode.get', 'plugins.list', 'plugin.timer.getState'];
      t.put(t.builtin, 'caller', caller(bad.concat(['hub.getState'])), { api: { calls: bad.concat(['hub.getState']) } });
      await t.registry.loadAll();
      const row = t.registry.snapshot().find((r) => r.id === 'caller');
      assert.deepStrictEqual(row.manifest.api.calls, ['hub.getState']);
      assert.ok(t.logs.some((l) => l.indexOf('ignore api.calls entry on caller') !== -1));
      const out = globalThis.__v2call.caller;
      for (const m of bad) assert.deepStrictEqual(out[m], { ok: false, error: 'not-declared' }, m);
      assert.strictEqual(out['hub.getState'].product, 'marust');
    } finally { t.done(); }
  });

  await test('L8g: secrets・vault は一覧から外れたが、窓口だけ（windowOnly）なのでプラグインから呼んでも forbidden のまま', async () => {
    const t = setup({ dev: true });
    try {
      globalThis.__v2call = {};
      const names = ['secrets.list', 'vault.health'];
      t.put(t.builtin, 'caller', caller(names), { api: { calls: names } });
      await t.registry.loadAll();
      assert.deepStrictEqual(t.registry.snapshot().find((r) => r.id === 'caller').manifest.api.calls, names, 'manifest には残る');
      assert.strictEqual((await t.api.callAs('caller', 'secrets.list', {})).error, 'forbidden');
      assert.notStrictEqual((await t.api.callAs('caller', 'vault.health', {})).error, 'not-declared');
    } finally { t.done(); }
  });

  await test('windowOnly の行・emergency の行・プラグインが出した行（自分を含む）は forbidden', async () => {
    const t = setup({ dev: true });
    try {
      globalThis.__v2call = {};
      // 'settings.export' は windowOnly、'emergency' の行は下で describe から探す、'ownNs.ping' はこのプラグイン自身の行
      const names = ['settings.export', 'ownNs.ping'];
      const src = 'globalThis.__v2call = globalThis.__v2call || {};\n'
        + 'module.exports = {\n'
        + '  load(ctx) { ctx.api.register("ownNs.ping", () => ({ ok: true }), { access: "read" }); },\n'
        + '  start(ctx) { globalThis.__v2ctx = ctx; },\n'
        + '  stop() {}, destroy() {}\n};\n';
      t.put(t.builtin, 'self', src, { api: { namespaces: ['ownNs'], calls: ['ownNs.ping'] } });
      t.put(t.builtin, 'caller', caller(names.concat(['emergency.stop'])), { api: { calls: names.concat(['emergency.stop']) } });
      await t.registry.loadAll();
      assert.deepStrictEqual(await globalThis.__v2ctx.api.call('ownNs.ping', {}), { ok: false, error: 'forbidden' });
      assert.strictEqual((await t.api.call('ownNs.ping', {}, win)).ok, true);
      const out = globalThis.__v2call.caller;
      assert.strictEqual(out['settings.export'].error, 'forbidden');
      // 他のプラグインが出した行は、起動順しだいで unknown-method のこともある。running のあとに呼んで forbidden を確かめる
      assert.deepStrictEqual(await t.api.callAs('caller', 'ownNs.ping', {}), { ok: false, error: 'forbidden' });
      // emergency の権限の行は forbidden または unknown-method（どちらでも呼べない）
      assert.ok(['forbidden', 'unknown-method'].indexOf(out['emergency.stop'].error) !== -1);
      const emergencyRows = (await t.api.call('api.describe', {}, win)).methods.filter((m) => m.permission === 'emergency');
      for (const m of emergencyRows) {
        const r = await t.api.callAs('caller', m.method, {});
        assert.strictEqual(r.error, 'forbidden', m.method);
      }
    } finally { t.done(); }
  });

  await test('引数の検査は本体のまま（bad-… が返る）。開発者モードの門も同じ（dev-only）', async () => {
    const t = setup({ dev: false });
    try {
      const bad = await t.api.callAs('x-plugin', 'settings.export', {});
      assert.strictEqual(bad.error, 'forbidden'); // windowOnly
      const noMethod = await t.api.callAs('x-plugin', 'hub.nothing', {});
      assert.strictEqual(noMethod.error, 'unknown-method');
      const checked = await t.api.callAs('x-plugin', 'chat.recent', { limit: 9999 });
      assert.strictEqual(checked.ok, false); // limit は max 200
      assert.notStrictEqual(checked.error, 'unknown-method');
      const devOnly = (await t.api.call('api.describe', {}, win)).methods.find((m) => m.permission === 'read' && m.windowOnly === false && m.devOnly === true);
      if (devOnly) assert.strictEqual((await t.api.callAs('x-plugin', devOnly.method, {})).error, 'dev-only');
    } finally { t.done(); }
  });

  await test('書き込みは監査に plugin:<id> で残り、承認待ちにならない', async () => {
    const t = setup();
    try {
      const wrote = await t.api.callAs('writer', 'hub.getState', {});
      assert.strictEqual(wrote.product, 'marust');
      // write の行を 1 つ選んで呼ぶ（引数が足りなくて失敗してもよい。承認待ち（pending）にならないことと監査の行を見る）
      const row = (await t.api.call('api.describe', {}, win)).methods.find((m) => m.permission === 'write' && !m.windowOnly && !m.owner && m.method === 'layout.save');
      assert.ok(row, 'layout.save の行');
      const done = await t.api.callAs('writer', 'layout.save', {}); // 名前が無いので失敗するが、実行されて承認待ちにはならない
      assert.notStrictEqual(done.pending, true);
      assert.notStrictEqual(done.error, 'forbidden');
      const mine = t.audits.filter((a) => a.clientId === 'plugin:writer');
      assert.ok(mine.length >= 1);
      assert.strictEqual(mine[0].kind, 'plugin');
      assert.strictEqual(mine[0].method, 'layout.save');
    } finally { t.done(); }
  });

  await test('L8g: engine.setKey は名前の断りから外れた（manifest に残り、forbidden にならない）', async () => {
    const t = setup({ dev: true });
    try {
      globalThis.__v2call = {};
      t.put(t.builtin, 'caller', caller(['engine.setKey']), { api: { calls: ['engine.setKey'] } });
      await t.registry.loadAll();
      assert.deepStrictEqual(t.registry.snapshot().find((r) => r.id === 'caller').manifest.api.calls, ['engine.setKey']);
      const res = await t.api.callAs('caller', 'engine.setKey', { id: 't1', key: 'k' });
      assert.notStrictEqual(res.error, 'forbidden');
    } finally { t.done(); }
  });

  await test('名前で断る: hub.fanout（確認の門）・hub.forceLegacy・app.restart は呼べず、manifest に書いても捨てられる（L8g: engine.setKey は外した）', async () => {
    const t = setup({ dev: true });
    try {
      globalThis.__v2call = {};
      const names = ['hub.fanout', 'hub.forceLegacy', 'app.restart'];
      t.put(t.builtin, 'caller', caller(names.concat(['hub.getState'])), { api: { calls: names.concat(['hub.getState']) } });
      await t.registry.loadAll();
      assert.deepStrictEqual(t.registry.snapshot().find((r) => r.id === 'caller').manifest.api.calls, ['hub.getState']);
      for (const m of names) assert.strictEqual((await t.api.callAs('caller', m, { confirmed: true, allowedLiveIds: ['x'] })).error, 'forbidden', m);
    } finally { t.done(); }
  });

  await test('L8d: 外から入れた形（source: external）にも ctx.api が渡り呼べる（三層目は配信開始不可）', async () => {
    const t = setup();
    try {
      globalThis.__v2call = {};
      t.put(t.external, 'ext-caller', caller(['hub.getState', 'broadcast.start']), { api: { calls: ['hub.getState', 'broadcast.start'] } });
      t.modes['ext-caller'] = 'shadow';
      await t.registry.loadAll();
      const row = t.registry.snapshot().find((r) => r.id === 'ext-caller');
      assert.strictEqual(row.status, 'running');
      assert.strictEqual(globalThis.__v2call['ext-caller'].api, 'object');
      assert.ok(row.manifest.api);
      assert.deepStrictEqual(row.manifest.api.calls, ['hub.getState', 'broadcast.start']);
      const out = globalThis.__v2call['ext-caller'];
      assert.strictEqual(out['hub.getState'].product, 'marust');
      assert.deepStrictEqual(out['broadcast.start'], { ok: false, error: 'layer3-no-start' });
    } finally { t.done(); }
  });

  await test('calls の形の違反: 31 個・配列でない・重複。namespaces だけのプラグインには call が無い', async () => {
    const t = setup();
    try {
      globalThis.__v2call = {};
      const many = [];
      for (let i = 0; i < 31; i += 1) many.push('hub.m' + i);
      t.put(t.builtin, 'many', caller([]), { api: { calls: many } });
      t.put(t.builtin, 'shape', caller([]), { api: { calls: 'hub.getState' } });
      t.put(t.builtin, 'dup', caller(['hub.getState']), { api: { calls: ['hub.getState', 'hub.getState'] } });
      t.put(t.builtin, 'nsonly', caller([]), { api: { namespaces: ['nsOnly'] } });
      await t.registry.loadAll();
      const snap = (id) => t.registry.snapshot().find((r) => r.id === id).manifest.api;
      assert.strictEqual(snap('many'), undefined);
      assert.strictEqual(snap('shape'), undefined);
      assert.deepStrictEqual(snap('dup').calls, ['hub.getState']);
      assert.strictEqual(globalThis.__v2call.many.api, 'undefined');
      assert.strictEqual(globalThis.__v2call.nsonly.call, 'function'); // ctx.api はあるので call は有るが、宣言が無いので何も呼べない
    } finally { t.done(); }
  });

  await test('止めたあとの呼び出しは plugin-stopped', async () => {
    const t = setup();
    try {
      globalThis.__v2call = {};
      const src = 'module.exports = {\n'
        + '  load(ctx) { globalThis.__v2ctx = ctx; },\n'
        + '  start() {}, stop() {}, destroy() {}\n};\n';
      t.put(t.builtin, 'later', src, { api: { calls: ['hub.getState'] } });
      await t.registry.loadAll();
      const ctx = globalThis.__v2ctx;
      assert.strictEqual((await ctx.api.call('hub.getState', {})).product, 'marust');
      fs.writeFileSync(path.join(t.builtin, 'later', 'index.js'), 'module.exports = { load() { throw new Error("x"); }, start() {}, stop() {}, destroy() {} };\n');
      assert.strictEqual((await t.registry.reload('later')).result, 'error');
      assert.deepStrictEqual(await ctx.api.call('hub.getState', {}), { ok: false, error: 'plugin-stopped' });
    } finally { t.done(); }
  });

  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
  console.log('v2-api-call: all passed');
})();
