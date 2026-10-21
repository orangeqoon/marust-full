'use strict';
const { requirePlugin } = require('../../../test/_plugins');

// N1: サイトのプラグインの loginNeeds（足りない物を種類だけで答える）と、一斉送信の skip 行への need / how。
const assert = require('assert');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const { createFanout } = require('../lib/fanout');
const { createSiteFc2 } = requirePlugin('site-fc2');
const { createSitePicarto } = requirePlugin('site-picarto');
const { createSiteKukulu } = requirePlugin('site-kukulu');
const { createSiteRumble } = requirePlugin('site-rumble');
const { createSiteSoop } = requirePlugin('site-soop');
const { createSiteTwitcasting } = requirePlugin('site-twitcasting');
const { createSiteNiconico } = requirePlugin('site-niconico');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function boot(create, secrets) {
  const bag = secrets || {};
  const site = create({ fetch: async () => { throw new Error('no network'); }, now: () => new Date('2026-10-18T00:00:00Z') });
  site.load({
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
  });
  return site;
}

async function check(site, expected) {
  const n = await site.loginNeeds();
  assert.deepStrictEqual(n, expected);
  assert.strictEqual(await site.isConfigured(), expected.ready, 'isConfigured は ready と同じ');
  assert.ok(!JSON.stringify(n).includes('SECRETVALUE'));
}

(async () => {
  await test('FC2: Cookie なし -> cookies、Cookie だけ -> channel、両方 -> ready', async () => {
    const ext = 'extension';
    await check(boot(createSiteFc2, {}), { ready: false, need: 'cookies', how: ext });
    await check(boot(createSiteFc2, { 'cookies.fc2-main': { cookies: { fc2_a: 'SECRETVALUE' } } }), { ready: false, need: 'channel', how: ext });
    await check(boot(createSiteFc2, { 'cookies.fc2-main': { cookies: { fc2_a: 'SECRETVALUE' } }, 'fc2.config': { channel_id: '12345678' } }), { ready: true, need: null, how: ext });
  });
  await test('Picarto: トークンなし -> token / paste、あり -> ready', async () => {
    await check(boot(createSitePicarto, {}), { ready: false, need: 'token', how: 'paste' });
    await check(boot(createSitePicarto, { 'picarto.config': { token: 'SECRETVALUE' } }), { ready: true, need: null, how: 'paste' });
  });
  await test('くくる: apikey なし -> config、あり -> ready', async () => {
    await check(boot(createSiteKukulu, {}), { ready: false, need: 'config', how: 'paste' });
    await check(boot(createSiteKukulu, { 'kukulu.config': { apikey: 'SECRETVALUE' } }), { ready: true, need: null, how: 'paste' });
  });
  await test('Rumble: Cookie なし -> cookies、あり -> ready', async () => {
    await check(boot(createSiteRumble, {}), { ready: false, need: 'cookies', how: 'extension' });
    await check(boot(createSiteRumble, { 'cookies.rumble-main': { u_s: 'SECRETVALUE' } }), { ready: true, need: null, how: 'extension' });
  });
  await test('SOOP: Cookie なし -> cookies、Cookie だけ -> config、両方 -> ready', async () => {
    const cookie = { 'cookies.soop-main': { PdboxTicket: 'SECRETVALUE' } };
    await check(boot(createSiteSoop, {}), { ready: false, need: 'cookies', how: 'extension' });
    await check(boot(createSiteSoop, cookie), { ready: false, need: 'config', how: 'extension' });
    const both = Object.assign({ 'capture.soop-main.soop-save': { url: 'https://api-broadcast.sooplive.com/broad/setting', method: 'POST', body: { title: 'old' }, headers: {} } }, cookie);
    await check(boot(createSiteSoop, both), { ready: true, need: null, how: 'extension' });
  });
  await test('TwitCasting: Cookie なし -> cookies、Cookie だけ -> token、両方 -> ready', async () => {
    const cookie = { 'cookies.twitcasting-main': { tc_ss: 'SECRETVALUE' } };
    await check(boot(createSiteTwitcasting, {}), { ready: false, need: 'cookies', how: 'extension' });
    await check(boot(createSiteTwitcasting, cookie), { ready: false, need: 'token', how: 'paste' });
    await check(boot(createSiteTwitcasting, Object.assign({ 'twitcasting.config': { access_token: 'SECRETVALUE' } }, cookie)), { ready: true, need: null, how: 'extension' });
  });
  await test('ニコニコ: user_session なし -> cookies、あり -> ready', async () => {
    await check(boot(createSiteNiconico, {}), { ready: false, need: 'cookies', how: 'extension' });
    await check(boot(createSiteNiconico, { 'cookies.niconico-main': { user_session: 'user_session_123456_abcdef0123456789' } }), { ready: true, need: null, how: 'extension' });
  });

  function peersFor(table) {
    return {
      list() { return Object.keys(table).map((id) => ({ id: id, mode: 'live', manifestVersion: 2, provides: ['stream.site@1'], fanout: null })); },
      async run(id, method) { return table[id](method); }
    };
  }
  await test('一斉送信: not-configured の行に need / how が付く。message は not-configured のまま', async () => {
    const calls = [];
    const peers = peersFor({
      'site-fc2': (m) => { calls.push(m); return m === 'isConfigured' ? { result: 'ok', value: false } : { result: 'ok', value: { ready: false, need: 'channel', how: 'extension' } }; },
      'site-ok': (m) => { calls.push('ok:' + m); return m === 'isConfigured' ? { result: 'ok', value: true } : { result: 'ok', value: { ok: true } }; }
    });
    const rows = await createFanout({ peers: peers }).fanout({ title: 'T', category: '' });
    const fc2 = rows.find((r) => r.id === 'site-fc2');
    assert.deepStrictEqual([fc2.result, fc2.message, fc2.need, fc2.how], ['skip', 'not-configured', 'channel', 'extension']);
    assert.ok(!calls.includes('ok:loginNeeds'), 'ready のサイトには聞かない');
  });
  await test('一斉送信: loginNeeds が無い・timeout・形が悪いなら need を付けない。従来どおり', async () => {
    const answers = [
      { result: 'error', message: 'unknown-method' },
      { result: 'timeout' },
      { result: 'ok', value: { need: 'Bad Value!', how: 'paste' } },
      { result: 'ok', value: 'cookies' },
      { result: 'ok', value: { need: 'cookies', how: 'x'.repeat(41) } }
    ];
    for (const a of answers) {
      const peers = peersFor({ 'site-x': (m) => (m === 'isConfigured' ? { result: 'ok', value: false } : a) });
      const [row] = await createFanout({ peers: peers }).fanout({ title: 'T', category: '' });
      assert.deepStrictEqual(row, { id: 'site-x', result: 'skip', elapsedMs: 0, message: 'not-configured', mode: 'live' });
    }
    const peers = peersFor({ 'site-x': (m) => (m === 'isConfigured' ? { result: 'timeout' } : (() => { throw new Error('ask'); })()) });
    const [row] = await createFanout({ peers: peers }).fanout({ title: 'T', category: '' });
    assert.strictEqual(row.message, 'not-configured-timeout');
    assert.strictEqual(row.need, undefined);
  });

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('n1 login-needs: ok');
})().catch((e) => { console.error(e); process.exit(1); });
