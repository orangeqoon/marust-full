'use strict';

// Twitch の OAuth の共通部品（plugins/sites/twitch/lib/oauth.js）。
// 2 つの役目（site・sink）が続けて refresh しても、2 つ目は 1 つ目の新しい token を使い、古い refresh token を送らない。
const { requirePlugin } = require('../../../../test/_plugins');
const assert = require('assert');
const oauth = require('../lib/oauth');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const siteApi = requirePlugin('site-twitch');
const sinkApi = requirePlugin('sink-twitch');
const ytSiteApi = requirePlugin('site-youtube');

const NOW = Date.parse('2026-10-04T03:00:00.000Z');
const LATER = Date.parse('2026-10-04T05:00:00.000Z');
const PAST = Date.parse('2026-10-04T01:00:00.000Z');
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const USERS = 'https://api.twitch.tv/helix/users';

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
function json(status, body) {
  const text = JSON.stringify(body == null ? {} : body);
  return { ok: status >= 200 && status < 300, status: status, async text() { return text; } };
}

// 金庫の代わり。get の n 回目に返す値を差し替えられる（別の役目が先に更新した状況を作る）。
function makeVault(initial) {
  const vault = { value: initial, gets: 0, sets: [], onGet: null };
  vault.ctx = function ctx(id, mode) {
    return {
      id: id,
      mode: function () { return mode || 'live'; },
      logger: function () {},
      secrets: {
        get: function (name) {
          assert.ok(name === 'twitch.oauth' || name === 'youtube.oauth', name);
          vault.gets += 1;
          if (vault.onGet) vault.onGet(vault.gets);
          return Promise.resolve({ ok: true, value: JSON.stringify(vault.value) });
        },
        set: function (name, value) {
          vault.sets.push(JSON.parse(value));
          vault.value = JSON.parse(value);
          return Promise.resolve({ ok: true });
        }
      }
    };
  };
  return vault;
}

function secret(extra) {
  return Object.assign({ client_id: 'CID-AAAAAAAA', client_secret: 'CSEC-AAAAAAAA', refresh_token: 'REFRESH-0000', access_token: 'ACCESS-0000', expiry_date: PAST }, extra || {});
}

function makeFetch(log, tokenHandler) {
  return async function (url, init) {
    const u = String(url);
    log.push({ url: u, init: init || {} });
    if (u === TOKEN_URL) return tokenHandler(new URLSearchParams(String(init.body)));
    if (u === USERS) return json(200, { data: [{ id: '123' }] });
    return json(204, {});
  };
}

const now = function () { return new Date(NOW); };

