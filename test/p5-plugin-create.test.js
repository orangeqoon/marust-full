'use strict';
require('./_ui-inline');

/**
 * P5「作る」: plugin.create（ひな形を空いている id のときだけ作る・上書きしない）・plugin.openFolder・
 * ★3 M1（開発者モードがオフでも、外部の有効化は id を入力すれば通る。内蔵は dev-only のまま）。
 * 偽のもの（一時フォルダ・偽の状態）だけ。本物のサイト・OBS・Google には触らない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const { createApi } = require('../host/layer1/api');
const { createCore } = require('../host/core/core-bridge');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createAppInstaller } = require('../host/layer1/plugin-install-wire');
const { WINDOW_ID } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const real = createCore();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-'));
  const stateDir = path.join(root, 'state');
  const builtin = path.join(root, 'builtin');
  fs.mkdirSync(path.join(stateDir, 'services'), { recursive: true });
  fs.mkdirSync(path.join(builtin, 'timer'), { recursive: true });
  fs.writeFileSync(path.join(builtin, 'timer', 'manifest.json'), JSON.stringify({ id: 'timer', name: 'timer', version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration' }));
  fs.writeFileSync(path.join(builtin, 'timer', 'index.js'), 'module.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n');
  const core = { STATE_DIR: stateDir, SERVICES_DIR: path.join(stateDir, 'services'), COOKIES_DIR: path.join(stateDir, 'cookies'), DATA_DIR: path.join(stateDir, 'data'), atomicWriteJsonSync: real.atomicWriteJsonSync };
  const modesFile = path.join(core.SERVICES_DIR, 'marust-modes.json');
  const modeOf = (id) => { try { return JSON.parse(fs.readFileSync(modesFile, 'utf8')).plugins[id] || 'legacy'; } catch (_) { return 'legacy'; } };
  const audits = [];
  const registry = createRegistry({ core, appRoot: root, builtinRoot: builtin, authorRoot: path.join(root, 'no-author'), externalRoot: path.join(stateDir, 'plugins'), logger() {}, modeFor: modeOf });
  registry.discover();
  const st = { streaming: false, opened: [] };
  const installer = createAppInstaller({ core, registry, bus: { publish() {} }, audit: { write: (r) => audits.push(r) }, isStreaming: async () => st.streaming, modeOf });
  const api = createApi({
    core, confirmLive: true,
    bus: { publish() {} },
    audit: { write: (r) => audits.push(r) },
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    getState: () => ({ product: 'marust', plugins: registry.snapshot().map((r) => Object.assign({}, r, { mode: modeOf(r.id) })), destinations: { liveCount: st.streaming ? 1 : 0 }, engineStatus: { connected: true } }),
    pluginRegistry: registry,
    pluginInstaller: installer,
    openPluginFolder: async (id) => { st.opened.push(id); return { ok: true }; }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
  return { root, stateDir, modesFile, modeOf, audits, registry, installer, api, win, browser, st, plugins: path.join(stateDir, 'plugins'), done() { fs.rmSync(root, { recursive: true, force: true }); } };
}

(async () => {
  await test('権限: plugin.create / plugin.openFolder は write・ウィンドウだけ', async () => {
    const t = setup();
    try {
      assert.strictEqual(t.api.permissionFor('plugin.create'), 'write');
      assert.strictEqual(t.api.permissionFor('plugin.openFolder'), 'write');
      for (const m of ['plugin.create', 'plugin.openFolder']) {
        const r = await t.api.call(m, { id: 'my-memo' }, t.browser);
        assert.strictEqual(r.error, 'forbidden', m);
      }
      assert.ok(!fs.existsSync(path.join(t.plugins, 'my-memo')));
    } finally { t.done(); }
  });

  await test('作る: 空いている id でひな形ができ、使っていない（legacy）・一覧に出る・場所は返さない・試験ファイルは作らない', async () => {
    const t = setup();
    try {
      const r = await t.api.call('plugin.create', { id: 'my-memo', path: '/etc/evil' }, t.win);
      assert.deepStrictEqual(r, { ok: true, id: 'my-memo' });
      const dir = path.join(t.plugins, 'my-memo');
      ['manifest.json', 'index.js', 'ui/panel.html', 'ui/panel.js'].forEach((f) => assert.ok(fs.existsSync(path.join(dir, f)), f));
      assert.ok(!fs.existsSync(path.join(dir, 'test')));
      assert.strictEqual(t.modeOf('my-memo'), 'legacy');
      const row = t.registry.snapshot().find((x) => x.id === 'my-memo');
      assert.ok(row && row.source === 'user', '一覧に外部として出る');
      assert.ok(!fs.readdirSync(t.plugins).some((n) => n.indexOf('.tmp-') === 0), '一時フォルダが残らない');
      assert.ok(t.audits.some((a) => a.method === 'plugin.create' && a.paramNames.indexOf('id:my-memo') !== -1));
      assert.ok(!JSON.stringify(t.audits).includes(t.stateDir.replace(/\\/g, '\\\\')), '監査に場所を出さない');
    } finally { t.done(); }
  });

  await test('作ったひな形は、入れるときと同じ検査（inspect）を通る', async () => {
    const t = setup();
    try {
      await t.api.call('plugin.create', { id: 'my-memo' }, t.win);
      const res = await t.installer.inspect(path.join(t.plugins, 'my-memo'));
      assert.strictEqual(res.ok, true, res.error);
      assert.strictEqual(res.id, 'my-memo');
    } finally { t.done(); }
  });

  await test('作る: すでにある id（外部・内蔵・戻せる版）は何も書かずに断る。上書きしない', async () => {
    const t = setup();
    try {
      await t.api.call('plugin.create', { id: 'my-memo' }, t.win);
      const mine = path.join(t.plugins, 'my-memo', 'index.js');
      fs.writeFileSync(mine, '// 自分で書いた\n');
      const again = await t.api.call('plugin.create', { id: 'my-memo' }, t.win);
      assert.deepStrictEqual(again, { ok: false, error: 'exists' });
      assert.strictEqual(fs.readFileSync(mine, 'utf8'), '// 自分で書いた\n');
      const builtin = await t.api.call('plugin.create', { id: 'timer' }, t.win);
      assert.strictEqual(builtin.error, 'id-reserved');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'timer')));
      const bk = path.join(t.stateDir, 'plugins-backup', 'old-one-1.0.0');
      fs.mkdirSync(bk, { recursive: true });
      fs.writeFileSync(path.join(bk, 'manifest.json'), JSON.stringify({ id: 'old-one', version: '1.0.0' }));
      assert.strictEqual((await t.api.call('plugin.create', { id: 'old-one' }, t.win)).error, 'exists');
    } finally { t.done(); }
  });

  await test('作る: 使えない id・予約語は断る', async () => {
    const t = setup();
    try {
      const bad = ['', 'a', '../x', 'x/y', 'site-foo', 'slot-x', 'sink-x', 'chat-x', 'default', 'obs-engine', 'sites', 'UPPER', 'a'.repeat(33), '1abc', 'con '];
      for (const id of bad) {
        const r = await t.api.call('plugin.create', { id }, t.win);
        assert.strictEqual(r.ok, false, JSON.stringify(id));
      }
      assert.deepStrictEqual(fs.existsSync(t.plugins) ? fs.readdirSync(t.plugins) : [], []);
    } finally { t.done(); }
  });

  await test('作る: 配信中は断る（何も作らない）', async () => {
    const t = setup();
    try {
      t.st.streaming = true;
      const r = await t.api.call('plugin.create', { id: 'my-memo' }, t.win);
      assert.strictEqual(r.error, 'streaming');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'my-memo')));
    } finally { t.done(); }
  });

  await test('フォルダを開く: 一覧にある id だけ・場所は返さない', async () => {
    const t = setup();
    try {
      await t.api.call('plugin.create', { id: 'my-memo' }, t.win);
      assert.strictEqual((await t.api.call('plugin.openFolder', { id: '../state' }, t.win)).ok, false);
      assert.strictEqual((await t.api.call('plugin.openFolder', { id: 'timer' }, t.win)).error, 'not-installed');
      const r = await t.api.call('plugin.openFolder', { id: 'my-memo' }, t.win);
      assert.deepStrictEqual(r, { ok: true });
      assert.deepStrictEqual(t.st.opened, ['my-memo']);
    } finally { t.done(); }
  });

  await test('★3 M1: 開発者モードがオフでも、外部は id を入力すれば試すだけ・有効にできる。違う id は断る。内蔵は dev-only のまま', async () => {
    const t = setup();
    try {
      await t.api.call('plugin.create', { id: 'my-memo' }, t.win);
      const wrong = await t.api.call('modes.set', { id: 'my-memo', mode: 'shadow', confirmName: 'nope' }, t.win);
      assert.strictEqual(wrong.error, 'confirm-name');
      assert.strictEqual(t.modeOf('my-memo'), 'legacy');
      const shadow = await t.api.call('modes.set', { id: 'my-memo', mode: 'shadow', confirmName: 'my-memo' }, t.win);
      assert.strictEqual(shadow.ok, true, shadow.error);
      assert.strictEqual(t.modeOf('my-memo'), 'shadow');
      const live = await t.api.call('modes.set', { id: 'my-memo', mode: 'live', confirmName: 'my-memo' }, t.win);
      assert.strictEqual(live.ok, true, live.error);
      const builtin = await t.api.call('modes.set', { id: 'timer', mode: 'live', confirmName: 'timer' }, t.win);
      assert.strictEqual(builtin.error, 'dev-only');
      assert.strictEqual(t.modeOf('timer'), 'legacy');
      assert.strictEqual((await t.api.call('modes.setDefault', { mode: 'live' }, t.win)).error, 'dev-only');
    } finally { t.done(); }
  });

  await test('画面の文字: 依頼文（外部の制限の要点を含む）・案内ページ・パネルが plugin.create を呼ぶ', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'strings.js'), 'utf8');
    const STR = new Function(src + '; return STR;')();
    const text = STR.pluginMakeAiRequest;
    ['manifestVersion', 'inproc', 'ext.<自分のid>', 'obs.streamControl', 'chat.source@1', 'ctx.core', 'legacy', 'shadow', 'live'].forEach((w) => assert.ok(text.includes(w), w));
    assert.ok(text.split('\n').length > 20, '改行で区切られている');
    assert.ok(STR.pluginMakeErr('exists').length > 0);
    assert.ok(fs.existsSync(path.join(__dirname, '..', STR.pluginMakeGuidePath)));
    const panel = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'panels', 'plugin-manager.js'), 'utf8');
    assert.ok(/plugin\.create/.test(panel));
  });

  if (failed) { console.error('\n[p5] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] p5 plugin-create tests passed');
})();
