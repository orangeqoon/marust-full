'use strict';
const { requirePlugin, mainFileOf, panelFileOf, copyPlugin } = require('./_plugins');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createRegistry } = require('../host/layer1/plugin-registry');
const youtubeApi = requirePlugin('sink-youtube');
const twitchApi = requirePlugin('sink-twitch');
const kickApi = requirePlugin('sink-kick');

const ROOT = path.join(__dirname, '..');
const NOW = '2026-10-04T03:00:00.000Z';
const LATER = Date.parse('2026-10-04T04:00:00.000Z');
const PAST = Date.parse('2026-10-04T01:00:00.000Z');

const YT = {
  client: 'SENTINEL-YT-CLIENT',
  secret: 'SENTINEL-YT-SECRET',
  refresh: 'SENTINEL-YT-REFRESH',
  access: 'SENTINEL-YT-ACCESS',
  access2: 'SENTINEL-YT-ACCESS-2'
};
const TW = {
  client: 'SENTINEL-TW-CLIENT',
  secret: 'SENTINEL-TW-SECRET',
  refresh: 'SENTINEL-TW-REFRESH',
  access: 'SENTINEL-TW-ACCESS',
  access2: 'SENTINEL-TW-ACCESS-2'
};
const KK = {
  client: 'SENTINEL-KK-CLIENT',
  secret: 'SENTINEL-KK-SECRET',
  refresh: 'SENTINEL-KK-REFRESH',
  access: 'SENTINEL-KK-ACCESS',
  access2: 'SENTINEL-KK-ACCESS-2'
};

const YT_LIST_ACTIVE = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all&maxResults=5';
const YT_LIST_UPCOMING = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=upcoming&broadcastType=all&maxResults=5';
const YT_MESSAGES = 'https://youtube.googleapis.com/youtube/v3/liveChat/messages?part=snippet';
const YT_TOKEN = 'https://oauth2.googleapis.com/token';
const TW_USERS = 'https://api.twitch.tv/helix/users';
const TW_CHAT = 'https://api.twitch.tv/helix/chat/messages';
const TW_TOKEN = 'https://id.twitch.tv/oauth2/token';
const KK_USERS = 'https://api.kick.com/public/v1/users';
const KK_CHAT = 'https://api.kick.com/public/v1/chat';
const KK_TOKEN = 'https://id.kick.com/oauth/token';
const KICK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async text() { return text; }
  };
}

function redirectResponse() {
  return {
    ok: false,
    status: 302,
    headers: { location: 'https://evil.example/steal' },
    async text() { return 'go away'; }
  };
}

function header(call, name) {
  const headers = call && call.init && call.init.headers;
  return headers ? headers[name] : undefined;
}

function form(call) {
  return new URLSearchParams(call.init.body);
}

function assertManual(calls) {
  assert.ok(calls.length > 0);
  for (let i = 0; i < calls.length; i += 1) {
    assert.strictEqual(calls[i].init.redirect, 'manual', calls[i].url);
    assert.strictEqual(calls[i].url.indexOf('evil.example'), -1, calls[i].url);
  }
}

function assertClean(text, secrets) {
  const blob = text == null ? '' : String(text);
  for (let i = 0; i < secrets.length; i += 1) {
    assert.strictEqual(blob.indexOf(secrets[i]), -1, secrets[i]);
  }
}

function ytBroadcast(liveChatId) {
  return {
    id: 'bc-1',
    snippet: {
      title: '配信',
      liveChatId: liveChatId || 'CHAT-1',
      channelId: 'channel-1'
    }
  };
}

