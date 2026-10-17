'use strict';
require('./_ui-inline');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createLayouts } = require('../host/layer1/layouts');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-lvl-'));
try {
  const real = createCore();
  const layouts = createLayouts({ core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync } });
  const dock = { grid: { root: { type: 'leaf', data: { views: ['home', 'chat'] } } }, panels: { home: {}, chat: {} } };

  // 初めては無い
  assert.strictEqual(layouts.getLevel('advanced').error, 'not-found');
  // 離れるときに保存 → 戻ったとき読める。レベルごとに別
  assert.deepStrictEqual(layouts.saveLevel('advanced', { version: 1, dockview: dock }), { ok: true, level: 'advanced' });
  const adv = layouts.getLevel('advanced');
  assert.strictEqual(adv.ok, true);
  assert.deepStrictEqual(adv.data.dockview, dock);
  assert.strictEqual(layouts.getLevel('standard').error, 'not-found');
  const other = { grid: { root: { type: 'leaf', data: { views: ['home'] } } }, panels: { home: {} } };
  layouts.saveLevel('standard', { version: 1, dockview: other });
  assert.deepStrictEqual(layouts.getLevel('standard').data.dockview, other);
  assert.deepStrictEqual(layouts.getLevel('advanced').data.dockview, dock, '上級は変わらない');
  // 初級は保存しない・不正なレベルは拒否
  assert.strictEqual(layouts.saveLevel('basic', { version: 1, dockview: dock }).error, 'bad-level');
  assert.strictEqual(layouts.getLevel('basic').error, 'bad-level');
  assert.strictEqual(layouts.getLevel('../x').error, 'bad-level');
  // 不正な中身・大きすぎる中身は拒否
  assert.strictEqual(layouts.saveLevel('standard', { version: 1 }).error, 'layout-type');
  assert.strictEqual(layouts.saveLevel('standard', null).error, 'layout-type');
  assert.strictEqual(layouts.saveLevel('standard', { dockview: { big: 'x'.repeat(300 * 1024) } }).error, 'too-large');
  // 秘密っぽい欄は落とす
  layouts.saveLevel('standard', { version: 1, dockview: { panels: { a: { token: 'SECRET-TOKEN-1', title: 't' } }, grid: {} } });
  assert.strictEqual(JSON.stringify(layouts.getLevel('standard')).includes('SECRET-TOKEN-1'), false);
  // 壊れた保存は無視（既定へ）
  fs.writeFileSync(path.join(dir, 'data', 'marust', 'level-layouts', 'advanced.json'), '{broken');
  assert.strictEqual(layouts.getLevel('advanced').ok, false);
  // 名前つきの配置の一覧には出ない
  assert.deepStrictEqual(layouts.list().names, ['標準']);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 画面側の流れ（ソースの検査）: 離れる前に保存 → 保存できなくても切り替える → 切り替え直後だけ使う。初級は保存・復元しない
const menubar = fs.readFileSync(path.join(ROOT, 'plugins', 'ui-standard', 'shell', 'menubar.js'), 'utf8');
const dockSrc = fs.readFileSync(path.join(ROOT, 'plugins', 'ui-standard', 'shell', 'core', 'dock.js'), 'utf8');
const body = menubar.slice(menubar.indexOf('function saveLeavingLayout'), menubar.indexOf('function setUiLevel') + 700);
assert.ok(body.indexOf("uiLevel === 'basic'") !== -1, '初級は保存しない');
assert.ok(body.indexOf("'layout.saveLevel'") !== -1 && body.indexOf('saveLeavingLayout().then') !== -1);
assert.ok(body.indexOf("call('ui.setSettings'") > body.indexOf('saveLeavingLayout().then'), '保存のあとで切り替える');
assert.ok(dockSrc.includes("call('layout.getLevel'") && dockSrc.includes("uiLevel !== 'basic'") && dockSrc.includes('LEVEL_SWITCH_KEY'));
const api = require('./_api-source').read();
assert.ok(api.includes("'layout.saveLevel'") && api.includes("'layout.getLevel'"));
console.log('[marust] level layouts tests passed');
