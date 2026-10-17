'use strict';
require('./_ui-inline');

/**
 * P3: 上級の「プラグインの管理」（PLAN-plugin-core §7.2）。plugins.list・plugins.setHidden・隠したものの扱い。
 * 偽のもの（一時フォルダ・偽の状態）だけ。本物のサイト・OBS・Google には触らない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const { createApi } = require('../host/layer1/api');
const { createCore } = require('../host/core/core-bridge');
const { createUiSettings } = require('../host/layer1/ui-settings');
const { WINDOW_ID } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const real = createCore();
const base = { kind: 'ui', status: 'running', source: 'set', requires: [], provides: [], audience: 'public', stability: 'stable', version: '1.0.0', secretNames: [], needsCaps: [] };
const mkRow = (id, extra) => Object.assign({}, base, { id, name: id, mode: 'legacy' }, extra || {});
const feat = { label: 'タイマー', hint: '', level: 'standard', activation: 'live', group: 'timer', order: 60, needs: [], openPanel: 'plugin:timer:clock' };

function setup(rows, opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-'));
  const core = { STATE_DIR: dir, SERVICES_DIR: path.join(dir, 'services'), COOKIES_DIR: path.join(dir, 'cookies'), DATA_DIR: path.join(dir, 'data'), atomicWriteJsonSync: real.atomicWriteJsonSync };
  const ui = createUiSettings({ stateDir: dir, atomicWriteJsonSync: core.atomicWriteJsonSync });
  const state = { liveCount: o.liveCount || 0, destinations: o.destinations || [] };
  const events = [];
  const audits = [];
  // 偽の hub.getState。隠した印は ui-settings から付ける（electron-main の summarizePlugin と同じ）
  const api = createApi({
    core, confirmLive: true, uiSettings: ui,
    bus: { publish: (n, p) => events.push([n, p]) },
    audit: { write: (r) => audits.push(r) },
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    store: { snapshot: () => ({ destinations: state.destinations }) },
    tips: { get: () => ({ features: [] }), setFeature: () => ({ ok: true }) },
    getState() {
      const hidden = ui.getView().hiddenPlugins;
      return { product: 'marust', plugins: rows.map((r) => Object.assign({}, r, { hidden: hidden.indexOf(r.id) !== -1 })), destinations: { liveCount: state.liveCount }, engineStatus: { connected: true } };
    }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
  return { api, win, browser, ui, core, state, events, audits, rows, done() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
const modesOf = (t) => { try { return JSON.parse(fs.readFileSync(path.join(t.core.SERVICES_DIR, 'marust-modes.json'), 'utf8')).plugins; } catch (_) { return {}; } };

(async () => {
  await test('plugins.list: 一覧の項目・秘密は「名前」だけ・ウィンドウだけ（ほかの端末には出さない）', async () => {
    const t = setup([
      mkRow('timer', { name: 'タイマー', mode: 'live', feature: feat, provides: ['session.controller@1'] }),
      mkRow('gcal', { secretNames: ['google.oauth'], needsCaps: ['obs.read'] }),
      mkRow('ext-x', { source: 'user' }),
      mkRow('dev-only', { audience: 'dev' }),
      { id: 'skipped', status: 'skip' }
    ]);
    try {
      assert.strictEqual((await t.api.call('plugins.list', {}, t.browser)).error, 'forbidden');
      const r = await t.api.call('plugins.list', {}, t.win);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.plugins.map((p) => p.id), ['timer', 'gcal', 'ext-x'], '開発用・読めない行は出ない');
      const timer = r.plugins[0];
      assert.deepStrictEqual([timer.name, timer.version, timer.origin, timer.state, timer.mode, timer.feature], ['タイマー', '1.0.0', 'set', 'running', 'live', 'タイマー']);
      assert.deepStrictEqual(r.plugins[1].uses, { vaultNames: ['google.oauth'], needs: ['obs.read'], provides: [] });
      assert.strictEqual(r.plugins[2].origin, 'user');
      assert.strictEqual(r.plugins[2].hideBlock, 'not-set', '外部は隠せない（無効にするだけ）');
      assert.ok(!/token|password|cookie/i.test(JSON.stringify(r)));
    } finally { t.done(); }
  });

  await test('plugins.setHidden: 隠す＝legacy にして ui-settings に残す。戻す＝一覧に戻る（モードは legacy のまま）。ウィンドウだけ', async () => {
    const t = setup([mkRow('timer', { mode: 'live', feature: feat }), mkRow('overlay-basic')]);
    try {
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'timer', hidden: true }, t.browser)).error, 'forbidden');
      assert.deepStrictEqual(await t.api.call('plugins.setHidden', { id: 'timer', hidden: true }, t.win), { ok: true, id: 'timer', hidden: true });
      assert.strictEqual(modesOf(t).timer, 'legacy');
      assert.deepStrictEqual(t.ui.getView().hiddenPlugins, ['timer']);
      assert.ok(t.events.length >= 1 && t.audits.some((a) => a.method === 'plugins.setHidden'));
      assert.ok(!JSON.stringify(t.audits).includes('値'), '監査は id と hidden だけ');
      const listed = (await t.api.call('plugins.list', {}, t.win)).plugins.find((p) => p.id === 'timer');
      assert.strictEqual(listed.hidden, true);
      // 隠したものは「機能」一覧と modes.list の visible から外れる
      const features = (await t.api.call('features.list', {}, t.win)).features.map((f) => f.id);
      assert.ok(!features.includes('timer'));
      assert.strictEqual((await t.api.call('modes.list', {}, t.win)).plugins.find((p) => p.id === 'timer').visible, false);
      // 隠したあいだは有効にできない
      assert.strictEqual((await t.api.call('features.set', { id: 'timer', enabled: true }, t.win)).error, 'hidden');
      assert.strictEqual(modesOf(t).timer, 'legacy');
      // 戻す
      assert.deepStrictEqual(await t.api.call('plugins.setHidden', { id: 'timer', hidden: false }, t.win), { ok: true, id: 'timer', hidden: false });
      assert.deepStrictEqual(t.ui.getView().hiddenPlugins, []);
      assert.strictEqual(modesOf(t).timer, 'legacy');
      assert.strictEqual((await t.api.call('features.set', { id: 'timer', enabled: true }, t.win)).ok, true, '戻せば有効にできる');
      assert.strictEqual(modesOf(t).timer, 'live');
      // 同じ操作を繰り返しても壊れない
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'timer', hidden: false }, t.win)).ok, true);
    } finally { t.done(); }
  });

  await test('plugins.setHidden: 隠せないもの（配信中・配信先のあるサイト・土台・外部・知らない id・不正な id）', async () => {
    const rows = [mkRow('site-twitch', { site: { id: 'twitch', name: 'Twitch' } }), mkRow('sink-twitch'), mkRow('site-kick', { site: { id: 'kick', name: 'Kick' } }), mkRow('obs-engine'), mkRow('ext-x', { source: 'user' }), mkRow('timer', { mode: 'live' })];
    const t = setup(rows, { destinations: [{ id: 'd1', site: 'twitch' }] });
    try {
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'site-twitch', hidden: true }, t.win)).error, 'has-destination');
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'sink-twitch', hidden: true }, t.win)).error, 'has-destination');
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'obs-engine', hidden: true }, t.win)).error, 'core');
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'ext-x', hidden: true }, t.win)).error, 'not-set');
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'nope', hidden: true }, t.win)).error, 'unknown-plugin');
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'Bad Id!', hidden: true }, t.win)).error, 'bad-id');
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: '', hidden: true }, t.win)).error, 'bad-id');
      // 配信先の無いサイトは隠せる
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'site-kick', hidden: true }, t.win)).ok, true);
      // 配信中は隠せない
      t.state.liveCount = 1;
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'timer', hidden: true }, t.win)).error, 'streaming');
      assert.strictEqual(modesOf(t).timer, undefined, '何も書かない');
      assert.deepStrictEqual(t.ui.getView().hiddenPlugins, ['site-kick']);
      const listed = (await t.api.call('plugins.list', {}, t.win));
      assert.strictEqual(listed.streaming, true);
      const byId = (id) => listed.plugins.find((p) => p.id === id);
      assert.strictEqual(byId('timer').hideBlock, 'streaming');
      assert.strictEqual(byId('site-twitch').hideBlock, 'streaming', '配信中はまず「配信中」');
    } finally { t.done(); }
  });

  await test('Opus★1: 隠すときの守り（頼られている・兄弟が動いている・タイマー進行中）と、はっきり legacy を書く・上限・消えた id の整理', async () => {
    const rows = [
      mkRow('timer', { mode: 'live', provides: ['session.controller@1'] }),
      mkRow('gcal', { mode: 'live', requires: ['session.controller@1'] }),
      mkRow('site-youtube', { mode: 'legacy', siblings: ['site-youtube', 'slot-youtube'], site: { id: 'youtube', name: 'YouTube' } }),
      mkRow('slot-youtube', { mode: 'live', siblings: ['site-youtube', 'slot-youtube'] }),
      mkRow('overlay-basic', { mode: 'legacy' })
    ];
    const t = setup(rows);
    try {
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'timer', hidden: true }, t.win)).error, 'required-by');
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'site-youtube', hidden: true }, t.win)).error, 'siblings-on');
      // 既定の legacy（キー無し）でも、隠すときは legacy をはっきり書く
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'overlay-basic', hidden: true }, t.win)).ok, true);
      assert.strictEqual(modesOf(t)['overlay-basic'], 'legacy');
      // 消えた id は、次の操作で自動で外れる
      t.ui.set({ hiddenPlugins: 'overlay-basic,gone-plugin' });
      assert.strictEqual((await t.api.call('plugins.setHidden', { id: 'gcal', hidden: true }, t.win)).ok, true);
      assert.deepStrictEqual(t.ui.getView().hiddenPlugins, ['overlay-basic', 'gcal']);
      // 上限
      const many = []; for (let i = 0; i < 100; i += 1) many.push('p' + i);
      assert.strictEqual(t.ui.set({ hiddenPlugins: many.join(',') }).ok, true);
      assert.strictEqual(t.ui.getView().hiddenPlugins.length, 100);
    } finally { t.done(); }
    const s = setup([mkRow('timer', { mode: 'live', provides: ['session.controller@1'] })]);
    try {
      const rowsWithSessions = createApi({
        core: s.core, confirmLive: true, uiSettings: s.ui, audit: { write() {} }, bus: { publish() {} },
        devMode: { get: () => ({ devMode: false, source: 'default' }) },
        sessions: { view: () => ({ active: true }) },
        getState() { return { product: 'marust', plugins: [mkRow('timer', { mode: 'live', provides: ['session.controller@1'] })], destinations: { liveCount: 0 } }; }
      });
      assert.strictEqual((await rowsWithSessions.call('plugins.setHidden', { id: 'timer', hidden: true }, s.win)).error, 'session-active');
    } finally { s.done(); }
  });

  await test('Opus★1: 管理画面の「無効にする」は配信中ならサーバーが断る（画面の古い表示に頼らない）', async () => {
    const t = setup([mkRow('timer', { mode: 'live', feature: feat })], { liveCount: 0 });
    try {
      assert.strictEqual((await t.api.call('plugins.disable', { id: 'timer' }, t.browser)).error, 'forbidden');
      t.state.liveCount = 2;
      assert.strictEqual((await t.api.call('plugins.disable', { id: 'timer' }, t.win)).error, 'streaming');
      assert.strictEqual(modesOf(t).timer, undefined);
      t.state.liveCount = 0;
      assert.strictEqual((await t.api.call('plugins.disable', { id: 'timer' }, t.win)).ok, true);
      assert.strictEqual(modesOf(t).timer, 'legacy');
    } finally { t.done(); }
  });

  await test('隠した印は ui-settings の hiddenPlugins だけに残る。不正な値は拒否・読み書きで他のキーを壊さない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-ui-'));
    try {
      const ui = createUiSettings({ stateDir: dir, atomicWriteJsonSync: real.atomicWriteJsonSync });
      assert.strictEqual(ui.set({ uiLevel: 'advanced' }).ok, true);
      assert.strictEqual(ui.set({ hiddenPlugins: 'timer,gcal' }).ok, true);
      assert.deepStrictEqual(ui.getView().hiddenPlugins, ['timer', 'gcal']);
      assert.strictEqual(ui.getView().uiLevel, 'advanced');
      assert.strictEqual(ui.set({ hiddenPlugins: 'Bad Id' }).error, 'bad-value');
      assert.strictEqual(ui.set({ hiddenPlugins: '' }).ok, true);
      assert.deepStrictEqual(ui.getView().hiddenPlugins, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('画面: 管理パネルは文字を strings.js から使い、「機能を足す」のようにプラグイン語は上級だけ。＋の一覧は隠したサイトを出さない', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const STR = require('../plugins/ui-standard/shell/strings');
    const panel = read('plugins/ui-standard/shell/panels/plugin-manager.js');
    ['plugins.list', 'plugins.setHidden', 'modes.set', 'STR.pluginManagerHide', 'STR.pluginManagerUnhide', 'STR.pluginManagerConfirm', 'p.uses.vaultNames'].forEach((s) => assert.ok(panel.includes(s), s));
    const keys = [...panel.matchAll(/STR\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    keys.forEach((k) => assert.ok(k in STR, '未定義の文字: ' + k));
    assert.ok(!/secret|token/i.test(panel.replace(/vaultNames|pluginManagerSecrets|\bsecrets\b/g, '')), '値を扱わない');
    assert.ok(require('./_ui-source').shellDocument().includes('id="plugin-manager-list"'));
    assert.ok(read('plugins/ui-standard/shell/panels/site-add.js').includes('r.hidden !== true'));
    assert.ok(STR.pluginManagerBlock('has-destination').length > 0 && STR.pluginManagerBlock('zzz') === '');
  });

  if (failed) { console.error('\n[p3] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] p3 plugin manager tests passed');
})();
