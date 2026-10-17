'use strict';
require('../../../test/_ui-inline');
const { hubSource } = require('../../../test/_ui-source');
// R1: 開発者モード（判定の強さ・API の dev-only・画面の印）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../../../host/core/core-bridge');
const { createApi } = require('../../../host/layer1/api');
const { createDevMode, resolveDevMode } = require('../../../host/layer1/dev-mode');
const { WINDOW_ID } = require('../../../host/layer1/clients');
const { attachDevShadow } = require('../../../test/_dev-shadow');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pending = Promise.resolve();
function test(name, fn) {
  pending = pending.then(async () => {
    try { await fn(); console.log('ok ' + name); } catch (err) { console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); process.exit(1); }
  });
}

function row(id) {
  return { id: id, name: id, kind: 'site', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [] };
}

function tmpCore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-r1-'));
  const c = createCore();
  const core = { STATE_DIR: dir, COOKIES_DIR: path.join(dir, 'cookies'), SERVICES_DIR: path.join(dir, 'services'), DATA_DIR: path.join(dir, 'data'), atomicWriteJsonSync: c.atomicWriteJsonSync };
  return core;
}

const settingsPath = (core) => path.join(core.STATE_DIR, 'data', 'marust', 'ui-settings.json');

test('resolveDevMode: env > setting > default', () => {
  assert.deepStrictEqual(resolveDevMode({ env: '1', setting: false, isPackaged: true }), { devMode: true, source: 'env' });
  assert.deepStrictEqual(resolveDevMode({ env: '0', setting: true, isPackaged: false }), { devMode: false, source: 'env' });
  assert.deepStrictEqual(resolveDevMode({ env: '', setting: true, isPackaged: true }), { devMode: true, source: 'setting' });
  assert.deepStrictEqual(resolveDevMode({ setting: false, isPackaged: false }), { devMode: false, source: 'setting' });
  assert.deepStrictEqual(resolveDevMode({ isPackaged: true }), { devMode: false, source: 'default' });
  assert.deepStrictEqual(resolveDevMode({ isPackaged: false }), { devMode: true, source: 'default' });
  assert.deepStrictEqual(resolveDevMode({}), { devMode: true, source: 'default' });
  assert.strictEqual(resolveDevMode({ env: 'x', isPackaged: true }).devMode, false);
});

test('createDevMode: settings file, other keys kept, env lock', () => {
  const core = tmpCore();
  const dm = createDevMode({ isPackaged: true, env: {}, stateDir: core.STATE_DIR, atomicWriteJsonSync: core.atomicWriteJsonSync });
  assert.strictEqual(dm.get().devMode, false);
  assert.strictEqual(fs.existsSync(settingsPath(core)), false, 'reading must not create the file');
  assert.strictEqual(dm.set('yes').error, 'bad-value');
  fs.mkdirSync(path.dirname(settingsPath(core)), { recursive: true });
  fs.writeFileSync(settingsPath(core), JSON.stringify({ theme: 'dark' }), 'utf8');
  assert.deepStrictEqual(dm.set(true), { ok: true, devMode: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath(core), 'utf8')), { theme: 'dark', devMode: true });
  assert.deepStrictEqual(dm.get(), { devMode: true, source: 'setting' });
  const locked = createDevMode({ isPackaged: false, env: { MARUST_DEV: '0' }, stateDir: core.STATE_DIR });
  assert.strictEqual(locked.get().devMode, false);
  assert.strictEqual(locked.set(true).error, 'env-locked');
});

async function makeApi(devOn) {
  const core = tmpCore();
  const dm = createDevMode({ isPackaged: !devOn, env: {}, stateDir: core.STATE_DIR, atomicWriteJsonSync: core.atomicWriteJsonSync });
  let forced = 0;
  const api = createApi({
    core: core,
    confirmLive: false,
    devMode: dm,
    forceLegacy() { forced += 1; return { mode: 'legacy' }; },
    getState() { return { product: 'marust', plugins: [row('site-a'), row('site-b')] }; }
  });
  await attachDevShadow(api, core); // shadow.report は plugins/dev-shadow が出す（V1）
  return { api: api, core: core, dm: dm, forced: () => forced };
}
const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

test('api: dev mode off returns dev-only for dev APIs', async () => {
  const t = await makeApi(false);
  const a = t.api;
  assert.strictEqual((await a.call('modes.setMany', { mode: 'legacy' }, win)).error, 'dev-only');
  assert.strictEqual((await a.call('modes.set', { id: 'site-a', mode: 'live' }, win)).error, 'dev-only');
  assert.strictEqual((await a.call('modes.set', { id: 'site-a', mode: 'shadow' }, win)).error, 'dev-only');
  assert.strictEqual((await a.call('modes.setDefault', { mode: 'shadow' }, win)).error, 'dev-only');
  assert.strictEqual((await a.call('shadow.report', {}, win)).error, 'dev-only');
  assert.strictEqual((await a.call('golive.check', { site: 'twitch' }, win)).error, 'dev-only');
  // NeonTimer の取り込みは開発者プラグイン dev-legacy-import の legacyImport.*（本体には無い。dev-only の確かめは v6-legacy-import.test.js）
  assert.strictEqual((await a.call('secrets.importScan', {}, win)).error, 'unknown-method');
  assert.strictEqual((await a.call('secrets.importRun', { names: [] }, win)).error, 'unknown-method');
  assert.strictEqual(fs.existsSync(path.join(t.core.SERVICES_DIR, 'marust-modes.json')), false);
});

