'use strict';
require('./_ui-inline');

/**
 * V3 C5: 画面（PLAN-V3 V3-9・V3-14）。回線の余裕・ホットキーのパネルを、対応するプラグインを切っているあいだ隠す・
 * ホームの余裕の 1 行・案内の手順・ホットキーの「切ってある」行・言葉。ソースの文字列と、panels.js を vm で動かして確かめる。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const STR = require('../plugins/ui-standard/shell/strings');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

test('言葉は strings.js にある（V3-12・V3-14）', () => {
  assert.strictEqual(STR.uiHotkeysOff, 'このキーの機能は切ってあります');
  assert.strictEqual(STR.uplinkNoPlugin, undefined, '使われない言葉は消した（S6）');
  assert.strictEqual(STR.setupUplinkOff, '回線の余裕は上級の機能です。使うときは、あとで「機能」から入れてください。この手順はとばせます。');
});

test('ホーム: uplink.last が unknown-method なら余裕の文と「計算」を出さない（それ以外の失敗は今どおり「まだ」）。見せるものが無ければ 1 行ごと隠す', () => {
  const src = read('plugins/ui-standard/shell/panels/home.js');
  assert.ok(src.includes("state.uplinkOff = !!(r && r.ok !== true && r.error === 'unknown-method');"));
  assert.ok(/uplink: null, uplinkOff: false,/.test(src));
  assert.ok(src.includes('var showMargin = state.uplinkOff !== true;'));
  assert.ok(src.includes('line.hidden = !showWatch && !showMargin;'));
  const margin = src.indexOf('if (!showMargin) return;');
  assert.ok(margin !== -1 && margin < src.indexOf("STR.homeLineMargin(u.verdict, ago)") && margin < src.indexOf("id: 'home-uplink-open'"), '文も「計算」ボタンも、ここより後ろ');
  // 見張りの文と getStatus の呼び出しは、開発者モードか上級
  assert.ok(src.includes('var showWatch = devMode || isAdvanced();'));
  assert.ok(src.includes("(devMode || isAdvanced()) ? call('plugin.signal-monitor.getStatus', {})"));
  assert.ok(!/\bdevMode \? call\('plugin\.signal-monitor/.test(src));
  assert.ok(src.includes('回線の見張りは開発者モードか上級'));
});

test('回線の余裕のパネル: estimate・setSettings が unknown-method なら「プラグインが切ってあります」', () => {
  // 回線の余裕の画面は uplink-estimate のパネル（V7）。切ってあるときの言葉はパネルの中にある
  const src = read('plugins/uplink-estimate/ui/panel.js');
  assert.ok(src.includes("res && res.error === 'unknown-method' ? '回線の余裕（プラグイン）が切ってあります。「機能」から入れると使えます。'"));
  assert.ok(src.includes("if (res && res.error === 'unknown-method') { say('回線の余裕（プラグイン）が切ってあります。「機能」から入れると使えます。'); return; }"));
});

test('初回の案内の uplink の手順: unknown-method なら埋め込まず 1 行（手順は残す）。それ以外は今までどおり', () => {
  const src = read('plugins/ui-standard/shell/setup.js');
  const i = src.indexOf("} else if (id === 'uplink') {");
  const block = src.slice(i, src.indexOf("} else if (id === 'verify')", i));
  assert.ok(block.includes("call('uplink.last', {})") && block.includes("r.error === 'unknown-method'"));
  assert.ok(block.includes('STR.setupUplinkOff') && block.includes('STR.setupUplinkMiss') && block.includes("setupEmbed('uplink', body)"));
  assert.ok(block.indexOf('STR.setupUplinkOff') < block.indexOf("setupEmbed('uplink', body)"), '切のときは埋め込みの前に 1 行だけ出して戻る');
  assert.ok(block.includes('if (!body.parentNode) return;'), '手順が変わったあとは何もしない');
  assert.ok(STR.setupSteps.some((s) => s.id === 'uplink'), '手順の番号は変えない');
});

test('ホットキーのパネル: off の行は「切ってある」・押したときの unknown-method も同じ言葉・保存には off を送らない', () => {
  // 押したときの知らせは本体の画面（plugins/ui-standard/shell/hub.js）、一覧と編集はホットキーのプラグインのパネル（V7）
  assert.ok(read('plugins/ui-standard/shell/hub.js').includes("if (error === 'unknown-method') return 'このキーの機能は切ってあります';"));
  const src = read('plugins/hotkeys/ui/panel.js');
  assert.ok(src.includes("'このキーの機能は切ってあります'") && STR.uiHotkeysOff === 'このキーの機能は切ってあります');
  assert.ok(src.includes('row.off === true'));
  assert.ok(src.includes('off: row.off === true'));
  // 保存の組み立て（欄 → bindings）には off を入れない
  const push = src.indexOf('bindings.push({');
  assert.ok(push !== -1);
  const block = src.slice(push, src.indexOf('});', push));
  assert.ok(!/off/.test(block), block);
});

test('signal-monitor は public（上級）・ほかの欄は変えない', () => {
  const m = JSON.parse(read('plugins/signal-monitor/manifest.json'));
  assert.strictEqual(m.audience, 'public');
  assert.strictEqual(m.stability, 'stable');
  assert.deepStrictEqual(m.feature && m.feature.level, 'advanced');
  assert.ok(m.subscribes.indexOf('slot.switching') !== -1);
});

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('v3-ui: all ok');
