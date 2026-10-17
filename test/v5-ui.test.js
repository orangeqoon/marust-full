'use strict';
require('./_ui-inline');

/**
 * V5: 画面（段階）。メニューの言葉・配信中／読み込み中の断りの言葉・Google カレンダーの節は上級だけ。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const STR = require('../plugins/ui-standard/shell/strings');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

test('言葉: 「段階」・3 つの名前と説明・配信中と読み込み中の断り・初級のバックアップ', () => {
  assert.strictEqual(STR.levelMenu, '段階');
  ['basic', 'standard', 'advanced'].forEach((k) => {
    assert.ok(STR.levelNames[k] && STR.levelHints[k], k);
  });
  assert.ok(/読み込みません/.test(STR.levelHints.basic));
  assert.ok(STR.levelStreaming.indexOf('送信中') !== -1);
  assert.ok(STR.levelBusy);
  assert.strictEqual(STR.backupOffBeginner, undefined, '使われない言葉は消した（S6）');
});

test('setUiLevel: streaming / busy は専用の言葉、それ以外は今までの言葉', () => {
  const src = read('plugins/ui-standard/shell/menubar.js');
  const alerts = [];
  const ctx = vm.createContext({
    STR, uiLevel: 'basic', can: { write: true }, window: { alert: (m) => alerts.push(m), location: { reload() {} }, sessionStorage: { setItem() {} } },
    dockApi: null, call: null
  });
  const fn = src.slice(src.indexOf('function saveLeavingLayout'), src.indexOf('function toggleDevMode'));
  vm.runInContext(fn, ctx);
  const run = async (answer) => {
    ctx.call = () => Promise.resolve(answer);
    vm.runInContext("setUiLevel('standard')", ctx);
    await new Promise((r) => setTimeout(r, 20)); // setUiLevel は約束を返さない
  };
  return (async () => {
    await run({ ok: false, error: 'streaming' });
    await run({ ok: false, error: 'busy' });
    await run({ ok: false, error: 'forbidden' });
    assert.deepStrictEqual(alerts, [STR.levelStreaming, STR.levelBusy, STR.uiMenubar68]);
  })();
});

test('初級に残らない入口: 自動枠取りの問い・R24 の紹介は中級から・回線の余裕の手順の言葉は上級だけ入れ方を案内', () => {
  assert.ok(read('plugins/ui-standard/shell/panels/site-add.js').includes("if (!levelAtLeast('standard')) return null;"));
  assert.ok(read('plugins/ui-standard/shell/panels/home.js').includes("!levelAtLeast('standard')) { box.hidden = true; return; }"));
  assert.ok(read('plugins/ui-standard/shell/setup.js').includes("levelAtLeast('advanced') ? STR.setupUplinkOff : STR.setupUplinkOffBeginner"));
  assert.ok(STR.setupUplinkOffBeginner.indexOf('機能') === -1);
});

test('featureOn は段階で読み込まない印のプラグインを切ってあるのと同じに見る', () => {
  const src = read('electron-main.js');
  const fn = src.slice(src.indexOf('function featureOn'), src.indexOf('function currentTier'));
  assert.ok(fn.includes('registry.tierBlocked(id)'));
});

test('Google カレンダーの節は上級だけ作る（中級以下は節ごと出さず、読みにも行かない）', () => {
  const src = read('plugins/ui-standard/shell/menubar.js');
  assert.ok(src.indexOf("if (levelAtLeast('advanced')) buildGcalSection(extras);") !== -1);
  assert.ok(src.indexOf('\n  buildGcalSection(extras);') === -1);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
  }
  if (failed) { console.error('[v5-ui] ' + failed + ' failed'); process.exit(1); }
})();
