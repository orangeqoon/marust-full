'use strict';
const { requirePlugin } = require('./_plugins');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createSinkTwitcasting } = requirePlugin('sink-twitcasting');
const { createSinkNiconico } = require('./_plugins').requirePlugin('sink-niconico');
const { createSinkFc2 } = requirePlugin('sink-fc2');
const { createSinkKukulu } = requirePlugin('sink-kukulu');
const { createSinkPicarto } = requirePlugin('sink-picarto');

const TOKEN = 'SENTINEL-TOKEN';
const COOKIE = 'SENTINEL-COOKIE';
const COMMENT = 'SENTINEL-COMMENT';
const APIKEY = 'SENTINEL-APIKEY';
const JA = '\u3053\u3093\u306b\u3061\u306f';

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

function response(status, body, extra) {
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    url: extra && extra.url ? extra.url : '',
    async text() { return text; }
  };
}

async function peer(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === 'apiv2.twitcasting.tv' && parsed.pathname === '/verify_credentials') {
    return response(200, { user: { is_live: true, last_movie_id: 42 } });
  }
  if (host === 'apiv2.twitcasting.tv' && parsed.pathname === '/movies/42/comments') {
    return response(200, {});
  }
  if (host === 'live2.nicovideo.jp' && parsed.pathname === '/unama/api/v2/programs/latest') {
    return response(200, { data: { id: 'lv123456' } });
  }
  if (host === 'live2.nicovideo.jp' && parsed.pathname === '/watch/lv123456/operator_comment') {
    return response(200, {});
  }
  if (host === 'live.erinn.biz' && parsed.pathname === '/api/') {
    return response(200, { success: 1 });
  }
  if (host === 'live.fc2.com' && parsed.pathname === '/api/getControlServer.php') {
    return response(200, { url: 'wss://ctrl.fc2.com/live', control_token: 'abcDEF' });
  }
  throw new Error('unexpected url ' + host + parsed.pathname);
}

function boot(create, id, options) {
  const opts = options || {};
  let clock = opts.clock == null ? 10000 : opts.clock;
  const logs = [];
  const calls = [];
  const connects = [];
  const secrets = opts.secrets || {};
  const ctx = {
    id: id,
    mode() { return opts.mode || 'live'; },
    logger(level, message) { logs.push(String(level) + ':' + String(message)); },
    secrets: {
      async get(name) {
        if (!Object.prototype.hasOwnProperty.call(secrets, name)) return { ok: false, error: 'unavailable' };
        const value = secrets[name];
        if (value == null) return { ok: false, error: 'unavailable' };
        return { ok: true, value: typeof value === 'string' ? value : JSON.stringify(value) };
      }
    }
  };
  const fetchImpl = opts.fetch || peer;
  const api = create({
    fetch: async function fetch(url, init) {
      calls.push({ url: String(url), init: init || {} });
      return fetchImpl(url, init);
    },
    connect: async function connect(spec) {
      connects.push(spec);
      if (opts.onConnect) return opts.onConnect(spec);
      return { status: 101 };
    },
    now: function now() { return clock; },
    nonce: function nonce() { return 4242; },
    wsKey: function wsKey() { return 'AQIDBAUGBwgJCgsMDQ4PEA=='; }
  });
  api.load(ctx);
  return {
    api: api,
    logs: logs,
    calls: calls,
    connects: connects,
    setClock: function setClock(value) { clock = value; }
  };
}

function header(call, name) {
  const headers = call && call.init && call.init.headers ? call.init.headers : {};
  const want = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === want) return headers[keys[i]];
  }
  return undefined;
}

function assertManual(calls) {
  for (let i = 0; i < calls.length; i += 1) {
    assert.strictEqual(calls[i].init.redirect, 'manual');
  }
}

function assertQuiet(logs) {
  const joined = logs.join('\n');
  assert.strictEqual(joined.indexOf(COMMENT), -1);
  assert.strictEqual(joined.indexOf(COOKIE), -1);
  assert.strictEqual(joined.indexOf(TOKEN), -1);
  assert.strictEqual(joined.indexOf(APIKEY), -1);
  assert.strictEqual(joined.indexOf('abcDEF'), -1);
}

