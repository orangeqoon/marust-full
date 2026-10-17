'use strict';
const { requirePlugin } = require('../../../test/_plugins');

// L9b: サイトの困りごと（site.trouble）。ログイン切れの見分け（偽の返事だけ）・題名とコメントの合図・同じ物は 1 回だけ。
const assert = require('assert');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createFanout } = require('../lib/fanout');
const { createChatSend } = require('../../comment-send/lib/chat-send');
const { createSiteKukulu } = requirePlugin('site-kukulu');
const { createSitePicarto } = requirePlugin('site-picarto');
const { createSiteRumble } = requirePlugin('site-rumble');
const { createSiteSoop } = requirePlugin('site-soop');
const { createSiteFc2 } = requirePlugin('site-fc2');
const { createSiteTwitcasting } = requirePlugin('site-twitcasting');
const { createHomeState } = require('../../../host/layer1/home-state');
const { createEventBus } = require('../../../host/core/event-bus');
const STR = require('../../../plugins/ui-standard/shell/strings');

const NOW = new Date('2026-10-14T03:00:00.000Z');
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

function res(status, body, extra) {
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
  return Object.assign({ status: status, url: '', async text() { return text; } }, extra || {});
}

function ctxFor(secrets) {
  const bag = secrets || {};
  return {
    id: 'site',
    mode() { return 'live'; },
    logger() {},
    secrets: {
      async get(name) {
        if (!Object.prototype.hasOwnProperty.call(bag, name)) return { ok: false, error: 'unavailable' };
        const v = bag[name];
        return { ok: true, value: typeof v === 'string' ? v : JSON.stringify(v) };
      }
    }
  };
}

function boot(create, secrets, fetchImpl) {
  const site = create({ fetch: async (url, init) => fetchImpl(new URL(url), init || {}), now: () => NOW });
  site.load(ctxFor(secrets));
  return site;
}

