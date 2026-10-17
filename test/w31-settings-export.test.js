'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createApi } = require('../host/layer1/api');
const { createLayouts } = require('../host/layer1/layouts');
const { createStateStore } = require('../host/core/state-store');
const { createSettingsExport } = require('../host/layer1/settings-export');
const { WINDOW_ID } = require('../host/layer1/clients');

const VAULT = 'VAULT-SENTINEL-w31';
const COOKIE = 'COOKIE-SENTINEL-w31';
const HASH = 'HASH-SENTINEL-w31';
const CLIENT = 'CLIENTID-SENTINEL-w31';
const LOG = 'LOG-SENTINEL-w31';
const ACTUAL = 'ACTUAL-SENTINEL-w31';
const TOKEN_FIELD = 'TOKENFIELD-SENTINEL-w31';
const COOKIE_FIELD = 'COOKIEFIELD-SENTINEL-w31';
const PARAM_TOKEN = 'PARAMTOKEN-SENTINEL-w31';
const MODE_SECRET = 'MODESECRET-SENTINEL-w31';
const LOGIN_TOKEN = 'LOGINTOKEN-SENTINEL-w31';
const LAYOUT_COOKIE = 'LAYOUTCOOKIE-SENTINEL-w31';
const SESSION = 'SESSION-SENTINEL-w31';
const SENSITIVE = [
  VAULT, COOKIE, HASH, CLIENT, LOG, ACTUAL, TOKEN_FIELD, COOKIE_FIELD,
  PARAM_TOKEN, MODE_SECRET, LOGIN_TOKEN, LAYOUT_COOKIE, SESSION
];

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

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function tempCore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w31-'));
  assert.ok(dir.startsWith(os.tmpdir()));
  const real = createCore();
  return {
    dir: dir,
    core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync }
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function windowCtx(permissions) {
  return {
    clientId: WINDOW_ID,
    kind: 'window',
    permissions: permissions || ['read', 'write', 'emergency']
  };
}

function browserCtx() {
  return {
    clientId: 'browser-pad',
    kind: 'browser',
    permissions: ['read', 'write', 'emergency']
  };
}

function assertNoSentinels(value, where) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (let i = 0; i < SENSITIVE.length; i += 1) {
    assert.ok(text.indexOf(SENSITIVE[i]) === -1, where + ' leaked ' + SENSITIVE[i]);
  }
}

function walkKeys(value, fn) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walkKeys(value[i], fn);
    return;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    fn(keys[i]);
    walkKeys(value[keys[i]], fn);
  }
}

function plant(box) {
  const dir = box.dir;
  const core = box.core;
  const layouts = createLayouts({ core: core });
  const store = createStateStore({ core: core, logger: function () {} });
  assert.strictEqual(layouts.save('作業', {
    version: 1,
    marker: 'keep-layout',
    cookie: LAYOUT_COOKIE
  }).ok, true);
  writeJson(path.join(dir, 'services', 'marust-modes.json'), {
    default: 'legacy',
    plugins: { timer: 'shadow' },
    secret: MODE_SECRET
  });
  writeJson(path.join(dir, 'data', 'marust', 'hotkeys.json'), [{
    accelerator: 'Ctrl+Shift+A',
    method: 'hub.getState',
    params: { title: 'keep-hotkey-title', token: PARAM_TOKEN },
    label: '古い',
    token: PARAM_TOKEN
  }]);
  store.putDestination({
    id: 'yt',
    site: 'youtube',
    accountId: 'me',
    enabled: true,
   
    engine: { id: 'obs-local', targetId: 'tgt-1' },
    actual: { live: true, lastError: ACTUAL }
  });
  const stateFile = path.join(dir, 'data', 'marust', 'state.json');
  const state = readJson(stateFile);
  state.session = { title: SESSION };
  state.destinations[0].token = TOKEN_FIELD;
  writeJson(stateFile, state);
  store.load();
  writeJson(path.join(dir, 'data', 'marust', 'plugins', 'gcal', 'config.json'), {
    channel: 'keep-channel',
    cookie: COOKIE_FIELD
  });
  writeJson(path.join(dir, 'data', 'marust', 'plugins', 'gcal', 'shadow-20261005.jsonl'), {
    line: LOG
  });
  writeJson(path.join(dir, 'data', 'marust', 'app-settings.json'), {
    openAtLogin: false,
    refreshToken: LOGIN_TOKEN
  });
  writeJson(path.join(dir, 'services', 'marust-vault.json'), { value: VAULT, cookie: COOKIE });
  writeJson(path.join(dir, 'cookies', 'marust', 'site.json'), { cookies: { session: COOKIE } });
  writeJson(path.join(dir, 'services', 'marust-clients.json'), {
    clients: [{ id: CLIENT, tokenHash: HASH }]
  });
  fs.mkdirSync(path.join(dir, 'logs', 'marust'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'marust', 'api-20261005.jsonl'), LOG + '\n', 'utf8');
  return { layouts: layouts, store: store };
}

