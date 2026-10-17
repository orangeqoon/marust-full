'use strict';
const { hubSource } = require('./_ui-source');

/** 題名の本番送信の確認は最初の 1 回だけ（fanoutAck）。保存・形の検査・画面が「聞く→保存→以後聞かない」になっていること。偽物だけ。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createUiSettings } = require('../host/layer1/ui-settings');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

test('ui-settings: fanoutAck は既定 false・true を保存・他のキーを壊さない・型違いは拒否', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w58-'));
  try {
    const ui = createUiSettings({ stateDir: dir });
    assert.strictEqual(ui.getView().fanoutAck, false);
    assert.strictEqual(ui.set({ uiLevel: 'standard' }).ok, true);
    assert.strictEqual(ui.set({ fanoutAck: 'yes' }).error, 'bad-value');
    assert.strictEqual(ui.getView().fanoutAck, false);
    assert.strictEqual(ui.set({ fanoutAck: true }).ok, true);
    const view = ui.getView();
    assert.strictEqual(view.fanoutAck, true);
    assert.strictEqual(view.uiLevel, 'standard');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('画面: 確認は confirmFanoutOnce に集約（home.js・hub.js が直に confirm を出さない）', () => {
  const hub = hubSource();
  const home = read('plugins/ui-standard/shell/panels/home.js');
  assert.ok(hub.includes('function confirmFanoutOnce'));
  assert.ok(hub.includes('s.fanoutAck === true && covered) return true'), '保存済み（予約の範囲内）なら聞かない。K3');
  assert.ok(hub.includes("call('ui.setSettings', { fanoutAck: true })"), '「はい」のあとに保存');
  assert.ok(home.includes('confirmFanoutOnce(') && hub.includes('confirmFanoutOnce(names'));
  assert.ok(!home.includes("'本番送信するサイト: '") && !hub.includes("'本番送信するプラグイン: '"));
});

if (failed) { console.error('\n[w58] ' + failed + ' failed'); process.exit(1); }
console.log('\n[marust] w58 fanout-ack tests passed');
