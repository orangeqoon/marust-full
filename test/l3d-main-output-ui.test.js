'use strict';

// L3d: メイン出力の行（ホーム）・メイン出力のボタン・site-add の一覧から main を外す。YouTube の枠の切り替えの試験は YouTube のフォルダの test にある。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STR = require('../plugins/ui-standard/shell/strings');
global.STR = STR;
global.siteLabel = function (id) { return String(id); };
const buttons = require('../plugins/ui-standard/shell/panels/destinations');
const home = require('../plugins/ui-standard/shell/panels/home');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('streamGroups: main は先頭の「メイン出力」1 つで、サイトのボタンと混ぜない', () => {
  const targets = [
    { id: 't1', name: 'YT', site: 'youtube', state: 'stopped', enabled: true, destinationId: 'site-t1' },
    { id: 'main', name: 'メイン出力', main: true, site: 'youtube', state: 'live', destinationId: 'obs-main' }
  ];
  const groups = buttons.streamGroups(targets, { youtube: 'YouTube' }, {}, [{ id: 'obs-main', enabled: true, site: 'youtube' }]);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].key, 'main');
  assert.strictEqual(groups[0].label, STR.mainOutputButton);
  assert.strictEqual(groups[0].isMain, true);
  assert.deepStrictEqual(groups[0].destIds, ['obs-main']);
  assert.strictEqual(groups[0].state, 'live');
  assert.strictEqual(groups[0].enabled, true);
  assert.strictEqual(groups[1].key, 's:youtube');
  assert.strictEqual(groups[1].targets.length, 1);
  const off = buttons.streamGroups(targets, {}, {}, [{ id: 'obs-main', enabled: false }]);
  assert.strictEqual(off[0].enabled, false);
});

test('homeSiteRows: main のターゲットはサイトの行に数えない', () => {
  const rows = [{ id: 'site-youtube', site: { name: 'YouTube', tier: 'core' }, audience: 'public' }];
  const out = home.homeSiteRows(rows, [{ id: 'main', main: true, site: 'youtube', state: 'live', enabled: true }]);
  assert.strictEqual(out[0].targets.length, 0);
  assert.strictEqual(out[0].destState, 'none');
});

test('homeMainOutputView: 送信中は locked・未接続は OBS 未接続・行が無ければ use:false', () => {
  const live = home.homeMainOutputView({ id: 'obs-main', enabled: true, site: 'youtube' }, { id: 'main', state: 'live' });
  assert.strictEqual(live.locked, true);
  assert.strictEqual(live.use, true);
  assert.strictEqual(live.site, 'youtube');
  assert.strictEqual(live.stateText, STR.stateLive);
  for (const s of ['connecting', 'reconnecting']) assert.strictEqual(home.homeMainOutputView(null, { id: 'main', state: s }).locked, true);
  const stopped = home.homeMainOutputView({ enabled: true }, { id: 'main', state: 'stopped' });
  assert.strictEqual(stopped.locked, false);
  assert.strictEqual(stopped.stateText, STR.stateStopped);
  const off = home.homeMainOutputView({ id: 'obs-main', enabled: true, site: 'twitch' }, null);
  assert.strictEqual(off.connected, false);
  assert.strictEqual(off.stateText, STR.mainOutputObsOff);
  assert.strictEqual(off.locked, false);
  assert.strictEqual(off.site, 'twitch');
  const none = home.homeMainOutputView(null, null);
  assert.strictEqual(none.use, false);
  assert.strictEqual(none.site, '');
});

test('site-add: ターゲットの一覧から main を外す（ソース）', () => {
  const src = read('plugins/ui-standard/shell/panels/site-add.js');
  assert.ok(/function targetRows[\s\S]*?r\.main === true \|\| r\.id === 'main'/.test(src));
});

test('home.js: destination.setMain を呼ぶ・main の行にキーの欄を出さない（ソース）', () => {
  const src = read('plugins/ui-standard/shell/panels/home.js');
  assert.ok(src.includes("call('destination.setMain'"));
  const detail = src.slice(src.indexOf('function detailBlock'), src.indexOf('function mainDestRow'));
  assert.ok(detail.indexOf("t.main === true") !== -1 && detail.indexOf("t.main === true") < detail.indexOf("'key-save'"), 'key-save より前に main を抜ける');
});

test('plugins/ui-standard/shell/strings.js: 新しい文字と main-not-youtube の知らせ', () => {
  assert.ok(STR.mainOutputNote.includes('OBS'));
  assert.ok(STR.homeAlert('youtube', 'main-not-youtube').includes('メイン出力'));
  assert.ok(/止めてから/.test(STR.mainOutputLocked));
});

if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
