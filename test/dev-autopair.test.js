'use strict';

/**
 * 開発中の自動ペアリング（host/core/dev-autopair.js）。一時フォルダだけ。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createClients } = require('../host/layer1/clients');
const autopair = require('../host/layer1/dev-autopair');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopair-'));
  const real = createCore();
  const core = { STATE_DIR: dir, SERVICES_DIR: path.join(dir, 'services'), COOKIES_DIR: path.join(dir, 'cookies'), DATA_DIR: path.join(dir, 'data'), atomicWriteJsonSync: real.atomicWriteJsonSync };
  const clients = createClients({ core: core });
  clients.ensureWindowClient();
  return { dir, core, clients, services: core.SERVICES_DIR, done() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
const readTokenFile = (t, name) => JSON.parse(fs.readFileSync(path.join(t.services, name), 'utf8'));

test('開発者モードがオン: CLI と MCP の合言葉が置かれ、承認なしの native（read と write だけ）として通る', () => {
  const t = setup();
  try {
    const out = autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => true, env: {} });
    assert.strictEqual(out.on, true);
    assert.strictEqual(out.made.length, 2);
    for (const file of ['marust-cli.json', 'marust-mcp.json']) {
      const data = readTokenFile(t, file);
      assert.ok(data.token.length >= 32);
      const client = t.clients.authenticate(data.token);
      assert.strictEqual(client.kind, 'native');
      assert.strictEqual(client.requiresApproval, false);
      assert.deepStrictEqual(client.permissions.slice().sort(), ['read', 'write']);
    }
  } finally { t.done(); }
});

test('もう一度呼んでも増えない（有効な合言葉はそのまま）', () => {
  const t = setup();
  try {
    autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => true, env: {} });
    const before = t.clients.list().length;
    const tokenBefore = readTokenFile(t, 'marust-cli.json').token;
    const again = autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => true, env: {} });
    assert.strictEqual(again.made.length, 0);
    assert.strictEqual(t.clients.list().length, before);
    assert.strictEqual(readTokenFile(t, 'marust-cli.json').token, tokenBefore);
  } finally { t.done(); }
});

test('取り消された・壊れた合言葉は作り直す', () => {
  const t = setup();
  try {
    autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => true, env: {} });
    const old = readTokenFile(t, 'marust-mcp.json').token;
    t.clients.revoke(t.clients.authenticate(old).id);
    fs.writeFileSync(path.join(t.services, 'marust-cli.json'), 'not json');
    const again = autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => true, env: {} });
    assert.strictEqual(again.made.length, 2);
    assert.ok(t.clients.authenticate(readTokenFile(t, 'marust-mcp.json').token));
    assert.ok(t.clients.authenticate(readTokenFile(t, 'marust-cli.json').token));
  } finally { t.done(); }
});

test('開発者モードを切る・MARUST_AI_PAIR=1: 自動で作った端末を取り消さない（合言葉も残る）。手でペアしたものと窓も残す', () => {
  const t = setup();
  try {
    const hand = t.clients.beginPairing({ name: '手でペア', kind: 'native', permissions: ['read'] });
    t.clients.redeem(hand.code, { kind: 'native' });
    autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => true, env: {} });
    const tokens = ['marust-cli.json', 'marust-mcp.json'].map((f) => readTokenFile(t, f).token);
    for (const env of [{}, { MARUST_AI_PAIR: '1' }]) {
      autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => true, env: {} });
      const off = autopair.sync({ clients: t.clients, servicesDir: t.services, devModeOn: () => env.MARUST_AI_PAIR !== '1' ? false : true, env: env });
      assert.strictEqual(off.on, false);
      assert.strictEqual(off.revoked, 0);
      tokens.forEach((token) => assert.ok(t.clients.authenticate(token)));
      assert.ok(fs.existsSync(path.join(t.services, 'marust-cli.json')));
      const names = t.clients.list().map((row) => row.name);
      assert.ok(names.indexOf('手でペア') !== -1);
      assert.ok(names.some((n) => n.slice(-4) === '（自動）'));
    }
  } finally { t.done(); }
});

test('issueNative は emergency を付けられない', () => {
  const t = setup();
  try {
    assert.strictEqual(t.clients.issueNative({ name: 'x', permissions: ['read', 'emergency'] }).ok, false);
  } finally { t.done(); }
});

if (failed) { console.error('[dev-autopair] ' + failed + ' failed'); process.exit(1); }
console.log('[marust] dev autopair tests passed');
