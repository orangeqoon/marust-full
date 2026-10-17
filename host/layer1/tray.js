'use strict';

/**
 * タスクトレイ、二重起動の防止、Windows の自動起動。
 * Electron の Tray / Menu / nativeImage / shell / app は注入する。
 * アイコンは emergencyButtonState の色（blue 配信中、red 停止、gray OBS 未接続）。
 * 「全部止める」は確認の窓を出さず、押したらすぐ止める（押している間の二度押しは 1 回だけ）。
 * 自動起動は STATE_DIR/data/marust/app-settings.json の openAtLogin。無いときはオフ。読んでもファイルは作らない。
 */

const fs = require('fs');
const path = require('path');
const { emergencyButtonState } = require('../core');

const BROWSER_URL = 'http://127.0.0.1:18770/';
const MAX_SETTINGS_BYTES = 64 * 1024;

const MENU_LABELS = Object.freeze({
  open: 'ウィンドウを開く',
  browser: 'ブラウザで開く',
  emergency: '全部止める',
  quit: '終了'
});

const TRAY_ICONS = Object.freeze({
  blue: 'tray-live.png',
  red: 'tray-stopped.png',
  gray: 'tray-disconnected.png'
});

function colorOf(state) {
  const color = state && typeof state.color === 'string' ? state.color : '';
  if (color === 'blue' || color === 'red' || color === 'gray') return color;
  return 'gray';
}

function trayIconFile(state) {
  return TRAY_ICONS[colorOf(state)];
}

function trayTooltip(state) {
  const color = colorOf(state);
  if (color === 'blue') {
    const count = state && Number.isInteger(state.count) && state.count > 0 ? state.count : 0;
    return '丸スト — 配信中 ' + String(count) + ' 件';
  }
  if (color === 'red') return '丸スト — 停止';
  return '丸スト — OBS 未接続';
}

function bringToFront(win) {
  if (!win) return false;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
  if (typeof win.isMinimized === 'function' && win.isMinimized() && typeof win.restore === 'function') {
    win.restore();
  }
  if (typeof win.show === 'function') win.show();
  if (typeof win.focus === 'function') win.focus();
  if (typeof win.setAlwaysOnTop === 'function') {
    try {
      win.setAlwaysOnTop(true);
    } finally {
      win.setAlwaysOnTop(false);
    }
  }
  return true;
}

function installSingleInstance(app, hooks) {
  if (!app || typeof app.requestSingleInstanceLock !== 'function') {
    throw new Error('single instance requires requestSingleInstanceLock');
  }
  const primary = app.requestSingleInstanceLock() === true;
  if (!primary) return { primary: false };
  if (typeof app.on !== 'function') throw new Error('single instance requires app.on');
  const options = hooks || {};
  app.on('second-instance', function () {
    try {
      const win = typeof options.getWindow === 'function' ? options.getWindow() : null;
      if (!bringToFront(win) && typeof options.showWindow === 'function') options.showWindow();
    } catch (_) { /* 起動途中でも落とさない */ }
  });
  return { primary: true };
}

function isHeadless(argv) {
  const list = Array.isArray(argv)
    ? argv
    : (typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv : []);
  return list.indexOf('--headless') !== -1;
}

function settingsFile(store) {
  const src = store && typeof store === 'object' ? store : null;
  const root = src && typeof src.STATE_DIR === 'string' && src.STATE_DIR
    ? src.STATE_DIR
    : (src && typeof src.stateDir === 'string' ? src.stateDir : '');
  if (!root) throw new Error('app settings require STATE_DIR');
  return path.join(root, 'data', 'marust', 'app-settings.json');
}

function emptySettings() {
  return { openAtLogin: false };
}

function readSettingsObject(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, missing: true, data: null };
    return { ok: false };
  }
  if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return { ok: false };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (_) {
    return { ok: false };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
    return { ok: true, missing: false, data: data };
  } catch (_) {
    return { ok: false };
  }
}

function readAppSettings(store) {
  const loaded = readSettingsObject(settingsFile(store));
  if (!loaded.ok || loaded.missing || !loaded.data) return emptySettings();
  return { openAtLogin: loaded.data.openAtLogin === true };
}

function writeAppSettings(store, patch) {
  const src = store && typeof store === 'object' ? store : null;
  const writeJson = src && typeof src.atomicWriteJsonSync === 'function' ? src.atomicWriteJsonSync : null;
  if (!writeJson) throw new Error('app settings require atomicWriteJsonSync');
  const file = settingsFile(src);
  const openAtLogin = !!(patch && patch.openAtLogin === true);
  const loaded = readSettingsObject(file);
  const base = loaded.ok && loaded.data ? loaded.data : {};
  const next = Object.assign({}, base, { openAtLogin: openAtLogin });
  writeJson(file, next);
  return { openAtLogin: openAtLogin };
}

