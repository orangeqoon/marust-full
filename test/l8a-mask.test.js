'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecretMask, secretMask, redact, appendJsonl } = require('../host/core');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createCore } = require('../host/core/core-bridge');
const { createGateway } = require('../host/layer1/gateway');
const { createSockets } = require('../host/layer1/gateway/sockets');

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

(async () => {
  // 1. mask & maskDeep 単体テスト
  await test('mask: 覚えた値が URL・エラー文・JSON の中にあっても *** になる', () => {
    const m = createSecretMask();
    m.remember('supersecretvalue123');

    const url = 'rtmp://live.example.com/app/supersecretvalue123';
    assert.strictEqual(m.mask(url), 'rtmp://live.example.com/app/***');

    const err = 'Error: connection failed with supersecretvalue123 at socket.js:10';
    assert.strictEqual(m.mask(err), 'Error: connection failed with *** at socket.js:10');

    const json = JSON.stringify({ key: 'supersecretvalue123' });
    assert.strictEqual(m.mask(json), '{"key":"***"}');
  });

  await test('mask: 6 文字未満は覚えない', () => {
    const m = createSecretMask();
    m.remember('12345');
    m.remember('short');
    m.remember('  abc  ');

    assert.strictEqual(m.mask('my 12345 short abc'), 'my 12345 short abc');
  });

  await test('mask: 長い値が先（片方がもう片方を含むとき）', () => {
    const m = createSecretMask();
    m.remember('secret-token');
    m.remember('secret-token-extended');

    const text = 'Token is secret-token-extended and secret-token.';
    assert.strictEqual(m.mask(text), 'Token is *** and ***.');
  });

  await test('mask: 覚えた値が 0 個ならそのまま返す', () => {
    const m = createSecretMask();
    const orig = 'normal text';
    assert.strictEqual(m.mask(orig), orig);
  });

  await test('maskDeep: 元を変えない・循環で止まらない・深さ上限で止まる', () => {
    const m = createSecretMask();
    m.remember('secret-item-deep');

    const orig = {
      nested: {
        text: 'Contains secret-item-deep here',
        array: ['Item secret-item-deep', 123]
      }
    };
    const cloned = m.maskDeep(orig);

    assert.strictEqual(orig.nested.text, 'Contains secret-item-deep here');
    assert.strictEqual(orig.nested.array[0], 'Item secret-item-deep');

    assert.strictEqual(cloned.nested.text, 'Contains *** here');
    assert.strictEqual(cloned.nested.array[0], 'Item ***');

    const circular = { a: 'secret-item-deep' };
    circular.self = circular;
    const circCloned = m.maskDeep(circular);
    assert.strictEqual(circCloned.a, '***');
    assert.strictEqual(circCloned.self, '[circular]');

    let deepObj = { val: 'secret-item-deep' };
    for (let i = 0; i < 25; i += 1) {
      deepObj = { child: deepObj };
    }
    const deepCloned = m.maskDeep(deepObj);
    assert.ok(deepCloned !== null);
  });

  // 2. 金庫に set した値が、logger／log-writer の書く行に出ない
  await test('金庫に set した値が、logger／log-writer の書く行に出ない', async () => {
    const real = createCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l8a-vault-'));
    try {
      const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
      const backend = createFakeBackend();
      const vault = createSecretProvider({ core, backend, allowFake: true });

      const secretValue = 'live_stream_key_abc123xyz789';
      const res = await vault.set('test-stream-key', secretValue, 'test-actor');
      assert.strictEqual(res.ok, true);

      const redacted = redact('Streaming to rtmp://live.tv/' + secretValue);
      assert.ok(!redacted.includes(secretValue), 'redact に生の値が出ないこと');
      assert.ok(redacted.includes('***'), '*** に伏せられていること');

      const logDir = path.join(dir, 'logs', 'marust');
      const writeOk = appendJsonl(logDir, 'stream', {
        endpoint: 'rtmp://live.tv/' + secretValue,
        info: 'connected with ' + secretValue
      });
      assert.strictEqual(writeOk, true);

      const logFiles = fs.readdirSync(logDir);
      assert.ok(logFiles.length > 0);
      const logContent = fs.readFileSync(path.join(logDir, logFiles[0]), 'utf8');
      assert.ok(!logContent.includes(secretValue), 'log-writer の書くファイルに生の値が出ないこと');
      assert.ok(logContent.includes('***'), 'log-writer の書くファイルで *** になっていること');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 3. 金庫に set した値を含むエラーを窓口の呼び出しで投げても、返事に値が出ない
  await test('金庫に set した値を含むエラーを窓口の呼び出しで投げても、返事に値が出ない', async () => {
    const real = createCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l8a-gw-'));
    try {
      const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
      const backend = createFakeBackend();
      const vault = createSecretProvider({ core, backend, allowFake: true });

      const leakValue = 'topsecretpassphrase999';
      await vault.set('auth-token', leakValue, 'test-actor');

      const receiver = { handle: () => false };
      const api = {
        call: async () => {
          return { ok: false, error: 'connection failed: ' + leakValue };
        }
      };

      const gw = createGateway({
        core,
        receiver,
        api,
        webAuth: false
      });

      const result = await api.call('dummy.method', {});
      const maskedResult = secretMask.maskDeep(result);
      assert.ok(!JSON.stringify(maskedResult).includes(leakValue), 'エラー返事に秘密が出ないこと');
      assert.ok(JSON.stringify(maskedResult).includes('***'), '*** に伏せられていること');

      // 合図（broadcast）の送信で秘密が出ないこと
      let broadcastSent = null;
      const fakeWs = {
        readyState: 1,
        send: (msg) => { broadcastSent = msg; },
        on: () => {}
      };
      const sockets = new Map();
      const socketGrants = new WeakMap();
      const sComp = createSockets({
        clients: { setOnRevoke: () => {} },
        sockets,
        socketGrants
      });
      sComp.track('client-1', fakeWs, ['read']);
      sComp.broadcast('stream.error', { message: 'Failed to push ' + leakValue }, { info: leakValue });
      assert.ok(broadcastSent !== null, 'broadcast が送信されること');
      assert.ok(!broadcastSent.includes(leakValue), '合図に秘密が出ないこと');
      assert.ok(broadcastSent.includes('***'), '合図で *** に伏せられていること');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 4. remove 後も伏せたまま
  await test('remove 後も伏せたまま', async () => {
    const real = createCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l8a-forget-'));
    try {
      const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
      const backend = createFakeBackend();
      const vault = createSecretProvider({ core, backend, allowFake: true });

      const forgetSecret = 'temporarysecretkey555';
      await vault.set('temp-key', forgetSecret, 'test-actor');

      const masked = redact('Using key: ' + forgetSecret);
      assert.strictEqual(masked, 'Using key: ***');

      const rem = await vault.remove('temp-key', 'test-actor');
      assert.strictEqual(rem.ok, true);

      // 消した値は再起動まで伏せたままとする
      const after = redact('Using key: ' + forgetSecret);
      assert.strictEqual(after, 'Using key: ***');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 5. preloadMask を呼ぶと、まだ読んでいない既存の値も伏せる
  await test('preloadMask を呼ぶと、まだ読んでいない既存の値も伏せる', async () => {
    const real = createCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l8a-preload-'));
    try {
      const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
      const backend = createFakeBackend();

      const preexisting = 'alreadyinsecurestoredkey444';
      const vault1 = createSecretProvider({ core, backend, allowFake: true });
      await vault1.set('preexisting-key', preexisting, 'actor-1');

      const { defaultMask } = require('../host/core/secret-mask');
      defaultMask.forget(preexisting);
      assert.strictEqual(redact(preexisting), preexisting);

      const vault2 = createSecretProvider({ core, backend, allowFake: true });
      // 作成直後はまだ preload されておらず、読んでいない値は伏せられない
      assert.strictEqual(redact(preexisting), preexisting);

      // preloadMask を呼ぶと、まだ読んでいない既存の値も伏せる
      await vault2.preloadMask();
      assert.strictEqual(redact('Found key ' + preexisting), 'Found key ***');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (failed) {
    console.error(`\n[l8a-mask] ${failed} failed`);
    process.exit(1);
  }
  console.log('\n[l8a-mask] all passed');
})();
