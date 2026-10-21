'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

/**
 * R9: 重なりの整理（止める・本番切り替え・持ち出し・セッションとタイマー・言葉の統一）。画面のソースの約束を確かめる。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const STR = require('../plugins/ui-standard/shell/strings');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

const hub = hubSource();
const bar = read('plugins/ui-standard/shell/menubar.js');
const html = require('./_ui-source').shellDocument();

test('止める: 一般の画面は「全部止める」とサイトごとのボタン。非常停止はパネルと OBS のドック', () => {
  assert.ok(!html.includes('全配信停止'));
  assert.ok(read('plugins/ui-standard/shell/strings.js').includes("homeStopAll: '全部止める'"));
  assert.ok(!read('plugins/ui-standard/shell/panels/home.js').includes("openPanel('emergency')"), 'ホームに非常停止の入口を重ねない');
  assert.ok(!bar.includes("togglePanel('emergency')"), '丸ストの画面には出さない（OBS 側のボタンがある）');
  assert.ok(hub.includes("['engine-status', 'broadcast', 'emergency'].forEach"), '古い配置に残っていても外す');
  // 全部止めるの本体は click で broadcast.stopAll を呼ぶ。OBS のドック（?view=dock）は全部止めるだけを縦に大きく出す
  const dock = read('plugins/ui-standard/shell/view-dock.js');
  assert.ok(dock.includes("DOCK_WIDGETS = ['emergency']"));
  assert.ok(hub.includes('data-panel="emergency"') || html.includes('data-panel="emergency"'));
  assert.ok(read('plugins/ui-standard/shell/panels/home.js').includes("id: 'home-stop-all'"));
});

test('本番切り替え: モード・golive・shadow の報告は開発者モードだけ（パネルとメニュー）', () => {
  // モードの画面は開発者プラグイン dev-shadow（audience: dev＝開発者モードのときだけ読む）のパネル（K3）
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'dev-shadow', 'manifest.json'), 'utf8')).audience, 'dev');
  assert.ok(!/\['modes', /.test(hub) && !/\['modes', /.test(bar), '本体の PANELS・TOOL_PANELS には無い');
  const edit = bar.slice(bar.indexOf("kind === 'edit'"), bar.indexOf("kind === 'view'"));
  assert.ok(/if \(devMode\) \{[\s\S]*legacy に戻す[\s\S]*live にする[\s\S]*\}/.test(edit), '一括切り替えは開発者モードの中');
  const tools = bar.slice(bar.indexOf("kind === 'tools'"), bar.indexOf("kind === 'help'"));
  assert.ok(tools.includes('toolRowsForLevel()'));
  assert.ok(bar.includes('visiblePanelRows(TOOL_PANELS)'), 'ツールの一覧は開発者モードの印で絞ってから、表示の細かさで絞る');
});

test('持ち出し: ファイルメニューは「バックアップと引っ越し」1 つ。違い（秘密なし／あり）を画面に書く', () => {
  const file = bar.slice(bar.indexOf("kind === 'file'"), bar.indexOf("kind === 'edit'"));
  // V7 C5: バックアップは backup プラグインの画面、引っ越しは本体の画面。ファイルメニューは 2 行
  assert.ok(file.includes("panelMenuRows('file')") && file.includes("openPanel('migration')"));
  const backupMenu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'backup', 'manifest.json'), 'utf8')).panels.find((p) => p.menu);
  assert.ok(backupMenu && backupMenu.menu.in === 'file' && backupMenu.menu.title === 'バックアップ…', 'バックアップの行は backup のパネルの menu の名乗りで出る（入っているときだけ）');
  assert.ok(!file.includes('設定を書き出す') && !file.includes('設定を読み込む'));
  assert.ok(hub.includes("['migration', STR.migrationTitle]"));
  assert.ok(hub.includes('金庫の秘密（キー・トークン・OBS の接続設定）') && hub.includes('合言葉で暗号化'));
  const backupHtml = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'backup', 'ui', 'panel.html'), 'utf8');
  assert.ok(backupHtml.includes('秘密は入りません'));
  // 旧いアプリの取り込みは本体の画面に無い（dev-legacy-import の自分のパネルが出す）
  assert.ok(!hub.includes('secret-import'));
});

test('セッションとタイマー: 一般の画面は「配信の経過時間」1 つ。細かい設定はタイマーの窓（中級）', () => {
  // 経過時間の画面は K3 でプラグイン session のパネルへ移った
  const sessionDir = path.join(__dirname, '..', 'plugins', 'session');
  assert.ok(fs.readFileSync(path.join(sessionDir, 'ui', 'panel.html'), 'utf8').includes('<h1>配信の経過時間</h1>'));
  assert.ok(!hub.includes("['session', '配信の経過時間'"));
  assert.ok(!bar.includes('題名と配信の経過時間'));
  assert.ok(bar.includes("['other', 'タイマー'"));
  assert.ok(!hub.includes("['session', 'セッション']"));
});

test('言葉: 「送る」は「題名を送る」に統一（ボタンと説明）。専門語の shadow / live を一般の文に出さない', () => {
  const strings = read('plugins/ui-standard/shell/strings.js');
  assert.ok(!/「送る」/.test(strings), 'strings.js に単独の「送る」が残っていない');
  assert.strictEqual(STR.sendColumn, '題名を送る');
  assert.strictEqual(STR.sendOn, '題名を送る');
  assert.strictEqual(STR.sendOff, '送らない');
  assert.ok(STR.obsControlHint.includes('「題名を送る」とは別'));
  assert.ok(STR.sendSwitchError('requires-unmet').includes('「題名を送る」'));
  assert.ok(STR.sendNone.includes('止めてあります'));
  assert.ok(STR.sendNoneButton.includes('使えるように'));
  assert.ok(STR.obsControlLabel.includes('止める'), '配信の開始・停止の操作は「止める」にチェック（外した状態がふだん）');
  assert.ok(!hub.includes("'記録だけ（shadow）'") && !hub.includes("'実行（live）'"));
});

test('M3 の評価の直し: 「全部止める」は選択に関係なく broadcast.stopAll を呼ぶ。受け取りの失敗は受け取りの言葉', () => {
  const homeSrc = read('plugins/ui-standard/shell/panels/home.js');
  const btnSrc = read('plugins/ui-standard/shell/panels/destinations.js');
  assert.ok(homeSrc.includes("call('broadcast.stopAll', {})"));
  assert.ok(!homeSrc.includes('homeStopTargets'));
  assert.ok(!btnSrc.includes('homeStopTargets'));
  assert.ok(!homeSrc.includes('selected()'), '停止は選択を使わない');
  assert.ok(hub.includes('STR.receiveSwitchError('));
  assert.ok(STR.receiveSwitchError('bad-id').includes('試験中'));
  // 回線の余裕の説明は uplink-estimate の画面が持つ（S6: 本体の strings.js にあった使われない言葉は消した）
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'uplink-estimate', 'ui', 'panel.html'), 'utf8').includes('OBS 本体の配信'));
  assert.ok(!read('plugins/ui-standard/shell/view-dock.js').includes('セッションはすでに'));
});

test('サイト別の状態の確認文も「題名を送る」', () => {
  assert.ok(STR.sitesSendConfirm('twitch').includes('を「題名を送る」にします'));
  assert.ok(!hub.includes('を「送る」にします') && !STR.sitesSendConfirm('twitch').includes('を「送る」にします'));
  assert.ok(hub.includes('STR.sitesSendConfirm'));
});

if (failed) {
  console.error(failed + ' test(s) failed');
  process.exit(1);
}