function boot(spec) {
  const calls = [];
  const logs = [];
  const gets = [];
  const sets = [];
  const sleeps = [];
  let mode = spec.mode || 'live';
  let clock = Date.parse(NOW);
  let secret = Object.prototype.hasOwnProperty.call(spec, 'secret') ? spec.secret : spec.defaultSecret;
  const fetchImpl = spec.fetch || async function unexpected(url) {
    throw new Error('unexpected fetch ' + url);
  };
  const plugin = spec.create({
    fetch: async function fetch(url, init) {
      calls.push({ url: String(url), init: init || {} });
      return fetchImpl(url, init, calls);
    },
    now: function now() { return new Date(clock); },
    sleep: async function sleep(ms) {
      sleeps.push(ms);
      clock += ms;
    }
  });
  const ctx = {
    id: spec.id,
    mode: function modeFn() { return mode; },
    logger: function logger(level, message) { logs.push(String(message)); },
    secrets: {
      get: function get(name) {
        gets.push(name);
        if (name !== spec.secretName) return Promise.resolve({ ok: false, error: 'not-declared' });
        if (secret == null) return Promise.resolve({ ok: false, error: 'unavailable' });
        const value = typeof secret === 'string' ? secret : JSON.stringify(secret);
        return Promise.resolve({ ok: true, value: value });
      },
      set: function set(name, value) {
        sets.push({ name: name, value: value });
        if (spec.throwOnSet) throw new Error('value=' + value);
        if (name !== spec.secretName) return Promise.resolve({ ok: false, error: 'not-declared' });
        return Promise.resolve({ ok: true });
      }
    }
  };
  plugin.load(ctx);
  return {
    plugin: plugin,
    calls: calls,
    logs: logs,
    gets: gets,
    sets: sets,
    sleeps: sleeps,
    ctx: ctx,
    setMode: function setMode(value) { mode = value; },
    setSecret: function setSecret(value) { secret = value; },
    advance: function advance(ms) { clock += ms; }
  };
}

function youtubeSecret(extra) {
  return Object.assign({
    client_id: YT.client,
    client_secret: YT.secret,
    refresh_token: YT.refresh,
    access_token: YT.access,
    expiry_date: LATER
  }, extra || {});
}

function twitchSecret(extra) {
  return Object.assign({
    client_id: TW.client,
    client_secret: TW.secret,
    refresh_token: TW.refresh,
    access_token: TW.access,
    expiry_date: LATER
  }, extra || {});
}

function kickSecret(extra) {
  return Object.assign({
    client_id: KK.client,
    client_secret: KK.secret,
    refresh_token: KK.refresh,
    access_token: KK.access,
    expiry_date: LATER
  }, extra || {});
}

function bootYouTube(options) {
  const opts = options || {};
  return boot({
    id: 'sink-youtube',
    secretName: 'youtube.oauth',
    create: youtubeApi.createSinkYoutube,
    defaultSecret: Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : youtubeSecret(opts.secretExtra),
    mode: opts.mode,
    fetch: opts.fetch,
    throwOnSet: opts.throwOnSet
  });
}

function bootTwitch(options) {
  const opts = options || {};
  return boot({
    id: 'sink-twitch',
    secretName: 'twitch.oauth',
    create: twitchApi.createSinkTwitch,
    defaultSecret: Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : twitchSecret(opts.secretExtra),
    mode: opts.mode,
    fetch: opts.fetch,
    throwOnSet: opts.throwOnSet
  });
}

function bootKick(options) {
  const opts = options || {};
  return boot({
    id: 'sink-kick',
    secretName: 'kick.oauth',
    create: kickApi.createSinkKick,
    defaultSecret: Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : kickSecret(opts.secretExtra),
    mode: opts.mode,
    fetch: opts.fetch,
    throwOnSet: opts.throwOnSet
  });
}

function tokenResponse(access, refresh) {
  const body = { access_token: access, expires_in: 3600, token_type: 'Bearer' };
  if (refresh) body.refresh_token = refresh;
  return jsonResponse(200, body);
}