async function main() {
  await test('kukulu: 401 / 403 はログイン切れ（unauthorized）。500 はただの http', async () => {
    for (const status of [401, 403]) {
      const site = boot(createSiteKukulu, { 'kukulu.config': { apikey: 'abc123' } }, () => res(status, ''));
      assert.deepStrictEqual(await site.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    }
    const site = boot(createSiteKukulu, { 'kukulu.config': { apikey: 'abc123' } }, () => res(500, ''));
    assert.deepStrictEqual(await site.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'http' });
  });

  await test('picarto: 401 / 403 はログイン切れ（unauthorized）。500 はただの http', async () => {
    for (const status of [401, 403]) {
      const site = boot(createSitePicarto, { 'picarto.config': { token: 'tok-abc' } }, () => res(status, ''));
      assert.deepStrictEqual(await site.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    }
    const site = boot(createSitePicarto, { 'picarto.config': { token: 'tok-abc' } }, () => res(500, ''));
    assert.deepStrictEqual(await site.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'http' });
  });

  await test('twitcasting: 401 はログイン切れ（unauthorized）。500 はただの http', async () => {
    const secrets = {
      'cookies.twitcasting-main': JSON.stringify({ tc_ss: 'c', tc_token: 't' }),
      'twitcasting.config': JSON.stringify({ access_token: 'a', client_secret: 's' }),
      'capture.twitcasting-main.page': JSON.stringify({ csrf_token: 'x', user_id: 'u', page_url: 'https://twitcasting.tv/u' })
    };
    const bad = boot(createSiteTwitcasting, secrets, () => res(401, ''));
    assert.deepStrictEqual(await bad.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    const ng = boot(createSiteTwitcasting, secrets, () => res(500, ''));
    assert.deepStrictEqual(await ng.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'http' });
  });

  await test('fc2: 403 とログイン画面への転送はログイン切れ。ほかの転送は redirect のまま', async () => {
    const secrets = {
      'cookies.fc2-main': JSON.stringify({ PHPSESSID: 'c' }),
      'fc2.config': JSON.stringify({ channel_id: '555' }),
      'capture.fc2-main.page': JSON.stringify({ page_url: 'https://live.fc2.com/777/' }),
      'capture.fc2-main.fc2-http': JSON.stringify({ body: 'streamid=666&title=old' })
    };
    const forbidden = boot(createSiteFc2, secrets, () => res(403, ''));
    assert.deepStrictEqual(await forbidden.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    const login = boot(createSiteFc2, secrets, () => res(302, '', { headers: { location: 'https://secure.id.fc2.com/?login=1' } }));
    assert.deepStrictEqual(await login.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    const other = boot(createSiteFc2, secrets, () => res(302, '', { headers: { location: 'https://live.fc2.com/other/' } }));
    assert.deepStrictEqual(await other.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'redirect' });
    const server = boot(createSiteFc2, secrets, () => res(500, ''));
    assert.deepStrictEqual(await server.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'http' });
  });

  await test('rumble: 見つけに行く所がログイン画面へ転送・401 ならログイン切れ。保存の 403 もログイン切れ', async () => {
    const secrets = { 'cookies.rumble-main': { u_s: 'c' } };
    const login = boot(createSiteRumble, secrets, () => res(302, '', { headers: { location: 'https://rumble.com/login.php' } }));
    assert.deepStrictEqual(await login.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    const plain = boot(createSiteRumble, secrets, () => res(302, '', { headers: { location: 'https://rumble.com/elsewhere' } }));
    assert.deepStrictEqual(await plain.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'redirect' });
    const html = '<script>Account("AccountContent", "deadbeefcafebabe")</script><div class="info-video" id="8_450050654_7drsdk_item"></div>';
    const save403 = boot(createSiteRumble, secrets, (url, init) => {
      if (url.pathname.indexOf('/account/live-streaming') !== -1) return res(200, html);
      if (url.search.indexOf('a=edit') !== -1 && !(init && init.body)) return res(200, '<form></form>');
      return res(403, '');
    });
    assert.deepStrictEqual(await save403.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
  });

  await test('soop: 401・ログイン画面への転送はログイン切れ。500 はただの http', async () => {
    const secrets = {
      'cookies.soop-main': { u_s: 'c' },
      'capture.soop-main.soop-save': { url: 'https://api-broadcast.sooplive.com/broad/setting', method: 'POST', body: { title: 'old' }, headers: {} }
    };
    const a = boot(createSiteSoop, secrets, () => res(401, ''));
    assert.deepStrictEqual(await a.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    const b = boot(createSiteSoop, secrets, () => res(302, '', { headers: { location: 'https://login.sooplive.com/' } }));
    assert.deepStrictEqual(await b.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'unauthorized' });
    const c = boot(createSiteSoop, secrets, () => res(500, ''));
    assert.deepStrictEqual(await c.updateMetadata({ title: 'T' }, {}), { ok: false, error: 'http' });
  });

  function peersFor(table) {
    return {
      list() {
        return Object.keys(table).map((id) => ({ id: id, mode: table[id].mode || 'live', manifestVersion: 2, provides: ['stream.site@1'], fanout: null }));
      },
      async run(id, method, args) {
        if (method === 'isConfigured') return { result: 'ok', value: true, elapsedMs: 0 };
        const out = table[id].next();
        return { result: 'ok', value: out, elapsedMs: 0 };
      }
    };
  }

  await test('題名の一斉送信: ログイン切れは site.trouble（job title）を同じサイトで 1 回だけ。切れたサイトだけ失敗で、ほかには送る。送れたら次の切れでまた 1 回', async () => {
    const published = [];
    const twitchReplies = [{ ok: false, error: 'unauthorized' }, { ok: false, error: 'unauthorized' }, { ok: true }, { ok: false, error: 'unauthorized' }];
    const sent = [];
    const peers = peersFor({
      'site-twitch': { next: () => twitchReplies.shift() },
      'site-kukulu': { next: () => { sent.push('kukulu'); return { ok: true }; } },
      'site-picarto': { next: () => ({ ok: false, error: 'http' }) }
    });
    const fan = createFanout({ peers: peers, bus: { publish(name, payload) { published.push([name, payload]); return 1; } } });
    const rows1 = await fan.fanout({ title: 'T', category: '' });
    assert.deepStrictEqual(rows1.map((r) => [r.id, r.result, r.message]), [
      ['site-twitch', 'error', 'unauthorized'], ['site-kukulu', 'ok', ''], ['site-picarto', 'error', 'http']
    ]);
    assert.deepStrictEqual(sent, ['kukulu'], '切れたサイトのほかへは送る');
    await fan.fanout({ title: 'T', category: '' });
    const troubles = () => published.filter((p) => p[0] === 'site.trouble');
    assert.strictEqual(troubles().length, 1, '直るまで 1 回だけ');
    assert.deepStrictEqual([troubles()[0][1].site, troubles()[0][1].job, troubles()[0][1].kind], ['twitch', 'title', 'login-expired']);
    await fan.fanout({ title: 'T', category: '' }); // 送れた
    await fan.fanout({ title: 'T', category: '' }); // また切れた
    assert.strictEqual(troubles().length, 2);
  });

  await test('題名の一斉送信: shadow・dryRun では site.trouble を出さない。一時的な失敗（http・network）でも出さない', async () => {
    const published = [];
    const peers = peersFor({
      'site-twitch': { mode: 'shadow', next: () => ({ ok: false, error: 'unauthorized' }) },
      'site-kukulu': { next: () => ({ ok: false, error: 'network' }) },
      'site-picarto': { next: () => ({ ok: false, error: 'http-503' }) }
    });
    const fan = createFanout({ peers: peers, bus: { publish(name, payload) { published.push(name); return 1; } } });
    await fan.fanout({ title: 'T', category: '' });
    await fan.fanout({ title: 'T', category: '', dryRun: true });
    assert.deepStrictEqual(published.filter((n) => n === 'site.trouble'), []);
  });

  await test('コメント送信: ログイン切れは site.trouble（job comment）を 1 回だけ。ほかのサイトには送る', async () => {
    const published = [];
    const replies = { twitch: [{ ok: false, error: 'unauthorized' }, { ok: false, error: 'unauthorized' }], youtube: [{ ok: true }, { ok: true }] };
    const peers = {
      list() { return ['twitch', 'youtube'].map((s) => ({ id: 'sink-' + s, mode: 'live', provides: ['chat.sink@1'] })); },
      async run(id) { return { result: 'ok', value: replies[id.replace('sink-', '')].shift(), elapsedMs: 0 }; }
    };
    const sender = createChatSend({ peers: peers, bus: { publish(name, payload) { published.push([name, payload]); return 1; } } });
    const first = await sender.send({ text: 'hi', sites: ['twitch', 'youtube'] }, {});
    assert.deepStrictEqual(first.results.map((r) => [r.site, r.ok, r.error]), [['twitch', false, 'unauthorized'], ['youtube', true, undefined]]);
    await sender.send({ text: 'hi', sites: ['twitch', 'youtube'] }, {});
    const troubles = published.filter((p) => p[0] === 'site.trouble');
    assert.strictEqual(troubles.length, 1);
    assert.deepStrictEqual([troubles[0][1].site, troubles[0][1].job, troubles[0][1].kind], ['twitch', 'comment', 'login-expired']);
  });

  await test('ホームの控えと文言: job・kind を持ち、文は「サイト: 仕事で種類」の形', async () => {
    const bus = createEventBus();
    const st = createHomeState({ bus, now: () => NOW });
    bus.publish('site.trouble', { site: 'twitch', job: 'title', kind: 'login-expired', code: 'login-expired' }, {});
    bus.publish('site.trouble', { site: 'twitch', job: 'weird', kind: 'weird' }, {});
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(st.getState().alert, { site: 'twitch', job: 'slot', kind: 'failed', code: 'failed', at: NOW.toISOString() }, '知らない値は丸める');
    bus.publish('site.trouble', { site: 'twitch', job: 'title', kind: 'login-expired', code: 'login-expired' }, {});
    await new Promise((r) => setTimeout(r, 30));
    const alert = st.getState().alert;
    assert.deepStrictEqual([alert.job, alert.kind], ['title', 'login-expired']);
    st.stop();
    {
      const text = STR.homeAlert('Twitch', alert);
      assert.strictEqual(text, 'Twitch: 題名の送信でログインが切れています。ログインし直してください');
    }
  });

  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
