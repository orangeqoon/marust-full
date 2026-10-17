'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApi } = require('../../host/layer1/api');
const { createCore } = require('../../host/core/core-bridge');
const { createSecretProvider } = require('../../host/core/vault');
const { createFakeBackend } = require('../../host/core/vault-backends/fake');
const { createChat } = require('../_k3-parts');
const { createClients } = require('../../host/layer1/clients');
const { createLayouts } = require('../../host/layer1/layouts');
const { createKeysPort: createHotkeys } = require('../../host/layer1/keys-port');
const { createObsLocalEngine } = require('../../host/core/engine/obs-local');

const KEY_VALUE = 'FAKE-KEY-w36-9f3a';
const TOKEN_VALUE = 'FAKE-TOKEN-w36-9f3a';
const FILE_BODY = 'FAKE-FILE-w36-9f3a';
const SECRET_NAME = /^(key|token|password|secret|cookie)s?$/i;
const WINDOW_ONLY = /^(secrets\.|clients\.|modes\.set|settings\.|obs\.|sites\.)/;
const WINDOW_ONLY_EXACT = {
  'hotkeys.save': true,
  'app.settings.set': true,
  'approval.approve': true,
  'approval.deny': true
};

let failed = 0;
const skipped = [];

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

function skip(name, reason) {
  skipped.push(name);
  console.log('skip ' + name);
  console.log('  ' + reason);
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function secretFields(value, base, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) secretFields(value[i], base + '[]', out);
    return;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const next = base ? base + '.' + key : key;
    if (SECRET_NAME.test(key)) out.push(next);
    secretFields(value[key], next, out);
  }
}

function allowedField(method, fieldPath) {
  if (method === 'secrets.list' && fieldPath === 'secrets') return true;
  if (method === 'api.describe' && /\.params\.key$/.test(fieldPath)) return true;
  // obs.setConnection / obs.testConnection の入力欄の名前（値ではない）
  if (method === 'api.describe' && /\.params\.password$/.test(fieldPath)) return true;
  return false;
}

// K3: プラグイン（tips・site-login）が読むための 2 つの read。windowOnly の行はプラグインが呼べないので、窓と内蔵プラグイン以外は api.js の中で forbidden にしている（このファイルの下の試験で確かめる）
const PLUGIN_READABLE = { 'sites.loginFacts': true, 'sites.loginStates': true };
function mustWindowOnly(method) {
  if (PLUGIN_READABLE[method] === true) return false;
  return WINDOW_ONLY.test(method) || WINDOW_ONLY_EXACT[method] === true;
}

