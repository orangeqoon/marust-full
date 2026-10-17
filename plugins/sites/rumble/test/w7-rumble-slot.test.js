'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createRegistry } = require('../../../../host/layer1/plugin-registry');
const { createRumbleSlot } = require('../slot');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const API = 'SENTINEL-API';
const COOKIE = 'SENTINEL-COOKIE';
const STREAM = 'SENTINEL-STREAM';
const SERVER = 'rtmp://ls1.live.rmbl.ws/slot-1';
const T0 = '2026-10-04T03:00:00.000Z';

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

function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async text() { return text; }
  };
}

function classify(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host !== 'rumble.com' && !host.endsWith('.rumble.com')) return 'foreign';
  if (parsed.pathname === '/-livestream-api/get-data') return 'get-data';
  if (parsed.pathname === '/service.php') return 'claim';
  if (parsed.pathname === '/upload.php') return 'upload';
  return 'other';
}

function kinds(calls) {
  return calls.map((call) => classify(call.url));
}

function header(call, name) {
  const headers = call && call.init && call.init.headers;
  return headers ? headers[name] : undefined;
}

function clockAt(iso) {
  let t = Date.parse(iso);
  const sleeps = [];
  return {
    sleeps: sleeps,
    now() { return new Date(t); },
    sleep(ms) {
      sleeps.push(ms);
      t += ms;
    },
    ms() { return t; }
  };
}

function streamItem(extra) {
  return Object.assign({
    id: 'ls-1',
    server_url: SERVER,
    stream_key: STREAM,
    is_live: false
  }, extra || {});
}

function claimBody(endpoint) {
  return {
    data: { success: true, claim_id: 'claim-1' },
    user: { upload: { endpoint: endpoint || 'https://web27.rumble.com' } }
  };
}

function uploadBody() {
  return { success: 1, data: { fid: 'fid-9', url: 'https://rumble.com/v/example' } };
}

function boot(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-rumble-slot-'));
  const calls = [];
  const logs = [];
  const secretGets = [];
  const clock = opts.clock || clockAt(T0);
  let secrets = {
    api: Object.prototype.hasOwnProperty.call(opts, 'api') ? opts.api : API,
    cookies: Object.prototype.hasOwnProperty.call(opts, 'cookies') ? opts.cookies : COOKIE
  };
  const fetchImpl = opts.fetch || async function failClosed() {
    throw new Error('unexpected fetch');
  };
  const plugin = createRumbleSlot({
    fetch: async function fetch(url, init) {
      calls.push({ url: String(url), init: init || {} });
      return fetchImpl(url, init, calls);
    },
    now: clock.now,
    sleep: clock.sleep
  });
  let mode = opts.mode || 'live';
  const ctx = {
    id: 'rumble-slot',
    dataDir: dir,
    mode() { return mode; },
    logger(level, message) { logs.push(String(message)); },
    secrets: {
      async get(name) {
        secretGets.push(name);
        if (opts.secretGet) return opts.secretGet(name);
        if (name === 'rumble.livestream-api') {
          if (typeof secrets.api !== 'string') return { ok: false, error: 'unavailable' };
          return { ok: true, value: secrets.api };
        }
        if (name === 'cookies.rumble-main') {
          if (typeof secrets.cookies !== 'string') return { ok: false, error: 'unavailable' };
          return { ok: true, value: secrets.cookies };
        }
        return { ok: false, error: 'not-declared' };
      }
    }
  };
  if (opts.config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(opts.config));
  plugin.load(ctx);
  return {
    plugin: plugin,
    ctx: ctx,
    dir: dir,
    calls: calls,
    logs: logs,
    secretGets: secretGets,
    clock: clock,
    setMode(next) { mode = next; },
    setSecrets(next) { secrets = Object.assign(secrets, next); }
  };
}