async function main() {
  await test('youtube sendComment posts liveChatMessages like MultiCommenter', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [ytBroadcast('LIVE-CHAT-9')] });
        if (url === YT_MESSAGES) return jsonResponse(200, { id: 'msg-1' });
        throw new Error('unexpected ' + url);
      }
    });
    const text = 'こんにちは';
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: text, site: 'youtube' }, {}), { ok: true });
    assert.strictEqual(bag.calls.length, 2);
    assert.strictEqual(bag.calls[0].url, YT_LIST_ACTIVE);
    assert.strictEqual(bag.calls[1].url, YT_MESSAGES);
    assert.strictEqual(bag.calls[1].init.method, 'POST');
    const body = JSON.parse(bag.calls[1].init.body);
    assert.deepStrictEqual(body, {
      snippet: {
        liveChatId: 'LIVE-CHAT-9',
        type: 'textMessageEvent',
        textMessageDetails: { messageText: text }
      }
    });
    assert.strictEqual(header(bag.calls[1], 'Authorization'), 'Bearer ' + YT.access);
    assertManual(bag.calls);
    assertClean(bag.logs.join('\n'), [YT.client, YT.secret, YT.refresh, YT.access, text]);
    bag.plugin.destroy();
  });

  await test('youtube falls back to upcoming liveChatId', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [] });
        if (url === YT_LIST_UPCOMING) return jsonResponse(200, { items: [ytBroadcast('UP-CHAT')] });
        if (url === YT_MESSAGES) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'hi' }, {}), { ok: true });
    assert.strictEqual(JSON.parse(bag.calls[2].init.body).snippet.liveChatId, 'UP-CHAT');
    bag.plugin.destroy();
  });

  await test('youtube refreshes once after 401 and retries that call', async () => {
    let lists = 0;
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) {
          lists += 1;
          if (lists === 1) return jsonResponse(401, {});
          return jsonResponse(200, { items: [ytBroadcast()] });
        }
        if (url === YT_MESSAGES) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'a' }, {}), { ok: true });
    assert.strictEqual(bag.calls.filter((c) => c.url === YT_TOKEN).length, 1);
    assert.strictEqual(form(bag.calls.find((c) => c.url === YT_TOKEN)).get('grant_type'), 'refresh_token');
    assert.strictEqual(header(bag.calls[bag.calls.length - 1], 'Authorization'), 'Bearer ' + YT.access2);
    assert.strictEqual(bag.sets.length, 1);
    assert.strictEqual(bag.sets[0].name, 'youtube.oauth');
    assert.strictEqual(JSON.parse(bag.sets[0].value).access_token, YT.access2);
    bag.plugin.destroy();
  });

  await test('youtube: トークン更新が 503 なら network（ログイン切れ扱いにしない）、400 だけが refresh-failed', async () => {
    for (const [status, want] of [[503, 'network'], [429, 'network'], [400, 'refresh-failed'], [401, 'refresh-failed']]) {
      const bag = bootYouTube({
        secretExtra: { expiry_date: PAST },
        fetch: async function fetch(url) {
          if (url === YT_TOKEN) return jsonResponse(status, {});
          throw new Error('unexpected ' + url);
        }
      });
      const out = await bag.plugin.sendComment({ text: 'a' }, {});
      assert.deepStrictEqual(out, { ok: false, error: want }, String(status));
      bag.plugin.destroy();
    }
  });

  await test('youtube does not refresh a second time', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) return jsonResponse(401, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'a' }, {}), { ok: false, error: 'unauthorized' });
    assert.strictEqual(bag.calls.filter((c) => c.url === YT_TOKEN).length, 1);
    bag.plugin.destroy();
  });

  await test('youtube refreshes before the call when the access token is expired', async () => {
    const bag = bootYouTube({
      secretExtra: { expiry_date: PAST },
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [ytBroadcast()] });
        if (url === YT_MESSAGES) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'a' }, {}), { ok: true });
    assert.strictEqual(bag.calls[0].url, YT_TOKEN);
    bag.plugin.destroy();
  });

  await test('youtube no-credentials dryRun legacy and length checks', async () => {
    const missing = bootYouTube({ secret: null });
    assert.deepStrictEqual(await missing.plugin.sendComment({ text: 'a' }, {}), { ok: false, error: 'no-credentials' });
    assert.strictEqual(missing.calls.length, 0);
    missing.plugin.destroy();

    const dry = bootYouTube({
      fetch: async function fetch() { throw new Error('no fetch'); }
    });
    assert.deepStrictEqual(await dry.plugin.sendComment({ text: 'a' }, { dryRun: true }), { ok: true, dryRun: true });
    dry.setMode('legacy');
    assert.deepStrictEqual(await dry.plugin.sendComment({ text: 'a' }, {}), { ok: true });
    dry.setMode('shadow');
    assert.deepStrictEqual(await dry.plugin.sendComment({ text: 'a' }, {}), { ok: true, dryRun: true });
    assert.strictEqual(dry.calls.length, 0);
    dry.plugin.destroy();

    const len = bootYouTube({
      fetch: async function fetch() { throw new Error('no fetch'); }
    });
    assert.deepStrictEqual(await len.plugin.sendComment({ text: '' }, {}), { ok: false, error: 'too-long' });
    assert.deepStrictEqual(await len.plugin.sendComment({ text: 'x'.repeat(201) }, {}), { ok: false, error: 'too-long' });
    assert.strictEqual(len.calls.length, 0);
    len.plugin.destroy();
  });

  await test('youtube rate limits to one send per second', async () => {
    let posts = 0;
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [ytBroadcast()] });
        if (url === YT_MESSAGES) {
          posts += 1;
          return jsonResponse(200, {});
        }
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'one' }, {}), { ok: true });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'two' }, {}), { ok: true });
    assert.strictEqual(posts, 2);
    assert.ok(bag.sleeps.some((ms) => ms > 0 && ms <= 1000));
    bag.plugin.destroy();
  });

  await test('youtube rejects redirects and unknown domains', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE) return redirectResponse();
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'a' }, {}), { ok: false, error: 'network' });
    assertManual(bag.calls);
    const allow = youtubeApi.createSinkYoutube.allowedUrl;
    assert.strictEqual(allow(YT_MESSAGES), true);
    assert.strictEqual(allow(YT_TOKEN), true);
    assert.strictEqual(allow('https://evil.example/x'), false);
    assert.strictEqual(allow('https://www.googleapis.com/youtube/v3/liveChat/messages'), false);
    bag.plugin.destroy();
  });

  await test('twitch sendComment posts helix chat messages like MultiCommenter', async () => {
    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '42' }] });
        if (url === TW_CHAT) return jsonResponse(200, { data: [{ message_id: 'm1' }] });
        throw new Error('unexpected ' + url);
      }
    });
    const text = 'ハロー';
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: text, site: 'twitch' }, {}), { ok: true });
    assert.strictEqual(bag.calls[1].url, TW_CHAT);
    assert.strictEqual(bag.calls[1].init.method, 'POST');
    assert.deepStrictEqual(JSON.parse(bag.calls[1].init.body), {
      broadcaster_id: '42',
      sender_id: '42',
      message: text
    });
    assert.strictEqual(header(bag.calls[1], 'Client-ID'), TW.client);
    assert.strictEqual(header(bag.calls[1], 'Authorization'), 'Bearer ' + TW.access);
    assertClean(bag.logs.join('\n'), [TW.client, TW.secret, TW.refresh, TW.access, text]);
    bag.plugin.destroy();
  });

  await test('twitch refreshes once when chat returns 401', async () => {
    let chats = 0;
    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_TOKEN) return tokenResponse(TW.access2);
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '7' }] });
        if (url === TW_CHAT) {
          chats += 1;
          if (chats === 1) return jsonResponse(401, {});
          return jsonResponse(200, {});
        }
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'a' }, {}), { ok: true });
    assert.strictEqual(bag.calls.filter((c) => c.url === TW_TOKEN).length, 1);
    assert.strictEqual(bag.sets.length, 1);
    assert.strictEqual(JSON.parse(bag.sets[0].value).access_token, TW.access2);
    bag.plugin.destroy();
  });

  await test('twitch no-credentials dryRun and redirect', async () => {
    const missing = bootTwitch({
      secret: { client_id: TW.client, refresh_token: TW.refresh }
    });
    assert.deepStrictEqual(await missing.plugin.sendComment({ text: 'a' }, {}), { ok: false, error: 'no-credentials' });
    assert.strictEqual(missing.calls.length, 0);
    missing.plugin.destroy();

    const dry = bootTwitch();
    assert.deepStrictEqual(await dry.plugin.sendComment({ text: 'a' }, { dryRun: true }), { ok: true, dryRun: true });
    dry.setMode('legacy');
    assert.deepStrictEqual(await dry.plugin.sendComment({ text: 'a' }, {}), { ok: true });
    assert.strictEqual(dry.calls.length, 0);
    dry.plugin.destroy();

    const bad = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_USERS) return redirectResponse();
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bad.plugin.sendComment({ text: 'a' }, {}), { ok: false, error: 'network' });
    const allow = twitchApi.createSinkTwitch.allowedUrl;
    assert.strictEqual(allow(TW_CHAT), true);
    assert.strictEqual(allow('https://api.twitch.tv/helix/channels'), false);
    bad.plugin.destroy();
  });

  await test('kick sendComment posts public chat like MultiCommenter', async () => {
    const bag = bootKick({
      fetch: async function fetch(url) {
        if (url === KK_USERS) return jsonResponse(200, { data: [{ user_id: 99 }] });
        if (url === KK_CHAT) return jsonResponse(200, { data: { is_sent: true } });
        throw new Error('unexpected ' + url);
      }
    });
    const text = 'キック';
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: text, site: 'kick' }, {}), { ok: true });
    assert.strictEqual(bag.calls[1].url, KK_CHAT);
    assert.deepStrictEqual(JSON.parse(bag.calls[1].init.body), {
      type: 'user',
      broadcaster_user_id: 99,
      content: text
    });
    assert.strictEqual(header(bag.calls[1], 'User-Agent'), KICK_UA);
    assert.strictEqual(header(bag.calls[1], 'Authorization'), 'Bearer ' + KK.access);
    assertClean(bag.logs.join('\n'), [KK.client, KK.secret, KK.refresh, KK.access, text]);
    bag.plugin.destroy();
  });

  await test('kick uses stored broadcaster_user_id and refreshes once', async () => {
    let chats = 0;
    const bag = bootKick({
      secretExtra: { broadcaster_user_id: '55' },
      fetch: async function fetch(url) {
        if (url === KK_TOKEN) return tokenResponse(KK.access2, 'SENTINEL-KK-REFRESH-2');
        if (url === KK_USERS) throw new Error('users should not be called');
        if (url === KK_CHAT) {
          chats += 1;
          if (chats === 1) return jsonResponse(401, {});
          return jsonResponse(200, {});
        }
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'a' }, {}), { ok: true });
    assert.strictEqual(bag.calls.filter((c) => c.url === KK_USERS).length, 0);
    assert.strictEqual(bag.sets.length, 1);
    assert.strictEqual(JSON.parse(bag.sets[0].value).access_token, KK.access2);
    assert.strictEqual(JSON.parse(bag.sets[0].value).broadcaster_user_id, '55');
    assert.strictEqual(JSON.parse(bag.sets[0].value).refresh_token, 'SENTINEL-KK-REFRESH-2');
    bag.plugin.destroy();
  });

  await test('kick no-credentials dryRun length and allowlist', async () => {
    const missing = bootKick({ secret: null });
    assert.deepStrictEqual(await missing.plugin.sendComment({ text: 'a' }, {}), { ok: false, error: 'no-credentials' });
    missing.plugin.destroy();

    const dry = bootKick();
    dry.setMode('shadow');
    assert.deepStrictEqual(await dry.plugin.sendComment({ text: 'a' }, {}), { ok: true, dryRun: true });
    assert.strictEqual(dry.calls.length, 0);
    dry.plugin.destroy();

    const len = bootKick();
    assert.deepStrictEqual(await len.plugin.sendComment({ text: 'あ'.repeat(201) }, {}), { ok: false, error: 'too-long' });
    len.plugin.destroy();

    const allow = kickApi.createSinkKick.allowedUrl;
    assert.strictEqual(allow(KK_CHAT), true);
    assert.strictEqual(allow(KK_USERS), true);
    assert.strictEqual(allow(KK_TOKEN), true);
    assert.strictEqual(allow('https://api.kick.com/public/v1/channels'), false);
  });

  await test('panel status and wrong-site leave secrets out', async () => {
    const bag = bootYouTube();
    const panel = await bag.plugin.actions.getStatus({}, bag.ctx);
    assert.strictEqual(panel.ok, true);
    assert.strictEqual(panel.configured, true);
    assert.strictEqual(panel.mode, 'live');
    assertClean(JSON.stringify(panel), [YT.client, YT.secret, YT.refresh, YT.access]);
    assert.deepStrictEqual(await bag.plugin.sendComment({ text: 'a', site: 'twitch' }, {}), { ok: false, error: 'wrong-site' });
    bag.plugin.destroy();
  });

  await test('source does not read secret files or start a browser login', async () => {
    const files = [
      path.relative(ROOT, mainFileOf('sink-youtube')),
      path.relative(ROOT, mainFileOf('sink-twitch')),
      'plugins/sites/kick/sink.js'
    ];
    for (let i = 0; i < files.length; i += 1) {
      const src = fs.readFileSync(path.join(ROOT, files[i]), 'utf8');
      assert.strictEqual(src.indexOf("require('fs')"), -1, files[i]);
      assert.strictEqual(src.indexOf('require("fs")'), -1, files[i]);
      assert.strictEqual(src.indexOf('readFile'), -1, files[i]);
      assert.strictEqual(src.indexOf('writeFile'), -1, files[i]);
      assert.strictEqual(src.indexOf('createServer'), -1, files[i]);
      assert.strictEqual(src.indexOf('child_process'), -1, files[i]);
      assert.strictEqual(src.indexOf('token.json'), -1, files[i]);
      assert.strictEqual(src.indexOf('credentials.json'), -1, files[i]);
      assert.strictEqual(src.indexOf('twitch-config'), -1, files[i]);
      assert.strictEqual(src.indexOf('kick-config'), -1, files[i]);
    }
    const panels = [
      path.relative(ROOT, panelFileOf('sink-youtube')),
      path.relative(ROOT, panelFileOf('sink-twitch')),
      'plugins/sites/kick/ui/panel-sink.js'
    ];
    for (let i = 0; i < panels.length; i += 1) {
      const src = fs.readFileSync(path.join(ROOT, panels[i]), 'utf8');
      assert.strictEqual(src.indexOf('access_token'), -1, panels[i]);
      assert.strictEqual(src.indexOf('client_secret'), -1, panels[i]);
      assert.strictEqual(src.indexOf('refresh_token'), -1, panels[i]);
    }
  });

  await test('manifests are accepted and the plugins start', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-reg-'));
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-plugins-'));
    try {
      const registry = createRegistry({
        appRoot: ROOT,
        core: { STATE_DIR: stateDir },
        logger: function logger() {}
      });
      const found = registry.discover().filter(function (rec) {
        return rec.id === 'sink-youtube' || rec.id === 'sink-twitch' || rec.id === 'sink-kick';
      });
      assert.strictEqual(found.length, 3);
      const expect = {
        'sink-youtube': { secrets: ['youtube.oauth'], sinkFor: ['youtube'] },
        'sink-twitch': { secrets: ['twitch.oauth'], sinkFor: ['twitch'] },
        'sink-kick': { secrets: ['kick.oauth'], sinkFor: ['kick'] }
      };
      for (let i = 0; i < found.length; i += 1) {
        assert.strictEqual(found[i].status, 'accepted', found[i].id + ' ' + found[i].reason);
        assert.strictEqual(found[i].manifest.manifestVersion, 2);
        assert.strictEqual(found[i].manifest.runtime, 'inproc');
        assert.strictEqual(found[i].manifest.defaultMode, 'legacy');
        // サイトの形（plugins/sites/）の sink は、パネルをサイトの site の役目が持つので ui.panel を持たない（R16）
        assert.deepStrictEqual(found[i].manifest.provides, found[i].manifest.siteId ? ['chat.sink@1'] : ['chat.sink@1', 'ui.panel@1']);
        assert.deepStrictEqual(found[i].manifest.secrets, expect[found[i].id].secrets);
        assert.deepStrictEqual(found[i].manifest.sinkFor, expect[found[i].id].sinkFor);
      }
      for (const id of ['sink-youtube', 'sink-twitch', 'sink-kick']) {
        copyPlugin(id, isolated);
      }
      const started = createRegistry({
        appRoot: isolated,
        builtinRoot: isolated,
        core: { STATE_DIR: path.join(isolated, 'state') },
        secrets: {
          get: function get() { return Promise.resolve({ ok: false, error: 'unavailable' }); }
        },
        logger: function logger() {}
      });
      await started.loadAll();
      // サイトの形のフォルダは、同じサイトの役目（site など）もまとめて動かす。ここでは sink- だけ数える。
      const running = started.getRunning().map(function (rec) { return rec.id; }).filter(function (id) { return /^sink-/.test(id); }).sort();
      assert.deepStrictEqual(running, ['sink-kick', 'sink-twitch', 'sink-youtube']);
      const health = await started.getRunning().filter(function (rec) { return /^sink-/.test(rec.id); })[0].instance.health();
      assert.deepStrictEqual(health, { ok: false, detail: 'no-credentials' });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all ok');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});