(async () => {
  await test('lib/oauth: needsRefresh・refreshBody・applyRefresh・vaultBody', () => {
    assert.strictEqual(oauth.needsRefresh({ access_token: 'A', expiry_date: LATER }, NOW), false);
    assert.strictEqual(oauth.needsRefresh({ access_token: 'A', expiry_date: PAST }, NOW), true);
    assert.strictEqual(oauth.needsRefresh({ access_token: '' }, NOW), true);
    const mem = { refresh_token: 'R0', client_id: 'C', client_secret: 'S' };
    assert.ok(oauth.refreshBody(mem).includes('grant_type=refresh_token'));
    const fresh = oauth.applyRefresh(mem, { access_token: 'A1', refresh_token: 'R1', expires_in: 100 }, NOW);
    assert.deepStrictEqual(fresh, ['A1', 'R1']);
    assert.strictEqual(mem.refresh_token, 'R1');
    assert.strictEqual(mem.expiry_date, NOW + 100000);
    assert.strictEqual(oauth.applyRefresh(mem, { nothing: 1 }, NOW), null);
    const body = JSON.parse(oauth.vaultBody(mem));
    assert.deepStrictEqual(Object.keys(body), Object.keys(body).slice().sort());
  });

  await test('2 つの役目が続けて refresh しても、2 つ目は 1 つ目の新しい token を使う（token エンドポイントは 1 回）', async () => {
    const vault = makeVault(secret());
    const tokenCalls = [];
    const siteLog = [];
    const sinkLog = [];
    const tokenHandler = async (body) => {
      tokenCalls.push(body.get('refresh_token'));
      if (body.get('refresh_token') !== 'REFRESH-0000') return json(400, { message: 'invalid refresh token' });
      return json(200, { access_token: 'ACCESS-1111', refresh_token: 'REFRESH-1111', expires_in: 3600 });
    };
    const site = siteApi.createSiteTwitch({ fetch: makeFetch(siteLog, tokenHandler), now: now });
    const sink = sinkApi.createSinkTwitch({ fetch: makeFetch(sinkLog, tokenHandler), now: now, sleep: async () => {} });
    site.load(vault.ctx('site-twitch'));
    sink.load(vault.ctx('sink-twitch'));
    // sink が先に（古い金庫の中身を）読み、そのあと site が refresh して金庫を更新する。
    // 順番: sink.load 後に site が 1 回 refresh → 金庫は ACCESS-1111 / REFRESH-1111。
    assert.deepStrictEqual(await site.updateMetadata({ title: 'x' }, {}), { ok: true });
    assert.strictEqual(vault.value.refresh_token, 'REFRESH-1111');
    assert.deepStrictEqual(await sink.sendComment({ text: 'hi' }, {}), { ok: true });
    assert.deepStrictEqual(tokenCalls, ['REFRESH-0000']);
    const auth = sinkLog.filter((c) => c.url === USERS)[0].init.headers.Authorization;
    assert.strictEqual(auth, 'Bearer ACCESS-1111');
  });

  await test('sink が refresh する直前に別の役目が金庫を更新していたら、再 refresh せずその token を使う', async () => {
    const vault = makeVault(secret());
    const tokenCalls = [];
    const sinkLog = [];
    const tokenHandler = async (body) => {
      tokenCalls.push(body.get('refresh_token'));
      return json(400, { message: 'refresh token already used' });
    };
    // 1 回目の読み（adopt 用）は古い中身。2 回目（refresh の直前）には、別の役目が更新した中身に変わっている。
    vault.onGet = (n) => {
      if (n === 2) vault.value = secret({ access_token: 'ACCESS-2222', refresh_token: 'REFRESH-2222', expiry_date: LATER });
    };
    const sink = sinkApi.createSinkTwitch({ fetch: makeFetch(sinkLog, tokenHandler), now: now, sleep: async () => {} });
    sink.load(vault.ctx('sink-twitch'));
    assert.deepStrictEqual(await sink.sendComment({ text: 'hi' }, {}), { ok: true });
    assert.deepStrictEqual(tokenCalls, [], 'token endpoint is not called');
    assert.ok(vault.gets >= 2);
    assert.strictEqual(sinkLog.filter((c) => c.url === USERS)[0].init.headers.Authorization, 'Bearer ACCESS-2222');
  });

  await test('金庫の refresh token が入れ替わっていたら、古い方を送らず金庫の新しい方を送る', async () => {
    const vault = makeVault(secret());
    const tokenCalls = [];
    const log = [];
    // 2 回目の読みで、access は同じ（期限切れのまま）だが refresh token だけ別の役目に入れ替えられている。
    vault.onGet = (n) => {
      if (n === 2) vault.value = secret({ refresh_token: 'REFRESH-3333' });
    };
    const tokenHandler = async (body) => {
      tokenCalls.push(body.get('refresh_token'));
      return json(200, { access_token: 'ACCESS-3333', refresh_token: 'REFRESH-4444', expires_in: 3600 });
    };
    const site = siteApi.createSiteTwitch({ fetch: makeFetch(log, tokenHandler), now: now });
    site.load(vault.ctx('site-twitch'));
    assert.deepStrictEqual(await site.updateMetadata({ title: 'x' }, {}), { ok: true });
    assert.deepStrictEqual(tokenCalls, ['REFRESH-3333']);
    assert.strictEqual(vault.value.refresh_token, 'REFRESH-4444');
  });

  await test('書き戻しに失敗しても古い token に戻らない（金庫は古いまま・次の操作は新しい token と新しい refresh token を使う）', async () => {
    const vault = makeVault(secret());
    vault.ctxFailing = function (id) {
      const c = vault.ctx(id);
      c.secrets.set = function () { return Promise.reject(new Error('disk full')); };
      return c;
    };
    const tokenCalls = [];
    const log = [];
    let n = 0;
    const tokenHandler = async (body) => {
      tokenCalls.push(body.get('refresh_token'));
      n += 1;
      return json(200, { access_token: 'ACCESS-' + n + n + n + n, refresh_token: 'REFRESH-' + n + n + n + n, expires_in: 1 });
    };
    // expires_in: 1 秒 → 次の操作でまた期限切れ扱いになり、refresh する
    const site = siteApi.createSiteTwitch({ fetch: makeFetch(log, tokenHandler), now: now });
    site.load(vault.ctxFailing('site-twitch'));
    assert.deepStrictEqual(await site.updateMetadata({ title: 'x' }, {}), { ok: true });
    assert.strictEqual(vault.value.refresh_token, 'REFRESH-0000', '金庫は古いまま');
    assert.deepStrictEqual(await site.updateMetadata({ title: 'y' }, {}), { ok: true });
    assert.deepStrictEqual(tokenCalls, ['REFRESH-0000', 'REFRESH-1111'], '2 回目の refresh は 1 回目の新しい refresh token を送る（古い方に戻らない）');
  });

  await test('YouTube も同じ: 書き戻しに失敗しても古い token に戻らない', async () => {
    const vault = makeVault(secret());
    const c = vault.ctx('site-youtube');
    c.secrets.set = function () { return Promise.reject(new Error('disk full')); };
    const tokenCalls = [];
    let n = 0;
    const log = [];
    const site = ytSiteApi.createSiteYoutube({
      fetch: async (url, init) => {
        log.push({ url: String(url), init: init || {} });
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          const body = new URLSearchParams(String(init.body));
          tokenCalls.push(body.get('refresh_token'));
          n += 1;
          return json(200, { access_token: 'ACCESS-' + n + n + n + n, refresh_token: 'REFRESH-' + n + n + n + n, expires_in: 1 });
        }
        return json(200, { items: [] });
      },
      now: now
    });
    site.load(c);
    await site.updateMetadata({ title: 'x' }, {});
    await site.updateMetadata({ title: 'y' }, {});
    assert.deepStrictEqual(tokenCalls, ['REFRESH-0000', 'REFRESH-1111']);
    assert.strictEqual(vault.value.refresh_token, 'REFRESH-0000');
  });

  await test('refresh の失敗の文に token は出ない', async () => {
    const vault = makeVault(secret());
    const site = siteApi.createSiteTwitch({
      fetch: makeFetch([], async () => json(400, { message: 'REFRESH-0000 is bad' })),
      now: now
    });
    site.load(vault.ctx('site-twitch'));
    const res = await site.updateMetadata({ title: 'x' }, {});
    assert.deepStrictEqual(res, { ok: false, error: 'refresh-failed' });
    assert.ok(!JSON.stringify(res).includes('REFRESH-0000'));
  });

  await test('YouTube: refresh の直前に金庫が更新されていたら、再 refresh せずその token を使う', async () => {
    const vault = makeVault(secret());
    vault.onGet = (n) => {
      if (n === 2) vault.value = secret({ access_token: 'ACCESS-5555', refresh_token: 'REFRESH-5555', expiry_date: LATER });
    };
    const log = [];
    const site = ytSiteApi.createSiteYoutube({
      fetch: async (url, init) => {
        log.push({ url: String(url), init: init || {} });
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) return json(400, {});
        return json(200, { items: [] });
      },
      now: now
    });
    site.load(vault.ctx('site-youtube'));
    const yres = await site.updateMetadata({ title: 'x' }, {});
    assert.ok(log.length > 0, JSON.stringify(yres) + ' gets=' + vault.gets);
    assert.strictEqual(log.filter((c) => c.url.startsWith('https://oauth2.googleapis.com/token')).length, 0);
    assert.strictEqual(log[0].init.headers.Authorization, 'Bearer ACCESS-5555');
  });

  if (failed) process.exit(1);
})();
