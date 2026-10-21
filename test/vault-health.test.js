'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');

const SECRET = 'plain-secret-NEVER-IN-HEALTH-91ac';

function open(dir, backend) {
  const real = createCore();
  return createSecretProvider({
    core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync },
    backend: backend || createFakeBackend(),
    allowFake: true,
    logger() {}
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-vault-health-'));
  try {
    // 空の金庫は「失われた」ではない
    const empty = open(dir);
    await empty.ready;
    assert.deepStrictEqual(await empty.health(), { ok: true, usable: true, reason: '', store: 'file', total: 0, readable: 0, unreadable: 0, lost: false, backendMismatch: 0, decryptFailures: 0 });

    // 読める 2 件
    await empty.set('a.one', SECRET, 'local-window');
    await empty.set('b.two', SECRET, 'local-window');
    const good = await empty.health();
    assert.strictEqual(good.total, 2);
    assert.strictEqual(good.readable, 2);
    assert.strictEqual(good.lost, false);
    assert.strictEqual(JSON.stringify(good).includes(SECRET), false);

    // 鍵が変わった（復号が全部失敗）→ lost
    const broken = createFakeBackend();
    broken.decrypt = async () => { throw new Error('decrypt-failed'); };
    const lost = open(dir, broken);
    await lost.ready;
    const bad = await lost.health();
    assert.strictEqual(bad.total, 2);
    assert.strictEqual(bad.readable, 0);
    assert.strictEqual(bad.unreadable, 2);
    assert.strictEqual(bad.lost, true);
    assert.strictEqual(bad.decryptFailures, 2);
    assert.strictEqual(bad.backendMismatch, 0);
    const otherBackend = createFakeBackend();
    otherBackend.id = 'different-test-backend';
    const mismatched = await open(dir, otherBackend).health();
    assert.strictEqual(mismatched.backendMismatch, 2);
    assert.strictEqual(mismatched.decryptFailures, 0);
    assert.ok(!JSON.stringify(mismatched).includes(SECRET));

    // 一部だけ読めない → lost ではない
    let calls = 0;
    const partial = createFakeBackend();
    const realDecrypt = partial.decrypt;
    partial.decrypt = async (c) => { calls += 1; if (calls === 1) throw new Error('x'); return realDecrypt(c); };
    const some = open(dir, partial);
    await some.ready;
    const mixed = await some.health();
    assert.strictEqual(mixed.readable, 1);
    assert.strictEqual(mixed.unreadable, 1);
    assert.strictEqual(mixed.lost, false);

    // 60 秒は覚える（もう一度呼んでも復号しない）
    const before = calls;
    await some.health();
    assert.strictEqual(calls, before);

    // 書くと覚えを捨てる
    await some.set('c.three', SECRET, 'local-window');
    const after = await some.health();
    assert.strictEqual(after.total, 3);

    // 使えない backend は readable 0・usable false
    const none = open(dir, { id: 'none', production: true, available: () => false, encrypt: async () => '', decrypt: async () => '' });
    await none.ready;
    const off = await none.health();
    assert.strictEqual(off.usable, false);
    assert.strictEqual(off.readable, 0);
    console.log('[marust] vault health tests passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
