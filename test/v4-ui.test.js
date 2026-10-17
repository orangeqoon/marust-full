'use strict';
require('./_ui-inline');

/**
 * V4 C4: 画面（V4-2・V4-3）。
 * ① バックアップのパネル: settings.preview / exportToFile / import が unknown-method ならバックアップの部分だけ隠して 1 行にする。引っ越しの部分と、FEATURE_PANEL_PLUGIN（パネルごと隠す表）は今どおり。
 * ② メニューの Google カレンダーの行: calendar.loginStatus が unknown-method なら「カレンダーのプラグインが入っていません」の 1 行。
 * ソースの文字列と、パネルの関数を vm で動かして確かめる。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const STR = require('../plugins/ui-standard/shell/strings');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

(async () => {
  await test('言葉は strings.js にある（V4-2・V4-3）', () => {
    assert.strictEqual(STR.backupOff, undefined, '使われない言葉は消した（S6。backup の画面が自分の言葉を持つ）');
    assert.strictEqual(STR.gcalNoPlugin, 'カレンダーのプラグインが入っていません。');
    assert.strictEqual(STR.uiMenubar49, 'バックアップと引っ越し…', 'メニューの名前は直さない');
  });

  await test('バックアップの画面は backup のパネル（V7 C5）。切ってあると言うのは書き出し・読み込み・反映の 3 か所。引っ越しは本体の画面で、切でも隠さない', () => {
    const panel = read('plugins/backup/ui/panel.js');
    const n = (panel.match(/res\.error === 'unknown-method'\) \{[^}]*offText\(\)/g) || []).length;
    assert.ok(n >= 3, 'exportToFile・preview・import の 3 か所: ' + n);
    assert.ok(panel.includes("'バックアップ（プラグイン）は切ってあります。「機能」から入れると使えます。'"));
    const mig = read('plugins/ui-standard/shell/panels/migration.js');
    assert.ok(mig.indexOf('data-backup') === -1 && mig.indexOf('settings.') === -1, '引っ越しの画面はバックアップを見ない');
    assert.ok(!read('plugins/ui-standard/shell/core/dock.js').includes('refreshBackupPart'));
  });

  await test('メニュー: calendar.loginStatus が unknown-method なら 1 行だけ（鍵の欄・ボタン・説明リンクを隠す）。それ以外は今どおり', () => {
    const src = read('plugins/ui-standard/shell/menubar.js');
    assert.ok(src.includes("if (st && st.ok === false && st.error === 'unknown-method') { paintNoPlugin(); return; }"));
    const fn = src.slice(src.indexOf('function paintNoPlugin()'), src.indexOf('function showLinkParts()'));
    ['linkState.textContent = STR.gcalNoPlugin', "form.style.display = 'none'", "loginBtn.style.display = 'none'", "rekeyBtn.style.display = 'none'", "guideP.style.display = 'none'"].forEach((t) => assert.ok(fn.indexOf(t) !== -1, t));
    assert.ok(src.indexOf('showLinkParts();') > src.indexOf("paintNoPlugin(); return; }"), '戻ったら出し直す');
  });

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('v4-ui: all ok');
})();