function assertClean(text, label) {
  const blob = String(text);
  assert.strictEqual(blob.indexOf(API), -1, label + ' has api key');
  assert.strictEqual(blob.indexOf(COOKIE), -1, label + ' has cookie');
  assert.strictEqual(blob.indexOf(STREAM), -1, label + ' has stream key');
  assert.strictEqual(/https?:\/\//i.test(blob), false, label + ' has a url');
  assert.strictEqual(/[?&]key=/i.test(blob), false, label + ' has a key query');
}

function armFs() {
  const orig = {
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    writeFileSync: fs.writeFileSync,
    appendFileSync: fs.appendFileSync,
    mkdirSync: fs.mkdirSync,
    symlinkSync: fs.symlinkSync,
    linkSync: fs.linkSync
  };
  const hits = [];
  const writes = [];
  function note(kind, file) {
    const text = String(file);
    if (/rumble-config/i.test(text) || /[\\/]services[\\/]/i.test(text)) hits.push(kind);
  }
  fs.readFileSync = function (file) {
    note('read', file);
    return orig.readFileSync.apply(fs, arguments);
  };
  fs.existsSync = function (file) {
    note('exists', file);
    return orig.existsSync.apply(fs, arguments);
  };
  fs.writeFileSync = function (file) {
    writes.push('write');
    return orig.writeFileSync.apply(fs, arguments);
  };
  fs.appendFileSync = function (file) {
    writes.push('append');
    return orig.appendFileSync.apply(fs, arguments);
  };
  fs.mkdirSync = function (file) {
    writes.push('mkdir');
    return orig.mkdirSync.apply(fs, arguments);
  };
  fs.symlinkSync = function (file) {
    writes.push('symlink');
    return orig.symlinkSync.apply(fs, arguments);
  };
  fs.linkSync = function (file) {
    writes.push('link');
    return orig.linkSync.apply(fs, arguments);
  };
  return {
    hits: hits,
    writes: writes,
    restore() {
      fs.readFileSync = orig.readFileSync;
      fs.existsSync = orig.existsSync;
      fs.writeFileSync = orig.writeFileSync;
      fs.appendFileSync = orig.appendFileSync;
      fs.mkdirSync = orig.mkdirSync;
      fs.symlinkSync = orig.symlinkSync;
      fs.linkSync = orig.linkSync;
    }
  };
}

async function main() {
  await test('reuses the newest livestream and does not claim', async () => {
    const bag = boot({
      fetch: async (url) => {
        assert.strictEqual(classify(url), 'get-data');
        return jsonResponse(200, { livestreams: [streamItem({ is_live: false })] });
      }
    });
    const guard = armFs();
    try {
      const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main', site: 'rumble' }, { title: '番組' }, {});
      assert.deepStrictEqual(result, {
        ok: true,
        server: SERVER,
        key: STREAM,
        slotId: 'ls-1',
        reused: true
      });
      assert.deepStrictEqual(kinds(bag.calls), ['get-data']);
      assert.strictEqual(new URL(bag.calls[0].url).searchParams.get('key'), API);
      assert.strictEqual(header(bag.calls[0], 'Cookie'), undefined);
      assert.strictEqual(bag.calls[0].init.redirect, 'manual');
      const status = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.deepStrictEqual(status, {
        ok: true,
        mode: 'live',
        lastOp: 'reused',
        lastOpAt: T0,
        credentials: { api: true, cookies: true }
      });
      assertClean(bag.logs.join('\n'), 'logs');
      assertClean(JSON.stringify(status), 'panel');
      assert.strictEqual(JSON.stringify(result).indexOf(API), -1);
      assert.strictEqual(JSON.stringify(result).indexOf(COOKIE), -1);
      assert.deepStrictEqual(guard.hits, []);
      assert.deepStrictEqual(guard.writes, []);
    } finally {
      guard.restore();
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('creates once when no livestream exists', async () => {
    let reads = 0;
    const bag = boot({
      config: {
        description: '説明です',
        tags: 'a,b',
        categoryId: 13,
        defaultTitle: '既定の題',
        stream_key: 'ignored-field',
        extraMarker: 'EXTRA-MARKER'
      },
      fetch: async (url) => {
        const kind = classify(url);
        if (kind === 'get-data') {
          reads += 1;
          if (reads === 1) return jsonResponse(200, { livestreams: [] });
          return jsonResponse(200, { livestreams: [streamItem({ id: 'ls-new' })] });
        }
        if (kind === 'claim') return jsonResponse(200, claimBody('https://web27.rumble.com'));
        if (kind === 'upload') return jsonResponse(200, uploadBody());
        throw new Error('foreign');
      }
    });
    try {
      const result = await bag.plugin.prepareBroadcast(
        { id: 'rumble-main', site: 'rumble' },
        { title: '番組', category: 21 },
        { correlationId: 'c1' }
      );
      assert.deepStrictEqual(result, {
        ok: true,
        server: SERVER,
        key: STREAM,
        slotId: 'ls-new',
        reused: false
      });
      assert.deepStrictEqual(kinds(bag.calls), ['get-data', 'claim', 'upload', 'get-data']);
      assert.strictEqual(bag.calls[1].url, 'https://rumble.com/service.php?name=live_video.slots.claim');
      assert.strictEqual(bag.calls[1].init.method, 'POST');
      assert.strictEqual(header(bag.calls[1], 'Cookie'), COOKIE);
      assert.strictEqual(bag.calls[1].url.indexOf(API), -1);
      assert.strictEqual(bag.calls[2].url, 'https://web27.rumble.com/upload.php?api=1.3&form=1&json=1');
      assert.strictEqual(header(bag.calls[2], 'Cookie'), COOKIE);
      const form = new URLSearchParams(bag.calls[2].init.body);
      assert.strictEqual(form.get('title'), '番組');
      assert.strictEqual(form.get('description'), '説明です');
      assert.strictEqual(form.get('tags'), 'a,b');
      assert.strictEqual(form.get('siteChannelId'), '21');
      assert.strictEqual(form.get('liveStreamingClaimId'), 'claim-1');
      assert.strictEqual(form.get('stream_key'), null);
      assert.strictEqual(String(bag.calls[2].init.body).indexOf('EXTRA-MARKER'), -1);
      assert.strictEqual(String(bag.calls[2].init.body).indexOf(API), -1);
      assert.strictEqual(String(bag.calls[2].init.body).indexOf(COOKIE), -1);
      const again = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.strictEqual(again.reused, true);
      assert.strictEqual(kinds(bag.calls).filter((kind) => kind === 'claim').length, 1);
      assert.strictEqual(kinds(bag.calls).filter((kind) => kind === 'upload').length, 1);
      assertClean(bag.logs.join('\n'), 'logs');
      const status = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(status.lastOp, 'reused');
      assertClean(JSON.stringify(status), 'panel');
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('uses the configured title when the session title is empty', async () => {
    const bag = boot({
      config: { defaultTitle: '既定の題', description: '', tags: '', categoryId: 13 },
      fetch: async (url) => {
        const kind = classify(url);
        if (kind === 'get-data') {
          if (kinds(bag.calls).filter((name) => name === 'get-data').length < 2) {
            return jsonResponse(200, { livestreams: [] });
          }
          return jsonResponse(200, { livestreams: [streamItem()] });
        }
        if (kind === 'claim') return jsonResponse(200, claimBody());
        if (kind === 'upload') return jsonResponse(200, uploadBody());
        throw new Error('foreign');
      }
    });
    try {
      const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '  ' }, {});
      assert.strictEqual(result.reused, false);
      const upload = bag.calls.filter((call) => classify(call.url) === 'upload')[0];
      assert.strictEqual(new URLSearchParams(upload.init.body).get('title'), '既定の題');
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('does not retry when the slot limit is hit', async () => {
    const phrase = 'All your streaming slots are being used';
    const claimBag = boot({
      fetch: async (url) => {
        const kind = classify(url);
        if (kind === 'get-data') return jsonResponse(200, { livestreams: [] });
        if (kind === 'claim') return jsonResponse(200, { data: { success: false }, error_msg: phrase });
        throw new Error('upload should not run');
      }
    });
    try {
      const result = await claimBag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'slots-exhausted' });
      assert.deepStrictEqual(kinds(claimBag.calls), ['get-data', 'claim']);
      assert.strictEqual(claimBag.logs.join('\n').indexOf(phrase), -1);
      assertClean(claimBag.logs.join('\n'), 'logs');
    } finally {
      claimBag.plugin.destroy();
      rimraf(claimBag.dir);
    }

    const uploadBag = boot({
      fetch: async (url) => {
        const kind = classify(url);
        if (kind === 'get-data') return jsonResponse(200, { livestreams: [] });
        if (kind === 'claim') return jsonResponse(200, claimBody());
        if (kind === 'upload') return jsonResponse(500, phrase);
        throw new Error('extra');
      }
    });
    try {
      const result = await uploadBag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'slots-exhausted' });
      assert.deepStrictEqual(kinds(uploadBag.calls), ['get-data', 'claim', 'upload']);
      assert.strictEqual(uploadBag.logs.join('\n').indexOf(phrase), -1);
    } finally {
      uploadBag.plugin.destroy();
      rimraf(uploadBag.dir);
    }
  });

  await test('times out while polling ingest after create', async () => {
    const clock = clockAt(T0);
    const bag = boot({
      clock: clock,
      fetch: async (url) => {
        const kind = classify(url);
        if (kind === 'get-data') return jsonResponse(200, { livestreams: [] });
        if (kind === 'claim') return jsonResponse(200, claimBody());
        if (kind === 'upload') return jsonResponse(200, uploadBody());
        throw new Error('foreign');
      }
    });
    try {
      const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'timeout' });
      assert.strictEqual(kinds(bag.calls).filter((kind) => kind === 'claim').length, 1);
      assert.strictEqual(kinds(bag.calls).filter((kind) => kind === 'upload').length, 1);
      assert.strictEqual(kinds(bag.calls).filter((kind) => kind === 'get-data').length, 8);
      assert.deepStrictEqual(kinds(bag.calls).slice(0, 3), ['get-data', 'claim', 'upload']);
      assert.deepStrictEqual(clock.sleeps, [5000, 5000, 5000, 5000, 5000, 5000]);
      assert.strictEqual(clock.ms(), Date.parse(T0) + 30000);
      const status = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(status.lastOp, 'timeout');
      assert.strictEqual(status.lastOpAt, '2026-10-04T03:00:30.000Z');
      assertClean(bag.logs.join('\n'), 'logs');
      assertClean(JSON.stringify(result), 'result');
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('lookup failure does not claim', async () => {
    const bag = boot({
      fetch: async (url) => {
        throw new Error(String(url));
      }
    });
    try {
      const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'network' });
      assert.strictEqual(bag.calls.length, 1);
      assert.strictEqual(classify(bag.calls[0].url), 'get-data');
      assertClean(bag.logs.join('\n'), 'logs');
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('an incomplete livestream is not turned into a new slot', async () => {
    const bag = boot({
      fetch: async () => jsonResponse(200, { livestreams: [{ id: 'ls-1', server_url: SERVER }] })
    });
    try {
      const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'network' });
      assert.deepStrictEqual(kinds(bag.calls), ['get-data']);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('missing secrets return no-credentials and do not fetch', async () => {
    async function check(partial) {
      const bag = boot(Object.assign({ fetch: async () => { throw new Error('fetched'); } }, partial));
      try {
        const before = bag.secretGets.length;
        const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
        assert.deepStrictEqual(result, { ok: false, error: 'no-credentials' });
        assert.strictEqual(bag.calls.length, 0);
        assert.ok(bag.secretGets.length > before);
        const status = await bag.plugin.actions.getStatus({}, bag.ctx);
        const thrown = typeof partial.secretGet === 'function';
        assert.strictEqual(status.lastOp, 'no-credentials');
        assert.strictEqual(status.credentials.api, !thrown && typeof partial.api === 'string' && partial.api !== '');
        assert.strictEqual(status.credentials.cookies, !thrown && typeof partial.cookies === 'string' && partial.cookies !== '');
        assertClean(bag.logs.join('\n'), 'logs');
        assertClean(JSON.stringify(status), 'panel');
      } finally {
        bag.plugin.destroy();
        rimraf(bag.dir);
      }
    }
    await check({ api: null, cookies: null });
    await check({ api: API, cookies: null });
    await check({ api: '', cookies: COOKIE });
    await check({
      api: API,
      cookies: COOKIE,
      secretGet: async () => { throw new Error('boom ' + API); }
    });
  });

  await test('the same destination is busy until prepare finishes', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const bag = boot({
      fetch: async (url) => {
        assert.strictEqual(classify(url), 'get-data');
        await gate;
        return jsonResponse(200, { livestreams: [streamItem()] });
      }
    });
    try {
      const first = bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      const other = bag.plugin.prepareBroadcast({ id: 'other' }, { title: '番組' }, {});
      const dry = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, { dryRun: true });
      const busy = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.deepStrictEqual(dry, { ok: true, dryRun: true });
      assert.deepStrictEqual(busy, { ok: false, error: 'busy' });
      assert.deepStrictEqual(kinds(bag.calls).filter((kind) => kind !== 'get-data'), []);
      release();
      const done = await Promise.all([first, other]);
      assert.strictEqual(done[0].reused, true);
      assert.strictEqual(done[1].reused, true);
      assert.strictEqual(done[0].key, STREAM);
      const third = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.strictEqual(third.ok, true);
      assert.strictEqual(third.reused, true);
      assertClean(bag.logs.join('\n'), 'logs');
      const status = await bag.plugin.actions.getStatus({}, bag.ctx);
      assertClean(JSON.stringify(status), 'panel');
      assert.strictEqual(JSON.stringify(busy).indexOf(STREAM), -1);
    } finally {
      release();
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('verifyLive reads is_live and endBroadcast does not fetch', async () => {
    let live = true;
    const bag = boot({
      fetch: async (url, init) => {
        assert.strictEqual(classify(url), 'get-data');
        assert.strictEqual(header({ init: init }, 'Cookie'), undefined);
        return jsonResponse(200, { livestreams: [streamItem({ is_live: live })] });
      }
    });
    try {
      const yes = await bag.plugin.verifyLive({ id: 'rumble-main' }, {});
      assert.deepStrictEqual(yes, { ok: true, live: true });
      live = false;
      const no = await bag.plugin.verifyLive({ id: 'rumble-main' }, {});
      assert.deepStrictEqual(no, { ok: true, live: false });
      assert.strictEqual(JSON.stringify(yes).indexOf(STREAM), -1);
      assert.strictEqual(JSON.stringify(yes).indexOf(API), -1);
      assert.strictEqual(JSON.stringify(no).indexOf(COOKIE), -1);
      const ended = bag.plugin.endBroadcast({ id: 'rumble-main' }, {});
      assert.deepStrictEqual(ended, { ok: true });
      const shadowEnd = bag.plugin.endBroadcast({ id: 'rumble-main' }, { dryRun: true });
      assert.deepStrictEqual(shadowEnd, { ok: true, dryRun: true });
      assert.strictEqual(kinds(bag.calls).every((kind) => kind === 'get-data'), true);
      assert.strictEqual(bag.calls.length, 2);
      assertClean(bag.logs.join('\n'), 'logs');
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('verifyLive without the api key does not fetch', async () => {
    const bag = boot({
      api: null,
      fetch: async () => { throw new Error('fetched'); }
    });
    try {
      const result = await bag.plugin.verifyLive({ id: 'rumble-main' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'no-credentials' });
      assert.strictEqual(bag.calls.length, 0);
      const empty = boot({
        fetch: async () => jsonResponse(200, { livestreams: [] })
      });
      try {
        const none = await empty.plugin.verifyLive({ id: 'rumble-main' }, {});
        assert.deepStrictEqual(none, { ok: true, live: false });
      } finally {
        empty.plugin.destroy();
        rimraf(empty.dir);
      }
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('shadow, dryRun, and legacy do not fetch', async () => {
    async function check(opts, expected) {
      let fetched = 0;
      const bag = boot(Object.assign({
        fetch: async () => { fetched += 1; throw new Error('fetched'); }
      }, opts));
      try {
        const gets = bag.secretGets.length;
        const prepared = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, opts.meta || {});
        const verified = await bag.plugin.verifyLive({ id: 'rumble-main' }, opts.meta || {});
        const ended = bag.plugin.endBroadcast({ id: 'rumble-main' }, opts.meta || {});
        assert.deepStrictEqual(prepared, expected.prepare);
        assert.deepStrictEqual(verified, expected.verify);
        assert.deepStrictEqual(ended, expected.end);
        assert.strictEqual(fetched, 0);
        assert.strictEqual(bag.calls.length, 0);
        assert.strictEqual(bag.secretGets.length, gets);
        assertClean(bag.logs.join('\n'), 'logs');
      } finally {
        bag.plugin.destroy();
        rimraf(bag.dir);
      }
    }
    await check({ mode: 'shadow' }, {
      prepare: { ok: true, dryRun: true },
      verify: { ok: true, dryRun: true },
      end: { ok: true, dryRun: true }
    });
    await check({ mode: 'live', meta: { dryRun: true } }, {
      prepare: { ok: true, dryRun: true },
      verify: { ok: true, dryRun: true },
      end: { ok: true, dryRun: true }
    });
    await check({ mode: 'legacy' }, {
      prepare: { ok: true },
      verify: { ok: true },
      end: { ok: true }
    });
  });

  await test('a non-rumble upload endpoint is not called', async () => {
    const bag = boot({
      fetch: async (url) => {
        assert.strictEqual(String(url).indexOf('evil.example'), -1);
        const kind = classify(url);
        if (kind === 'get-data') {
          if (kinds(bag.calls).filter((name) => name === 'get-data').length < 2) {
            return jsonResponse(200, { livestreams: [] });
          }
          return jsonResponse(200, { livestreams: [streamItem()] });
        }
        if (kind === 'claim') return jsonResponse(200, claimBody('https://evil.example/steal'));
        if (kind === 'upload') return jsonResponse(200, uploadBody());
        throw new Error('foreign');
      }
    });
    try {
      const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.strictEqual(result.reused, false);
      const upload = bag.calls.filter((call) => classify(call.url) === 'upload')[0];
      assert.strictEqual(upload.url, 'https://web27.rumble.com/upload.php?api=1.3&form=1&json=1');
      assert.strictEqual(kinds(bag.calls).indexOf('foreign'), -1);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('a redirect is not followed', async () => {
    const bag = boot({
      fetch: async (url) => {
        const kind = classify(url);
        if (kind === 'get-data') return jsonResponse(200, { livestreams: [] });
        if (kind === 'claim') return { ok: false, status: 302, async text() { return ''; } };
        throw new Error('followed');
      }
    });
    try {
      const result = await bag.plugin.prepareBroadcast({ id: 'rumble-main' }, { title: '番組' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'network' });
      assert.deepStrictEqual(kinds(bag.calls), ['get-data', 'claim']);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('manifest is accepted and the source does not read config files', async () => {
    const top = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'sites', 'rumble', 'manifest.json'), 'utf8'));
    const manifest = top.roles.slot;
    assert.strictEqual(top.id, 'rumble');
    assert.strictEqual(top.manifestVersion, 2);
    assert.deepStrictEqual(manifest.provides, ['stream.slot@1']);
    assert.deepStrictEqual(manifest.secrets, ['rumble.livestream-api', 'cookies.rumble-main']);
    assert.strictEqual(manifest.defaultMode, 'legacy');
    assert.strictEqual(manifest.timeouts.prepareBroadcast, 90000);
    assert.strictEqual(manifest.timeouts.verifyLive, 15000);
    assert.strictEqual(manifest.configSchema, 'config.schema.json');
    assert.strictEqual(manifest.dataDirId, 'rumble-slot');
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'sites', 'rumble', 'slot.js'), 'utf8');
    assert.strictEqual(src.indexOf('rumble-config'), -1);
    assert.strictEqual(src.indexOf('DEFAULT_API_KEY'), -1);
    assert.strictEqual(/state[\\/]+services/.test(src), false);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-reg-'));
    try {
      const registry = createRegistry({
        appRoot: ROOT,
        core: { STATE_DIR: stateDir },
        logger() {}
      });
      const found = registry.discover().filter((rec) => rec.id === 'slot-rumble');
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].modeKey, 'rumble:slot');
      assert.strictEqual(found[0].manifest.dataDirId, 'rumble-slot');
      assert.strictEqual(registry.discover().filter((rec) => rec.id === 'rumble-slot').length, 0);
      assert.strictEqual(found[0].status, 'accepted', found[0].reason);
      assert.deepStrictEqual(found[0].manifest.slotFor, ['rumble']);
      assert.deepStrictEqual(found[0].manifest.provides, ['stream.slot@1']);
      assert.strictEqual(found[0].manifest.timeouts.prepareBroadcast, 90000);
      assert.strictEqual(found[0].manifest.timeouts.verifyLive, 15000);
      assert.deepStrictEqual(found[0].manifest.secrets, ['rumble.livestream-api', 'cookies.rumble-main']);
    } finally {
      rimraf(stateDir);
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
