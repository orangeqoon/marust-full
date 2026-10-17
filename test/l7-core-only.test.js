'use strict';

/**
 * L7b: 核だけの結合テスト（host/core/index.js のみ）
 * - host/core/index.js だけを require し、host/layer1 は読まない
 * - 偽の配信エンジンと偽のスロットで核の動作を検証する:
 *   1. 配信先を 1 つ足せる（state-store）
 *   2. 配信開始でその配信先が送信中になり、合図「配信を始めた」（broadcast.started）が 1 回出る
 *   3. 「全部止める」（stopAll）でメイン出力を含めて止まり、合図「全部止めた」（broadcast.stopped）が出る
 * - 一時フォルダを保存場所に使い、作者の state/ に触らない
 * - require.cache に host/layer1 が入っていないことを最後に確かめる
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// 一時フォルダを保存場所にする（作者の state/ に触らない）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l7-core-only-'));
process.env.MARUST_STATE = tmpDir;

// 核の入口だけを require（host/layer1 は一切読まない）
const core = require('../host/core/index.js');

async function waitEvents() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function main() {
  const publishedEvents = [];
  const bus = core.createEventBus({ logger: () => {} });
  bus.subscribe('*', (name, payload) => {
    publishedEvents.push({ name, payload });
  });

  const realCore = core.createCore();
  const isolatedCore = {
    STATE_DIR: tmpDir,
    atomicWriteJsonSync: realCore.atomicWriteJsonSync
  };
  const store = core.createStateStore({ core: isolatedCore, logger: () => {} });

  // 1. 配信先を 1 つ足せる（state-store）
  test('核だけで配信先を 1 つ追加できる（state-store）', () => {
    const putRes = store.putDestination({
      id: 'dest-core-1',
      site: 'mock-site',
      name: 'Mock Destination',
      enabled: true,
      engine: { id: 'mock-engine', targetId: 'target-1' }
    });
    assert.strictEqual(putRes.ok, true);

    const summary = store.destinationSummary();
    assert.strictEqual(summary.count, 1);

    const snapshot = store.snapshot();
    assert.strictEqual(snapshot.destinations.length, 1);
    assert.strictEqual(snapshot.destinations[0].id, 'dest-core-1');
  });

  // 偽の配信エンジン（メイン出力フラグと個別ターゲットフラグを管理）
  let mainOutputActive = false;
  let targetActive = false;
  const mockEngine = {
    id: 'mock-engine',
    setKey: (id, settings, flags) => ({ ok: true }),
    start: (id) => {
      targetActive = true;
      return { ok: true };
    },
    stop: (id) => {
      targetActive = false;
      return { ok: true };
    },
    emergencyStop: async () => {
      mainOutputActive = false;
      targetActive = false;
      return { ok: true, results: [{ id: 'target-1', ok: true }] };
    },
    listTargets: () => [
      { id: 'target-1', state: targetActive ? 'live' : 'stopped' }
    ]
  };

  const preflight = {
    run: async (ids) => ({
      ok: true,
      globalOk: true,
      blocked: [],
      items: []
    })
  };

  const broadcast = core.createBroadcast({
    preflight,
    registry: { getRunning: () => [] },
    store,
    bus,
    engines: {
      get: (id) => (id === 'mock-engine' ? mockEngine : null),
      emergencyStop: (ctx) => mockEngine.emergencyStop(ctx)
    },
    orchestrator: { modeFor: () => 'live' },
    now: () => Date.now(),
    sleep: async () => {},
    liveWaitMs: 100,
    verifyWaitMs: 100,
    verifyIntervalMs: 50
  });

  // 2. 配信開始で、その配信先が送信中になり、合図「配信を始めた」が 1 回出る
  await test('配信開始で配信先が送信中になり、合図「配信を始めた」が 1 回出る', async () => {
    mainOutputActive = true;
    const startResult = await broadcast.start({
      destinationIds: ['dest-core-1'],
      confirmed: true
    });
    assert.strictEqual(startResult.ok, true);
    assert.strictEqual(targetActive, true, '配信先が送信中（live）になること');

    await waitEvents();

    const startedEvents = publishedEvents.filter(
      (e) => e.name === core.EVENTS.BROADCAST_STARTED
    );
    assert.strictEqual(startedEvents.length, 1, 'broadcast.started は 1 回だけ発行されること');
    assert.deepStrictEqual(startedEvents[0].payload.destinationIds, ['dest-core-1']);
  });

  // 3. 「全部止める」でメイン出力を含めて止まり、合図「全部止めた」が出る
  await test('全部止めるでメイン出力を含めて止まり、合図「全部止めた」が出る', async () => {
    const stopResult = await broadcast.stopAll();
    assert.strictEqual(stopResult.ok, true);
    assert.strictEqual(mainOutputActive, false, 'メイン出力を含めて停止すること');
    assert.strictEqual(targetActive, false, '配信先が停止すること');

    await waitEvents();

    const stoppedEvents = publishedEvents.filter(
      (e) => e.name === core.EVENTS.BROADCAST_STOPPED
    );
    assert.strictEqual(stoppedEvents.length, 1, 'broadcast.stopped が発行されること');
  });

  // 4. require.cache に host/layer1 が入っていないことを確かめる
  test('require.cache に host/layer1 が入っていない', () => {
    const layer1Loaded = Object.keys(require.cache).filter((p) =>
      p.replace(/\\/g, '/').includes('/host/layer1/')
    );
    assert.deepStrictEqual(layer1Loaded, [], 'require.cache に host/layer1 が含まれていてはならない');
  });

  // クリーンアップ
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}

  if (failed) {
    console.error(`[l7-core-only] ${failed} failed`);
    process.exit(1);
  }
  console.log('[l7-core-only] all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
