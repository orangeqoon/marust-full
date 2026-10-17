'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAudit } = require('../../host/layer1/audit');
const { createCore } = require('../../host/core/core-bridge');
const { createSecretProvider } = require('../../host/core/vault');
const { createFakeBackend } = require('../../host/core/vault-backends/fake');
const { createApi } = require('../../host/layer1/api');
const { appendJsonl } = require('../../host/core/log-writer');

const FAKE = 'FAKE-SECRET-w36-9f3a';

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

function dayStamp(date) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
}

function readLogs(dir) {
  const root = path.join(dir, 'logs', 'marust');
  if (!fs.existsSync(root)) return '';
  const names = fs.readdirSync(root);
  let text = '';
  for (let i = 0; i < names.length; i += 1) {
    text += fs.readFileSync(path.join(root, names[i]), 'utf8');
  }
  return text;
}

async function main() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w36-log-'));
  const when = new Date('2026-10-05T01:02:03.000Z');
  const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
  try {
    await test('audit.write keeps names and drops secret values', async function () {
      const audit = createAudit({ core: core, now: function () { return when; } });
      const wrote = audit.write({
        clientId: 'browser-1',
        kind: 'browser',
        method: 'secrets.set',
        paramNames: ['name', 'value'],
        ok: false,
        error: 'forbidden',
        value: FAKE,
        token: FAKE,
        password: FAKE
      });
      assert.strictEqual(wrote.ok, true);
      const text = fs.readFileSync(wrote.file, 'utf8');
      assert.ok(text.indexOf('secrets.set') !== -1);
      assert.ok(text.indexOf('"value"') !== -1);
      assert.strictEqual(text.indexOf(FAKE), -1);
    });

    await test('vault audit does not store the secret value', async function () {
      const vault = createSecretProvider({
        core: core,
        backend: createFakeBackend(),
        allowFake: true,
        logger: function () {},
        now: function () { return when; }
      });
      await vault.ready;
      const saved = await vault.set('demo.name', FAKE, 'local-window');
      assert.strictEqual(saved.ok, true);
      const text = readLogs(dir);
      assert.ok(text.indexOf('demo.name') !== -1);
      assert.strictEqual(text.indexOf(FAKE), -1);
    });

    await test('api audit of secrets.set does not store the value', async function () {
      const vault = createSecretProvider({
        core: core,
        backend: createFakeBackend(),
        allowFake: true,
        logger: function () {},
        now: function () { return when; }
      });
      await vault.ready;
      const api = createApi({
        core: core,
        secrets: vault,
        now: function () { return when.getTime(); }
      });
      await api.call('secrets.set', { name: 'demo.name', value: FAKE }, {
        permissions: ['read', 'write'],
        clientId: 'browser-1',
        kind: 'browser'
      });
      const file = path.join(dir, 'logs', 'marust', 'api-' + dayStamp(when) + '.jsonl');
      assert.ok(fs.existsSync(file));
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.indexOf('secrets.set') !== -1);
      assert.strictEqual(text.indexOf(FAKE), -1);
    });

    const probeDir = path.join(dir, 'raw');
    const wroteRaw = appendJsonl(probeDir, 'probe', { note: FAKE }, { now: when });
    assert.strictEqual(wroteRaw, true);
    const rawText = fs.readFileSync(path.join(probeDir, 'probe-' + dayStamp(when) + '.jsonl'), 'utf8');
    await test('appendJsonl redacts a planted secret', async function () {
      assert.strictEqual(rawText.indexOf(FAKE), -1);
    });
  } finally {
    rimraf(dir);
  }

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w36 logs ok (' + skipped.length + ' skipped)');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});