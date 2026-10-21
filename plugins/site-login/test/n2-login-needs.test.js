'use strict';

// N2: sites.loginStatus が need / how を返し、Cookie があっても足りない物があれば incomplete。拡張のペアリング有無だけを出す。
const assert = require('assert');
const { createSiteLogin } = require('../lib/login');
const { createSiteConfig } = require('../../../host/layer1/site-config');

let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function facts(sites, paired) {
  const out = { ok: true, sites: sites };
  if (paired !== undefined) out.extension = { paired: paired };
  return out;
}

function login(sites, answers, oauthDocs, paired) {
  return createSiteLogin({
    loginFacts: async () => facts(sites, paired),
    secrets: { get: async (name) => (oauthDocs && oauthDocs[name] ? { ok: true, value: JSON.stringify(oauthDocs[name]) } : { ok: false, error: 'not-found' }) },
    needs: async (id) => (answers && Object.prototype.hasOwnProperty.call(answers, id) ? answers[id] : null),
    now: () => Date.parse('2026-10-18T00:00:00Z')
  });
}

const row = (res, id) => res.sites.find((s) => s.id === id);

test('cookie 型: present でもプラグインが ready でなければ incomplete。need / how が付く', async () => {
  const l = login([{ id: 'fc2', type: 'cookie', present: true }], { fc2: { ready: false, need: 'channel', how: 'extension' } });
  const r = row(await l.status(), 'fc2');
  assert.deepStrictEqual([r.state, r.need, r.how], ['incomplete', 'channel', 'extension']);
});

test('cookie 型: ready なら logged-in。Cookie が無ければ none のまま need を言う', async () => {
  const l = login([
    { id: 'rumble', type: 'cookie', present: true },
    { id: 'soop', type: 'cookie', present: false }
  ], { rumble: { ready: true, need: null, how: 'extension' }, soop: { ready: false, need: 'cookies', how: 'extension' } });
  const res = await l.status();
  assert.deepStrictEqual([row(res, 'rumble').state, row(res, 'rumble').need], ['logged-in', null]);
  assert.deepStrictEqual([row(res, 'soop').state, row(res, 'soop').need, row(res, 'soop').how], ['none', 'cookies', 'extension']);
});

test('config 型 (Picarto): present でもトークンが読めなければ incomplete / token / paste', async () => {
  const l = login([{ id: 'picarto', type: 'config', present: true }], { picarto: { ready: false, need: 'token', how: 'paste' } });
  const r = row(await l.status(), 'picarto');
  assert.deepStrictEqual([r.state, r.need, r.how], ['incomplete', 'token', 'paste']);
});

test('loginNeeds が答えられない・形が悪い・送信オフ(mode) のときは従来どおり（present なら logged-in）', async () => {
  const l = login([
    { id: 'a', type: 'cookie', present: true },
    { id: 'b', type: 'cookie', present: true },
    { id: 'c', type: 'cookie', present: true },
    { id: 'd', type: 'cookie', present: false }
  ], { b: { ready: false, need: 'Bad Value', how: 'x' }, c: { ready: false, need: 'mode', how: 'toggle' } });
  const res = await l.status();
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((id) => row(res, id).state), ['logged-in', 'logged-in', 'logged-in', 'none']);
});

test('OAuth 型: none -> client-keys/keys、keys-only と expired -> login/oauth、logged-in -> need null', async () => {
  const sites = [
    { id: 'youtube', type: 'oauth', oauthName: 'youtube.oauth', present: false },
    { id: 'twitch', type: 'oauth', oauthName: 'twitch.oauth', present: true },
    { id: 'kick', type: 'oauth', oauthName: 'kick.oauth', present: true }
  ];
  const docs = { 'twitch.oauth': { client_id: 'x', client_secret: 'y' }, 'kick.oauth': { refresh_token: 'r' } };
  const res = await login(sites, {}, docs).status();
  assert.deepStrictEqual([row(res, 'youtube').state, row(res, 'youtube').need, row(res, 'youtube').how], ['none', 'client-keys', 'keys']);
  assert.deepStrictEqual([row(res, 'twitch').state, row(res, 'twitch').need, row(res, 'twitch').how], ['keys-only', 'login', 'oauth']);
  assert.deepStrictEqual([row(res, 'kick').state, row(res, 'kick').need], ['logged-in', null]);
  const expired = await login([sites[1]], {}, { 'twitch.oauth': { access_token: 'a', expiry_date: 1000 } }).status();
  assert.deepStrictEqual([row(expired, 'twitch').state, row(expired, 'twitch').need, row(expired, 'twitch').how], ['expired', 'login', 'oauth']);
});

test('答えのトップに extension.paired。値は出さない', async () => {
  assert.deepStrictEqual((await login([], {}, {}, true).status()).extension, { paired: true });
  assert.deepStrictEqual((await login([], {}, {}, false).status()).extension, { paired: false });
  assert.deepStrictEqual((await login([], {}, {}).status()).extension, { paired: false });
});

test('核の loginFacts: 端末の一覧に extension が 1 つでもあれば paired（名前・ID は出さない）', async () => {
  const make = (list) => createSiteConfig({
    secrets: { list: async () => ({ ok: true, secrets: [] }) },
    getSites: async () => [],
    extensionPaired: () => list.some((c) => c && c.kind === 'extension')
  });
  assert.deepStrictEqual((await make([{ kind: 'browser' }, { kind: 'extension', name: 'SECRETNAME' }]).loginFacts()).extension, { paired: true });
  assert.deepStrictEqual((await make([{ kind: 'browser' }]).loginFacts()).extension, { paired: false });
  const bare = await createSiteConfig({ secrets: { list: async () => ({ ok: true, secrets: [] }) }, getSites: async () => [] }).loginFacts();
  assert.deepStrictEqual(bare.extension, { paired: false });
  assert.ok(!JSON.stringify(await make([{ kind: 'extension', name: 'SECRETNAME' }]).loginFacts()).includes('SECRETNAME'));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('ok ' + name); } catch (err) {
      failed += 1;
      console.error('FAIL ' + name);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  if (failed) process.exit(1);
  console.log('n2 login-needs: ok');
})();
