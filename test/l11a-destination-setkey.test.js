'use strict';

/**
 * L11a: destination.setKey の試験。
 * - 送信中なら streaming、メイン出力なら main-output、無い配信先なら unknown-destination、結び付いていなければ no-engine。
 * - 書けたとき、エンジンの setKey が (targetId, { key, server }, { restartIfActive: false }) で呼ばれる。
 * - 返事に key の値が入らない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApi } = require('../host/layer1/api');
const { createStateStore } = require('../host/core/state-store');
const { createCore } = require('../host/core/core-bridge');
const { WINDOW_ID } = require('../host/layer1/clients');

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

const SENTINEL_KEY = 'SENTINEL-SECRET-KEY-12345';
const SENTINEL_SERVER = 'rtmp://example.com/live';

function makeFixture(initialDestinations, engineOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l11a-'));
  const real = createCore();
  const core = { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync };
  const store = createStateStore({ core, logger: () => {} });

  (initialDestinations || []).forEach((dest) => {
    store.putDestination(dest);
  });

  const engineCalls = [];
  const engineState = {
    targets: [
      { id: 't1', name: 'T1', state: 'stopped' },
      { id: 't-live', name: 'TLive', state: 'live' }
    ]
  };

  const mockEngine = Object.assign({
    id: 'obs-local',
    listTargets() {
      return engineState.targets.slice();
    },
    setKey(targetId, settings, options) {
      engineCalls.push({ targetId, settings, options });
      return { ok: true, key: 'SHOULD_NOT_LEAK' };
    }
  }, engineOverrides || {});

  const registry = {
    get(id) {
      if (id === mockEngine.id) return mockEngine;
      return null;
    },
    only() {
      return mockEngine;
    }
  };

  const api = createApi({
    core,
    registry,
    store,
    audit: { write() {} }
  });

  const ctx = {
    clientId: WINDOW_ID,
    kind: 'window',
    permissions: ['read', 'write']
  };

  return {
    dir,
    api,
    ctx,
    store,
    mockEngine,
    engineCalls,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function main() {
  await test('無い配信先なら unknown-destination', async () => {
    const f = makeFixture([
      { id: 'dest-1', site: 'rumble', enabled: true, engine: { id: 'obs-local', targetId: 't1' } }
    ]);
    try {
      const res = await f.api.call('destination.setKey', { id: 'dest-nonexistent', key: SENTINEL_KEY }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'unknown-destination');
      assert.strictEqual(f.engineCalls.length, 0);
    } finally {
      f.cleanup();
    }
  });

  await test('メイン出力（obs-main）なら main-output', async () => {
    const f = makeFixture([
      { id: 'obs-main', site: 'rumble', enabled: true, engine: { id: 'obs-local', targetId: 'main' } }
    ]);
    try {
      const res = await f.api.call('destination.setKey', { id: 'obs-main', key: SENTINEL_KEY }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'main-output');
      assert.strictEqual(f.engineCalls.length, 0);
    } finally {
      f.cleanup();
    }
  });

  await test('エンジンに結び付いていなければ no-engine（engine が null）', async () => {
    const f = makeFixture([
      { id: 'dest-no-eng', site: 'rumble', enabled: true, engine: null }
    ]);
    try {
      const res = await f.api.call('destination.setKey', { id: 'dest-no-eng', key: SENTINEL_KEY }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'no-engine');
      assert.strictEqual(f.engineCalls.length, 0);
    } finally {
      f.cleanup();
    }
  });

  await test('エンジンに結び付いていなければ no-engine（未知の engine.id）', async () => {
    const f = makeFixture([
      { id: 'dest-bad-eng', site: 'rumble', enabled: true, engine: { id: 'unknown-engine', targetId: 't1' } }
    ]);
    try {
      const res = await f.api.call('destination.setKey', { id: 'dest-bad-eng', key: SENTINEL_KEY }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'no-engine');
      assert.strictEqual(f.engineCalls.length, 0);
    } finally {
      f.cleanup();
    }
  });

  await test('送信中（actual.engineState が live）なら streaming', async () => {
    const f = makeFixture([
      {
        id: 'dest-live-actual',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: 't1' },
        actual: { engineState: 'live' }
      }
    ]);
    try {
      const res = await f.api.call('destination.setKey', { id: 'dest-live-actual', key: SENTINEL_KEY }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'streaming');
      assert.strictEqual(f.engineCalls.length, 0);
    } finally {
      f.cleanup();
    }
  });

  await test('送信中（actual.engineState が connecting / reconnecting）なら streaming', async () => {
    for (const state of ['connecting', 'reconnecting']) {
      const f = makeFixture([
        {
          id: 'dest-conn',
          site: 'rumble',
          enabled: true,
          engine: { id: 'obs-local', targetId: 't1' },
          actual: { engineState: state }
        }
      ]);
      try {
        const res = await f.api.call('destination.setKey', { id: 'dest-conn', key: SENTINEL_KEY }, f.ctx);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, 'streaming');
        assert.strictEqual(f.engineCalls.length, 0);
      } finally {
        f.cleanup();
      }
    }
  });

  await test('送信中（エンジンの listTargets が live）なら streaming', async () => {
    const f = makeFixture([
      {
        id: 'dest-target-live',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: 't-live' }
      }
    ]);
    try {
      const res = await f.api.call('destination.setKey', { id: 'dest-target-live', key: SENTINEL_KEY }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'streaming');
      assert.strictEqual(f.engineCalls.length, 0);
    } finally {
      f.cleanup();
    }
  });

  await test('書けたとき、エンジンの setKey が (targetId, { key, server }, { restartIfActive: false }) で呼ばれ、返事に key が入らない', async () => {
    const f = makeFixture([
      {
        id: 'dest-ok',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: 't1' },
        actual: { engineState: 'stopped' }
      }
    ]);
    try {
      const res = await f.api.call('destination.setKey', {
        id: 'dest-ok',
        key: SENTINEL_KEY,
        server: SENTINEL_SERVER
      }, f.ctx);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(f.engineCalls.length, 1);
      const call = f.engineCalls[0];
      assert.strictEqual(call.targetId, 't1');
      assert.deepStrictEqual(call.settings, { key: SENTINEL_KEY, server: SENTINEL_SERVER });
      assert.deepStrictEqual(call.options, { restartIfActive: false });

      // 返事に key の値が入らないこと
      const dump = JSON.stringify(res);
      assert.strictEqual(dump.indexOf(SENTINEL_KEY), -1, 'response contains secret key');
      assert.strictEqual(dump.indexOf('SHOULD_NOT_LEAK'), -1, 'response leaked engine returned key');
    } finally {
      f.cleanup();
    }
  });

  await test('server 省略時は key のみ settings に渡る', async () => {
    const f = makeFixture([
      {
        id: 'dest-ok-noserver',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: 't1' },
        actual: { engineState: 'stopped' }
      }
    ]);
    try {
      const res = await f.api.call('destination.setKey', {
        id: 'dest-ok-noserver',
        key: SENTINEL_KEY
      }, f.ctx);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(f.engineCalls.length, 1);
      assert.deepStrictEqual(f.engineCalls[0].settings, { key: SENTINEL_KEY });
    } finally {
      f.cleanup();
    }
  });

  await test('key が空文字なら key-empty で断る', async () => {
    const f = makeFixture([
      {
        id: 'dest-ok',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: 't1' }
      }
    ]);
    try {
      const res = await f.api.call('destination.setKey', {
        id: 'dest-ok',
        key: '   '
      }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'key-empty');
      assert.strictEqual(f.engineCalls.length, 0);
    } finally {
      f.cleanup();
    }
  });

  await test('impl.setKey の返事が undefined のとき失敗として { ok: false, error: "failed" } を返す', async () => {
    const f = makeFixture([
      {
        id: 'dest-ok',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: 't1' }
      }
    ], {
      setKey() {
        // undefined を返す
      }
    });
    try {
      const res = await f.api.call('destination.setKey', {
        id: 'dest-ok',
        key: SENTINEL_KEY
      }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'failed');
    } finally {
      f.cleanup();
    }
  });

  await test('impl.setKey の返事が ok:false のときエラーをそのまま返す', async () => {
    const f = makeFixture([
      {
        id: 'dest-ok',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: 't1' }
      }
    ], {
      setKey() {
        return { ok: false, error: 'obs-socket-closed' };
      }
    });
    try {
      const res = await f.api.call('destination.setKey', {
        id: 'dest-ok',
        key: SENTINEL_KEY
      }, f.ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'obs-socket-closed');
    } finally {
      f.cleanup();
    }
  });

  if (failed) {
    console.error(`[marust] destination.setKey tests failed: ${failed}`);
    process.exit(1);
  }
  console.log('[marust] destination.setKey tests passed');
}

main();
