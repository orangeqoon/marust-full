'use strict';
const { siteManifests } = require('./_plugins');
// R5: ログインの状態・準備。秘密（client_secret・トークン・設定の値）が、答え・ログ・監査・画面向けの形のどこにも出ないこと。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createSiteLogin, oauthState } = require('../plugins/site-login/lib/login');
const { createSiteConfig } = require('../host/layer1/site-config');
const { createApi } = require('../host/layer1/api');
const { summarizeSite } = require('../host/layer1/site-info');
const { WINDOW_ID } = require('../host/layer1/clients');

const SECRET = 'client-secret-SHOULD-NOT-LEAK-5c2e';
const TOKEN = 'access-token-SHOULD-NOT-LEAK-8d1f';
const PICARTO = 'picarto-token-SHOULD-NOT-LEAK-2b9a';

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) walk(file, out); else out.push(file);
  }
  return out;
}

async function main() {
  // ---- 状態の判定（純粋関数）
  const now = Date.parse('2026-10-07T00:00:00Z');
  assert.strictEqual(oauthState(null, now), 'none');
  assert.strictEqual(oauthState({ client_id: 'a' }, now), 'none');
  assert.strictEqual(oauthState({ client_id: 'a', client_secret: 'b' }, now), 'keys-only');
  assert.strictEqual(oauthState({ client_id: 'a', client_secret: 'b', refresh_token: 'r' }, now), 'logged-in');
  assert.strictEqual(oauthState({ client_id: 'a', client_secret: 'b', access_token: 't', expiry_date: now + 1000 }, now), 'logged-in');
  assert.strictEqual(oauthState({ client_id: 'a', client_secret: 'b', access_token: 't', expiry_date: now - 1000 }, now), 'expired');
  assert.strictEqual(oauthState({ client_id: 'a', client_secret: 'b', access_token: 't', expires_in: 60, obtained_at: now - 120000 }, now), 'expired');
  assert.strictEqual(oauthState({ client_id: 'a', client_secret: 'b', access_token: 't' }, now), 'logged-in');
  // NeonTimer から取り込んだ Twitch: client_secret が無くてもトークンがあれば logged-in
  assert.strictEqual(oauthState({ client_id: 'a', access_token: 't' }, now), 'logged-in');
  assert.strictEqual(oauthState({ client_id: 'a', refresh_token: 'r' }, now), 'logged-in');
  assert.strictEqual(oauthState({ client_id: 'a' }, now), 'none');

  // ---- 金庫と API
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-r5-'));
  const core = { STATE_DIR: dir, SERVICES_DIR: path.join(dir, 'services'), atomicWriteJsonSync: real.atomicWriteJsonSync };
  const logs = [];
  const vault = createSecretProvider({ core: core, backend: createFakeBackend(), allowFake: true, logger(l, m) { logs.push(String(m)); } });
  const sites = [
    { id: 'youtube', login: { type: 'oauth' }, secretNames: ['youtube.oauth'] },
    { id: 'twitch', login: { type: 'oauth' }, secretNames: ['twitch.oauth'] },
    { id: 'niconico', login: { type: 'cookie' }, secretNames: ['cookies.niconico-main'] },
    { id: 'picarto', login: { type: 'config' }, secretNames: ['picarto.config'],
      configSchema: [{ name: 'token', label: 'T', secret: true, required: true }, { name: 'channel', label: 'C', secret: false, required: true }] },
    { id: 'fc2', login: { type: 'config' }, secretNames: ['fc2.config'] },
    { id: 'plain', login: { type: 'none' }, secretNames: [] }
  ];
  // K3: OAuth の状態・鍵はプラグイン site-login（宣言した名前だけの ctx.secrets 相当）、設定欄と有無は核の site-config
  const siteConfig = createSiteConfig({ secrets: vault, reader: vault.coreReader('site-login', () => true), getSites: async () => sites });
  const ctxSecrets = {
    get: (name) => vault.coreReader('site-login', () => true).get(name),
    set: (name, value) => vault.set(name, value, 'site-login')
  };
  const login = createSiteLogin({ secrets: ctxSecrets, loginFacts: () => siteConfig.loginFacts(), now: () => now });
  const auditRows = [];
  const api = createApi({
    core: core,
    secrets: vault,
    siteConfig: siteConfig,
    devMode: { get: () => ({ devMode: false, source: 'default' }) }, // 一般の画面でも使える
    audit: { write(row) { auditRows.push(row); } },
    getState() { return { plugins: [] }; }
  });
  api.registerPluginMethod('sites', 'sites.loginStatus', { access: 'read', windowOnly: true, params: {} }, () => login.status(), { audience: 'public' });
  api.registerPluginMethod('sites', 'sites.setOAuthApp', {
    access: 'write', windowOnly: true,
    params: {
      site: { type: 'string', required: true, max: 16, enum: ['youtube', 'twitch', 'kick', 'google'], error: 'unknown-site' },
      clientId: { type: 'string', required: true, max: 2000, typeError: 'bad-client-id', lengthError: 'bad-client-id' },
      clientSecret: { type: 'string', required: true, max: 2000, typeError: 'bad-client-secret', lengthError: 'bad-client-secret' },
      redirectUri: { type: 'string', required: false, max: 200, typeError: 'bad-redirect', lengthError: 'bad-redirect' }
    }
  }, (params) => login.setOAuthApp(params), { audience: 'public' });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };

  // ウィンドウだけ
  for (const method of ['sites.loginStatus', 'sites.setOAuthApp', 'sites.setConfig']) {
    assert.strictEqual((await api.call(method, { site: 'youtube', clientId: 'a', clientSecret: 'b', fields: {} }, browser)).error, 'forbidden', method);
  }

  // 最初は全部 none（ログイン不要の種類は出ない）
  let st = await api.call('sites.loginStatus', {}, win);
  assert.deepStrictEqual(st.sites.map((r) => r.id + ':' + r.state), ['youtube:none', 'twitch:none', 'niconico:none', 'picarto:none', 'fc2:none']);

  // 戻り先を省いたときの既定値が返る（YouTube は /oauth2callback つき）
  const yt = (await api.call('sites.loginStatus', {}, win)).sites.find((r) => r.id === 'youtube');
  assert.strictEqual(yt.defaultRedirect, 'http://localhost:3000/oauth2callback');

  // OAuth アプリの鍵
  assert.strictEqual((await api.call('sites.setOAuthApp', { site: 'niconico', clientId: 'a', clientSecret: 'b' }, win)).error, 'unknown-site');
  assert.strictEqual((await api.call('sites.setOAuthApp', { site: 'youtube', clientId: '', clientSecret: SECRET }, win)).error, 'bad-client-id');
  assert.strictEqual((await api.call('sites.setOAuthApp', { site: 'youtube', clientId: 'cid', clientSecret: '' }, win)).error, 'bad-client-secret');
  assert.strictEqual((await api.call('sites.setOAuthApp', { site: 'youtube', clientId: 'cid', clientSecret: SECRET, redirectUri: 'https://evil.example/cb' }, win)).error, 'bad-redirect');
  const saved = await api.call('sites.setOAuthApp', { site: 'youtube', clientId: 'cid', clientSecret: SECRET, redirectUri: 'http://localhost:3000/oauth2callback' }, win);
  assert.deepStrictEqual(saved, { ok: true });
  st = await api.call('sites.loginStatus', {}, win);
  assert.strictEqual(st.sites.find((r) => r.id === 'youtube').state, 'keys-only');

  // 既にトークンがあるサイトの鍵を入れ直しても、トークンは残る
  await vault.set('twitch.oauth', JSON.stringify({ client_id: 'old', client_secret: 'old', access_token: TOKEN, refresh_token: 'r', expiry_date: now - 5 }), 'test');
  assert.strictEqual((await api.call('sites.loginStatus', {}, win)).sites.find((r) => r.id === 'twitch').state, 'logged-in');
  await api.call('sites.setOAuthApp', { site: 'twitch', clientId: 'new-id', clientSecret: SECRET }, win);
  const kept = JSON.parse((await vault.coreReader('test', () => true).get('twitch.oauth')).value);
  assert.strictEqual(kept.client_id, 'new-id');
  assert.strictEqual(kept.access_token, TOKEN);

  // Cookie は有無だけ
  await vault.set('cookies.niconico-main', 'cookie-value-SHOULD-NOT-LEAK', 'test');
  assert.strictEqual((await api.call('sites.loginStatus', {}, win)).sites.find((r) => r.id === 'niconico').state, 'logged-in');

  // 設定欄（configSchema にある項目だけ）
  assert.strictEqual((await api.call('sites.setConfig', { site: 'fc2', fields: { x: 'y' } }, win)).error, 'unknown-site'); // 欄の定義が無い
  assert.strictEqual((await api.call('sites.setConfig', { site: 'picarto', fields: { evil: 'x' } }, win)).error, 'bad-field');
  assert.strictEqual((await api.call('sites.setConfig', { site: 'picarto', fields: { token: PICARTO } }, win)).error, 'missing-field'); // channel が無い
  assert.strictEqual((await api.call('sites.setConfig', { site: 'picarto', fields: { token: PICARTO, channel: 'me' } }, win)).ok, true);
  const cfg = JSON.parse((await vault.coreReader('test', () => true).get('picarto.config')).value);
  assert.deepStrictEqual(cfg, { token: PICARTO, channel: 'me' });
  // 空欄は今のまま
  await api.call('sites.setConfig', { site: 'picarto', fields: { token: '', channel: 'you' } }, win);
  const cfg2 = JSON.parse((await vault.coreReader('test', () => true).get('picarto.config')).value);
  assert.deepStrictEqual(cfg2, { token: PICARTO, channel: 'you' });

  // ---- 秘密がどこにも出ない
  const answers = JSON.stringify([saved, st, await api.call('sites.loginStatus', {}, win)]);
  for (const secret of [SECRET, TOKEN, PICARTO, 'cookie-value-SHOULD-NOT-LEAK']) {
    assert.ok(!answers.includes(secret), 'answer leaks ' + secret);
    assert.ok(!JSON.stringify(auditRows).includes(secret), 'audit leaks');
    assert.ok(!logs.join('\n').includes(secret), 'log leaks');
    for (const file of walk(dir, [])) {
      assert.ok(!fs.readFileSync(file, 'utf8').includes(secret), 'disk leaks in ' + path.basename(file));
    }
  }
  // 監査は引数の名前だけ
  assert.ok(auditRows.filter((r) => r.method === 'sites.setOAuthApp').every((r) => r.paramNames.every((n) => ['site', 'clientId', 'clientSecret', 'redirectUri', 'fields'].indexOf(n) !== -1)));

  // ---- 画面向けの形（manifest → summarizeSite）に値は無く、名前だけ
  const info = summarizeSite({ id: 'picarto', name: 'P', login: { type: 'config' }, configSchema: [{ name: 'token', label: 'T', secret: true, required: true, value: 'LEAK' }, { name: '../bad' }] }, 'site-picarto', 'legacy', ['picarto.config', 'Bad Name']);
  assert.deepStrictEqual(info.secretNames, ['picarto.config']);
  assert.deepStrictEqual(info.configSchema, [{ name: 'token', label: 'T', secret: true, required: true }]);
  assert.ok(!JSON.stringify(info).includes('LEAK'));

  // 実際の manifest: 3 サイトの OAuth 名が secrets にある
  const siteManifestOf = (id) => siteManifests().find((row) => row.name === 'site-' + id).manifest;
  for (const id of ['youtube', 'twitch']) {
    const m = siteManifestOf(id);
    assert.ok(m.secrets.indexOf(id + '.oauth') !== -1);
    assert.strictEqual(m.site.login.type, 'oauth');
  }
  const pic = siteManifestOf('picarto');
  assert.ok(pic.site.configSchema.length === 2 && pic.secrets.indexOf('picarto.config') !== -1);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok r5-login');
}

main().catch((err) => { console.error(err); process.exit(1); });
