'use strict';
const { siteManifests } = require('./_plugins');
// R4: サイトの説明（manifest.site）、sites.setSend、obs.setControl、audience/stability の通し、試験中の表示。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createApi } = require('../host/layer1/api');
const { createUiSettings } = require('../host/layer1/ui-settings');
const { summarizeSite } = require('../host/layer1/site-info');
const { WINDOW_ID } = require('../host/layer1/clients');

function tempBag() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-r4-'));
  return {
    dir: dir,
    core: {
      STATE_DIR: dir,
      SERVICES_DIR: path.join(dir, 'services'),
      COOKIES_DIR: path.join(dir, 'cookies'),
      DATA_DIR: path.join(dir, 'data'),
      atomicWriteJsonSync: real.atomicWriteJsonSync
    }
  };
}

function site(id, extra) {
  return Object.assign({
    id: id, name: id, kind: 'site', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [],
    audience: 'public', stability: 'stable',
    site: { id: id.replace(/^site-/, ''), name: id, tier: 'core' }
  }, extra || {});
}

function modesFile(core) {
  return JSON.parse(fs.readFileSync(path.join(core.SERVICES_DIR, 'marust-modes.json'), 'utf8'));
}

async function main() {
  // ---- 1. manifest の整合（配る 10 サイト）
  const sites = siteManifests();
  assert.strictEqual(sites.length, 10);
  const core3 = ['site-twitch', 'site-youtube', 'site-niconico'];
  for (const { name, manifest: m } of sites) {
    assert.strictEqual(m.audience, 'public', name);
    assert.strictEqual(m.stability, core3.indexOf(name) !== -1 ? 'stable' : 'experimental', name);
    assert.ok(m.site && m.site.id === name.replace(/^site-/, ''), name + ' site.id');
    assert.strictEqual(m.site.tier, core3.indexOf(name) !== -1 ? 'core' : 'extra', name);
    const s = summarizeSite(m.site, name, 'legacy');
    assert.ok(s && s.name, name);
    // 書いた URL は全部 https か rtmp(s)（推測の URL・怪しい形を許さない）
    for (const url of [m.site.keyHelpUrl, m.site.tosUrl].concat((m.site.ingest || []).map((r) => r.helpUrl))) {
      assert.ok(url === null || /^https:\/\/[^\s]+$/.test(url), name + ' url ' + url);
    }
    for (const row of m.site.ingest || []) assert.ok(row.url === null || /^rtmps?:\/\//.test(row.url));
    if (core3.indexOf(name) !== -1) {
      assert.ok(m.site.keyHelpUrl && m.site.tosUrl, name + ' needs keyHelpUrl and tosUrl');
      assert.ok(m.site.ingest.length >= 1);
    }
  }
  // L4b: 公式で確かめた 3 サイトは keyHelpUrl と案内つきの ingest、確かめられなかった 4 サイトは URL を書かない
  for (const { name, manifest: m } of sites) {
    const id = name.replace(/^site-/, '');
    if (['kick', 'rumble', 'twitcasting'].indexOf(id) !== -1) {
      assert.ok(/^https:\/\/[^\s]+$/.test(m.site.keyHelpUrl), id + ' keyHelpUrl');
      assert.ok(m.site.ingest.length >= 1 && m.site.ingest.every((r) => r.url === null && /^https:\/\//.test(r.helpUrl)), id + ' ingest');
    }
    if (['fc2', 'kukulu'].indexOf(id) !== -1) {
      assert.ok(m.site.ingest.every((r) => !r.url), id + ' に推測の URL を書かない');
      assert.strictEqual(m.site.keyHelpUrl, null, id);
      assert.ok(m.site.addHint && m.site.addHint.length <= 200, id + ' addHint');
    }
    if (['picarto', 'soop'].indexOf(id) !== -1) {
      assert.ok(m.site.ingest.length >= 1 && m.site.ingest.every((r) => /^rtmp:\/\//.test(r.url)), id + ' ingest は rtmp://');
      assert.strictEqual(m.site.keyHelpUrl, null, id);
      assert.ok(m.site.addHint && m.site.addHint.length <= 200, id + ' addHint');
    }
  }
  // 引用の整理: 画面へ渡す形に危ない文字列が無い
  const bad = summarizeSite({ id: 'x', name: 'x', tosUrl: 'javascript:alert(1)', keyHelpUrl: 'http://insecure.example', ingest: [{ label: 'a', url: 'file:///c:/x', helpUrl: 'data:text/html,x' }] }, 'site-x', 'live');
  assert.strictEqual(bad.tosUrl, '');
  assert.strictEqual(bad.keyHelpUrl, '');
  assert.strictEqual(bad.ingest[0].url, '');
  assert.strictEqual(bad.ingest[0].helpUrl, '');
  assert.strictEqual(bad.send, true);
  assert.strictEqual(summarizeSite({ id: 'x' }, 'chat-x', 'legacy'), null);

  // ---- 2. ui-settings: 他のキー（devMode）を壊さない
  const bag = tempBag();
  const ui = createUiSettings({ stateDir: bag.dir, atomicWriteJsonSync: bag.core.atomicWriteJsonSync });
  assert.deepStrictEqual(ui.get(), { showExperimental: false });
  fs.mkdirSync(path.join(bag.dir, 'data', 'marust'), { recursive: true });
  fs.writeFileSync(path.join(bag.dir, 'data', 'marust', 'ui-settings.json'), JSON.stringify({ devMode: true, layout: 'x' }));
  assert.strictEqual(ui.set({ showExperimental: true }).showExperimental, true);
  const doc = JSON.parse(fs.readFileSync(path.join(bag.dir, 'data', 'marust', 'ui-settings.json'), 'utf8'));
  assert.deepStrictEqual(doc, { devMode: true, layout: 'x', showExperimental: true });
  assert.strictEqual(ui.set({ nope: true }).error, 'bad-key');
  assert.strictEqual(ui.set({ showExperimental: 'yes' }).error, 'bad-value');
  ui.set({ showExperimental: false });

  // ---- 3. API
  const rows = [
    site('site-twitch'),
    site('site-kick', { stability: 'experimental' }),
    site('site-hidden', { audience: 'author' }),
    site('sink-twitch', { kind: 'sink', site: undefined }),
    { id: 'site-nosite', name: 'x', kind: 'site', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [], audience: 'public', stability: 'stable' }
  ];
  let dev = false;
  const auditRows = [];
  const api = createApi({
    core: bag.core,
    confirmLive: true,
    uiSettings: ui,
    devMode: { get: () => ({ devMode: dev, source: 'default' }) },
    audit: { write(row) { auditRows.push(row); } },
    getState() { return { product: 'marust', plugins: rows }; }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };

  // 3-1 見える・見えない
  let state = await api.call('hub.getState', {}, win);
  const vis = (id) => state.plugins.find((p) => p.id === id).visible;
  assert.deepStrictEqual([vis('site-twitch'), vis('site-kick'), vis('site-hidden')], [true, false, false]);
  assert.strictEqual(state.showExperimental, false);
  assert.strictEqual((await api.call('ui.setSettings', { showExperimental: true }, browser)).error, 'forbidden');
  assert.strictEqual((await api.call('ui.setSettings', { showExperimental: 'x' }, win)).error, 'bad-value');
  assert.strictEqual((await api.call('ui.getSettings', {}, browser)).showExperimental, false);

  // 3-2 sites.setSend（開発者モードがオフでも通る）
  assert.strictEqual((await api.call('sites.setSend', { id: 'site-twitch', send: true }, browser)).error, 'forbidden');
  assert.strictEqual((await api.call('sites.setSend', { id: 'site-twitch', send: 'yes' }, win)).error, 'bad-value');
  assert.strictEqual((await api.call('sites.setSend', { id: 'site-twitch', send: true }, win)).error, 'confirm-name');
  const on = await api.call('sites.setSend', { id: 'site-twitch', send: true, confirmName: 'site-twitch' }, win);
  assert.deepStrictEqual(on, { ok: true, id: 'site-twitch', on: true });
  assert.strictEqual(modesFile(bag.core).plugins['site-twitch'], 'live');
  const off = await api.call('sites.setSend', { id: 'site-twitch', send: false }, win);
  assert.deepStrictEqual(off, { ok: true, id: 'site-twitch', on: false }); // 「送らない」は確認なし・shadow にならない
  assert.strictEqual(modesFile(bag.core).plugins['site-twitch'], 'legacy');
  // 対象外
  for (const id of ['sink-twitch', 'site-nosite', 'site-hidden', 'site-kick', 'obs-engine', 'nope']) {
    assert.strictEqual((await api.call('sites.setSend', { id: id, send: true, confirmName: id }, win)).error, 'bad-id', id);
  }
  // 試験中を表示するとき、site-kick も対象になる
  ui.set({ showExperimental: true });
  state = await api.call('hub.getState', {}, win);
  assert.strictEqual(vis('site-kick'), true);
  assert.strictEqual((await api.call('sites.setSend', { id: 'site-kick', send: true, confirmName: 'site-kick' }, win)).ok, true);
  await api.call('sites.setSend', { id: 'site-kick', send: false }, win);
  ui.set({ showExperimental: false });
  // modes.set の live は、開発者モードがオフなら今までどおり dev-only
  assert.strictEqual((await api.call('modes.set', { id: 'site-twitch', mode: 'live', confirmName: 'site-twitch' }, win)).error, 'dev-only');
  // 監査の名前は sites.setSend。確認の名前（confirmName）は記録しない
  const sendAudit = auditRows.filter((r) => r.method === 'sites.setSend');
  assert.ok(sendAudit.length >= 2);
  assert.ok(sendAudit.every((r) => r.paramNames.every((n) => !/confirm/.test(n))));

  // 3-3 一覧
  const listed = await api.call('modes.list', {}, win);
  const lrow = (id) => listed.plugins.find((p) => p.id === id);
  assert.strictEqual(lrow('site-kick').visible, false);
  assert.strictEqual(lrow('site-kick').stability, 'experimental');
  assert.strictEqual(lrow('site-twitch').send, false);
  assert.deepStrictEqual(lrow('site-twitch').site, { name: 'site-twitch', tier: 'core' });
  // 開発者モードなら全部見える
  dev = true;
  state = await api.call('hub.getState', {}, win);
  assert.strictEqual(vis('site-hidden'), true);
  dev = false;

  // 3-4 obs.setControl（サイトの「送る」とは別。obs-engine と broadcast の 2 つ）
  assert.strictEqual((await api.call('obs.setControl', { enabled: true }, browser)).error, 'forbidden');
  assert.strictEqual((await api.call('obs.setControl', { enabled: 'x' }, win)).error, 'bad-value');
  assert.deepStrictEqual(await api.call('obs.setControl', { enabled: true }, win), { ok: true, enabled: true });
  let plugins = modesFile(bag.core).plugins;
  assert.deepStrictEqual([plugins['obs-engine'], plugins.broadcast], ['live', 'live']);
  assert.strictEqual(plugins['site-twitch'], 'legacy'); // サイトには触らない
  await api.call('obs.setControl', { enabled: false }, win);
  plugins = modesFile(bag.core).plugins;
  assert.deepStrictEqual([plugins['obs-engine'], plugins.broadcast], ['legacy', 'legacy']);
  assert.ok(auditRows.some((r) => r.method === 'obs.setControl'));
  const withControl = createApi({
    core: bag.core,
    obsSetup: { getConnection: async () => ({ ok: true, host: 'localhost', port: 4455, hasPassword: false, source: 'default', connected: false }) },
    getState() { return { plugins: [] }; }
  });
  await withControl.call('obs.setControl', { enabled: true }, win);
  assert.strictEqual((await withControl.call('obs.getConnection', {}, win)).control, true);

  fs.rmSync(bag.dir, { recursive: true, force: true });
  console.log('ok r4-sites');
}

main().catch((err) => { console.error(err); process.exit(1); });
