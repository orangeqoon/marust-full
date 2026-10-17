'use strict';
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const STR = require('../plugins/ui-standard/shell/strings');

const root = path.join(__dirname, '..');
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

test('strings.js のキーは空でない', () => {
  Object.keys(STR).forEach((key) => {
    const v = STR[key];
    if (typeof v === 'string') assert.ok(v.length > 0, key);
    else if (v && typeof v === 'object') assert.ok(Object.keys(v).length > 0, key); // 表・並び（表示の細かさの名前、案内の手順）
    else assert.strictEqual(typeof v, 'function', key);
  });
});

test('接続の表示は一般向けの言葉', () => {
  assert.strictEqual(STR.agentOk, '丸スト: 動いています');
  assert.ok(STR.agentLost.includes('つながっていません'));
});

test('状態名は日本語に直る。知らない名前はそのまま', () => {
  assert.strictEqual(STR.state('stopped'), '停止中');
  assert.strictEqual(STR.state('live'), '送信中');
  assert.strictEqual(STR.state('failed'), '失敗');
  assert.strictEqual(STR.state('zzz'), 'zzz');
  assert.strictEqual(STR.state(null), '');
});

test('関数形の文は引数で変わる', () => {
  assert.notStrictEqual(STR.obsStatus(true), STR.obsStatus(false));
  assert.notStrictEqual(STR.destSummary(3), STR.destSummary(4));
  assert.ok(STR.destSummary(3).includes('3'));
  assert.strictEqual(STR.topBar(false, 'live 1 / shadow 0 / legacy 0', true), STR.obsConnected);
  assert.ok(STR.topBar(true, 'live 1 / shadow 0 / legacy 0', false).includes('live 1 / shadow 0 / legacy 0'));
  assert.ok(STR.topBar(true, 'live 1 / shadow 0 / legacy 0', false).includes(STR.obsDisconnected));
  assert.strictEqual(STR.topBar(false, 'live 1', null), '');
});

test('移した文は ui のソースに直書きされていない', () => {
  const client = read('ui/api-client.js');
  const hub = hubSource();
  const html = read('ui/hub.html');
  assert.ok(!client.includes('Agent 接続中'));
  assert.ok(!client.includes('切断（再接続中）'));
  assert.ok(!hub.includes('ずれ '));
  assert.ok(!hub.includes('表示のみ（legacy）'));
  assert.ok(!hub.includes('送信しません（legacy）'));
  assert.ok(!html.includes('送信（現在のモードで）'));
  assert.ok(client.includes('CORE_STR.agentOk'));
  assert.ok(read('plugins/ui-standard/shell/panels/home.js').includes('STR.homeStart') && read('plugins/ui-standard/shell/panels/destinations.js').includes('STR.stateLive'));
});

test('核の枠は言葉に依存せず、shellはstringsを先に読む', () => {
  const html = read('ui/hub.html');
  assert.ok(!html.includes('strings.js') || html.includes('core-strings.js'));
  assert.ok(!html.includes('/ui/strings.js'));
  const manifest = JSON.parse(read('plugins/ui-standard/manifest.json'));
  assert.ok(manifest.shell.scripts.indexOf('strings.js') < manifest.shell.scripts.indexOf('hub.js'));
});

test('サイト別の状態・サイトを足す・OBS とつなぐの文は strings.js から来る', () => {
  const sites = read('plugins/ui-standard/shell/panels/sites.js');
  const add = read('plugins/ui-standard/shell/panels/site-add.js');
  const obs = read('plugins/ui-standard/shell/panels/obs-connect.js');
  ["'サイト別の状態'", "'読み込み中…'", "'保存してログインする'", "'のログインを結び直します"].forEach((s) => assert.ok(!sites.includes(s), s));
  ['作っています…', '確かめましたか'].forEach((s) => assert.ok(!add.includes(s), s));
  ['つないでいます…', 'つながっています'].forEach((s) => assert.ok(!obs.includes(s), s));
  assert.ok(sites.includes('STR.sitesTitle') && add.includes('STR.addSiteConfirm') && obs.includes('STR.obsConnecting'));
  assert.ok(STR.sitesRelinkConfirm('Twitch').includes('Twitch'));
  assert.ok(STR.sitesRedirectLabel('http://x').includes('http://x') && STR.sitesRedirectLabel('').includes('必ず'));
  assert.ok(STR.addSiteConfirm('Kick').includes('Kick') && STR.addSiteIngestN(2).includes('2'));
});

if (failed) process.exit(1);
