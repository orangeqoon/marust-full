'use strict';
// N3/N4: サイトのログイン一覧の中身（DOM を使わない部品）と文言。値は出ない。
const assert = require('assert');
const path = require('path');
const STR = require('../shell/strings');
const { buildLoginList, reloginSites } = require(path.join('..', 'shell', 'core', 'login-list.js'));

const names = { fc2: 'FC2', picarto: 'Picarto', twitcasting: 'ツイキャス', youtube: 'YouTube', rumble: 'Rumble' };
const rows = [
  { id: 'fc2', state: 'incomplete', need: 'channel', how: 'extension' },
  { id: 'picarto', state: 'incomplete', need: 'token', how: 'paste' },
  { id: 'twitcasting', state: 'incomplete', need: 'token', how: 'paste' },
  { id: 'youtube', state: 'none', need: 'client-keys', how: 'keys' },
  { id: 'twitch', state: 'expired', need: 'login', how: 'oauth' },
  { id: 'rumble', state: 'logged-in', need: null, how: 'extension' },
  { id: 'kukulu', state: 'logged-in', need: 'mode', how: 'toggle' }
];
const view = (paired) => buildLoginList(rows, { names, pasteSites: { picarto: true }, paired, STR });
const item = (v, id) => v.items.find((i) => i.id === id);

assert.strictEqual(item(view(false), 'fc2').action, 'none', 'extension は文言だけ（個別のボタンは出さない）');
assert.ok(/配信管理ページ/.test(item(view(false), 'fc2').needText) && /チャンネル/.test(item(view(false), 'fc2').needText));
assert.strictEqual(item(view(false), 'picarto').action, 'sites', '貼る欄があるサイトはサイトの画面へ');
assert.strictEqual(item(view(false), 'twitcasting').action, 'none', '貼る欄が無いサイトは文言だけ');
assert.ok(item(view(false), 'twitcasting').needText.length > 0);
assert.strictEqual(item(view(false), 'youtube').action, 'sites', 'keys はログインの準備（サイトの画面）');
assert.strictEqual(item(view(false), 'twitch').action, 'reauth');
assert.strictEqual(item(view(false), 'rumble').action, 'none');
assert.strictEqual(item(view(false), 'rumble').needText, '');
assert.strictEqual(item(view(false), 'kukulu').needText, STR.siteLoginOff, 'toggle は送信オフとだけ');
assert.strictEqual(item(view(false), 'kukulu').action, 'none');
assert.strictEqual(item(view(false), 'fc2').name, 'FC2');
assert.strictEqual(item(view(false), 'twitch').name, 'twitch', '名前が無ければ id');

assert.strictEqual(view(false).pairNotice, true, '拡張が未ペアリングで extension のサイトが足りないとき注意');
assert.strictEqual(view(true).pairNotice, false);
assert.strictEqual(buildLoginList([{ id: 'rumble', state: 'logged-in', need: null, how: 'extension' }], { paired: false, STR }).pairNotice, false, 'ready なら注意しない');

// 形の悪い need / how は文言にしない・ボタンも出さない
const bad = buildLoginList([{ id: 'x', state: 'none', need: '<b>', how: 'oauth' }], { STR });
assert.deepStrictEqual([bad.items[0].needText, bad.items[0].action], ['', 'none']);
assert.deepStrictEqual(buildLoginList(null, { STR }), { items: [], pairNotice: false });

// 文言: 知らない need でも値は出さず、状態の文言に incomplete がある
assert.ok(STR.siteLoginNeed('zzz', 'paste').length > 0);
assert.ok(/足りない/.test(STR.loginState('incomplete')));
assert.ok(/足りない/.test(STR.homeLoginFor('incomplete')));

// N4
assert.deepStrictEqual(reloginSites(rows, names), ['FC2', 'Picarto', 'ツイキャス', 'YouTube', 'twitch']);
assert.deepStrictEqual(reloginSites([{ id: 'a', state: 'logged-in' }]), []);
assert.deepStrictEqual(reloginSites(null), []);
assert.ok(STR.vaultLostSites(['FC2']).includes('FC2'));
console.log('n3 login list: PASS');