async function main() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w36-api-'));
  const core = {
    STATE_DIR: dir,
    ROOT_DIR: dir,
    atomicWriteJsonSync: real.atomicWriteJsonSync
  };
  const when = new Date('2026-10-05T00:00:00.000Z');
  const vault = createSecretProvider({
    core: core,
    backend: createFakeBackend(),
    allowFake: true,
    logger: function () {},
    now: function () { return when; }
  });
  await vault.ready;
  await vault.set('demo.token', TOKEN_VALUE, 'local-window');

  fs.mkdirSync(path.join(dir, 'tokens'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokens', 'credentials.json'), '{"client_secret":"' + FILE_BODY + '"}', 'utf8');

  const hotkeyFile = path.join(dir, 'data', 'marust', 'hotkeys.json');
  fs.mkdirSync(path.dirname(hotkeyFile), { recursive: true });
  fs.writeFileSync(hotkeyFile, '[]', 'utf8');

  const configDir = path.join(dir, 'data', 'marust', 'plugins', 'sample');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    title: 'sample',
    token: TOKEN_VALUE,
    password: KEY_VALUE,
    note: 'visible'
  }), 'utf8');

  const chat = createChat({ logger: function () {} });
  chat.publish([{
    site: 'rumble',
    id: 'm1',
    name: '名前',
    text: '本文 ' + TOKEN_VALUE,
    source: 'test'
  }], { source: 'test' });

  const clients = createClients({ core: core, randomInt: function () { return 424242; } });
  const paired = clients.beginPairing({ name: 'sec-test', permissions: ['read'] });
  const redeemed = clients.redeem(paired.code);
  assert.strictEqual(redeemed.ok, true);

  const layouts = createLayouts({ core: core });

  const engine = createObsLocalEngine({
    core: core,
    logger: function () {},
    store: { snapshot: function () { return { destinations: [] }; } }
  });

  let hubState = {
    product: 'marust',
    productJa: '丸スト',
    plugins: [{ id: 'sample', name: '見本', kind: 'ui', mode: 'legacy', status: 'running' }],
    notes: ['note'],
    destinations: { count: 1 },
    session: { active: false, title: '題名', state: 'none', elapsedMs: 0 }
  };

  const api = createApi({
    core: core,
    secrets: vault,
    chat: chat,
    clients: clients,
    layouts: layouts,
    engine: engine,
    getState: function () { return hubState; },
    store: {
      snapshot: function () {
        return {
          destinations: [{
            id: 'dest-1',
            site: 'rumble',
            accountId: 'dest-1',
            enabled: true,
           
            key: KEY_VALUE,
            token: TOKEN_VALUE,
            engine: { id: 'obs-local', targetId: 'target-1' },
            desired: { title: '題', category: 'cat', live: false },
            actual: { streamKey: KEY_VALUE }
          }]
        };
      }
    },
    sessions: {
      view: function () { return { active: false, title: '題名', state: 'none', elapsedMs: 0 }; }
    },
    broadcast: {
      status: function () { return { ok: true, mode: 'legacy', destinations: [], last: null }; }
    },
    appSettings: { get: function () { return { openAtLogin: false }; } },
    getHotkeys: function () { return apiGetHotkeys; },
    skipNetwork: true,
    skipDisk: true,
    now: function () { return when.getTime(); }
  });

  const hk = createHotkeys({
    api: api,
    globalShortcut: {
      register: function () { return true; },
      unregister: function () {}
    },
    store: core,
    logger: function () {}
  });
  const reloaded = await hk.reload();
  assert.strictEqual(reloaded.ok, true);
  apiGetHotkeys = hk;

  const ctx = {
    permissions: ['read', 'write', 'emergency'],
    clientId: 'local-window',
    kind: 'window'
  };

  await test('every api.describe method has a permission', async function () {
    const described = await api.call('api.describe', {}, ctx);
    assert.strictEqual(described.ok, true);
    assert.ok(described.methods.length > 0);
    for (let i = 0; i < described.methods.length; i += 1) {
      const row = described.methods[i];
      assert.strictEqual(typeof row.method, 'string');
      assert.ok(row.permission, 'missing permission ' + row.method);
    }
  });

  await test('sensitive methods stay windowOnly', async function () {
    const described = await api.call('api.describe', {}, ctx);
    const missing = [];
    for (let i = 0; i < described.methods.length; i += 1) {
      const row = described.methods[i];
      if (!mustWindowOnly(row.method)) continue;
      if (row.windowOnly !== true) missing.push(row.method);
    }
    assert.deepStrictEqual(missing, []);
  });

  await test('read methods do not grow new secret-like field names', async function () {
    const described = await api.call('api.describe', {}, ctx);
    const unexpected = [];
    for (let i = 0; i < described.methods.length; i += 1) {
      const row = described.methods[i];
      if (row.permission !== 'read') continue;
      const params = paramsFor(row.method);
      const result = await api.call(row.method, params, ctx);
      const found = [];
      secretFields(result, '', found);
      for (let j = 0; j < found.length; j += 1) {
        if (!allowedField(row.method, found[j])) unexpected.push(row.method + ' ' + found[j]);
      }
    }
    assert.deepStrictEqual(unexpected, []);
  });

  await test('read results do not echo planted secret values', async function () {
    const described = await api.call('api.describe', {}, ctx);
    const leaks = [];
    for (let i = 0; i < described.methods.length; i += 1) {
      const row = described.methods[i];
      if (row.permission !== 'read') continue;
      if (row.method === 'chat.recent') continue;
      if (row.method === 'hotkeys.list') continue;
      if (row.method === 'layout.get') continue;
      if (row.method === 'settings.export') continue;
      const result = await api.call(row.method, paramsFor(row.method), ctx);
      const text = JSON.stringify(result);
      if (text.indexOf(KEY_VALUE) !== -1 || text.indexOf(TOKEN_VALUE) !== -1 || text.indexOf(FILE_BODY) !== -1) {
        leaks.push(row.method);
      }
    }
    assert.deepStrictEqual(leaks, []);
  });

  fs.writeFileSync(hotkeyFile, JSON.stringify([{
    accelerator: 'Ctrl+Shift+K',
    method: 'engine.setKey',
    params: { id: 'target-1', key: KEY_VALUE, token: TOKEN_VALUE },
    label: 'key'
  }]), 'utf8');
  const reloadedPoison = await hk.reload();
  assert.strictEqual(reloadedPoison.ok, true);
  const savedLayout = layouts.save('w36', { version: 1, token: TOKEN_VALUE, dockview: { key: 'panel' } });
  assert.strictEqual(savedLayout.ok, true);

  const hotkeyList = await api.call('hotkeys.list', {}, ctx);
  const hotkeyText = JSON.stringify(hotkeyList);
  await test('hotkeys.list does not return a planted key', async function () {
    assert.strictEqual(hotkeyText.indexOf(KEY_VALUE), -1);
    assert.strictEqual(hotkeyText.indexOf(TOKEN_VALUE), -1);
  });

  const exported = await api.call('settings.export', {}, ctx);
  const exportText = JSON.stringify(exported);
  await test('settings.export scrubs token and password fields', async function () {
    assert.strictEqual(exported.ok, true);
    assert.strictEqual(exportText.indexOf(TOKEN_VALUE), -1);
    assert.strictEqual(exportText.indexOf('password'), -1);
  });
  await test('settings.export does not keep a planted key', async function () {
    assert.strictEqual(exportText.indexOf(KEY_VALUE), -1);
  });

  const layout = await api.call('layout.get', { name: 'w36' }, ctx);
  await test('layout.get drops secret-like fields', async function () {
    const layoutFields = [];
    secretFields(layout, '', layoutFields);
    assert.deepStrictEqual(layoutFields, []);
    assert.strictEqual(JSON.stringify(layout).indexOf(TOKEN_VALUE), -1);
  });

  hubState = { product: 'marust', token: TOKEN_VALUE, password: KEY_VALUE };
  const poisoned = await api.call('hub.getState', {}, ctx);
  await test('hub.getState drops secret-like field names', async function () {
    assert.strictEqual(JSON.stringify(poisoned).indexOf(TOKEN_VALUE), -1);
    assert.strictEqual(JSON.stringify(poisoned).indexOf(KEY_VALUE), -1);
    assert.strictEqual(poisoned.product, 'marust');
  });
  hubState = {
    product: 'marust',
    plugins: [],
    notes: [],
    destinations: { count: 0 }
  };

  const listed = await api.call('secrets.list', {}, ctx);
  if (listed && listed.secrets) {
    skip('secrets.list uses the field name secrets', 'host/core/vault.js createSecretApi の list が { secrets } を返す。中身は name / updatedAt / size / expiresAt だけで、値は入らない。直し方: 項目名を entries にする。');
  }
  // NeonTimer の取り込み（legacyImport.scan / run）は開発者プラグイン dev-legacy-import。値を返さない・名前だけ監査に残すことは test/w25-import-dedupe.test.js で確かめる

  await test('engine.listTargets source does not return a key field', async function () {
    const text = Function.prototype.toString.call(engine.listTargets);
    assert.strictEqual(/(?:^|[\s{,])(key|token|password|secret|cookie)s?\s*:/i.test(text), false);
    const rows = engine.listTargets();
    const found = [];
    secretFields(rows, '', found);
    assert.deepStrictEqual(found, []);
  });

  await test('clients.list does not return the session token', async function () {
    const result = await api.call('clients.list', {}, ctx);
    const text = JSON.stringify(result);
    assert.strictEqual(text.indexOf(redeemed.token), -1);
    const found = [];
    secretFields(result, '', found);
    assert.deepStrictEqual(found, []);
  });

  if (failed) {
    console.error(failed + ' failed');
    rimraf(dir);
    process.exit(1);
  }
  rimraf(dir);
  console.log('w36 api-permissions ok (' + skipped.length + ' skipped)');
}

let apiGetHotkeys = null;

function paramsFor(method) {
  if (method === 'layout.get') return { name: 'w36' };
  if (method === 'chat.recent') return { limit: 10 };
  if (method === 'broadcast.preflight') return {};
  if (method === 'settings.preview') return { document: { schemaVersion: 1, layout: { last: '', items: [] } } };
  return {};
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});