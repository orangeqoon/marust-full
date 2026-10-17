'use strict';

/**
 * L11a: Rumble の枠 action prepareSlot の試験。
 * - legacy は off、shadow は書かない（destination.setKey が呼ばれない）。
 * - live で rumble の配信先 1 つ → その id に書く。ほかのサイトの配信先には書かない。
 * - rumble の配信先 0 → no-destination、2 → ambiguous、destinationId がほかのサイト → not-own-site。
 * - destination.setKey が streaming を返すとそのまま返す。
 * - 返事・ログに SENTINEL のキーが出ない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createRumbleSlot } = require('../slot');

const SENTINEL_API = 'SENTINEL-RUMBLE-API-KEY-999';
const SENTINEL_COOKIE = 'SENTINEL-RUMBLE-COOKIE-888';
const SENTINEL_STREAM = 'SENTINEL-SECRET-STREAM-KEY-777';
const SERVER_URL = 'rtmp://ls1.live.rmbl.ws/slot-1';

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

function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async text() { return text; }
  };
}

function boot(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l11a-rumble-slot-'));
  const fetchCalls = [];
  const logs = [];
  const apiCalls = [];

  const defaultFetch = async (url) => {
    fetchCalls.push(String(url));
    // 既存枠を 1 件返すモック
    return jsonResponse(200, {
      livestreams: [
        {
          id: 'ls-rumble-1',
          server_url: SERVER_URL,
          stream_key: SENTINEL_STREAM,
          is_live: false
        }
      ]
    });
  };

  const fetchImpl = opts.fetch || defaultFetch;

  const plugin = createRumbleSlot({
    fetch: async (url, init) => {
      fetchCalls.push(String(url));
      return fetchImpl(url, init);
    }
  });

  let mode = opts.mode || 'live';
  const destinations = opts.destinations || [
    { id: 'dest-rumble', site: 'rumble', main: false },
    { id: 'dest-twitch', site: 'twitch', main: false }
  ];

  const ctx = {
    id: 'rumble-slot',
    dataDir: dir,
    mode() { return mode; },
    logger(level, message) { logs.push(String(message)); },
    redact(text) { return String(text); },
    secrets: {
      async get(name) {
        if (name === 'rumble.livestream-api') return { ok: true, value: SENTINEL_API };
        if (name === 'cookies.rumble-main') return { ok: true, value: SENTINEL_COOKIE };
        return { ok: false, error: 'not-declared' };
      }
    },
    api: {
      async call(method, params) {
        apiCalls.push({ method, params });
        if (method === 'destination.list') {
          return { ok: true, destinations: destinations.slice() };
        }
        if (method === 'destination.setKey') {
          if (opts.setKeyResult) return opts.setKeyResult(params);
          return { ok: true };
        }
        return { ok: false, error: 'unknown-method' };
      }
    }
  };

  plugin.load(ctx);

  return {
    plugin,
    ctx,
    dir,
    fetchCalls,
    logs,
    apiCalls,
    setMode(m) { mode = m; },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function main() {
  await test('legacy は off（何もせず { ok: false, error: "off" }、setKey は呼ばれない）', async () => {
    const bag = boot({ mode: 'legacy' });
    try {
      const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
      assert.deepStrictEqual(res, { ok: false, error: 'off' });
      assert.strictEqual(bag.fetchCalls.length, 0);
      assert.strictEqual(bag.apiCalls.length, 0);
    } finally {
      bag.cleanup();
    }
  });

  await test('shadow は書かない（{ ok: true, dryRun: true }、setKey は呼ばれない）', async () => {
    const bag = boot({ mode: 'shadow' });
    try {
      const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
      assert.deepStrictEqual(res, { ok: true, dryRun: true });
      assert.strictEqual(bag.fetchCalls.length, 0);
      assert.strictEqual(bag.apiCalls.length, 0);
    } finally {
      bag.cleanup();
    }
  });

  await test('live で rumble の配信先 1 つ → その id に書く。ほかのサイトの配信先には書かない', async () => {
    const bag = boot({
      mode: 'live',
      destinations: [
        { id: 'dest-rumble', site: 'rumble', main: false },
        { id: 'dest-youtube', site: 'youtube', main: false },
        { id: 'obs-main', site: 'rumble', main: true } // main: true は除外される
      ]
    });
    try {
      const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.destinationId, 'dest-rumble');
      assert.strictEqual(res.reused, true);
      assert.strictEqual(res.keyTail, '••••' + SENTINEL_STREAM.slice(-4));

      // destination.setKey の呼び出し確認
      const setKeyCalls = bag.apiCalls.filter((c) => c.method === 'destination.setKey');
      assert.strictEqual(setKeyCalls.length, 1);
      assert.strictEqual(setKeyCalls[0].params.id, 'dest-rumble');
      assert.strictEqual(setKeyCalls[0].params.key, SENTINEL_STREAM);
      assert.strictEqual(setKeyCalls[0].params.server, SERVER_URL);
    } finally {
      bag.cleanup();
    }
  });

  await test('destinationId が指定されていればその rumble 配信先に書く', async () => {
    const bag = boot({
      mode: 'live',
      destinations: [
        { id: 'dest-r1', site: 'rumble', main: false },
        { id: 'dest-r2', site: 'rumble', main: false }
      ]
    });
    try {
      const res = await bag.plugin.actions.prepareSlot({ destinationId: 'dest-r2' }, bag.ctx);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.destinationId, 'dest-r2');

      const setKeyCalls = bag.apiCalls.filter((c) => c.method === 'destination.setKey');
      assert.strictEqual(setKeyCalls.length, 1);
      assert.strictEqual(setKeyCalls[0].params.id, 'dest-r2');
    } finally {
      bag.cleanup();
    }
  });

  await test('rumble の配信先 0 → no-destination（枠を取らない・fetch なし）', async () => {
    const bag = boot({
      mode: 'live',
      destinations: [
        { id: 'dest-twitch', site: 'twitch', main: false }
      ]
    });
    try {
      const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
      assert.deepStrictEqual(res, { ok: false, error: 'no-destination' });
      assert.strictEqual(bag.fetchCalls.length, 0, 'fetch should not be called');
      const setKeyCalls = bag.apiCalls.filter((c) => c.method === 'destination.setKey');
      assert.strictEqual(setKeyCalls.length, 0);
    } finally {
      bag.cleanup();
    }
  });

  await test('rumble の配信先 2（destinationId 指定なし）→ ambiguous（枠を取らない・fetch なし）', async () => {
    const bag = boot({
      mode: 'live',
      destinations: [
        { id: 'dest-r1', site: 'rumble', main: false },
        { id: 'dest-r2', site: 'rumble', main: false }
      ]
    });
    try {
      const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
      assert.deepStrictEqual(res, { ok: false, error: 'ambiguous' });
      assert.strictEqual(bag.fetchCalls.length, 0, 'fetch should not be called');
      const setKeyCalls = bag.apiCalls.filter((c) => c.method === 'destination.setKey');
      assert.strictEqual(setKeyCalls.length, 0);
    } finally {
      bag.cleanup();
    }
  });

  await test('destinationId がほかのサイト → not-own-site（枠を取らない・fetch なし）', async () => {
    const bag = boot({
      mode: 'live',
      destinations: [
        { id: 'dest-rumble', site: 'rumble', main: false },
        { id: 'dest-twitch', site: 'twitch', main: false }
      ]
    });
    try {
      const res = await bag.plugin.actions.prepareSlot({ destinationId: 'dest-twitch' }, bag.ctx);
      assert.deepStrictEqual(res, { ok: false, error: 'not-own-site' });
      assert.strictEqual(bag.fetchCalls.length, 0, 'fetch should not be called');
      const setKeyCalls = bag.apiCalls.filter((c) => c.method === 'destination.setKey');
      assert.strictEqual(setKeyCalls.length, 0);
    } finally {
      bag.cleanup();
    }
  });

  await test('選んだ配信先の status が live・connecting・reconnecting なら枠を取らず streaming を返す', async () => {
    for (const status of ['live', 'connecting', 'reconnecting']) {
      const bag = boot({
        mode: 'live',
        destinations: [
          { id: 'dest-rumble', site: 'rumble', main: false, status: status }
        ]
      });
      try {
        const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
        assert.deepStrictEqual(res, { ok: false, error: 'streaming' });
        assert.strictEqual(bag.fetchCalls.length, 0, 'fetch should not be called when destination is sending');
        const setKeyCalls = bag.apiCalls.filter((c) => c.method === 'destination.setKey');
        assert.strictEqual(setKeyCalls.length, 0, 'setKey should not be called');
      } finally {
        bag.cleanup();
      }
    }
  });

  await test('destination.setKey が streaming を返すとそのまま返す', async () => {
    const bag = boot({
      mode: 'live',
      destinations: [
        { id: 'dest-rumble', site: 'rumble', main: false }
      ],
      setKeyResult: () => ({ ok: false, error: 'streaming' })
    });
    try {
      const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
      assert.deepStrictEqual(res, { ok: false, error: 'streaming' });
    } finally {
      bag.cleanup();
    }
  });

  await test('返事・ログに SENTINEL のキーが出ない', async () => {
    const bag = boot({
      mode: 'live',
      destinations: [
        { id: 'dest-rumble', site: 'rumble', main: false }
      ]
    });
    try {
      const res = await bag.plugin.actions.prepareSlot({}, bag.ctx);
      assert.strictEqual(res.ok, true);

      const resDump = JSON.stringify(res);
      assert.strictEqual(resDump.indexOf(SENTINEL_STREAM), -1, 'response leaked stream key');
      assert.strictEqual(resDump.indexOf(SENTINEL_API), -1, 'response leaked api key');
      assert.strictEqual(resDump.indexOf(SENTINEL_COOKIE), -1, 'response leaked cookie');

      const logsDump = bag.logs.join('\n');
      assert.strictEqual(logsDump.indexOf(SENTINEL_STREAM), -1, 'logs leaked stream key');
      assert.strictEqual(logsDump.indexOf(SENTINEL_API), -1, 'logs leaked api key');
      assert.strictEqual(logsDump.indexOf(SENTINEL_COOKIE), -1, 'logs leaked cookie');

      const status = await bag.plugin.actions.getStatus({}, bag.ctx);
      const statusDump = JSON.stringify(status);
      assert.strictEqual(statusDump.indexOf(SENTINEL_STREAM), -1, 'status leaked stream key');
    } finally {
      bag.cleanup();
    }
  });

  await test('実物の plugins/sites/rumble/manifest.json を展開して slot の api.calls を見る', () => {
    const { expandSiteManifest } = require('../../../../host/layer1/registry/manifest');
    const manifestPath = path.join(__dirname, '..', 'manifest.json');
    const top = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const expanded = expandSiteManifest(top, 'rumble', () => {});
    assert.ok(expanded && Array.isArray(expanded.roles), 'expanded.roles must be array');
    const slotRow = expanded.roles.find((r) => r.role === 'slot');
    assert.ok(slotRow, 'slot role must exist');
    assert.deepStrictEqual(slotRow.manifest.api, {
      calls: ['destination.list', 'destination.setKey']
    });
  });

  if (failed) {
    console.error(`[rumble-slot] prepareSlot tests failed: ${failed}`);
    process.exit(1);
  }
  console.log('[rumble-slot] prepareSlot tests passed');
}

main();