function quoteArg(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return '"' + text.replace(/"/g, '\\"') + '"';
}

function loginItemOptions(appInfo, openAtLogin) {
  const info = appInfo || {};
  const options = { openAtLogin: openAtLogin === true };
  if (info.packaged === false) {
    if (typeof info.execPath === 'string' && info.execPath) options.path = info.execPath;
    if (typeof info.appPath === 'string' && info.appPath) options.args = [quoteArg(info.appPath)];
  }
  return options;
}

function applyOpenAtLogin(app, openAtLogin) {
  if (!app || typeof app.setLoginItemSettings !== 'function') {
    throw new Error('app settings require setLoginItemSettings');
  }
  const options = loginItemOptions({
    packaged: app.isPackaged === true,
    execPath: typeof app.execPath === 'string' ? app.execPath : process.execPath,
    appPath: typeof app.getAppPath === 'function' ? app.getAppPath() : ''
  }, openAtLogin);
  app.setLoginItemSettings(options);
  return options;
}

function buttonState(getButtonState) {
  if (typeof getButtonState !== 'function') return emergencyButtonState([], false);
  try {
    const state = getButtonState();
    if (state && typeof state.color === 'string') return state;
  } catch (_) { /* 状態が読めないときは未接続 */ }
  return emergencyButtonState([], false);
}

function createTray(deps) {
  const src = deps || {};
  const Tray = src.Tray;
  const Menu = src.Menu;
  const nativeImage = src.nativeImage;
  if (typeof Tray !== 'function') throw new Error('tray requires Tray');
  if (!Menu || typeof Menu.buildFromTemplate !== 'function') throw new Error('tray requires Menu');
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') throw new Error('tray requires nativeImage');
  const shell = src.shell;
  const assetsDir = typeof src.assetsDir === 'string' && src.assetsDir
    ? src.assetsDir
    : path.join(__dirname, '..', '..', 'assets');
  const browserUrl = typeof src.browserUrl === 'string' && src.browserUrl ? src.browserUrl : BROWSER_URL;
  const logger = typeof src.logger === 'function' ? src.logger : function () {};
  const images = new Map();

  function imageFor(fileName) {
    if (images.has(fileName)) return images.get(fileName);
    const image = nativeImage.createFromPath(path.join(assetsDir, fileName));
    images.set(fileName, image);
    return image;
  }

  let shownFile = '';
  let tip = '';

  function applyIcon(state) {
    const button = state || emergencyButtonState([], false);
    const fileName = trayIconFile(button);
    const image = imageFor(fileName);
    tip = trayTooltip(button);
    return { icon: fileName, image: image, button: button, tooltip: tip };
  }

  const initial = applyIcon(buttonState(src.getButtonState));
  shownFile = initial.icon;
  const tray = new Tray(initial.image);
  if (typeof tray.setToolTip === 'function') tray.setToolTip(initial.tooltip);

  let pending = false;

  async function stopAllNow() {
    if (pending) return { ok: false, error: 'busy' };
    pending = true;
    try {
      if (typeof src.emergencyStop !== 'function') return { ok: false, error: 'unavailable' };
      let stopped;
      try {
        stopped = await src.emergencyStop();
      } catch (_) {
        return { ok: false, error: 'failed' };
      }
      try { refresh(); } catch (_) { logger('warn', 'tray refresh failed'); }
      return stopped && typeof stopped === 'object' ? stopped : { ok: true };
    } finally {
      pending = false;
    }
  }

  const template = [
    {
      label: MENU_LABELS.open,
      click: function () {
        if (typeof src.openWindow === 'function') src.openWindow();
      }
    },
    {
      label: MENU_LABELS.browser,
      click: function () {
        if (typeof src.openBrowser === 'function') {
          src.openBrowser(browserUrl);
          return;
        }
        if (shell && typeof shell.openExternal === 'function') {
          Promise.resolve(shell.openExternal(browserUrl)).catch(function () {
            logger('warn', 'tray browser failed');
          });
        }
      }
    },
    {
      label: MENU_LABELS.emergency,
      click: function () {
        return stopAllNow().catch(function () {
          logger('warn', 'tray emergency failed');
          return { ok: false, error: 'failed' };
        });
      }
    },
    {
      label: MENU_LABELS.quit,
      click: function () {
        if (typeof src.quit === 'function') src.quit();
      }
    }
  ];
  const labels = template.map(function (item) { return item.label; });
  tray.setContextMenu(Menu.buildFromTemplate(template));

  function refresh() {
    const next = applyIcon(buttonState(src.getButtonState));
    if (next.icon !== shownFile && typeof tray.setImage === 'function') {
      tray.setImage(next.image);
      shownFile = next.icon;
    }
    if (typeof tray.setToolTip === 'function') tray.setToolTip(next.tooltip);
    return { icon: shownFile, button: next.button, tooltip: next.tooltip };
  }

  let timer = null;
  const pollMs = Number(src.pollMs);
  if (Number.isFinite(pollMs) && pollMs > 0) {
    const setTimer = src.setIntervalFn || setInterval;
    timer = setTimer(function () {
      try { refresh(); } catch (_) { logger('warn', 'tray refresh failed'); }
    }, pollMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function destroy() {
    if (timer) {
      const clearTimer = src.clearIntervalFn || clearInterval;
      try { clearTimer(timer); } catch (_) { /* 終了処理は続ける */ }
      timer = null;
    }
    if (typeof tray.destroy === 'function') tray.destroy();
  }

  function click(label) {
    for (let i = 0; i < template.length; i += 1) {
      if (template[i].label === label) {
        return Promise.resolve().then(function () { return template[i].click(); });
      }
    }
    return Promise.resolve({ ok: false, error: 'no-item' });
  }

  return {
    tray: tray,
    labels: labels,
    click: click,
    refresh: refresh,
    destroy: destroy
  };
}

module.exports = {
  BROWSER_URL: BROWSER_URL,
  MENU_LABELS: MENU_LABELS,
  TRAY_ICONS: TRAY_ICONS,
  trayIconFile: trayIconFile,
  trayTooltip: trayTooltip,
  bringToFront: bringToFront,
  installSingleInstance: installSingleInstance,
  isHeadless: isHeadless,
  readAppSettings: readAppSettings,
  writeAppSettings: writeAppSettings,
  loginItemOptions: loginItemOptions,
  applyOpenAtLogin: applyOpenAtLogin,
  createTray: createTray
};
