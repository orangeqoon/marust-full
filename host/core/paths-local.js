'use strict';

/**
 * scripts_core が無い PC（配った exe など）で使う、丸スト自身の小さな代わり（R10）。
 * createCore と同じ形（STATE_DIR・SERVICES_DIR・atomicWriteJsonSync …）を返す。
 * 保存場所の決め方（強い順）:
 *   1. 環境変数 MARUST_STATE
 *   2. exe（Electron の app.isPackaged）なら %APPDATA%\marust（APPDATA が無ければホームの AppData\Roaming\marust）
 *   3. ソースからなら streaming/marust/dev-state/（git の外。.gitignore で除外）
 * import 時と createLocalCore では何も作らない（書くときに親フォルダを作る）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP_DIR_NAME = 'marust';
const DEV_STATE_NAME = 'dev-state';

function detectPackaged() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.isPackaged === 'boolean') return electron.app.isPackaged;
  } catch (_) { /* Electron の外（node main.js など） */ }
  return false;
}

/** 純粋に近い関数。options: { env, isPackaged, appData, appRoot } はテスト用。{ stateDir, source } を返す。 */
function resolveLocalState(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const fromEnv = typeof env.MARUST_STATE === 'string' ? env.MARUST_STATE.trim() : '';
  if (fromEnv) return { stateDir: path.resolve(fromEnv), source: 'env' };
  const packaged = typeof opts.isPackaged === 'boolean' ? opts.isPackaged : detectPackaged();
  const appData = opts.appData || env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const appDataDir = path.join(path.resolve(appData), APP_DIR_NAME);
  if (packaged) return { stateDir: appDataDir, source: 'appdata' };
  // CLI・MCP（preferAppData）は Electron の外で動くが、exe 本体と同じ保存場所の鍵を使う。exe を入れた PC では %APPDATA%\marust が先（M5 評価 Should 3）。
  if (opts.preferAppData === true) {
    try { if (fs.statSync(appDataDir).isDirectory()) return { stateDir: appDataDir, source: 'appdata' }; } catch (_) { /* 無ければ dev-state */ }
  }
  const appRoot = opts.appRoot || path.join(__dirname, '..', '..');
  return { stateDir: path.join(path.resolve(appRoot), DEV_STATE_NAME), source: 'dev-state' };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.floor(ms)));
  } catch (_) {
    const start = Date.now();
    while (Date.now() - start < ms) { /* 待つだけ */ }
  }
}

/** 同じフォルダの一時ファイルに書いてから置き換える。Windows の EPERM/EBUSY は少し待って再試行。 */
function atomicWriteFileSync(targetPath, data, maxRetries, backoffBase) {
  const retries = maxRetries || 5;
  const base = backoffBase || 50;
  const target = path.resolve(targetPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, path.basename(target) + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex'));
  try {
    const fd = fs.openSync(temp, 'w');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        fs.renameSync(temp, target);
        return;
      } catch (err) {
        const busy = err && (err.code === 'EPERM' || err.code === 'EBUSY');
        if (!busy || attempt === retries - 1) throw err;
        sleepSync(base * Math.pow(2, attempt));
      }
    }
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) { /* 残っても害はない */ }
  }
}

function atomicWriteJsonSync(targetPath, obj, indent, maxRetries, backoffBase) {
  atomicWriteFileSync(targetPath, JSON.stringify(obj, null, indent === undefined ? 2 : indent), maxRetries, backoffBase);
}

/** 新しい場所と古い候補のうち、あるものを返す（新しい場所を優先）。無ければ null。 */
function resolveNewestPath(newPath, legacyPaths) {
  const all = [newPath].concat(Array.isArray(legacyPaths) ? legacyPaths : []);
  for (const candidate of all) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

function attachCoreLifecycle(core) {
  if (!core || typeof core !== 'object') return core;
  const closers = [];
  core.registerCloser = function (fn) {
    if (typeof fn === 'function') closers.push(fn);
  };
  core.attachEngine = function (engine) {
    if (!engine) return;
    core.registerCloser(async () => {
      try {
        if (typeof engine.close === 'function') await engine.close();
        else if (typeof engine.shutdown === 'function') engine.shutdown();
        else if (typeof engine.stop === 'function') await engine.stop();
      } catch (_) {}
      try {
        if (engine.connection && typeof engine.connection.disconnect === 'function') {
          await engine.connection.disconnect();
        } else if (engine.connection && typeof engine.connection.stop === 'function') {
          engine.connection.stop();
        }
      } catch (_) {}
    });
  };
  core.close = async function () {
    while (closers.length > 0) {
      const fn = closers.pop();
      try { await fn(); } catch (_) {}
    }
    if (core.obsLocal) {
      try {
        if (typeof core.obsLocal.close === 'function') await core.obsLocal.close();
        else if (typeof core.obsLocal.shutdown === 'function') core.obsLocal.shutdown();
        else if (typeof core.obsLocal.stop === 'function') await core.obsLocal.stop();
      } catch (_) {}
    }
    if (core.obsConnection) {
      try {
        if (typeof core.obsConnection.disconnect === 'function') await core.obsConnection.disconnect();
        else if (typeof core.obsConnection.stop === 'function') core.obsConnection.stop();
      } catch (_) {}
    }
  };
  return core;
}

function createLocalCore(options) {
  const state = resolveLocalState(options);
  const dir = state.stateDir;
  const localCore = {
    via: 'local',
    localSource: state.source,
    ROOT_DIR: '',
    STATE_DIR: dir,
    COOKIES_DIR: path.join(dir, 'cookies'),
    TOKENS_DIR: path.join(dir, 'tokens'),
    SERVICES_DIR: path.join(dir, 'services'),
    DATA_DIR: path.join(dir, 'data'),
    LOGS_DIR: path.join(dir, 'logs'),
    resolveNewestPath: resolveNewestPath,
    atomicWriteJsonSync: atomicWriteJsonSync,
    atomicWriteFileSync: atomicWriteFileSync
  };
  return attachCoreLifecycle(localCore);
}

module.exports = { createLocalCore, resolveLocalState, atomicWriteFileSync, atomicWriteJsonSync, resolveNewestPath, attachCoreLifecycle };
