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
const youtubeApi = requirePlugin('site-youtube');
const twitchApi = requirePlugin('site-twitch');
const kickApi = requirePlugin('site-kick');

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
  access2: 'SENTINEL-KK-ACCESS-2',
  streamKey: 'SENTINEL-KK-STREAM-KEY'
};

const YT_LIST_ACTIVE = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all&maxResults=5';
const YT_LIST_UPCOMING = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=upcoming&broadcastType=all&maxResults=5';
const YT_LIST_MINE = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&mine=true&maxResults=5';
const YT_UPDATE = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts?part=snippet';
const YT_TOKEN = 'https://oauth2.googleapis.com/token';
const TW_USERS = 'https://api.twitch.tv/helix/users';
const TW_TOKEN = 'https://id.twitch.tv/oauth2/token';
const KK_CHANNELS = 'https://api.kick.com/public/v1/channels';
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

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
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

function methodOf(call) {
  return call && call.init && call.init.method;
}

function jsonBody(call) {
  return JSON.parse(call.init.body);
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

function broadcast(title) {
  return {
    id: 'bc-1',
    snippet: {
      title: title || '古い題名',
      description: '説明は残す',
      scheduledStartTime: '2026-10-04T00:00:00.000Z',
      channelId: 'channel-1'
    }
  };
}

function boot(spec) {
  const calls = [];
  const logs = [];
  const gets = [];
  const sets = [];
  let mode = spec.mode || 'live';
  let secret = Object.prototype.hasOwnProperty.call(spec, 'secret') ? spec.secret : spec.defaultSecret;
  const fetchImpl = spec.fetch || async function unexpected(url) {
    throw new Error('unexpected fetch ' + url);
  };
  const plugin = spec.create({
    fetch: async function fetch(url, init) {
      calls.push({ url: String(url), init: init || {} });
      return fetchImpl(url, init, calls);
    },
    now: function now() { return new Date(NOW); }
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
    ctx: ctx,
    setMode: function setMode(value) { mode = value; },
    setSecret: function setSecret(value) { secret = value; }
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
    id: 'site-youtube',
    secretName: 'youtube.oauth',
    create: youtubeApi.createSiteYoutube,
    defaultSecret: Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : youtubeSecret(opts.secretExtra),
    mode: opts.mode,
    fetch: opts.fetch,
    throwOnSet: opts.throwOnSet
  });
}

function bootTwitch(options) {
  const opts = options || {};
  return boot({
    id: 'site-twitch',
    secretName: 'twitch.oauth',
    create: twitchApi.createSiteTwitch,
    defaultSecret: Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : twitchSecret(opts.secretExtra),
    mode: opts.mode,
    fetch: opts.fetch,
    throwOnSet: opts.throwOnSet
  });
}

function bootKick(options) {
  const opts = options || {};
  return boot({
    id: 'site-kick',
    secretName: 'kick.oauth',
    create: kickApi.createSiteKick,
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
  await test('youtube updates liveBroadcasts with the same snippet fields', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url, init) {
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [] });
        if (url === YT_LIST_UPCOMING) return jsonResponse(200, { items: [broadcast('待機')] });
        if (url === YT_UPDATE) return jsonResponse(200, { id: 'bc-1' });
        throw new Error('unexpected ' + url + ' ' + (init && init.method));
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名', category: 'Games' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(bag.calls.map((call) => call.url), [YT_LIST_ACTIVE, YT_LIST_UPCOMING, YT_UPDATE]);
    assert.strictEqual(methodOf(bag.calls[2]), 'PUT');
    assert.strictEqual(header(bag.calls[2], 'Authorization'), 'Bearer ' + YT.access);
    assert.strictEqual(header(bag.calls[2], 'Content-Type'), 'application/json');
    assert.deepStrictEqual(jsonBody(bag.calls[2]), {
      id: 'bc-1',
      snippet: {
        title: '新しい題名',
        description: '説明は残す',
        scheduledStartTime: '2026-10-04T00:00:00.000Z',
        channelId: 'channel-1'
      }
    });
    assertManual(bag.calls);
    bag.plugin.destroy();
  });

  await test('youtube stops at the first broadcast', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [broadcast('配信中')] });
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(bag.calls.map((call) => call.url), [YT_LIST_ACTIVE, YT_UPDATE]);
    bag.plugin.destroy();
  });

  await test('youtube falls through to mine=true', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE || url === YT_LIST_UPCOMING) return jsonResponse(200, { items: [] });
        if (url === YT_LIST_MINE) return jsonResponse(200, { items: [broadcast('手元')] });
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(bag.calls.map((call) => call.url), [YT_LIST_ACTIVE, YT_LIST_UPCOMING, YT_LIST_MINE, YT_UPDATE]);
    bag.plugin.destroy();
  });

  await test('youtube refreshes once after 401 and retries that call', async () => {
    let lists = 0;
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) {
          lists += 1;
          if (lists === 1) return jsonResponse(401, { error: YT.access });
          return jsonResponse(200, { items: [broadcast()] });
        }
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(bag.calls.filter((call) => call.url === YT_TOKEN).length, 1);
    assert.strictEqual(bag.calls.filter((call) => call.url === YT_LIST_ACTIVE).length, 2);
    assert.strictEqual(header(bag.calls[0], 'Authorization'), 'Bearer ' + YT.access);
    assert.strictEqual(header(bag.calls[2], 'Authorization'), 'Bearer ' + YT.access2);
    assert.strictEqual(header(bag.calls[3], 'Authorization'), 'Bearer ' + YT.access2);
    const token = form(bag.calls[1]);
    assert.strictEqual(token.get('grant_type'), 'refresh_token');
    assert.strictEqual(token.get('refresh_token'), YT.refresh);
    assert.strictEqual(token.get('client_id'), YT.client);
    assert.strictEqual(token.get('client_secret'), YT.secret);
    assert.strictEqual(bag.calls[1].url, YT_TOKEN);
    bag.plugin.destroy();
  });

  await test('youtube does not refresh a second time', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) return jsonResponse(401, { error: YT.access });
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'unauthorized' });
    assert.strictEqual(bag.calls.filter((call) => call.url === YT_TOKEN).length, 1);
    assert.strictEqual(bag.calls.filter((call) => call.url === YT_LIST_ACTIVE).length, 2);
    bag.plugin.destroy();
  });

  await test('youtube refreshes before the call when the access token is expired', async () => {
    const bag = bootYouTube({
      secretExtra: { expiry_date: PAST },
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [broadcast()] });
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(bag.calls.map((call) => call.url), [YT_TOKEN, YT_LIST_ACTIVE, YT_UPDATE]);
    assert.strictEqual(header(bag.calls[1], 'Authorization'), 'Bearer ' + YT.access2);
    assert.strictEqual(header(bag.calls[2], 'Authorization'), 'Bearer ' + YT.access2);
    bag.plugin.destroy();
  });

  await test('youtube keeps the refreshed token in memory', async () => {
    let lists = 0;
    const bodies = [];
    const bag = bootYouTube({
      fetch: async function fetch(url, init) {
        if (url === YT_TOKEN) {
          bodies.push(String(init.body));
          return tokenResponse('SENTINEL-YT-ACCESS-' + bodies.length, 'SENTINEL-YT-REFRESH-' + bodies.length);
        }
        if (url === YT_LIST_ACTIVE) {
          lists += 1;
          if (lists === 1 || lists === 3) return jsonResponse(401, { leaked: YT.access });
          return jsonResponse(200, { items: [broadcast()] });
        }
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    const first = await bag.plugin.updateMetadata({ title: '1' }, {});
    assert.deepStrictEqual(first, { ok: true });
    const mark = bag.calls.length;
    const second = await bag.plugin.updateMetadata({ title: '2' }, {});
    assert.deepStrictEqual(second, { ok: true });
    const again = bag.calls.slice(mark);
    const tokenCall = again.filter(function (call) { return call.url === YT_TOKEN; });
    assert.strictEqual(tokenCall.length, 1);
    assert.ok(String(tokenCall[0].init.body).indexOf('refresh_token=SENTINEL-YT-REFRESH-1') !== -1);
    assert.strictEqual(String(tokenCall[0].init.body).indexOf('refresh_token=' + YT.refresh + '&'), -1);
    assert.strictEqual(bodies.length, 2);
    bag.plugin.destroy();
  });

  await test('youtube isConfigured is false without a secret and does not call out', async () => {
    const bag = bootYouTube({
      secret: null,
      fetch: async function fetch() { throw new Error('called'); }
    });
    assert.strictEqual(await bag.plugin.isConfigured(), false);
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'not-configured' });
    assert.strictEqual(bag.calls.length, 0);
    const partial = bootYouTube({
      secret: { client_id: YT.client, client_secret: YT.secret },
      fetch: async function fetch() { throw new Error('called'); }
    });
    assert.strictEqual(await partial.plugin.isConfigured(), false);
    assert.deepStrictEqual(await partial.plugin.health(), { ok: false, detail: 'not-configured' });
    partial.plugin.destroy();
    bag.plugin.destroy();
  });

  await test('youtube dryRun legacy and shadow do not call out', async () => {
    const bag = bootYouTube({
      fetch: async function fetch() { throw new Error('called'); }
    });
    assert.deepStrictEqual(await bag.plugin.updateMetadata({ title: '新しい題名' }, { dryRun: true }), { ok: true, dryRun: true });
    bag.setMode('legacy');
    assert.deepStrictEqual(await bag.plugin.updateMetadata({ title: '新しい題名' }, {}), { ok: true });
    bag.setMode('shadow');
    assert.deepStrictEqual(await bag.plugin.updateMetadata({ title: '新しい題名' }, {}), { ok: true, dryRun: true });
    assert.strictEqual(bag.calls.length, 0);
    assert.strictEqual(bag.gets.length, 0);
    assert.deepStrictEqual(await bag.plugin.getStatus(), {});
    bag.plugin.destroy();
  });

  await test('youtube does not follow a redirect', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE) return redirectResponse();
        throw new Error('followed ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'network' });
    assert.strictEqual(bag.calls.length, 1);
    assertManual(bag.calls);
    bag.plugin.destroy();
  });

  await test('youtube allows only the liveBroadcasts and token hosts', async () => {
    const allow = youtubeApi.createSiteYoutube.allowedUrl;
    assert.strictEqual(allow(YT_LIST_ACTIVE), true);
    assert.strictEqual(allow(YT_UPDATE), true);
    assert.strictEqual(allow(YT_TOKEN), true);
    assert.strictEqual(allow('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet'), false);
    assert.strictEqual(allow('https://youtube.googleapis.com/youtube/v3/liveBroadcasts/bind'), false);
    assert.strictEqual(allow('https://youtube.googleapis.com.evil.example/youtube/v3/liveBroadcasts'), false);
    assert.strictEqual(allow('https://user:pass@youtube.googleapis.com/youtube/v3/liveBroadcasts'), false);
    assert.strictEqual(allow('http://youtube.googleapis.com/youtube/v3/liveBroadcasts'), false);
    assert.strictEqual(allow('https://oauth2.googleapis.com/token/extra'), false);
    assert.strictEqual(allow('https://evil.example/youtube/v3/liveBroadcasts'), false);
  });

  await test('youtube keeps secrets out of logs and the panel', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return jsonResponse(500, { access_token: YT.access, client_secret: YT.secret });
        if (url === YT_LIST_ACTIVE) return jsonResponse(401, { refresh_token: YT.refresh, access_token: YT.access });
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '新しい題名' }, {});
    const panel = await bag.plugin.actions.getStatus({}, bag.ctx);
    const secrets = [YT.client, YT.secret, YT.refresh, YT.access, YT.access2];
    assert.strictEqual(result.ok, false);
    assertClean(JSON.stringify(result), secrets);
    assertClean(JSON.stringify(panel), secrets);
    assertClean(bag.logs.join('\n'), secrets);
    assert.deepStrictEqual(Object.keys(panel).sort(), ['configured', 'lastAt', 'lastError', 'mode', 'lastOk', 'ok', 'lastStage', 'lastStatusError', 'lastStatusAt', 'statusStage', 'credentialsState', 'credentialsError'].sort());
    assert.strictEqual(panel.configured, true);
    assert.strictEqual(panel.lastOk, false);
    assert.strictEqual(panel.lastError, result.error);
    assert.strictEqual(JSON.stringify(panel).indexOf('新しい題名'), -1);
    bag.plugin.destroy();
  });

  await test('youtube getStatus reports live and title', async () => {
    const bag = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [broadcast('配信中')] });
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.getStatus(), { live: true, title: '配信中' });
    assert.deepStrictEqual(bag.calls.map((call) => call.url), [YT_LIST_ACTIVE]);
    bag.plugin.destroy();
  });

  await test('youtube drops a refreshed token on destroy', async () => {
    const bag = bootYouTube({
      secretExtra: { expiry_date: PAST },
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [broadcast()] });
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    await bag.plugin.updateMetadata({ title: '1' }, {});
    bag.plugin.destroy();
    bag.plugin.load(bag.ctx);
    await bag.plugin.updateMetadata({ title: '2' }, {});
    assert.strictEqual(bag.calls.filter((call) => call.url === YT_TOKEN).length, 2);
  });

  await test('twitch patches title and the exact category id', async () => {
    const bag = bootTwitch({
      secretExtra: { broadcaster_id: '999' },
      fetch: async function fetch(url) {
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '42' }] });
        if (url === 'https://api.twitch.tv/helix/search/categories?query=just%20chatting&first=5') {
          return jsonResponse(200, {
            data: [
              { id: '111', name: 'Just Chatting Extra' },
              { id: '509658', name: 'Just Chatting' }
            ]
          });
        }
        if (url === 'https://api.twitch.tv/helix/channels?broadcaster_id=42') return jsonResponse(204, '');
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '番組', category: 'just chatting' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(bag.calls[0].url, TW_USERS);
    assert.strictEqual(header(bag.calls[0], 'Client-ID'), TW.client);
    assert.strictEqual(header(bag.calls[0], 'Authorization'), 'Bearer ' + TW.access);
    const patch = bag.calls[2];
    assert.strictEqual(patch.url, 'https://api.twitch.tv/helix/channels?broadcaster_id=42');
    assert.strictEqual(methodOf(patch), 'PATCH');
    assert.strictEqual(patch.init.body, '{"title":"番組","game_id":"509658"}');
    assert.strictEqual(header(patch, 'Content-Type'), 'application/json');
    assertManual(bag.calls);
    bag.plugin.destroy();
  });

  await test('twitch uses the first category when none match', async () => {
    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '42' }] });
        if (url.indexOf('/helix/search/categories') !== -1) {
          return jsonResponse(200, { data: [{ id: '111', name: 'Something' }, { id: '222', name: 'Else' }] });
        }
        if (url.indexOf('/helix/channels') !== -1) return jsonResponse(204, '');
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '番組', category: 'nope' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(bag.calls[2].init.body, '{"title":"番組","game_id":"111"}');
    bag.plugin.destroy();
  });

  await test('twitch omits game_id when the search is empty', async () => {
    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '42' }] });
        if (url.indexOf('/helix/search/categories') !== -1) return jsonResponse(200, { data: [] });
        if (url.indexOf('/helix/channels') !== -1) return jsonResponse(204, '');
        throw new Error('unexpected ' + url);
      }
    });
    await bag.plugin.updateMetadata({ title: '番組' }, {});
    assert.strictEqual(bag.calls.length, 2);
    assert.strictEqual(bag.calls[1].init.body, '{"title":"番組"}');
    bag.plugin.destroy();
  });

  await test('twitch refreshes once when users returns 401', async () => {
    let users = 0;
    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_TOKEN) return tokenResponse(TW.access2);
        if (url === TW_USERS) {
          users += 1;
          if (users === 1) return jsonResponse(401, { message: TW.access });
          return jsonResponse(200, { data: [{ id: '42' }] });
        }
        if (url.indexOf('/helix/channels') !== -1) return jsonResponse(204, '');
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '番組' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(bag.calls.filter((call) => call.url === TW_TOKEN).length, 1);
    assert.strictEqual(bag.calls.filter((call) => call.url === TW_USERS).length, 2);
    assert.strictEqual(header(bag.calls[0], 'Authorization'), 'Bearer ' + TW.access);
    assert.strictEqual(header(bag.calls[2], 'Authorization'), 'Bearer ' + TW.access2);
    assert.strictEqual(form(bag.calls[1]).get('grant_type'), 'refresh_token');
    assert.strictEqual(bag.calls[1].url, TW_TOKEN);
    bag.plugin.destroy();
  });

  await test('twitch refreshes once when the patch returns 401', async () => {
    let patches = 0;
    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_TOKEN) return tokenResponse(TW.access2);
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '42' }] });
        if (url.indexOf('/helix/channels') !== -1) {
          patches += 1;
          if (patches === 1) return jsonResponse(401, { message: TW.refresh });
          return jsonResponse(204, '');
        }
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '番組' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(patches, 2);
    assert.strictEqual(bag.calls.filter((call) => call.url === TW_TOKEN).length, 1);
    assert.strictEqual(bag.calls.filter((call) => call.url === TW_USERS).length, 1);
    assert.strictEqual(header(bag.calls[3], 'Authorization'), 'Bearer ' + TW.access2);
    bag.plugin.destroy();
  });

  await test('twitch does not refresh twice and skips the call without a secret', async () => {
    const expired = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_TOKEN) return tokenResponse(TW.access2);
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '42' }] });
        if (url.indexOf('/helix/channels') !== -1) return jsonResponse(401, { message: TW.access });
        throw new Error('unexpected ' + url);
      }
    });
    const failedUpdate = await expired.plugin.updateMetadata({ title: '番組' }, {});
    assert.deepStrictEqual(failedUpdate, { ok: false, error: 'unauthorized' });
    assert.strictEqual(expired.calls.filter((call) => call.url === TW_TOKEN).length, 1);
    assert.strictEqual(expired.calls.filter((call) => call.url.indexOf('/helix/channels') !== -1).length, 2);
    expired.plugin.destroy();

    const missing = bootTwitch({
      secret: null,
      fetch: async function fetch() { throw new Error('called'); }
    });
    assert.strictEqual(await missing.plugin.isConfigured(), false);
    assert.deepStrictEqual(await missing.plugin.updateMetadata({ title: '番組', category: 'Games' }, {}), { ok: false, error: 'not-configured' });
    assert.strictEqual(missing.calls.length, 0);
    missing.plugin.destroy();

    const noRefresh = bootTwitch({
      secret: { client_id: TW.client, access_token: TW.access },
      fetch: async function fetch(url) {
        if (url === TW_USERS) return jsonResponse(401, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.strictEqual(await noRefresh.plugin.isConfigured(), true);
    assert.deepStrictEqual(await noRefresh.plugin.updateMetadata({ title: '番組' }, {}), { ok: false, error: 'refresh-unavailable' });
    assert.deepStrictEqual(noRefresh.calls.map((call) => call.url), [TW_USERS]);
    noRefresh.plugin.destroy();
  });

  await test('twitch dryRun does not call out and a redirect is not followed', async () => {
    const dry = bootTwitch({ fetch: async function fetch() { throw new Error('called'); } });
    assert.deepStrictEqual(await dry.plugin.updateMetadata({ title: '番組', category: 'Games' }, { dryRun: true }), { ok: true, dryRun: true });
    dry.setMode('legacy');
    assert.deepStrictEqual(await dry.plugin.updateMetadata({ title: '番組' }, {}), { ok: true });
    assert.strictEqual(dry.calls.length, 0);
    assert.strictEqual(dry.gets.length, 0);
    dry.plugin.destroy();

    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_USERS) return redirectResponse();
        throw new Error('followed ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.updateMetadata({ title: '番組' }, {}), { ok: false, error: 'network' });
    assert.strictEqual(bag.calls.length, 1);
    assertManual(bag.calls);
    bag.plugin.destroy();
  });

  await test('twitch allows only Helix and the token host', async () => {
    const allow = twitchApi.createSiteTwitch.allowedUrl;
    assert.strictEqual(allow(TW_USERS), true);
    assert.strictEqual(allow('https://api.twitch.tv/helix/search/categories?query=a&first=5'), true);
    assert.strictEqual(allow('https://api.twitch.tv/helix/channels?broadcaster_id=1'), true);
    assert.strictEqual(allow('https://api.twitch.tv/helix/streams?user_id=1'), true);
    assert.strictEqual(allow(TW_TOKEN), true);
    assert.strictEqual(allow('https://api.twitch.tv/helix/moderation/bans'), false);
    assert.strictEqual(allow('https://api.twitch.tv.evil.example/helix/users'), false);
    assert.strictEqual(allow('https://id.twitch.tv/oauth2/authorize'), false);
    assert.strictEqual(allow('http://api.twitch.tv/helix/users'), false);
  });

  await test('twitch getStatus returns live title and category without secrets', async () => {
    const bag = bootTwitch({
      fetch: async function fetch(url) {
        if (url === TW_USERS) return jsonResponse(200, { data: [{ id: '42' }] });
        if (url === 'https://api.twitch.tv/helix/channels?broadcaster_id=42') {
          return jsonResponse(200, { data: [{ title: '番組', game_name: 'Just Chatting', game_id: '509658' }] });
        }
        if (url === 'https://api.twitch.tv/helix/streams?user_id=42') {
          return jsonResponse(200, { data: [{ id: 'stream-1', type: 'live', title: '番組' }] });
        }
        throw new Error('unexpected ' + url);
      }
    });
    const status = await bag.plugin.getStatus();
    assert.deepStrictEqual(status, { live: true, title: '番組', category: 'Just Chatting' });
    const panel = await bag.plugin.actions.getStatus({}, bag.ctx);
    assertClean(JSON.stringify(panel), [TW.client, TW.secret, TW.refresh, TW.access]);
    assert.strictEqual(panel.configured, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(panel, 'title'), false);
    bag.plugin.destroy();
  });

  await test('kick patches stream_title and category_id', async () => {
    const bag = bootKick({
      fetch: async function fetch(url, init) {
        if (url === 'https://api.kick.com/public/v1/categories?q=just%20chatting') {
          return jsonResponse(200, {
            data: [
              { id: 5, name: 'Just Chatting 2' },
              { id: 101, name: 'Just Chatting' }
            ]
          });
        }
        if (url === KK_CHANNELS) return jsonResponse(204, '');
        throw new Error('unexpected ' + url + ' ' + (init && init.method));
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '番組', category: 'just chatting' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(methodOf(bag.calls[0]), 'GET');
    const patch = bag.calls[1];
    assert.strictEqual(patch.url, KK_CHANNELS);
    assert.strictEqual(methodOf(patch), 'PATCH');
    assert.strictEqual(patch.init.body, '{"stream_title":"番組","category_id":101}');
    assert.strictEqual(header(patch, 'Authorization'), 'Bearer ' + KK.access);
    assert.strictEqual(header(patch, 'Content-Type'), 'application/json');
    assert.strictEqual(header(patch, 'Accept'), 'application/json');
    assert.strictEqual(header(patch, 'User-Agent'), KICK_UA);
    assertManual(bag.calls);
    bag.plugin.destroy();
  });

  await test('kick uses the first category and skips an empty patch', async () => {
    const first = bootKick({
      fetch: async function fetch(url) {
        if (url.indexOf('/public/v1/categories') !== -1) {
          return jsonResponse(200, { data: [{ id: 7, name: 'A' }, { id: 8, name: 'B' }] });
        }
        if (url === KK_CHANNELS) return jsonResponse(204, '');
        throw new Error('unexpected ' + url);
      }
    });
    await first.plugin.updateMetadata({ title: '番組', category: 'nope' }, {});
    assert.strictEqual(first.calls[1].init.body, '{"stream_title":"番組","category_id":7}');
    first.plugin.destroy();

    const empty = bootKick({
      fetch: async function fetch(url) {
        if (url.indexOf('/public/v1/categories') !== -1) return jsonResponse(200, { data: [] });
        throw new Error('unexpected ' + url);
      }
    });
    const result = await empty.plugin.updateMetadata({ title: '   ', category: 'Nope' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(empty.calls.length, 1);
    empty.plugin.destroy();
  });

  await test('kick refreshes once when the patch returns 401', async () => {
    let patches = 0;
    const bag = bootKick({
      fetch: async function fetch(url) {
        if (url === KK_TOKEN) return tokenResponse(KK.access2);
        if (url.indexOf('/public/v1/categories') !== -1) {
          return jsonResponse(200, { data: [{ id: 101, name: 'Just Chatting' }] });
        }
        if (url === KK_CHANNELS) {
          patches += 1;
          if (patches === 1) return jsonResponse(401, { message: KK.access });
          return jsonResponse(204, '');
        }
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '番組', category: 'Just Chatting' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(patches, 2);
    assert.strictEqual(bag.calls.filter((call) => call.url === KK_TOKEN).length, 1);
    assert.strictEqual(bag.calls.filter((call) => call.url.indexOf('/categories') !== -1).length, 1);
    assert.strictEqual(header(bag.calls[3], 'Authorization'), 'Bearer ' + KK.access2);
    assert.strictEqual(form(bag.calls[2]).get('refresh_token'), KK.refresh);
    assert.strictEqual(bag.calls[2].url, KK_TOKEN);
    assert.strictEqual(header(bag.calls[2], 'User-Agent'), KICK_UA);
    bag.plugin.destroy();
  });

  await test('kick does not call out without a token or on dryRun', async () => {
    const missing = bootKick({
      secret: { client_id: KK.client, refresh_token: KK.refresh },
      fetch: async function fetch() { throw new Error('called'); }
    });
    assert.strictEqual(await missing.plugin.isConfigured(), false);
    assert.deepStrictEqual(await missing.plugin.updateMetadata({ title: '番組' }, {}), { ok: false, error: 'not-configured' });
    assert.strictEqual(missing.calls.length, 0);
    missing.plugin.destroy();

    const dry = bootKick({ fetch: async function fetch() { throw new Error('called'); } });
    dry.setMode('shadow');
    assert.deepStrictEqual(await dry.plugin.updateMetadata({ title: '番組', category: 'Games' }, {}), { ok: true, dryRun: true });
    assert.strictEqual(dry.gets.length, 0);
    assert.strictEqual(dry.calls.length, 0);
    dry.plugin.destroy();

    const bag = bootKick({
      fetch: async function fetch(url) {
        if (url.indexOf('/categories') !== -1) return redirectResponse();
        throw new Error('followed ' + url);
      }
    });
    assert.deepStrictEqual(await bag.plugin.updateMetadata({ title: '番組', category: 'Games' }, {}), { ok: false, error: 'network' });
    assert.strictEqual(bag.calls.length, 1);
    assertManual(bag.calls);
    bag.plugin.destroy();
  });

  await test('kick allows only the API and token hosts', async () => {
    const allow = kickApi.createSiteKick.allowedUrl;
    assert.strictEqual(allow('https://api.kick.com/public/v1/categories?q=a'), true);
    assert.strictEqual(allow(KK_CHANNELS), true);
    assert.strictEqual(allow(KK_TOKEN), true);
    assert.strictEqual(allow('https://id.kick.com/oauth/authorize'), false);
    assert.strictEqual(allow('https://kick.com/public/v1/channels'), false);
    assert.strictEqual(allow('https://api.kick.com.evil.example/public/v1/channels'), false);
    assert.strictEqual(allow('http://api.kick.com/public/v1/channels'), false);
  });

  await test('kick getStatus omits the stream key', async () => {
    const bag = bootKick({
      fetch: async function fetch(url) {
        if (url !== KK_CHANNELS) throw new Error('unexpected ' + url);
        return jsonResponse(200, {
          data: [{
            stream_title: '番組',
            category: { id: 101, name: 'Just Chatting' },
            stream: {
              is_live: true,
              key: KK.streamKey,
              url: 'rtmps://stream.kick.com/secret-url'
            }
          }]
        });
      }
    });
    const status = await bag.plugin.getStatus();
    assert.deepStrictEqual(status, { title: '番組', category: 'Just Chatting', live: true });
    const panel = await bag.plugin.actions.getStatus({}, bag.ctx);
    const secrets = [KK.client, KK.secret, KK.refresh, KK.access, KK.streamKey, 'secret-url'];
    assertClean(JSON.stringify(status), secrets);
    assertClean(JSON.stringify(panel), secrets);
    assertClean(bag.logs.join('\n'), secrets);
    assert.strictEqual(panel.lastOk, null);
    bag.plugin.destroy();
  });

  await test('kick keeps secrets out of logs and the panel', async () => {
    const bag = bootKick({
      fetch: async function fetch(url) {
        if (url === KK_TOKEN) return jsonResponse(400, { client_secret: KK.secret, refresh_token: KK.refresh });
        if (url === KK_CHANNELS) return jsonResponse(401, { access_token: KK.access });
        throw new Error('unexpected ' + url);
      }
    });
    const result = await bag.plugin.updateMetadata({ title: '番組' }, {});
    const panel = await bag.plugin.actions.getStatus({}, bag.ctx);
    const secrets = [KK.client, KK.secret, KK.refresh, KK.access];
    assertClean(JSON.stringify(result), secrets);
    assertClean(JSON.stringify(panel), secrets);
    assertClean(bag.logs.join('\n'), secrets);
    assert.strictEqual(panel.configured, true);
    assert.strictEqual(panel.lastOk, false);
    bag.plugin.destroy();
  });

  await test('refresh writes the new tokens back and leaves them out of the log', async () => {
    const expiry = Date.parse(NOW) + 3600 * 1000;
    let lists = 0;
    const yt = bootYouTube({
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2, 'SENTINEL-YT-REFRESH-2');
        if (url === YT_LIST_ACTIVE) {
          lists += 1;
          if (lists === 1) return jsonResponse(401, {});
          return jsonResponse(200, { items: [broadcast()] });
        }
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await yt.plugin.updateMetadata({ title: '新しい題名' }, {}), { ok: true });
    assert.strictEqual(yt.sets.length, 1);
    assert.strictEqual(yt.sets[0].name, 'youtube.oauth');
    assert.deepStrictEqual(JSON.parse(yt.sets[0].value), {
      access_token: YT.access2,
      client_id: YT.client,
      client_secret: YT.secret,
      expiry_date: expiry,
      refresh_token: 'SENTINEL-YT-REFRESH-2'
    });
    assertClean(yt.logs.join('\n'), [YT.access2, 'SENTINEL-YT-REFRESH-2', YT.secret]);
    yt.plugin.destroy();

    let users = 0;
    const tw = bootTwitch({
      secretExtra: { broadcaster_id: '9988' },
      fetch: async function fetch(url) {
        if (url === TW_TOKEN) return tokenResponse(TW.access2);
        if (url === TW_USERS) {
          users += 1;
          if (users === 1) return jsonResponse(401, {});
          return jsonResponse(200, { data: [{ id: '42' }] });
        }
        if (url.indexOf('/helix/channels') !== -1) return jsonResponse(204, '');
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await tw.plugin.updateMetadata({ title: '番組' }, {}), { ok: true });
    assert.strictEqual(tw.sets.length, 1);
    assert.strictEqual(tw.sets[0].name, 'twitch.oauth');
    assert.deepStrictEqual(JSON.parse(tw.sets[0].value), {
      access_token: TW.access2,
      broadcaster_id: '9988',
      client_id: TW.client,
      client_secret: TW.secret,
      expiry_date: expiry,
      refresh_token: TW.refresh
    });
    assertClean(tw.logs.join('\n'), [TW.access2, TW.secret, TW.refresh]);
    tw.plugin.destroy();

    let patches = 0;
    const rotated = 'SENTINEL-KK-REFRESH-2';
    const kk = bootKick({
      fetch: async function fetch(url) {
        if (url === KK_TOKEN) return tokenResponse(KK.access2, rotated);
        if (url.indexOf('/public/v1/categories') !== -1) {
          return jsonResponse(200, { data: [{ id: 101, name: 'Just Chatting' }] });
        }
        if (url === KK_CHANNELS) {
          patches += 1;
          if (patches === 1) return jsonResponse(401, {});
          return jsonResponse(204, '');
        }
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await kk.plugin.updateMetadata({ title: '番組', category: 'Just Chatting' }, {}), { ok: true });
    assert.strictEqual(kk.sets.length, 1);
    assert.strictEqual(kk.sets[0].name, 'kick.oauth');
    assert.deepStrictEqual(JSON.parse(kk.sets[0].value), {
      access_token: KK.access2,
      client_id: KK.client,
      client_secret: KK.secret,
      expiry_date: expiry,
      refresh_token: rotated
    });
    assert.strictEqual(JSON.parse(kk.sets[0].value).broadcaster_id, undefined);
    assertClean(kk.logs.join('\n'), [KK.access2, KK.secret, rotated]);
    kk.plugin.destroy();

    const failedRefresh = bootKick({
      fetch: async function fetch(url) {
        if (url === KK_TOKEN) return jsonResponse(400, { refresh_token: KK.refresh });
        if (url === KK_CHANNELS) return jsonResponse(401, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.strictEqual((await failedRefresh.plugin.updateMetadata({ title: '番組' }, {})).ok, false);
    assert.strictEqual(failedRefresh.sets.length, 0);
    failedRefresh.plugin.destroy();

    const thrown = bootYouTube({
      throwOnSet: true,
      secretExtra: { expiry_date: PAST },
      fetch: async function fetch(url) {
        if (url === YT_TOKEN) return tokenResponse(YT.access2);
        if (url === YT_LIST_ACTIVE) return jsonResponse(200, { items: [broadcast()] });
        if (url === YT_UPDATE) return jsonResponse(200, {});
        throw new Error('unexpected ' + url);
      }
    });
    assert.deepStrictEqual(await thrown.plugin.updateMetadata({ title: '新しい題名' }, {}), { ok: true });
    assert.strictEqual(thrown.sets.length, 1);
    assertClean(thrown.logs.join('\n'), [YT.access2, YT.secret, YT.refresh]);
    thrown.plugin.destroy();
  });

  await test('source does not read secret files or start a browser login', async () => {
    const files = [
      path.relative(ROOT, mainFileOf('site-youtube')),
      path.relative(ROOT, mainFileOf('site-twitch')),
      'plugins/sites/kick/site.js'
    ];
    for (let i = 0; i < files.length; i += 1) {
      const src = fs.readFileSync(path.join(ROOT, files[i]), 'utf8');
      assert.strictEqual(src.indexOf("require('fs')"), -1, files[i]);
      assert.strictEqual(src.indexOf('require("fs")'), -1, files[i]);
      assert.strictEqual(src.indexOf("require('googleapis')"), -1, files[i]);
      assert.strictEqual(src.indexOf('readFile'), -1, files[i]);
      assert.strictEqual(src.indexOf('writeFile'), -1, files[i]);
      assert.strictEqual(src.indexOf('createServer'), -1, files[i]);
      assert.strictEqual(src.indexOf('child_process'), -1, files[i]);
      assert.strictEqual(src.indexOf('token.json'), -1, files[i]);
      assert.strictEqual(src.indexOf('credentials.json'), -1, files[i]);
      assert.strictEqual(src.indexOf('twitch-config'), -1, files[i]);
      assert.strictEqual(src.indexOf('kick-config'), -1, files[i]);
      assert.strictEqual(src.indexOf('state'), -1, files[i]);
    }
    const panels = [
      path.relative(ROOT, panelFileOf('site-youtube')),
      path.relative(ROOT, panelFileOf('site-twitch')),
      'plugins/sites/kick/ui/panel.js'
    ];
    for (let i = 0; i < panels.length; i += 1) {
      const src = fs.readFileSync(path.join(ROOT, panels[i]), 'utf8');
      assert.strictEqual(src.indexOf('access_token'), -1, panels[i]);
      assert.strictEqual(src.indexOf('client_secret'), -1, panels[i]);
      assert.strictEqual(src.indexOf('refresh_token'), -1, panels[i]);
    }
  });

  await test('manifests are accepted and the plugins start', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w22-reg-'));
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'w22-plugins-'));
    try {
      const registry = createRegistry({
        appRoot: ROOT,
        core: { STATE_DIR: stateDir },
        logger: function logger() {}
      });
      const found = registry.discover().filter(function (rec) {
        return rec.id === 'site-youtube' || rec.id === 'site-twitch' || rec.id === 'site-kick';
      });
      assert.strictEqual(found.length, 3);
      const expect = {
        'site-youtube': ['youtube.oauth'],
        'site-twitch': ['twitch.oauth'],
        'site-kick': ['kick.oauth']
      };
      for (let i = 0; i < found.length; i += 1) {
        assert.strictEqual(found[i].status, 'accepted', found[i].id + ' ' + found[i].reason);
        assert.strictEqual(found[i].manifest.manifestVersion, 2);
        assert.strictEqual(found[i].manifest.runtime, 'inproc');
        assert.strictEqual(found[i].manifest.defaultMode, 'legacy');
        assert.deepStrictEqual(found[i].manifest.provides, ['stream.site@1', 'ui.panel@1']);
        assert.deepStrictEqual(found[i].manifest.secrets, expect[found[i].id]);
        assert.strictEqual(found[i].manifest.fanout, undefined);
      }
      for (const id of ['site-youtube', 'site-twitch', 'site-kick']) {
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
      // サイトの形のフォルダは、同じサイトの役目（sink など）もまとめて動かす。ここでは site- だけ数える。
      const running = started.getRunning().map(function (rec) { return rec.id; }).filter(function (id) { return /^site-/.test(id); }).sort();
      assert.deepStrictEqual(running, ['site-kick', 'site-twitch', 'site-youtube']);
      const health = await started.getRunning()[0].instance.health();
      assert.deepStrictEqual(health, { ok: false, detail: 'not-configured' });
    } finally {
      rimraf(stateDir);
      rimraf(isolated);
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
