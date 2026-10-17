'use strict';

/**
 * 開発者モードの判定を 1 か所に集める（R1）。
 * 強い順: 環境変数 MARUST_DEV=1/0 → <STATE_DIR>/data/marust/ui-settings.json の devMode → 既定。
 * 既定は「ソースから起動＝オン、exe（app.isPackaged）＝オフ」。Electron なし（node main.js）はオン。
 * ui-settings.json に他のキーがあっても壊さない。読むだけではファイルを作らない。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;

/** 純粋関数。env は 'MARUST_DEV' の値、setting は boolean か undefined。 */
function resolveDevMode(input) {
  const o = input || {};
  const env = o.env == null ? '' : String(o.env).trim();
  if (env === '1') return { devMode: true, source: 'env' };
  if (env === '0') return { devMode: false, source: 'env' };
  if (typeof o.setting === 'boolean') return { devMode: o.setting, source: 'setting' };
  return { devMode: o.isPackaged !== true, source: 'default' };
}

function settingsFile(stateDir) {
  return path.join(stateDir, 'data', 'marust', 'ui-settings.json');
}

function readObject(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { ok: false, data: null };
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, data: null };
    return { ok: true, data: data };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, data: {}, missing: true };
    return { ok: false, data: null };
  }
}

/**
 * deps: { isPackaged, env(=process.env), stateDir, atomicWriteJsonSync }
 * stateDir が無いときは設定の読み書きをせず、環境変数と既定だけで決める。
 */
function createDevMode(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const stateDir = typeof d.stateDir === 'string' && d.stateDir ? d.stateDir : '';

  function readSetting() {
    if (!stateDir) return undefined;
    const read = readObject(settingsFile(stateDir));
    if (!read.ok || !read.data) return undefined;
    return typeof read.data.devMode === 'boolean' ? read.data.devMode : undefined;
  }

  function get() {
    return resolveDevMode({ env: env.MARUST_DEV, setting: readSetting(), isPackaged: d.isPackaged === true });
  }

  function set(value) {
    if (typeof value !== 'boolean') return { ok: false, error: 'bad-value' };
    const envValue = env.MARUST_DEV == null ? '' : String(env.MARUST_DEV).trim();
    if (envValue === '1' || envValue === '0') return { ok: false, error: 'env-locked' };
    if (!stateDir) return { ok: false, error: 'unavailable' };
    const file = settingsFile(stateDir);
    const read = readObject(file);
    if (!read.ok) return { ok: false, error: 'unreadable' };
    const next = Object.assign({}, read.data, { devMode: value });
    try {
      if (typeof d.atomicWriteJsonSync === 'function') {
        d.atomicWriteJsonSync(file, next);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
      }
    } catch (_) {
      return { ok: false, error: 'write-failed' };
    }
    return { ok: true, devMode: get().devMode };
  }

  return { get: get, set: set, isOn: function () { return get().devMode; } };
}

module.exports = { createDevMode, resolveDevMode };