function toolOf(box, planted) {
  return createSettingsExport({
    core: box.core,
    layouts: planted.layouts,
    store: planted.store,
    now: function () { return new Date('2026-10-04T15:30:00.000Z'); }
  });
}

async function main() {
  await test('export keeps allowlisted settings and drops secrets, actual, clients, and logs', async function () {
    const box = tempCore();
    try {
      const planted = plant(box);
      const tool = toolOf(box, planted);
      const doc = tool.exportAll();
      assert.ok(doc);
      assert.strictEqual(doc.schemaVersion, 1);
      assert.strictEqual(tool.filename(), 'marust-settings-20261005.json');
      assert.strictEqual(doc.exportedAt, '2026-10-05T00:30:00+09:00');
      assert.deepStrictEqual(Object.keys(doc).sort(), [
        'autostart', 'destinations', 'exportedAt', 'hotkeys', 'layout', 'modes', 'pluginConfigs', 'schemaVersion'
      ]);
      assert.strictEqual(doc.layout.items.length, 1);
      assert.strictEqual(doc.layout.items[0].name, '作業');
      assert.strictEqual(doc.layout.items[0].data.marker, 'keep-layout');
      assert.ok(!Object.prototype.hasOwnProperty.call(doc.layout.items[0].data, 'cookie'));
      assert.strictEqual(doc.modes.default, 'legacy');
      assert.strictEqual(doc.modes.plugins.timer, 'shadow');
      assert.ok(!Object.prototype.hasOwnProperty.call(doc.modes, 'secret'));
      assert.strictEqual(doc.hotkeys.length, 1);
      assert.strictEqual(doc.hotkeys[0].params.title, 'keep-hotkey-title');
      assert.ok(!Object.prototype.hasOwnProperty.call(doc.hotkeys[0].params, 'token'));
      assert.strictEqual(doc.destinations.length, 1);
      assert.deepStrictEqual(Object.keys(doc.destinations[0]).sort(), [
        'accountId', 'enabled', 'engine', 'id', 'site'
      ]);
      assert.deepStrictEqual(doc.destinations[0].engine, { id: 'obs-local', targetId: 'tgt-1' });
      assert.strictEqual(doc.pluginConfigs.gcal.channel, 'keep-channel');
      assert.ok(!Object.prototype.hasOwnProperty.call(doc.pluginConfigs.gcal, 'cookie'));
      assert.deepStrictEqual(doc.autostart, { openAtLogin: false });
      assert.ok(!Object.prototype.hasOwnProperty.call(doc, 'session'));
      walkKeys(doc, function (key) {
        assert.notStrictEqual(key, 'actual');
        assert.ok(!/cookie|token|secret|password|vault|authorization|credential|bearer/i.test(key), key);
      });
      assertNoSentinels(doc, 'export');
      const preview = tool.preview(doc);
      assert.strictEqual(preview.ok, true);
      assert.strictEqual(preview.items.length, 6);
      const layoutRow = preview.items.find(function (row) { return row.section === 'layout'; });
      assert.strictEqual(layoutRow.count, 1);
      assert.deepStrictEqual(layoutRow.names, ['作業']);
      assertNoSentinels(preview, 'preview');
      const newer = tool.preview({ schemaVersion: 2, cookie: COOKIE, actual: ACTUAL });
      assert.strictEqual(newer.error, 'schema-version');
      assertNoSentinels(newer, 'newer preview');
    } finally {
      rimraf(box.dir);
    }
  });

  await test('import applies only selected sections and writes a backup first', async function () {
    const box = tempCore();
    try {
      const planted = plant(box);
      const tool = toolOf(box, planted);
      const incoming = {
        schemaVersion: 1,
        layout: { last: '新しい', items: [{ name: '新しい', data: { version: 1, marker: 'new-layout' } }] },
        modes: { default: 'shadow', plugins: { timer: 'live' } },
        hotkeys: [{ accelerator: 'Ctrl+Shift+B', method: 'hub.getState', params: {}, label: '新しい' }],
        destinations: [{
          id: 'yt',
          site: 'twitch',
          accountId: 'other',
          enabled: false,
          engine: { id: 'obs-local', targetId: 'tgt-2' },
          desired: { title: 'new-title', category: 'chat', live: true },
          actual: { title: ACTUAL }
        }],
        pluginConfigs: { gcal: { channel: 'new-channel', cookie: COOKIE_FIELD } },
        autostart: { openAtLogin: true, refreshToken: LOGIN_TOKEN }
      };
      const applied = tool.importSelected(incoming, ['layout', 'autostart', 'nope']);
      assert.strictEqual(applied.ok, true);
      assert.deepStrictEqual(applied.applied, ['layout', 'autostart']);
      const backupFile = path.join(box.dir, 'data', 'marust', 'backups', applied.backup);
      const backup = readJson(backupFile);
      assert.strictEqual(backup.layout.items[0].data.marker, 'keep-layout');
      assert.strictEqual(backup.autostart.openAtLogin, false);
      assert.ok(JSON.stringify(backup).indexOf('new-layout') === -1);
      assertNoSentinels(backup, 'backup');
      const saved = planted.layouts.get('新しい');
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(saved.data.marker, 'new-layout');
      assert.strictEqual(planted.layouts.get('作業').error, 'not-found');
      const modes = readJson(path.join(box.dir, 'services', 'marust-modes.json'));
      assert.strictEqual(modes.default, 'legacy');
      assert.strictEqual(modes.plugins.timer, 'shadow');
      const hotkeys = readJson(path.join(box.dir, 'data', 'marust', 'hotkeys.json'));
      assert.strictEqual(hotkeys[0].label, '古い');
      const state = readJson(path.join(box.dir, 'data', 'marust', 'state.json'));
      assert.ok(!('desired' in state.destinations[0]));
      assert.strictEqual(state.destinations[0].actual.lastError, ACTUAL);
      const config = readJson(path.join(box.dir, 'data', 'marust', 'plugins', 'gcal', 'config.json'));
      assert.strictEqual(config.channel, 'keep-channel');
      const settings = readJson(path.join(box.dir, 'data', 'marust', 'app-settings.json'));
      assert.deepStrictEqual(settings, { openAtLogin: true });
      assert.strictEqual(readJson(path.join(box.dir, 'services', 'marust-vault.json')).value, VAULT);
    } finally {
      rimraf(box.dir);
    }
  });

  await test('a newer schemaVersion is rejected before backup', async function () {
    const box = tempCore();
    try {
      const planted = plant(box);
      const tool = toolOf(box, planted);
      const rejected = tool.importSelected({
        schemaVersion: 99,
        autostart: { openAtLogin: true },
        cookie: COOKIE
      }, ['autostart']);
      assert.strictEqual(rejected.ok, false);
      assert.strictEqual(rejected.error, 'schema-version');
      assert.ok(!fs.existsSync(path.join(box.dir, 'data', 'marust', 'backups')));
      const settings = readJson(path.join(box.dir, 'data', 'marust', 'app-settings.json'));
      assert.strictEqual(settings.openAtLogin, false);
      assert.strictEqual(settings.refreshToken, LOGIN_TOKEN);
    } finally {
      rimraf(box.dir);
    }
  });

  await test('settings methods are window only', async function () {
    const box = tempCore();
    try {
      const planted = plant(box);
      const api = createApi({
        getState: function () { return { product: 'marust' }; },
        core: box.core,
        layouts: planted.layouts,
        store: planted.store,
        appSettings: {
          get: function () { return { openAtLogin: false }; },
          set: function (openAtLogin) { return { openAtLogin: openAtLogin === true }; }
        }
      });
      const deniedExport = await api.call('settings.export', {}, browserCtx());
      assert.strictEqual(deniedExport.error, 'forbidden');
      const deniedPreview = await api.call('settings.preview', {
        document: { schemaVersion: 1 }
      }, browserCtx());
      assert.strictEqual(deniedPreview.error, 'forbidden');
      const deniedImport = await api.call('settings.import', {
        document: { schemaVersion: 1, autostart: { openAtLogin: true } },
        sections: ['autostart']
      }, browserCtx());
      assert.strictEqual(deniedImport.error, 'forbidden');
      const noCtx = await api.call('settings.export', {});
      assert.strictEqual(noCtx.error, 'forbidden');
      assert.ok(!fs.existsSync(path.join(box.dir, 'data', 'marust', 'backups')));
      const exported = await api.call('settings.export', {}, windowCtx(['read']));
      assert.strictEqual(exported.ok, true);
      assert.match(exported.filename, /^marust-settings-\d{8}\.json$/);
      assertNoSentinels(exported.document, 'api export');
      const deniedFile = await api.call('settings.exportToFile', {}, browserCtx());
      assert.strictEqual(deniedFile.error, 'forbidden');
      const saved = await api.call('settings.exportToFile', {}, windowCtx(['read', 'write']));
      assert.strictEqual(saved.ok, true);
      assert.match(saved.filename, /^marust-settings-\d{8}\.json$/);
      const savedText = fs.readFileSync(path.join(saved.dir, saved.filename), 'utf8');
      assertNoSentinels(JSON.parse(savedText), 'file export');
      const described = await api.call('api.describe', {}, windowCtx(['read']));
      const row = described.methods.find(function (item) { return item.method === 'settings.export'; });
      assert.strictEqual(row.windowOnly, true);
      assert.strictEqual(row.permission, 'read');
      const imported = await api.call('settings.import', {
        document: exported.document,
        sections: ['hotkeys']
      }, windowCtx());
      assert.strictEqual(imported.ok, true);
      assert.ok(imported.backup);
      const readOnly = await api.call('settings.import', {
        document: exported.document,
        sections: ['hotkeys']
      }, windowCtx(['read']));
      assert.strictEqual(readOnly.error, 'forbidden');
    } finally {
      rimraf(box.dir);
    }
  });

  await test('hub panel offers export and import', function () {
    const hub = hubSource();
    const css = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'hub.css'), 'utf8');
    // V7 C5: 書き出し・読み込みは backup プラグインの画面。本体の画面は引っ越しだけ
    const panel = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'backup', 'ui', 'panel.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'backup', 'ui', 'panel.html'), 'utf8');
    assert.ok(hub.includes("['migration', STR.migrationTitle]"));
    assert.ok(html.includes('書き出す') && html.includes('読み込む'));
    assert.ok(panel.includes("'settings.exportToFile'") && panel.includes("'settings.preview'") && panel.includes("'settings.import'"));
    assert.ok(panel.includes("state.clientId === 'local-window'"));
    assert.ok(/relay\('settings\.exportToFile'/.test(panel) && /relay\('settings\.import'/.test(panel), '書き込みは窓の中継');
    assert.ok(/call\('settings\.preview'/.test(panel));
    assert.ok(css.includes('#settings-export-file') === false);
  });

  if (failed) {
    console.error('[marust] w31 tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] w31 tests passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
