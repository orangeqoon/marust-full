'use strict';
require('./_ui-inline');

/**
 * L8b: 秘密の欄は末尾 4 文字だけ見せる（直す所 34・ADR 0006）。
 * - tailOf の 3 つの場合（12 文字以上・未満・無し）
 * - 金庫の一覧に値が無く tail がある
 * - 配信先の一覧に keyTail があり、キーの全体がどの項目にも無い
 * - ••••abcd が secret-mask で壊れない
 * - obs.getConnection の passwordTail
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tailOf, BULLETS } = require('../host/core/secret-tail');
const { createSecretMask } = require('../host/core/secret-mask');
const { createCore } = require('../host/core/core-bridge');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createObsLocalEngine, REQUIRED } = require('../host/core/engine/obs-local');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');
const { createStateStore } = require('../host/core/state-store');

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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l8b-'));
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
    if (/^(key|token|password|secret|cookie)s?$/i.test(key)) out.push(next);
    secretFields(value[key], next, out);
  }
}

(async () => {
  // 1. tailOf の 3 つの場合
  await test('tailOf: 12 文字以上なら •••• + 末尾 4 文字', () => {
    assert.strictEqual(tailOf('123456789012'), BULLETS + '9012');
    assert.strictEqual(tailOf('live_12345678_abcdef'), BULLETS + 'cdef');
    assert.strictEqual(tailOf('my-secret-key-xyz'), BULLETS + '-xyz');
  });

  await test('tailOf: 12 文字未満なら •••• だけ', () => {
    assert.strictEqual(tailOf('12345678901'), BULLETS);
    assert.strictEqual(tailOf('password'), BULLETS);
    assert.strictEqual(tailOf('a'), BULLETS);
    assert.strictEqual(tailOf('1234'), BULLETS);
  });

  await test('tailOf: 値が無ければ空文字', () => {
    assert.strictEqual(tailOf(''), '');
    assert.strictEqual(tailOf(null), '');
    assert.strictEqual(tailOf(undefined), '');
    assert.strictEqual(tailOf(12345), '');
    assert.strictEqual(tailOf({}), '');
    assert.strictEqual(tailOf(false), '');
  });

  // 2. ••••abcd が secret-mask で壊れない
  await test('secret-mask: ••••abcd が mask で壊れない', () => {
    const mask = createSecretMask();
    const rawSecret = 'live_secret_key_1234567890_abcdef';
    mask.remember(rawSecret);

    const tail = tailOf(rawSecret);
    assert.strictEqual(tail, BULLETS + 'cdef');
    // mask を通しても末尾 4 文字は壊れない
    assert.strictEqual(mask.mask(tail), BULLETS + 'cdef');
    assert.strictEqual(mask.mask('入っています: ' + tail), '入っています: ' + BULLETS + 'cdef');

    // 生の秘密値はちゃんとマスクされる
    assert.strictEqual(mask.mask(rawSecret), '***');
    assert.strictEqual(mask.mask('key=' + rawSecret), 'key=***');
  });

  // 3. 金庫の一覧に値が無く tail がある
  await test('vault: 一覧と describe に値が無く tail がある', async () => {
    const dir = tempDir();
    try {
      const real = createCore();
      const vault = createSecretProvider({
        core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync },
        backend: createFakeBackend(),
        allowFake: true
      });
      await vault.ready;

      const SECRET_LONG = 'long-secret-value-1234abcd';
      const SECRET_SHORT = 'short-val';
      await vault.set('long-key', SECRET_LONG, 'test-actor');
      await vault.set('short-key', SECRET_SHORT, 'test-actor');

      // list() の検証
      const listRes = await vault.list();
      assert.strictEqual(listRes.ok, true);
      const rows = listRes.secrets;
      assert.strictEqual(rows.length, 2);

      const longRow = rows.find((r) => r.name === 'long-key');
      const shortRow = rows.find((r) => r.name === 'short-key');
      assert.ok(longRow);
      assert.ok(shortRow);

      assert.strictEqual(longRow.tail, BULLETS + 'abcd');
      assert.strictEqual(shortRow.tail, BULLETS);
      assert.strictEqual(longRow.value, undefined);
      assert.strictEqual(shortRow.value, undefined);

      // JSON に平文が一切ない
      const dumpedList = JSON.stringify(listRes);
      assert.strictEqual(dumpedList.indexOf(SECRET_LONG), -1);
      assert.strictEqual(dumpedList.indexOf(SECRET_SHORT), -1);

      // describe() の検証
      const descRes = await vault.describe('long-key');
      assert.strictEqual(descRes.ok, true);
      assert.strictEqual(descRes.secret.tail, BULLETS + 'abcd');
      assert.strictEqual(descRes.secret.value, undefined);
      assert.strictEqual(JSON.stringify(descRes).indexOf(SECRET_LONG), -1);

      // coreReader().list() の検証
      const reader = vault.coreReader('reader', ['long-key', 'short-key']);
      const readRes = await reader.list();
      assert.strictEqual(readRes.ok, true);
      const readLong = readRes.secrets.find((r) => r.name === 'long-key');
      assert.strictEqual(readLong.tail, BULLETS + 'abcd');
      assert.strictEqual(readLong.value, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 4. 配信先の一覧に keyTail があり、キーの全体がどの項目にも無い
  await test('engine & destination: 配信先一覧に keyTail がありキー全体はどこにも無い', async () => {
    const dir = tempDir();
    try {
      const real = createCore();
      const store = createStateStore({
        core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync }
      });

      const targets = [
        { id: 't-live', name: 'YouTube Live', state: 'stopped', enabled: true }
      ];

      const RAW_STREAM_KEY = 'live_stream_key_9876543210_wxyz';
      let lastSettings = null;

      const fakeConnection = {
        vendor: async (tier, requestType, requestData) => {
          if (requestType === 'list_capabilities') {
            return {
              requests: REQUIRED.map((item) => ({ name: item }))
            };
          }
          if (requestType === 'get_api_version') return { apiVersion: 3 };
          if (requestType === 'get_snapshot') {
            return { targets: targets };
          }
          if (requestType === 'set_target_service_settings') {
            lastSettings = requestData && requestData.settings;
            return { success: true };
          }
          return { success: true };
        },
        getStatus: () => ({ connected: true }),
        start: async () => ({ ok: true })
      };

      const engine = createObsLocalEngine({
        connection: fakeConnection,
        store: store,
        orchestrator: { modeFor: () => 'live' },
        now: () => new Date()
      });
      await engine.connect();
      await engine.ready;

      // ターゲットにキーを設定
      const setKeyRes = await engine.setKey('t-live', { key: RAW_STREAM_KEY });
      assert.strictEqual(setKeyRes.ok, true);
      assert.ok(lastSettings && lastSettings.key === RAW_STREAM_KEY);

      // listTargets() を検証
      const targetRows = engine.listTargets();
      const liveTarget = targetRows.find((r) => r.id === 't-live');
      assert.ok(liveTarget);
      assert.strictEqual(liveTarget.keyTail, BULLETS + 'wxyz');

      // mainRow の keyTail は空文字
      const mainTarget = targetRows.find((r) => r.id === 'main');
      if (mainTarget) {
        assert.strictEqual(mainTarget.keyTail, '');
      }

      // JSON 化してキー全体がどこにも存在しないことを確認
      const dumpedTargets = JSON.stringify(targetRows);
      assert.strictEqual(dumpedTargets.indexOf(RAW_STREAM_KEY), -1);

      // 禁止フィールド（key, token, password, secret, cookie）がないこと
      const foundForbidden = [];
      secretFields(targetRows, '', foundForbidden);
      assert.deepStrictEqual(foundForbidden, []);

      // destination.link で結びつける
      const linkRes = engine.linkDestination({
        destinationId: 'dest-yt',
        targetId: 't-live',
        site: 'youtube'
      });
      assert.strictEqual(linkRes.ok, true);

      // API 経由の destination.list
      const api = createApi({
        store: store,
        registry: { get: () => engine },
        core: { STATE_DIR: dir }
      });

      const destListRes = await api.call('destination.list', {}, { clientId: WINDOW_ID, kind: 'window', permissions: ['read'] });
      assert.strictEqual(destListRes.ok, true);
      const ytDest = destListRes.destinations.find((d) => d.id === 'dest-yt');
      assert.ok(ytDest);
      assert.strictEqual(ytDest.keyTail, BULLETS + 'wxyz');

      const dumpedDests = JSON.stringify(destListRes);
      assert.strictEqual(dumpedDests.indexOf(RAW_STREAM_KEY), -1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 5. obs.getConnection の passwordTail
  await test('obs.getConnection: 設定済みパスワードの tail が返り平文は出ない', async () => {
    const OBS_PASS = 'obs_websocket_password_12345678_pass';
    const fakeObsSetup = {
      getConnection: async () => ({
        ok: true,
        host: 'localhost',
        port: 4455,
        hasPassword: true,
        source: 'vault',
        connected: true
      }),
      readStored: async () => ({
        host: 'localhost',
        port: 4455,
        password: OBS_PASS
      })
    };

    const api = createApi({
      obsSetup: fakeObsSetup
    });

    const res = await api.call('obs.getConnection', {}, { clientId: WINDOW_ID, kind: 'window', permissions: ['read'] });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.passwordTail, BULLETS + 'pass');
    assert.strictEqual(res.hasPassword, true);
    assert.strictEqual(JSON.stringify(res).indexOf(OBS_PASS), -1);
  });

  // 6. 配信先 keyTail の 3 つの分け（null / '' / ••••abcd）と画面文字列
  await test('keyTail: 3つの分け（末尾が分かる・未設定・分からないnull）と中立文', async () => {
    const STR = require('../plugins/ui-standard/shell/strings');

    // 画面文字列関数の検証
    assert.strictEqual(STR.secretPlaceholder(null), STR.secretTailUnknown);
    assert.strictEqual(STR.secretPlaceholder(undefined), STR.secretTailUnknown);
    assert.strictEqual(STR.secretPlaceholder(''), STR.secretTailUnset);
    assert.strictEqual(STR.secretPlaceholder(BULLETS + 'abcd'), '入っています: ' + BULLETS + 'abcd');
    assert.strictEqual(STR.secretPlaceholder(BULLETS), '入っています: ' + BULLETS);

    const dir = tempDir();
    try {
      const real = createCore();
      const store = createStateStore({
        core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync }
      });

      // エンジンから返ってきたターゲット（list_targets はキーを返さないので key プロパティなし）
      const targets = [
        { id: 't-nokey', name: 'Existing Stream', state: 'stopped', enabled: true },
        { id: 't-emptykey', name: 'Cleared Stream', state: 'stopped', enabled: true, key: '' }
      ];

      const fakeConnection = {
        vendor: async (tier, requestType) => {
          if (requestType === 'list_capabilities') {
            return { requests: REQUIRED.map((item) => ({ name: item })) };
          }
          if (requestType === 'get_api_version') return { apiVersion: 3 };
          if (requestType === 'get_snapshot') return { targets: targets };
          return { success: true };
        },
        getStatus: () => ({ connected: true }),
        start: async () => ({ ok: true })
      };

      const engine = createObsLocalEngine({
        connection: fakeConnection,
        store: store,
        orchestrator: { modeFor: () => 'live' },
        now: () => new Date()
      });
      await engine.connect();
      await engine.ready;

      // 起動直後: marust がキーを書いていない行は keyTail: null
      const rows = engine.listTargets();
      const noKeyTarget = rows.find((r) => r.id === 't-nokey');
      assert.ok(noKeyTarget);
      assert.strictEqual(noKeyTarget.keyTail, null);

      // 空キーと分かっている行は keyTail: ''
      const emptyKeyTarget = rows.find((r) => r.id === 't-emptykey');
      assert.ok(emptyKeyTarget);
      assert.strictEqual(emptyKeyTarget.keyTail, '');

      // destination.link で結びつけて destination.list を取得
      engine.linkDestination({ destinationId: 'dest-nokey', targetId: 't-nokey', site: 'twitch' });
      engine.linkDestination({ destinationId: 'dest-empty', targetId: 't-emptykey', site: 'twitch' });

      const api = createApi({
        store: store,
        registry: { get: () => engine },
        core: { STATE_DIR: dir }
      });

      const destRes = await api.call('destination.list', {}, { clientId: WINDOW_ID, kind: 'window', permissions: ['read'] });
      assert.strictEqual(destRes.ok, true);

      const dNoKey = destRes.destinations.find((d) => d.id === 'dest-nokey');
      assert.ok(dNoKey);
      assert.strictEqual(dNoKey.keyTail, null);

      const dEmpty = destRes.destinations.find((d) => d.id === 'dest-empty');
      assert.ok(dEmpty);
      assert.strictEqual(dEmpty.keyTail, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (failed > 0) {
    console.error(failed + ' tests failed');
    process.exit(1);
  }
  console.log('all tests passed');
})();
