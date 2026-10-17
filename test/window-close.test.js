'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

// 実メインの窓と終了ハンドラを動かす。起動・本物の保存先・OBSには接続しない。
function sourceParts(file) {
  const source = fs.readFileSync(file, 'utf8');
  const windowStart = source.indexOf('function windowAlive(');
  const windowEnd = source.indexOf('function openInSystemBrowser(', windowStart);
  const quitStart = source.indexOf("app.on('before-quit'");
  assert.ok(windowStart >= 0 && windowEnd > windowStart && quitStart > windowEnd);
  return source.slice(windowStart, windowEnd) + '\n' + source.slice(quitStart);
}
function fixture(options = {}) {
  const calls = { quit: 0, exited: 0, hide: 0, destroy: 0, tray: 0, engine: 0, keys: 0, retention: 0 };
  let finish;
  const pending = new Promise((resolve, reject) => { finish = options.fail ? () => reject(new Error('fake cleanup')) : resolve; });
  const app = new EventEmitter();
  const windows = [];
  function event() { return { prevented: false, preventDefault() { this.prevented = true; } }; }
  class Window extends EventEmitter {
    constructor() { super(); this.dead = false; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; windows.push(this); }
    isDestroyed() { return this.dead; }
    setMenuBarVisibility() {}
    removeMenu() {}
    show() {}
    hide() { calls.hide++; }
    close() { const e = event(); this.emit('close', e); if (!e.prevented) this.finishClose(); }
    finishClose() { if (this.dead) return; this.dead = true; this.emit('closed'); if (windows.every((w) => w.dead)) app.emit('window-all-closed'); }
  }
  Window.getAllWindows = () => windows.filter((w) => !w.dead);
  app.quit = () => { calls.quit++; const e = event(); app.emit('before-quit', e); if (!e.prevented) { windows.forEach((w) => w.close()); calls.exited++; } };
  const context = vm.createContext({
    app, BrowserWindow: Window, EventEmitter, path, URL, __dirname: path.join(__dirname, '..'),
    mainWindow: null, quitting: false, pluginsClosed: false,
    trayHandle: options.tray === false ? null : { destroy() { calls.tray++; } },
    hotkeys: { unregisterAll() { calls.keys++; } }, retention: { stop() { calls.retention++; } },
    registry: {}, hubState: {}, process: { platform: 'win32', on() {} },
    isHeadless: () => !!options.headless, shutdownEngine() { calls.engine++; },
    destroyPlugins() { calls.destroy++; return pending; }, openInSystemBrowser() {}, showMainWindow() {}
  });
  context.registry.getRunning = () => [];
  vm.runInContext(sourceParts(path.join(__dirname, '..', 'electron-main.js')), context);
  return { calls, context, app, finish, create: () => context.createWindow() };
}
async function runTests() {
  for (const tray of [true, false]) {
    const f = fixture({ tray }); const win = f.create(); win.close();
    assert.strictEqual(f.calls.hide, 0, '×で隠して常駐しない');
    assert.strictEqual(f.calls.destroy, 1);
    assert.strictEqual(f.calls.exited, 0, '片付けの完了を待つ');
    assert.strictEqual(f.calls.keys, 1);
    assert.strictEqual(f.calls.engine, 1);
    assert.strictEqual(f.calls.tray, tray ? 1 : 0);
    f.finish(); await new Promise(setImmediate);
    assert.strictEqual(f.calls.exited, 1);
    assert.strictEqual(win.isDestroyed(), true);
    assert.strictEqual(f.context.mainWindow, null);
  }
  const failed = fixture({ fail: true }); failed.create().close(); failed.finish(); await new Promise(setImmediate);
  assert.strictEqual(failed.calls.exited, 1, 'destroy失敗でも終了する');
  const repeated = fixture(); const w = repeated.create(); w.close(); w.close(); repeated.finish(); await new Promise(setImmediate);
  assert.strictEqual(repeated.calls.destroy, 1, '二度閉じても片付けを重複しない');
  const detached = fixture(); detached.create(); detached.create(); // 既存のメイン窓は増やさない
  detached.app.emit('window-all-closed'); detached.finish(); await new Promise(setImmediate);
  assert.strictEqual(detached.calls.exited, 1, 'トレイがあっても全窓終了で終了する');
  const headless = fixture({ headless: true }); headless.app.emit('window-all-closed');
  assert.strictEqual(headless.calls.quit, 0, '明示的な画面なし起動は維持');
  headless.app.quit(); headless.finish(); await new Promise(setImmediate);
  assert.strictEqual(headless.calls.exited, 1, '画面なしでも明示終了できる');
  console.log('[window-close] all passed');
}
if (require.main === module) runTests().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { sourceParts };
