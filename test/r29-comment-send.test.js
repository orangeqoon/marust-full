'use strict';

// R25（M7 の答え）: sites.setCommentSend。コメントの書き込み（sink-<サイト>）を一般の画面からオン・オフする。
// 条件: 「題名を送る」（site-<サイト>）がオン・ログイン済み・公開。送信のコードは増やさず、役目のモードだけ切り替える。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createApi } = require('../host/layer1/api');
const { createUiSettings } = require('../host/layer1/ui-settings');
const { WINDOW_ID } = require('../host/layer1/clients');

const real = createCore();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-r29-'));
const core = { STATE_DIR: dir, SERVICES_DIR: path.join(dir, 'services'), COOKIES_DIR: path.join(dir, 'cookies'), DATA_DIR: path.join(dir, 'data'), atomicWriteJsonSync: real.atomicWriteJsonSync };
const modesFile = () => JSON.parse(fs.readFileSync(path.join(core.SERVICES_DIR, 'marust-modes.json'), 'utf8'));

const base = { kind: 'integration', status: 'running', source: 'set', requires: [], provides: [], audience: 'public', stability: 'stable' };
const siteRow = (s, mode, extra) => Object.assign({}, base, { id: 'site-' + s, name: s, mode: mode, site: { id: s, name: s, tier: 'core' } }, extra || {});
const sinkRow = (s, mode, extra) => Object.assign({}, base, { id: 'sink-' + s, name: s + ' sink', mode: mode }, extra || {});

(async () => {
  const rows = [
    siteRow('twitch', 'legacy'), sinkRow('twitch', 'legacy'),
    siteRow('kick', 'live', { stability: 'experimental' }), sinkRow('kick', 'legacy', { stability: 'experimental' }),
    siteRow('rumble', 'live')
  ];
  let loginState = 'none';
  const ui = createUiSettings({ stateDir: dir, atomicWriteJsonSync: core.atomicWriteJsonSync });
  const api = createApi({
    core, confirmLive: false, uiSettings: ui,
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    audit: { write() {} },
    getState() { return { product: 'marust', plugins: rows }; }
  });
  // ログインの状態はプラグイン site-login が出す（K3）。核は callInternal で読む
  api.registerPluginMethod('site-login', 'sites.loginStatus', { access: 'read', windowOnly: true, params: {} }, async () => ({ ok: true, sites: [{ id: 'twitch', type: 'oauth', state: loginState }, { id: 'kick', type: 'oauth', state: 'logged-in' }] }), { audience: 'public', builtin: true, roles: ['site.login@1'] });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
  const call = (p, c) => api.call('sites.setCommentSend', p, c || win);

  assert.strictEqual((await call({ site: 'twitch', on: true }, browser)).error, 'forbidden', 'ウィンドウだけ');
  assert.strictEqual((await call({ site: 'twitch', on: 'yes' })).error, 'bad-value');
  assert.strictEqual((await call({ site: '', on: true })).error, 'bad-id');
  assert.strictEqual((await call({ site: 'Bad Site', on: true })).error, 'bad-id');
  assert.strictEqual((await call({ site: 'nope', on: true })).error, 'bad-id');
  assert.strictEqual((await call({ site: 'rumble', on: true })).error, 'bad-id', 'sink の役目が無いサイト');

  // 「題名を送る」がオフなら先にそちら
  assert.strictEqual((await call({ site: 'twitch', on: true })).error, 'send-off');
  rows[0].mode = 'live';
  // ログインが無い
  assert.strictEqual((await call({ site: 'twitch', on: true })).error, 'not-logged-in');
  loginState = 'expired';
  assert.strictEqual((await call({ site: 'twitch', on: true })).error, 'not-logged-in');
  // 試験中のサイトは「試験中も表示する」がオンのときだけ
  assert.strictEqual((await call({ site: 'kick', on: true })).error, 'bad-id');

  loginState = 'logged-in';
  const on = await call({ site: 'twitch', on: true });
  assert.deepStrictEqual(on, { ok: true, id: 'sink-twitch', on: true });
  assert.strictEqual(modesFile().plugins['sink-twitch'], 'live');
  assert.ok(!('site-twitch' in modesFile().plugins) || modesFile().plugins['site-twitch'] !== 'live', '題名の役目は触らない');

  // オフは条件なし（ログインが切れていても止められる）
  loginState = 'none';
  const off = await call({ site: 'twitch', on: false });
  assert.deepStrictEqual(off, { ok: true, id: 'sink-twitch', on: false });
  assert.strictEqual(modesFile().plugins['sink-twitch'], 'legacy');

  ui.set({ showExperimental: true });
  assert.strictEqual((await call({ site: 'kick', on: true })).ok, true, '試験中を表示するときは対象');
  await call({ site: 'kick', on: false });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('[marust] r29 comment-send tests passed');
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
