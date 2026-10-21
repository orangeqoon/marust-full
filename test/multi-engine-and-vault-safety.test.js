'use strict';
require('./_ui-inline');

/**
 * multi-engine-and-vault-safety.test.js
 *
 * Codex 指摘の証明テスト（指摘2・3・4・5）:
 * 1. 性質の違う模擬エンジン2台（engine-a: 高速応答 / engine-b: ハング・故障）での一貫ライフサイクル
 *    - stream.engine@1 契約テストのパスと契約違反検出（指摘5）
 *    - 起動・登録 (attachEngine)
 *    - 厳密なID解決: 未登録エンジンIDは勝手にフォールバックせず null を返す（指摘4）
 *    - 事前検査の障害局所化: engine-b切断でもengine-aはブロックされず通過（指摘4）
 *    - 開始と一部故障の分離: engine-a配信先は正常開始（指摘5）
 *    - 非常停止の並列・即時到達: engine-aハングでもengine-bは即座に停止し、engine-aはtimeout（指摘2）
 *    - 終了: core.close() で両エンジンがクリーン終了（指摘5）
 * 2. 金庫（vault-store-file.js）の偽ファイル操作によるデータ保護（指摘3）
 *    - 破損行バックアップ失敗時に元ファイルを上書き破壊しない証明
 *    - readFileSync が EBUSY 等を投げたときに空金庫で初期化せず明示的エラーになる証明
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contracts = require('./contracts');
const { createEngineRegistry } = require('../host/core/engine');
const { createPreflight } = require('../host/core/engine/preflight');
const { createBroadcast } = require('../host/core/engine/broadcast');
const { createLocalCore } = require('../host/core/paths-local');
const { createFileStore } = require('../host/core/vault-store-file');
const { createEventBus } = require('../host/core/event-bus');
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

function quiet() {}

(async () => {
  // =========================================================================
  // 1. stream.engine@1 契約検証テスト（指摘5前半）
  // =========================================================================
  await test('契約テスト: stream.engine@1 は必要な関数群の存在を正しく検証する', () => {
    // 正常なエンジン
    const validEngine = {
      id: 'valid-engine',
      capabilities: () => ({ emergencyStop: true }),
      listTargets: () => [],
      status: () => ({ connected: true }),
      start: () => ({ ok: true }),
      stop: () => ({ ok: true }),
      stopAll: async () => ({ ok: true })
    };
    const okCheck = contracts.check('stream.engine@1', { module: validEngine });
    assert.deepStrictEqual(okCheck, [], '正常エンジンで欠けが検出された: ' + okCheck.join(', '));

    // 不完全なエンジン（stopAll と status が欠落）
    const brokenEngine = {
      id: 'broken-engine',
      capabilities: () => ({}),
      listTargets: () => [],
      start: () => ({ ok: true }),
      stop: () => ({ ok: true })
    };
    const badCheck = contracts.check('stream.engine@1', { module: brokenEngine });
    assert.ok(badCheck.indexOf('関数 status') !== -1, 'status欠落が検出されること');
    assert.ok(badCheck.indexOf('関数 stopAll') !== -1, 'stopAll欠落が検出されること');
  });

  // =========================================================================
  // 2. 模擬エンジン2台での一貫ライフサイクル試験（指摘2・4・5）
  // =========================================================================
  await test('模擬エンジン2台: 起動・厳密解決・事前検査局所化・並列非常停止・クリーン終了', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-multi-engine-'));
    try {
      const core = createLocalCore({ stateDir: tmpDir });
      const bus = createEventBus({ logger: quiet });
      const store = createStateStore({ core, bus, logger: quiet });

      let engineACloseCalled = false;
      let engineBCloseCalled = false;
      let engineBStopAllCalledAt = 0;
      let emergencyStopStartedAt = 0;

      // engine-a: 高速応答だが、後で stopAll をハング状態に切り替え可能
      let engineAHangStopAll = false;
      let targetAState = 'stopped';
      const engineA = {
        id: 'engine-a',
        capabilities: () => ({ emergencyStop: true, write: true }),
        listTargets: () => [{ id: 'target-a', name: 'target-a', state: targetAState, enabled: true }],
        status: () => ({ id: 'engine-a', connected: true, supported: true, mode: 'live', missing: [] }),
        start: (id) => { targetAState = 'live'; return { ok: true, id }; },
        stop: (id) => { targetAState = 'stopped'; return { ok: true, id }; },
        stopAll: async () => {
          targetAState = 'stopped';
          if (engineAHangStopAll) {
            // 永遠に応答しないハング
            return new Promise(() => {});
          }
          return { ok: true, count: 1 };
        },
        close: async () => { engineACloseCalled = true; }
      };

      // engine-b: 故障・切断シミュレート可能、stopAll は即座に成功
      let engineBConnected = true;
      const engineB = {
        id: 'engine-b',
        capabilities: () => ({ emergencyStop: true, write: true }),
        listTargets: () => [{ id: 'target-b', name: 'target-b', state: 'stopped', enabled: true }],
        status: () => ({ id: 'engine-b', connected: engineBConnected, supported: true, mode: 'live', missing: [] }),
        start: (id) => ({ ok: true, id }),
        stop: (id) => ({ ok: true, id }),
        stopAll: async () => {
          engineBStopAllCalledAt = Date.now();
          return { ok: true, accepted: true, verified: true, count: 1 };
        },
        shutdown: () => { engineBCloseCalled = true; }
      };

      // 起動・登録 & core.attachEngine
      const registry = createEngineRegistry();
      registry.register('engine-a', engineA);
      registry.register('engine-b', engineB);
      core.attachEngine(engineA);
      core.attachEngine(engineB);

      // (A) 厳密なID解決（指摘4）
      // 登録済みの解決
      assert.strictEqual(registry.resolveForDestination({ engine: { id: 'engine-a' } }), engineA);
      assert.strictEqual(registry.resolveForDestination({ engine: { id: 'engine-b' } }), engineB);
      // 未登録の 'cloud-relay' は勝手に obs-local や engine-a にフォールバックせず null を返す！
      assert.strictEqual(registry.resolveForDestination({ engine: { id: 'cloud-relay' } }), null);
      // 未指定時は obs-local が無ければ null（複数台登録時は only() も null）
      assert.strictEqual(registry.resolveForDestination({}), null);

      // (B) 事前検査の障害局所化（指摘4）
      // engine-b を切断状態にする
      engineBConnected = false;
      store.putDestination({
        id: 'dest-a',
        site: 'site-a',
        enabled: true,
        engine: { id: 'engine-a', targetId: 'target-a' }
      });
      store.putDestination({
        id: 'dest-b',
        site: 'site-b',
        enabled: true,
        engine: { id: 'engine-b', targetId: 'target-b' }
      });

      const preflight = createPreflight({
        engines: registry,
        store: store,
        orchestrator: { modeFor: () => 'live' },
        logger: quiet
      });

      const pfResult = await preflight.run(['dest-a', 'dest-b']);
      // engine-a の配信先はブロックされず通過し、engine-b の配信先だけが blocked に入る！
      assert.strictEqual(pfResult.globalOk, true, 'globalOk は true であること（全体ブロックされない）');
      assert.ok(pfResult.blocked.indexOf('dest-b') !== -1, 'dest-b は blocked に含まれること');
      assert.strictEqual(pfResult.blocked.indexOf('dest-a'), -1, 'dest-a は blocked に含まれないこと（通過する）');
      const destBError = pfResult.items.find((it) => it.destinationId === 'dest-b' && it.code === 'engine-disconnected');
      assert.ok(destBError, 'dest-b に対する engine-disconnected エラーが存在すること');

      // (C) 開始と一部故障の分離（指摘5）
      // engine-b は切断されているが、engine-a は正常開始できる
      const broadcast = createBroadcast({
        preflight: preflight,
        engines: registry,
        store: store,
        bus: bus,
        orchestrator: { modeFor: () => 'live' },
        logger: quiet
      });

      // dest-a 単体の開始
      const startRes = await broadcast.start({ destinationIds: ['dest-a'], confirmed: true });
      assert.strictEqual(startRes.ok, true, 'dest-a の開始が成功すること');

      // (D) 非常停止の並列・即時到達（指摘2）
      // engine-a をハング状態に設定
      engineAHangStopAll = true;
      emergencyStopStartedAt = Date.now();

      const emResult = await registry.emergencyStop({ timeoutMs: 80 });
      const elapsed = Date.now() - emergencyStopStartedAt;

      // engine-b.stopAll が即座に呼ばれたことの検証
      assert.ok(engineBStopAllCalledAt > 0, 'engine-b.stopAll が呼ばれたこと');
      assert.ok(engineBStopAllCalledAt - emergencyStopStartedAt < 60, 'engine-b.stopAll は engine-a のハングに待たされず即時（60ms以内）に呼ばれたこと');
      // 全体は約80msのタイムアウトで返る
      assert.ok(elapsed >= 70 && elapsed < 300, 'emergencyStop はタイムアウト（80ms）付近で完了したこと: ' + elapsed + 'ms');

      // 結果の集約検証
      assert.strictEqual(emResult.ok, false, '1台タイムアウトしたため全体 ok は false');
      const rowA = emResult.results.find((r) => r.id === 'engine-a');
      const rowB = emResult.results.find((r) => r.id === 'engine-b');

      assert.ok(rowA, 'engine-a の結果行が存在すること');
      assert.strictEqual(rowA.accepted, true, 'engine-a accepted: true');
      assert.strictEqual(rowA.verified, false, 'engine-a verified: false');
      assert.strictEqual(rowA.error, 'emergency-stop-timeout', 'engine-a error: emergency-stop-timeout');

      assert.ok(rowB, 'engine-b の結果行が存在すること');
      assert.strictEqual(rowB.accepted, true, 'engine-b accepted: true');
      assert.strictEqual(rowB.verified, true, 'engine-b verified: true');
      assert.strictEqual(rowB.ok, true, 'engine-b ok: true');

      // (E) クリーン終了（指摘5）
      await core.close();
      assert.strictEqual(engineACloseCalled, true, 'engine-a の close() が呼ばれたこと');
      assert.strictEqual(engineBCloseCalled, true, 'engine-b の shutdown() が呼ばれたこと');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 3. 金庫（vault-store-file.js）の偽ファイル操作によるデータ保護試験（指摘3）
  // =========================================================================
  await test('金庫保護: 破損行のバックアップ退避失敗時に元ファイルを上書き破壊しない証明', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-vault-test-'));
    try {
      const servicesDir = path.join(tmpDir, 'services');
      fs.mkdirSync(servicesDir, { recursive: true });
      const filePath = path.join(servicesDir, 'marust-vault.json');

      // 1件の正常行と、1件の破損行（nameが無い、値が無い等）を含む金庫ファイル
      const originalContent = JSON.stringify({
        schemaVersion: 1,
        entries: [
          { name: 'valid-token', ciphertext: 'enc123', iv: 'iv123', tag: 'tag123', updatedAt: 1000 },
          { invalid: 'broken-entry-without-name' } // 破損行
        ]
      }, null, 2);
      fs.writeFileSync(filePath, originalContent, 'utf8');

      // fs.copyFileSync をモックして退避失敗（EACCES / ディスクフル等）をシミュレート
      const originalCopyFileSync = fs.copyFileSync;
      let copyAttempted = false;
      fs.copyFileSync = (src, dest) => {
        copyAttempted = true;
        const err = new Error('EACCES: permission denied, copy failed');
        err.code = 'EACCES';
        throw err;
      };

      let store;
      try {
        let written = false;
        store = createFileStore({
          stateDir: tmpDir,
          writeJson: (f, data) => { written = true; fs.writeFileSync(f, JSON.stringify(data)); },
          warn: quiet
        });

        const listRes = store.list();
        assert.strictEqual(copyAttempted, true, '退避 copyFileSync が試みられたこと');
        assert.strictEqual(listRes.ok, false, '退避失敗時は list が unavailable になること');
        assert.strictEqual(listRes.error, 'unavailable');
        assert.strictEqual(written, false, '元ファイルへの上書き persist() は絶対に実行されないこと');

        // 元ファイルの中身が破壊されずにそのまま残っていることを証明！
        const preservedContent = fs.readFileSync(filePath, 'utf8');
        assert.strictEqual(preservedContent, originalContent, '元ファイルの内容が完全に保護されていること');

        // put や delete も保護されて書き込み不可
        const putRes = store.put({ name: 'new-key', ciphertext: 'c', iv: 'i', tag: 't' });
        assert.strictEqual(putRes.ok, false);
        assert.strictEqual(putRes.error, 'unavailable');
      } finally {
        fs.copyFileSync = originalCopyFileSync;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('金庫保護: readFileSync が ENOENT 以外の読取エラー（EBUSY 等）のとき空金庫で初期化せず明示的エラーになる証明', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-vault-io-'));
    try {
      const servicesDir = path.join(tmpDir, 'services');
      fs.mkdirSync(servicesDir, { recursive: true });
      const filePath = path.join(servicesDir, 'marust-vault.json');

      const originalContent = JSON.stringify({
        schemaVersion: 1,
        entries: [
          { name: 'secret-a', ciphertext: 'aaa', iv: 'i', tag: 't', updatedAt: 100 }
        ]
      });
      fs.writeFileSync(filePath, originalContent, 'utf8');

      // fs.readFileSync をモックして EBUSY をスロー
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = (p, opt) => {
        if (p === filePath) {
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return originalReadFileSync(p, opt);
      };

      try {
        let written = false;
        const store = createFileStore({
          stateDir: tmpDir,
          writeJson: () => { written = true; },
          warn: quiet
        });

        const res = store.list();
        // 空金庫として成功扱いせず、明示的にエラーになる！
        assert.strictEqual(res.ok, false, 'EBUSY 発生時は ok: false であること');
        assert.strictEqual(res.error, 'unavailable', 'error は unavailable であること');
        assert.strictEqual(written, false, '書き込みは発生しないこと');

        // put も断られる
        const putRes = store.put({ name: 'other', ciphertext: 'x', iv: 'i', tag: 't' });
        assert.strictEqual(putRes.ok, false);
        assert.strictEqual(putRes.error, 'unavailable');
      } finally {
        fs.readFileSync = originalReadFileSync;
      }

      // 元のファイルが消えたり空で上書きされたりしていないことを証明
      const afterContent = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(afterContent, originalContent, '金庫ファイルがそのまま残っていること');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  if (failed) {
    console.error(`[multi-engine-and-vault-safety] ${failed} failed`);
    process.exit(1);
  }
  console.log('[marust] multi-engine-and-vault-safety tests passed');
  process.exit(0);
})();
