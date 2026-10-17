'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const {
  createSecretProvider,
  createSecretApi,
  selectBackend,
  SECRET_API_SPEC,
  NAME_RE,
  MAX_SECRET_BYTES,
  WINDOW_ID
} = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createElectronSafeStorageBackend } = require('../host/core/vault-backends/electron-safestorage');

const SECRET = 'plain-secret-SHOULD-NOT-LEAK-7f3a';
const WHEN = new Date('2026-10-04T03:04:05.000Z');

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

function localDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
}

function tempCore() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-vault-'));
  return {
    dir: dir,
    core: {
      STATE_DIR: dir,
      atomicWriteJsonSync: real.atomicWriteJsonSync
    }
  };
}

function open(bag, extra) {
  const logs = [];
  const vault = createSecretProvider(Object.assign({
    core: bag.core,
    backend: createFakeBackend(),
    allowFake: true,
    logger(level, message) { logs.push(level + ':' + message); },
    now() { return WHEN; }
  }, extra || {}));
  return { vault: vault, logs: logs };
}

function auditText(dir) {
  const file = path.join(dir, 'logs', 'marust', 'vault-' + localDay(WHEN) + '.jsonl');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function auditRows(dir) {
  const text = auditText(dir);
  if (!text) return [];
  return text.trim().split(/\n/).map((line) => JSON.parse(line));
}

function assertNoSecret(text) {
  assert.strictEqual(String(text).includes(SECRET), false);
}

async function main() {
  await test('undeclared names are also returned (getFor)（L8g: 以前は not-declared。悪意への守りを外した）', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      const declared = function (pluginId) { return pluginId === 'gcal' ? ['google.oauth'] : []; };
      assert.strictEqual(vault.bindDeclared(declared), true);
      assert.strictEqual(vault.bindDeclared(function () { return ['everything']; }), false, '宣言の関数は 1 回しか渡せない');
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: true });
      assert.deepStrictEqual(await vault.set('cookies.niconico-main', SECRET, 'local-window'), { ok: true });
      assert.deepStrictEqual(await vault.getFor('gcal', 'cookies.niconico-main'), { ok: true, value: SECRET });
      assert.deepStrictEqual(await vault.getFor('twitch', 'google.oauth'), { ok: true, value: SECRET });
      assert.deepStrictEqual(await vault.getFor('gcal', 'other.name'), { ok: false, error: 'not-found' });
      assert.deepStrictEqual(await vault.hasFor('twitch', 'google.oauth'), { ok: true, has: true });
      assert.deepStrictEqual(await vault.getFor('gcal', 'google.oauth'), { ok: true, value: SECRET });
      assertNoSecret(auditText(bag.dir));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('宣言の関数が渡っていなくても getFor は読める（L8g: 以前は not-declared）。provider に get は無い', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: true });
      assert.deepStrictEqual(await vault.getFor('gcal', 'google.oauth'), { ok: true, value: SECRET });
      assert.strictEqual(vault.get, undefined);
      // 宣言の関数が例外を投げても get には関係しない
      vault.bindDeclared(function () { throw new Error('boom'); });
      assert.deepStrictEqual(await vault.getFor('gcal', 'google.oauth'), { ok: true, value: SECRET });
      assertNoSecret(auditText(bag.dir));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('coreReader は allow の名前だけ読める・list も allow の名前だけ', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      assert.deepStrictEqual(await vault.set('obs.websocket', SECRET, 'local-window'), { ok: true });
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: true });
      const host = vault.coreReader('host', ['obs.websocket']);
      assert.deepStrictEqual(await host.get('obs.websocket'), { ok: true, value: SECRET });
      assert.deepStrictEqual(await host.get('google.oauth'), { ok: false, error: 'not-declared' });
      assert.deepStrictEqual((await host.list()).secrets.map((r) => r.name), ['obs.websocket']);
      const none = vault.coreReader('x', undefined);
      assert.deepStrictEqual(await none.get('obs.websocket'), { ok: false, error: 'not-declared' });
      const thrower = vault.coreReader('x', function () { throw new Error('no'); });
      assert.deepStrictEqual(await thrower.get('obs.websocket'), { ok: false, error: 'not-declared' });
      assert.strictEqual((await vault.coreReader('migration', () => true).list()).secrets.length, 2);
      assertNoSecret(auditText(bag.dir));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('declared getFor round-trips and registry shape works', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      vault.bindDeclared(function (pluginId) { return pluginId === 'gcal' ? ['google.oauth'] : null; });
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'gcal'), { ok: true });
      assert.deepStrictEqual(await vault.getFor('gcal', 'google.oauth'), { ok: true, value: SECRET });
      const plain = open(bag);
      assert.deepStrictEqual(
        await plain.vault.coreReader('gcal', () => true).get('google.oauth'),
        { ok: true, value: SECRET }
      );
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('list and describe expose metadata only', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      await vault.set('cookies.niconico-main', SECRET, 'local-window');
      await vault.set('google.oauth', 'short-token-value', 'local-window');
      const listed = await vault.list();
      assert.deepStrictEqual(listed.secrets.map((row) => row.name), ['cookies.niconico-main', 'google.oauth']);
      for (const row of listed.secrets) {
        assert.deepStrictEqual(Object.keys(row).sort(), ['expiresAt', 'name', 'size', 'tail', 'updatedAt']);
        assert.strictEqual(row.expiresAt, null);
        assert.strictEqual(row.updatedAt, WHEN.toISOString());
      }
      assert.strictEqual(listed.secrets[1].size, Buffer.byteLength('short-token-value', 'utf8'));
      const described = await vault.describe('google.oauth');
      assert.deepStrictEqual(described, {
        ok: true,
        secret: {
          name: 'google.oauth',
          updatedAt: WHEN.toISOString(),
          size: Buffer.byteLength('short-token-value', 'utf8'),
          expiresAt: null,
          tail: '••••alue'
        }
      });
      assert.deepStrictEqual(await vault.describe('missing.name'), { ok: false, error: 'not-found' });
      assert.deepStrictEqual(await vault.describe('Bad'), { ok: false, error: 'bad-name' });
      assertNoSecret(JSON.stringify(listed));
      assertNoSecret(JSON.stringify(described));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('saved file does not contain plaintext', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: true });
      assert.deepStrictEqual(await vault.set('cookies.niconico-main', '', 'local-window'), { ok: true });
      const disk = fs.readFileSync(vault.file, 'utf8');
      assertNoSecret(disk);
      const parsed = JSON.parse(disk);
      assert.strictEqual(parsed.schemaVersion, 1);
      const row = parsed.entries.find((entry) => entry.name === 'google.oauth');
      assert.deepStrictEqual(Object.keys(row).sort(), ['backend', 'ciphertext', 'name', 'size', 'updatedAt']);
      assert.strictEqual(row.backend, 'fake');
      assert.notStrictEqual(row.ciphertext, SECRET);
      assert.notStrictEqual(row.ciphertext, Buffer.from(SECRET, 'utf8').toString('base64'));
      assert.strictEqual(row.size, Buffer.byteLength(SECRET, 'utf8'));
      const again = open(bag);
      assert.deepStrictEqual(
        await again.vault.coreReader('gcal', () => true).get('google.oauth'),
        { ok: true, value: SECRET }
      );
      assert.deepStrictEqual(
        await again.vault.coreReader('niconico', () => true).get('cookies.niconico-main'),
        { ok: true, value: '' }
      );
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('audit log records get set remove without the value', async () => {
    const bag = tempCore();
    try {
      const { vault, logs } = open(bag);
      await vault.set('google.oauth', SECRET, SECRET);
      await vault.coreReader('gcal', () => true).get('google.oauth');
      await vault.coreReader('gcal', () => true).get('missing.name');
      await vault.coreReader('gcal', () => true).get(SECRET);
      await vault.remove('google.oauth', 'local-window');
      const rows = auditRows(bag.dir);
      assert.deepStrictEqual(rows.map((row) => row.action), ['set', 'get', 'get', 'get', 'remove']);
      assert.deepStrictEqual(rows.map((row) => row.ok), [true, true, false, false, true]);
      assert.strictEqual(rows[0].actor, 'unknown');
      assert.strictEqual(rows[0].name, 'google.oauth');
      assert.strictEqual(rows[0].at, WHEN.toISOString());
      assert.strictEqual(rows[3].name, '');
      for (const row of rows) {
        assert.deepStrictEqual(Object.keys(row).sort(), ['action', 'actor', 'at', 'name', 'ok']);
      }
      assertNoSecret(auditText(bag.dir));
      assertNoSecret(logs.join('\n'));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('broken vault file is quarantined and starts empty', async () => {
    const bag = tempCore();
    try {
      const file = path.join(bag.dir, 'services', 'marust-vault.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{broken', 'utf8');
      const { vault } = open(bag);
      const listed = await vault.list();
      assert.deepStrictEqual(listed, { ok: true, secrets: [] });
      assert.strictEqual(fs.existsSync(file), false);
      const names = fs.readdirSync(path.dirname(file));
      assert.ok(names.some((name) => name.indexOf('marust-vault.json.broken-') === 0));
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: true });
      const disk = fs.readFileSync(vault.file, 'utf8');
      assertNoSecret(disk);
      assert.strictEqual(JSON.parse(disk).entries.length, 1);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('a file that stores a value field is quarantined', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      await vault.set('google.oauth', SECRET, 'local-window');
      const parsed = JSON.parse(fs.readFileSync(vault.file, 'utf8'));
      parsed.schemaVersion = 1;
      parsed.entries[0].value = SECRET;
      fs.writeFileSync(vault.file, JSON.stringify(parsed));
      const next = open(bag);
      assert.deepStrictEqual(await next.vault.list(), { ok: true, secrets: [] });
      assert.strictEqual(fs.existsSync(vault.file), false);
      const names = fs.readdirSync(path.dirname(vault.file));
      assert.ok(names.some((name) => name.indexOf('marust-vault.json.broken-') === 0));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('a bad entry is dropped and a good entry remains', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      await vault.set('google.oauth', SECRET, 'local-window');
      const parsed = JSON.parse(fs.readFileSync(vault.file, 'utf8'));
      parsed.entries.push({ name: 'not a name', ciphertext: '!!!!', size: 1 });
      parsed.entries.push({ name: 'cookies.niconico-main', size: 1 });
      fs.writeFileSync(vault.file, JSON.stringify(parsed));
      const next = open(bag);
      const listed = await next.vault.list();
      assert.deepStrictEqual(listed.secrets.map((row) => row.name), ['google.oauth']);
      assert.strictEqual(
        (await next.vault.coreReader('gcal', () => true).get('google.oauth')).value,
        SECRET
      );
      const disk = fs.readFileSync(next.vault.file, 'utf8');
      assert.strictEqual(JSON.parse(disk).entries.length, 1);
      assertNoSecret(disk);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('unavailable backend makes get unavailable', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      await vault.set('google.oauth', SECRET, 'local-window');
      const down = open(bag, {
        backend: {
          id: 'down',
          production: true,
          available() { return false; },
          async encrypt() { throw new Error(SECRET); },
          async decrypt() { throw new Error(SECRET); }
        }
      });
      assert.deepStrictEqual(
        await down.vault.coreReader('gcal', () => true).get('google.oauth'),
        { ok: false, error: 'unavailable' }
      );
      assert.deepStrictEqual(await down.vault.set('google.oauth', SECRET, 'local-window'), { ok: false, error: 'unavailable' });
      const listed = await down.vault.list();
      assert.strictEqual(listed.secrets[0].name, 'google.oauth');
      assertNoSecret(JSON.stringify(listed));
      assertNoSecret(down.logs.join('\n'));
      const none = open(bag, { backend: null });
      assert.deepStrictEqual(
        await none.vault.coreReader('gcal', () => true).get('google.oauth'),
        { ok: false, error: 'unavailable' }
      );
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('names and sizes are rejected outside the rules', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      const badNames = ['', 'Google', '.oauth', '-a', '_a', 'a/b', 'a b', 'a'.repeat(65), '日本語', 'HasSpace'];
      for (const name of badNames) {
        assert.strictEqual(NAME_RE.test(name), false);
        assert.deepStrictEqual(await vault.set(name, SECRET, 'local-window'), { ok: false, error: 'bad-name' });
      }
      const okName = 'a' + 'b'.repeat(63);
      assert.strictEqual(okName.length, 64);
      assert.deepStrictEqual(await vault.set(okName, 'x', 'local-window'), { ok: true });
      assert.deepStrictEqual(await vault.set('a' + 'b'.repeat(64), 'x', 'local-window'), { ok: false, error: 'bad-name' });
      assert.deepStrictEqual(await vault.set('google.oauth', null, 'local-window'), { ok: false, error: 'bad-value' });
      assert.deepStrictEqual(await vault.set('google.oauth', 1, 'local-window'), { ok: false, error: 'bad-value' });
      assert.deepStrictEqual(await vault.set('google.oauth', { v: SECRET }, 'local-window'), { ok: false, error: 'bad-value' });
      assert.strictEqual(MAX_SECRET_BYTES, 65536);
      assert.deepStrictEqual(await vault.set('google.oauth', 'a'.repeat(65537), 'local-window'), { ok: false, error: 'too-large' });
      assert.deepStrictEqual(await vault.set('google.oauth', 'あ'.repeat(21846), 'local-window'), { ok: false, error: 'too-large' });
      const exact = 'a'.repeat(65536);
      assert.deepStrictEqual(await vault.set('google.oauth', exact, 'local-window'), { ok: true });
      const got = await vault.coreReader('gcal', () => true).get('google.oauth');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(got.value, exact);
      assert.strictEqual((await vault.describe('google.oauth')).secret.size, 65536);
      assert.strictEqual(fs.readFileSync(vault.file, 'utf8').includes(exact), false);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('plaintext ciphertext and thrown backend errors are not stored or logged', async () => {
    const bag = tempCore();
    try {
      const echo = open(bag, {
        backend: {
          id: 'echo',
          production: true,
          available() { return true; },
          async encrypt(plain) { return plain; },
          async decrypt(cipher) { return cipher; }
        }
      });
      assert.deepStrictEqual(await echo.vault.set('google.oauth', SECRET, 'local-window'), { ok: false, error: 'unavailable' });
      assert.strictEqual(fs.existsSync(echo.vault.file), false);
      const noisy = open(bag, {
        backend: {
          id: 'noisy',
          production: true,
          available() { return true; },
          async encrypt() { throw new Error('boom ' + SECRET); },
          async decrypt() { throw new Error('boom ' + SECRET); }
        }
      });
      assert.deepStrictEqual(await noisy.vault.set('google.oauth', SECRET, 'local-window'), { ok: false, error: 'unavailable' });
      assertNoSecret(noisy.logs.join('\n'));
      assertNoSecret(auditText(bag.dir));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('fake backend is refused unless allowFake is set', async () => {
    const bag = tempCore();
    try {
      const { vault, logs } = open(bag, { allowFake: false });
      assert.deepStrictEqual(
        await vault.coreReader('gcal', () => true).get('google.oauth'),
        { ok: false, error: 'unavailable' }
      );
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: false, error: 'unavailable' });
      assert.ok(logs.some((line) => line.indexOf('fake backend refused') !== -1));
      assertNoSecret(logs.join('\n'));
      assert.strictEqual(fs.existsSync(vault.file), false);
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('backend が無いとき health は usable:false・reason:no-backend（値と件数以外は出さない）', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag, { backend: null });
      const body = await vault.health();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.usable, false);
      assert.strictEqual(body.reason, 'no-backend');
      assert.deepStrictEqual(Object.keys(body).sort(), ['lost', 'ok', 'readable', 'reason', 'store', 'total', 'unreadable', 'usable']);
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: false, error: 'unavailable' });
      const fine = open(tempCore(), {});
      assert.strictEqual((await fine.vault.health()).reason, '');
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('selectBackend uses electron safeStorage only (no dpapi fallback) and never the fake', async () => {
    const electron = {
      safeStorage: {
        isEncryptionAvailable() { return true; },
        encryptString(text) { return Buffer.from(String(text), 'utf8'); },
        decryptString(buf) { return buf.toString('utf8'); }
      }
    };
    const preferred = selectBackend({
      platform: 'win32',
      electron: electron,
      spawn() { throw new Error('should not spawn'); }
    });
    assert.strictEqual(preferred.id, 'electron-safestorage');
    assert.strictEqual(preferred.production, true);
    assert.strictEqual(selectBackend({ platform: 'linux', electron: null }), null);
    const chosen = selectBackend();
    if (chosen) {
      assert.notStrictEqual(chosen.id, 'fake');
      assert.notStrictEqual(chosen.production, false);
    }
    const down = createElectronSafeStorageBackend({
      safeStorage: {
        isEncryptionAvailable() { return false; },
        encryptString() { return Buffer.from('x'); },
        decryptString() { return 'x'; }
      }
    });
    assert.strictEqual(down.available(), false);
    const indexSrc = fs.readFileSync(require.resolve('../host/core/vault-backends/index.js'), 'utf8');
    assert.strictEqual(indexSrc.includes('createFakeBackend'), false);
    assert.strictEqual(indexSrc.includes("require('./fake')"), false);
  });

  await test('electron safeStorage backend round-trips without writing plaintext', async () => {
    const bag = tempCore();
    try {
      const backend = createElectronSafeStorageBackend({
        safeStorage: {
          isEncryptionAvailable() { return true; },
          encryptString(text) {
            const body = Buffer.from(String(text), 'utf8');
            const out = Buffer.alloc(body.length);
            for (let i = 0; i < body.length; i += 1) out[i] = body[i] ^ 0x5A;
            return out;
          },
          decryptString(buf) {
            const out = Buffer.alloc(buf.length);
            for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ 0x5A;
            return out.toString('utf8');
          }
        }
      });
      assert.strictEqual(backend.available(), true);
      const { vault } = open(bag, { backend: backend, allowFake: false });
      assert.deepStrictEqual(await vault.set('google.oauth', SECRET, 'local-window'), { ok: true });
      const disk = fs.readFileSync(vault.file, 'utf8');
      assertNoSecret(disk);
      assert.strictEqual(JSON.parse(disk).entries[0].backend, 'electron-safestorage');
      assert.deepStrictEqual(
        await vault.coreReader('gcal', () => true).get('google.oauth'),
        { ok: true, value: SECRET }
      );
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('corrupt ciphertext fails without returning a value', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      await vault.set('google.oauth', SECRET, 'local-window');
      const parsed = JSON.parse(fs.readFileSync(vault.file, 'utf8'));
      parsed.entries[0].ciphertext = Buffer.from('not-the-secret').toString('base64');
      fs.writeFileSync(vault.file, JSON.stringify(parsed));
      const next = open(bag);
      const got = await next.vault.coreReader('gcal', () => true).get('google.oauth');
      assert.deepStrictEqual(got, { ok: false, error: 'decrypt-failed' });
      assertNoSecret(JSON.stringify(got));
      assertNoSecret(auditText(bag.dir));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('remove drops the secret and a mismatched backend does not decrypt', async () => {
    const bag = tempCore();
    try {
      const { vault } = open(bag);
      await vault.set('google.oauth', SECRET, 'local-window');
      assert.deepStrictEqual(await vault.remove('missing.name', 'local-window'), { ok: false, error: 'not-found' });
      assert.deepStrictEqual(await vault.remove('google.oauth', 'local-window'), { ok: true });
      assert.deepStrictEqual(
        await vault.coreReader('gcal', () => true).get('google.oauth'),
        { ok: false, error: 'not-found' }
      );
      await vault.set('google.oauth', SECRET, 'local-window');
      const other = open(bag, {
        backend: {
          id: 'other',
          production: true,
          available() { return true; },
          async encrypt(plain) { return Buffer.from('x' + plain).toString('base64'); },
          async decrypt() { throw new Error(SECRET); }
        }
      });
      const got = await other.vault.coreReader('gcal', () => true).get('google.oauth');
      assert.deepStrictEqual(got, { ok: false, error: 'decrypt-failed' });
      assertNoSecret(other.logs.join('\n'));
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('secret api is window-only for set and remove and never returns values', async () => {
    const bag = tempCore();
    try {
      assert.strictEqual(WINDOW_ID, 'local-window');
      assert.deepStrictEqual(SECRET_API_SPEC['secrets.list'], { permission: 'read', windowOnly: true });
      assert.deepStrictEqual(SECRET_API_SPEC['secrets.set'], { permission: 'write', windowOnly: true });
      assert.deepStrictEqual(SECRET_API_SPEC['secrets.remove'], { permission: 'write', windowOnly: true });
      assert.strictEqual(Object.prototype.hasOwnProperty.call(SECRET_API_SPEC, 'secrets.get'), false);
      const { vault } = open(bag);
      const api = createSecretApi(vault);
      const denied = await api.set({ name: 'google.oauth', value: SECRET }, { clientId: 'browser', permissions: ['write'] });
      assert.deepStrictEqual(denied, { ok: false, error: 'forbidden' });
      assert.deepStrictEqual(await api.remove({ name: 'google.oauth' }, { clientId: 'browser' }), { ok: false, error: 'forbidden' });
      assert.deepStrictEqual(await api.set({ name: 'google.oauth', value: SECRET }, null), { ok: false, error: 'forbidden' });
      assert.strictEqual(fs.existsSync(vault.file), false);
      const saved = await api.set({ name: 'google.oauth', value: SECRET }, { clientId: 'local-window', permissions: ['write'] });
      assert.deepStrictEqual(saved, { ok: true });
      assert.deepStrictEqual(Object.keys(saved), ['ok']);
      const listed = await api.list({}, { clientId: 'browser', permissions: ['read'] });
      assert.strictEqual(listed.ok, true);
      assert.strictEqual(listed.secrets[0].name, 'google.oauth');
      assertNoSecret(JSON.stringify(listed));
      assert.deepStrictEqual(await api.remove({ name: 'google.oauth' }, { clientId: 'local-window' }), { ok: true });
      const emptyApi = createSecretApi(null);
      assert.deepStrictEqual(await emptyApi.list(), { ok: false, error: 'unavailable' });
      assert.deepStrictEqual(await emptyApi.set({ name: 'google.oauth', value: SECRET }, { clientId: 'local-window' }), { ok: false, error: 'unavailable' });
      assert.deepStrictEqual(await emptyApi.set({ name: 'google.oauth', value: SECRET }, { clientId: 'browser' }), { ok: false, error: 'forbidden' });
      const leaky = createSecretApi({
        list() {
          return { ok: true, secrets: [{ name: 'google.oauth', updatedAt: 't', size: 3, value: SECRET, ciphertext: SECRET }] };
        },
        set() { return { ok: true, value: SECRET }; },
        remove() { return { ok: true, value: SECRET }; }
      });
      const stripped = await leaky.list();
      assertNoSecret(JSON.stringify(stripped));
      assert.strictEqual(Object.prototype.hasOwnProperty.call(stripped.secrets[0], 'value'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(stripped.secrets[0], 'ciphertext'), false);
      assert.deepStrictEqual(await leaky.set({ name: 'google.oauth', value: SECRET }, { clientId: 'local-window' }), { ok: true });
      assert.deepStrictEqual(await leaky.remove({ name: 'google.oauth' }, { clientId: 'local-window' }), { ok: true });
    } finally {
      rimraf(bag.dir);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).then(() => {
  if (failed) {
    console.error('[marust] vault tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] vault tests passed');
});