test('api: safe-side calls still work with dev mode off', async () => {
  const t = await makeApi(false);
  const a = t.api;
  const back = await a.call('hub.forceLegacy', {}, win);
  assert.strictEqual(back.mode, 'legacy');
  assert.strictEqual(t.forced(), 1);
  assert.strictEqual((await a.call('modes.setDefault', { mode: 'legacy' }, win)).ok, true);
  const toLegacy = await a.call('modes.set', { id: 'site-a', mode: 'legacy' }, win);
  assert.strictEqual(toLegacy.ok, true);
  assert.strictEqual((await a.call('modes.list', {}, win)).ok, true);
});

test('api: dev mode on behaves as before', async () => {
  const t = await makeApi(true);
  const a = t.api;
  const many = await a.call('modes.setMany', { mode: 'shadow' }, win);
  assert.strictEqual(many.ok, true);
  assert.strictEqual((await a.call('modes.set', { id: 'site-a', mode: 'live' }, win)).ok, true);
  assert.notStrictEqual((await a.call('shadow.report', {}, win)).error, 'dev-only');
  assert.strictEqual((await a.call('hub.forceLegacy', {}, win)).mode, 'legacy');
});

test('api: hub.getState carries devMode', async () => {
  const off = await makeApi(false);
  assert.strictEqual((await off.api.call('hub.getState', {}, win)).devMode, false);
  const on = await makeApi(true);
  assert.strictEqual((await on.api.call('hub.getState', {}, win)).devMode, true);
});

test('api: devmode.get / devmode.set (window only, boolean only, saved)', async () => {
  const t = await makeApi(false);
  const a = t.api;
  const got = await a.call('devmode.get', {}, win);
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.devMode, false);
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
  assert.strictEqual((await a.call('devmode.set', { value: true }, browser)).error, 'forbidden');
  assert.ok((await a.call('devmode.set', { value: 'true' }, win)).error);
  assert.ok((await a.call('devmode.set', {}, win)).error);
  const set = await a.call('devmode.set', { value: true }, win);
  assert.strictEqual(set.ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(settingsPath(t.core), 'utf8')).devMode, true);
  assert.strictEqual((await a.call('hub.getState', {}, win)).devMode, true);
  assert.strictEqual((await a.call('modes.setMany', { mode: 'legacy' }, win)).ok, true);
  assert.strictEqual((await a.call('devmode.set', { value: false }, win)).ok, true);
  assert.strictEqual((await a.call('modes.setMany', { mode: 'legacy' }, win)).error, 'dev-only');
});

test('api: without devMode dependency the api stays open (old callers)', async () => {
  const core = tmpCore();
  const api = createApi({ core: core, confirmLive: false, getState() { return { plugins: [row('site-a')] }; } });
  assert.strictEqual((await api.call('modes.setMany', { mode: 'legacy' }, win)).ok, true);
});

test('ui: dev panels are marked in PANELS and TOOL_PANELS', () => {
  const hub = hubSource();
  const bar = read('plugins/ui-standard/shell/menubar.js');
  // モード・プラグイン一覧はプラグイン dev-shadow（audience: dev）のパネルへ移った（K3）
  const shadow = JSON.parse(read('plugins/dev-shadow/manifest.json'));
  assert.strictEqual(shadow.audience, 'dev');
  assert.deepStrictEqual(shadow.panels.map((p) => p.name).filter((n) => n === 'modes' || n === 'plugins'), ['modes', 'plugins']);
  ['approvals'].forEach((id) => {
    assert.ok(new RegExp("\\['" + id + "', '[^']+', \\{ dev: true \\}\\]").test(hub), 'hub PANELS ' + id);
    assert.ok(new RegExp("\\['" + id + "', '[^']+', \\{ dev: true \\}\\]").test(bar), 'menubar TOOL_PANELS ' + id);
  });
  ['secrets', 'hotkeys', 'diagnostics', 'clients', 'modes', 'plugins'].forEach((id) => {
    assert.ok(!new RegExp("\\['" + id + "', '[^']+', \\{ dev: true").test(hub), 'hub keeps ' + id);
    assert.ok(!new RegExp("\\['" + id + "', '[^']+', \\{ dev: true").test(bar), 'menubar keeps ' + id);
  });
});

test('ui: menus and lists are filtered by devMode', () => {
  const hub = hubSource();
  const bar = read('plugins/ui-standard/shell/menubar.js');
  assert.ok(hub.indexOf('var devMode = false;') !== -1);
  assert.ok(hub.indexOf('state.devMode') !== -1);
  assert.ok(hub.indexOf('visiblePanelRows(PANELS)') !== -1);
  assert.ok(hub.indexOf('STR.topBar(devMode, modeName, obsConnected, obsLiveCount)') !== -1);
  assert.ok(bar.indexOf('visiblePanelRows(TOOL_PANELS)') !== -1);
  assert.ok(bar.indexOf("bucket[0] === 'watch' && !devMode") !== -1);
  // R9: モードをまとめて切り替える項目は、どちらも開発者モードのときだけ
  const devBlock = bar.indexOf('if (devMode) {', bar.indexOf("kind === 'edit'"));
  assert.ok(devBlock !== -1);
  assert.ok(bar.indexOf("add(menuItem('全部のプラグインを legacy に戻す（非常用）'", devBlock) > devBlock);
  assert.ok(bar.indexOf("add(menuItem('全部のプラグインを live にする'", devBlock) > devBlock);
  assert.ok(bar.indexOf("add(menuItem('全部のプラグインを legacy に戻す（非常用）'") === bar.indexOf("add(menuItem('全部のプラグインを legacy に戻す（非常用）'", devBlock));
  assert.ok(bar.indexOf("menuItem('開発者モード'") !== -1);
  assert.ok(bar.indexOf("call('devmode.set'") !== -1);
  assert.ok(bar.indexOf('window.confirm(\'開発者モードをオンにします') !== -1);
});

pending.then(() => console.log('r1-dev-mode ok'));