const SITES = [
  {
    id: 'sink-twitcasting',
    site: 'twitcasting',
    create: createSinkTwitcasting,
    secrets: { 'twitcasting.config': { access_token: TOKEN } },
    calls: 2,
    connects: 0
  },
  {
    id: 'sink-niconico',
    site: 'niconico',
    create: createSinkNiconico,
    secrets: { 'cookies.niconico-main': { cookies: { user_session: COOKIE, other: 'keep' } } },
    calls: 2,
    connects: 0
  },
  {
    id: 'sink-fc2',
    site: 'fc2',
    create: createSinkFc2,
    secrets: {
      'cookies.fc2-main': { cookies: { login: COOKIE } },
      'fc2.config': { channel_id: '2468', user_name: 'caster' }
    },
    calls: 1,
    connects: 1
  },
  {
    id: 'sink-kukulu',
    site: 'kukulu',
    create: createSinkKukulu,
    secrets: { 'kukulu.config': { apikey: APIKEY } },
    calls: 1,
    connects: 0
  },
  {
    id: 'sink-picarto',
    site: 'picarto',
    create: createSinkPicarto,
    secrets: { 'picarto.config': { token: TOKEN, channel: 'OrangeCast' } },
    calls: 0,
    connects: 1
  }
];

function shape(site, env, text) {
  assertManual(env.calls);
  if (site.site === 'twitcasting') {
    assert.strictEqual(env.calls.length, 2);
    assert.strictEqual(env.calls[0].init.method, 'GET');
    assert.strictEqual(new URL(env.calls[0].url).pathname, '/verify_credentials');
    assert.strictEqual(header(env.calls[0], 'Authorization'), 'Bearer ' + TOKEN);
    assert.strictEqual(header(env.calls[0], 'X-Api-Version'), '2.0');
    assert.strictEqual(header(env.calls[0], 'Accept'), 'application/json');
    assert.strictEqual(header(env.calls[0], 'User-Agent'), 'MultiCommenter/1.0');
    assert.strictEqual(env.calls[1].init.method, 'POST');
    assert.strictEqual(new URL(env.calls[1].url).pathname, '/movies/42/comments');
    assert.strictEqual(header(env.calls[1], 'Content-Type'), 'application/json');
    assert.deepStrictEqual(JSON.parse(env.calls[1].init.body), { comment: text, sns: 'none' });
    assert.strictEqual(env.connects.length, 0);
  } else if (site.site === 'niconico') {
    assert.strictEqual(env.calls.length, 2);
    assert.strictEqual(env.calls[0].init.method, 'GET');
    assert.strictEqual(new URL(env.calls[0].url).pathname, '/unama/api/v2/programs/latest');
    assert.strictEqual(header(env.calls[0], 'X-niconico-session'), COOKIE);
    assert.strictEqual(header(env.calls[0], 'Cookie'), 'user_session=' + COOKIE + '; other=keep');
    assert.strictEqual(header(env.calls[0], 'User-Agent'), 'MultiCommenter/1.0');
    assert.strictEqual(env.calls[1].init.method, 'PUT');
    assert.strictEqual(new URL(env.calls[1].url).pathname, '/watch/lv123456/operator_comment');
    assert.strictEqual(header(env.calls[1], 'X-niconico-session'), undefined);
    assert.strictEqual(header(env.calls[1], 'Cookie'), 'user_session=' + COOKIE + '; other=keep');
    assert.strictEqual(header(env.calls[1], 'User-Agent'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    assert.deepStrictEqual(JSON.parse(env.calls[1].init.body), { text: text, isPermanent: false });
  } else if (site.site === 'fc2') {
    assert.strictEqual(env.calls.length, 1);
    assert.strictEqual(env.calls[0].init.method, 'POST');
    assert.strictEqual(new URL(env.calls[0].url).pathname, '/api/getControlServer.php');
    assert.strictEqual(header(env.calls[0], 'Content-Type'), 'application/x-www-form-urlencoded; charset=UTF-8');
    assert.strictEqual(header(env.calls[0], 'Origin'), 'https://live.fc2.com');
    assert.strictEqual(header(env.calls[0], 'Referer'), 'https://live.fc2.com/2468/');
    assert.strictEqual(header(env.calls[0], 'Cookie'), 'login=' + COOKIE);
    assert.strictEqual(header(env.calls[0], 'X-Requested-With'), 'XMLHttpRequest');
    const form = qs.parse(env.calls[0].init.body);
    assert.strictEqual(form.channel_id, '2468');
    assert.strictEqual(form.mode, 'play');
    assert.strictEqual(form.client_type, 'pc');
    assert.strictEqual(form.client_app, 'browser_hls');
    assert.strictEqual(env.connects.length, 1);
    assert.strictEqual(env.connects[0].method, 'GET');
    assert.strictEqual(env.connects[0].url, 'wss://ctrl.fc2.com/live?control_token=abcDEF');
    assert.strictEqual(env.connects[0].headers.Origin, 'https://live.fc2.com');
    assert.strictEqual(env.connects[0].headers['User-Agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    assert.deepStrictEqual(JSON.parse(env.connects[0].body), {
      name: 'send_comment',
      arguments: {
        user_name: 'caster',
        comment: text,
        lang: 'ja',
        size: 'middle',
        color: 'black',
        image: '',
        anonymous: 0
      },
      id: 4242
    });
  } else if (site.site === 'kukulu') {
    assert.strictEqual(env.calls.length, 1);
    assert.strictEqual(env.calls[0].init.method, 'GET');
    const url = new URL(env.calls[0].url);
    assert.strictEqual(url.hostname, 'live.erinn.biz');
    assert.strictEqual(url.searchParams.get('category'), 'comment');
    assert.strictEqual(url.searchParams.get('type'), 'write');
    assert.strictEqual(url.searchParams.get('apikey'), APIKEY);
    assert.strictEqual(url.searchParams.get('comment'), text);
    assert.strictEqual(env.connects.length, 0);
  } else if (site.site === 'picarto') {
    assert.strictEqual(env.calls.length, 0);
    assert.strictEqual(env.connects.length, 1);
    const spec = env.connects[0];
    assert.strictEqual(spec.method, 'GET');
    assert.strictEqual(spec.url, 'wss://chat.picarto.tv/bot/username=OrangeCast&password=' + TOKEN);
    assert.strictEqual(spec.headers.Host, 'chat.picarto.tv');
    assert.strictEqual(spec.headers.Upgrade, 'websocket');
    assert.strictEqual(spec.headers.Connection, 'Upgrade');
    assert.strictEqual(spec.headers['Sec-WebSocket-Version'], '13');
    assert.strictEqual(spec.headers['Sec-WebSocket-Key'], 'AQIDBAUGBwgJCgsMDQ4PEA==');
    assert.strictEqual(spec.headers['User-Agent'], 'PTV-BOT-OrangeCast');
    assert.deepStrictEqual(JSON.parse(spec.body), { type: 'chat', message: text });
  }
}

async function main() {
  for (let i = 0; i < SITES.length; i += 1) {
    const site = SITES[i];
    await test(site.site + ' request shape', async function () {
      const env = boot(site.create, site.id, { secrets: site.secrets });
      const result = await env.api.sendComment({ text: COMMENT, site: site.site, account: 'other' }, {});
      assert.deepStrictEqual(result, { ok: true });
      shape(site, env, COMMENT);
      assert.deepStrictEqual(env.logs, ['info:ok 1']);
      assertQuiet(env.logs);
    });

    await test(site.site + ' no-credentials', async function () {
      const env = boot(site.create, site.id, { secrets: {} });
      const result = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'no-credentials' });
      assert.strictEqual(env.calls.length, 0);
      assert.strictEqual(env.connects.length, 0);
      assertQuiet(env.logs);
    });

    await test(site.site + ' dryRun', async function () {
      const env = boot(site.create, site.id, { secrets: site.secrets });
      const result = await env.api.sendComment({ text: COMMENT, site: site.site }, { dryRun: true });
      assert.deepStrictEqual(result, { ok: true, dryRun: true });
      assert.strictEqual(env.calls.length, 0);
      assert.strictEqual(env.connects.length, 0);
      assert.deepStrictEqual(env.logs, []);
    });

    await test(site.site + ' rate limit', async function () {
      const env = boot(site.create, site.id, { secrets: site.secrets });
      const first = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
      assert.deepStrictEqual(first, { ok: true });
      const calls = env.calls.length;
      const connects = env.connects.length;
      env.setClock(10999);
      const second = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
      assert.deepStrictEqual(second, { ok: false, error: 'rate-limit' });
      assert.strictEqual(env.calls.length, calls);
      assert.strictEqual(env.connects.length, connects);
      env.setClock(11000);
      const third = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
      assert.deepStrictEqual(third, { ok: true });
      assertQuiet(env.logs);
    });

    await test(site.site + ' empty and too-long', async function () {
      const env = boot(site.create, site.id, { secrets: site.secrets });
      assert.deepStrictEqual(await env.api.sendComment({ text: '', site: site.site }, {}), { ok: false, error: 'empty' });
      assert.deepStrictEqual(await env.api.sendComment({ text: 'a'.repeat(201), site: site.site }, {}), { ok: false, error: 'too-long' });
      assert.strictEqual(env.calls.length, 0);
      assert.strictEqual(env.connects.length, 0);
      const ok = await env.api.sendComment({ text: 'a'.repeat(200), site: site.site }, {});
      assert.deepStrictEqual(ok, { ok: true });
      shape(site, env, 'a'.repeat(200));
    });

    await test(site.site + ' wrong site', async function () {
      const env = boot(site.create, site.id, { secrets: site.secrets });
      const result = await env.api.sendComment({ text: COMMENT, site: 'youtube' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'wrong-site' });
      assert.strictEqual(env.calls.length, 0);
      assert.strictEqual(env.connects.length, 0);
    });

    await test(site.site + ' redirect not followed', async function () {
      if (site.site === 'picarto') {
        const env = boot(site.create, site.id, {
          secrets: site.secrets,
          onConnect: async function onConnect() { return { status: 302 }; }
        });
        const result = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
        assert.deepStrictEqual(result, { ok: false, error: 'redirect' });
        assert.strictEqual(env.connects.length, 1);
        assert.strictEqual(new URL(env.connects[0].url).hostname, 'chat.picarto.tv');
        return;
      }
      const env = boot(site.create, site.id, {
        secrets: site.secrets,
        fetch: async function fetch() {
          return response(302, '', { url: 'https://evil.example/away' });
        }
      });
      const result = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'redirect' });
      assert.strictEqual(env.calls.length, 1);
      assert.ok(env.calls[0].url.indexOf('evil.example') === -1);
      assert.strictEqual(env.connects.length, 0);
    });

    await test(site.site + ' domain lock', async function () {
      if (site.site === 'fc2') {
        const env = boot(site.create, site.id, {
          secrets: site.secrets,
          fetch: async function fetch() {
            return response(200, { url: 'wss://evil.example/socket', control_token: 'abcDEF' });
          }
        });
        const result = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
        assert.deepStrictEqual(result, { ok: false, error: 'domain' });
        assert.strictEqual(env.calls.length, 1);
        assert.strictEqual(env.connects.length, 0);
        assertQuiet(env.logs);
        return;
      }
      if (site.site === 'picarto') {
        const env = boot(site.create, site.id, { secrets: site.secrets });
        const result = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
        assert.strictEqual(result.ok, true);
        assert.strictEqual(new URL(env.connects[0].url).hostname, 'chat.picarto.tv');
        assert.ok(env.connects[0].url.indexOf('evil.example') === -1);
        return;
      }
      const env = boot(site.create, site.id, {
        secrets: site.secrets,
        fetch: async function fetch(url) {
          return response(200, { user: { is_live: true, last_movie_id: 42 }, data: { id: 'lv1' }, success: 1 }, { url: 'https://evil.example/stolen' });
        }
      });
      const result = await env.api.sendComment({ text: COMMENT, site: site.site }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'redirect' });
      assert.strictEqual(env.calls.length, 1);
      assert.ok(env.calls[0].url.indexOf('evil.example') === -1);
    });
  }

  await test('kukulu encodes comment', async function () {
    const env = boot(createSinkKukulu, 'sink-kukulu', { secrets: SITES[3].secrets });
    const result = await env.api.sendComment({ text: JA, site: 'kukulu' }, {});
    assert.deepStrictEqual(result, { ok: true });
    const url = new URL(env.calls[0].url);
    assert.strictEqual(url.searchParams.get('comment'), JA);
    assert.ok(env.calls[0].url.indexOf(encodeURIComponent(JA)) !== -1);
    assertQuiet(env.logs);
  });

  await test('fc2 missing user_name', async function () {
    const env = boot(createSinkFc2, 'sink-fc2', {
      secrets: {
        'cookies.fc2-main': { cookies: { login: COOKIE } },
        'fc2.config': { channel_id: '2468' }
      }
    });
    const result = await env.api.sendComment({ text: COMMENT, site: 'fc2' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'no-credentials' });
    assert.strictEqual(env.calls.length, 0);
    assert.strictEqual(env.connects.length, 0);
  });

  await test('picarto missing channel', async function () {
    const env = boot(createSinkPicarto, 'sink-picarto', {
      secrets: { 'picarto.config': { token: TOKEN } }
    });
    const result = await env.api.sendComment({ text: COMMENT, site: 'picarto' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'no-credentials' });
    assert.strictEqual(env.connects.length, 0);
  });

  await test('twitcasting token alias', async function () {
    const env = boot(createSinkTwitcasting, 'sink-twitcasting', {
      secrets: { 'twitcasting.config': { token: TOKEN } }
    });
    const result = await env.api.sendComment({ text: COMMENT, site: 'twitcasting' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(header(env.calls[0], 'Authorization'), 'Bearer ' + TOKEN);
    assertQuiet(env.logs);
  });

  await test('manifests', async function () {
    const ids = ['sink-twitcasting', 'sink-niconico', 'sink-fc2', 'sink-kukulu', 'sink-picarto'];
    for (let i = 0; i < ids.length; i += 1) {
      const manifest = require('./_plugins').roleManifest(ids[i]);
      assert.strictEqual(manifest.manifestVersion, 2);
      assert.strictEqual(manifest.defaultMode, 'legacy');
      // サイトの形（plugins/sites/。R16）の sink は、パネルを site の役目が持つので ui.panel を持たない
      assert.deepStrictEqual(manifest.provides, manifest.siteId ? ['chat.sink@1'] : ['chat.sink@1', 'ui.panel@1']);
      assert.deepStrictEqual(manifest.sinkFor, [ids[i].replace(/^sink-/, '')]);
      assert.strictEqual(manifest.kind, 'integration');
    }
  });

  await test('picarto tls verification enabled', async function () {
    const tls = require('tls');
    const original = tls.connect;
    const seen = [];
    tls.connect = function (options) {
      seen.push(options);
      const socket = new (require('events').EventEmitter)();
      socket.destroy = function () {};
      socket.write = function () {};
      process.nextTick(function () {
        socket.emit('error', new Error('stop'));
      });
      return socket;
    };
    try {
      const api = createSinkPicarto({
        now: function () { return 10000; },
        wsKey: function () { return 'AQIDBAUGBwgJCgsMDQ4PEA=='; }
      });
      api.load({
        id: 'sink-picarto',
        mode: function () { return 'live'; },
        logger: function () {},
        secrets: {
          async get(name) {
            if (name !== 'picarto.config') return { ok: false, error: 'unavailable' };
            return { ok: true, value: JSON.stringify({ token: TOKEN, channel: 'OrangeCast' }) };
          }
        }
      });
      const result = await api.sendComment({ text: COMMENT, site: 'picarto' }, {});
      const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'sites', 'picarto', 'sink.js'), 'utf8');
      assert.strictEqual(src.indexOf('rejectUnauthorized'), -1);
      assert.strictEqual(src.indexOf('NODE_TLS_REJECT_UNAUTHORIZED'), -1);
      assert.strictEqual(seen.length, 1);
      assert.ok(!Object.prototype.hasOwnProperty.call(seen[0], 'rejectUnauthorized') || seen[0].rejectUnauthorized === true);
      assert.notStrictEqual(seen[0].rejectUnauthorized, false);
      assert.strictEqual(seen[0].host, 'chat.picarto.tv');
      assert.strictEqual(seen[0].servername, 'chat.picarto.tv');
      assert.strictEqual(typeof seen[0].checkServerIdentity, 'undefined');
      assert.deepStrictEqual(result, { ok: false, error: 'network' });
    } finally {
      tls.connect = original;
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exitCode = 1;
  } else {
    console.log('all passed');
  }
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
