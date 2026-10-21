'use strict';

/**
 * 保存場所（core）を作る。
 *
 * 保存場所の探し方は、プラグインの読み込みより前に決まるので「差し込み」にしてある:
 * セットの置き場（MARUST_SET_DIR など）のどれかに、役割 storage.locator@1 を名乗るプラグインの locator.js があれば、
 * それが createCore / resolveCoreDir / pathsJs を出す。置き場の種類（作者用かどうか）では選ばない。
 * 無ければ丸スト自身の小さな代わり（paths-local.js。R10）を使う。本体は保存場所の探し方を知らない。
 *
 * locator が NOT_FOUND を投げたとき（見つからない）は止まらず、代わりを使う。
 * ただし locator が指定ミス（misconfigured）と言うときは止まる。
 */

const fs = require('fs');
const path = require('path');
const { createLocalCore, attachCoreLifecycle } = require('./paths-local');
const { resolveSetDirs } = require('./set-dirs');

const NOT_FOUND = 'MARUST_SCRIPTS_CORE_NOT_FOUND'; // 差し込みが「見つからない」と言うときのコード
const LOCATOR_ROLE = 'storage.locator@1'; // 差し込みが名乗る役割（manifest の provides）

const APP_ROOT = path.join(__dirname, '..', '..');

/** セットの置き場のうち、みんなのプラグイン（community）でないもの。差し込みはプラグインの読み込みより前に require するので、外から入れた置き場は見ない。無ければ []。 */
function locatorDirs() {
  try { return resolveSetDirs({ appRoot: APP_ROOT }).dirs.filter((row) => !row.community).map((row) => row.dir); } catch (_) { return []; }
}

/** 置き場の中で、provides に storage.locator@1 を持つプラグインの locator.js の場所。無ければ ''。 */
function findLocatorFile(rootDir) {
  let names = [];
  try { names = fs.readdirSync(rootDir); } catch (_) { return ''; }
  for (let i = 0; i < names.length; i += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, names[i], 'manifest.json'), 'utf8'));
      if (Array.isArray(manifest.provides) && manifest.provides.indexOf(LOCATOR_ROLE) !== -1) return path.join(rootDir, names[i], 'locator.js');
    } catch (_) { /* manifest の無いフォルダ */ }
  }
  return '';
}

/** 差し込み。無ければ null（配り物）。options.locator は試験用（null で無し、パスで差し替え）。 */
function loadLocator(options) {
  const given = options && options.locator !== undefined ? options.locator : undefined;
  if (given === null) return null;
  let file = given || '';
  if (!file) {
    const dirs = locatorDirs();
    for (let i = 0; i < dirs.length && !file; i += 1) file = findLocatorFile(dirs[i]);
  }
  if (!file) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch (_) {
    return null;
  }
  return require(file);
}


function createCore(options) {
  const locator = loadLocator(options);
  const localOpts = options && options.local ? options.local : undefined;
  let core;
  if (locator) {
    try {
      const opts = options ? Object.assign({}, options, { startDir: options.startDir || __dirname }) : undefined;
      core = locator.createCore(opts);
    } catch (err) {
      if (!(err && err.code === NOT_FOUND) || err.misconfigured === true) throw err;
      core = useLocal(localOpts, '差し込みの保存場所が見つからないので');
    }
  } else {
    core = useLocal(localOpts, '');
  }
  return attachCoreLifecycle(core);
}

function useLocal(localOpts, why) {
  const local = createLocalCore(localOpts);
  if (why) {
    try { console.error('[marust] state=local source=' + local.localSource + '（' + why + '、丸スト自身の保存場所を使います）'); } catch (_) { /* ログで止めない */ }
  }
  return local;
}

/** 差し込みが見つけた保存場所の部品の場所（試験・移行用）。差し込みが無ければ投げる。 */
function resolveCoreDir(options) {
  const locator = loadLocator(options);
  if (!locator) {
    const err = new Error('保存場所の差し込みがありません。');
    err.code = NOT_FOUND;
    throw err;
  }
  return locator.resolveCoreDir(options ? Object.assign({}, options, { startDir: options.startDir || __dirname }) : { startDir: __dirname });
}

module.exports = {
  createCore: createCore,
  resolveCoreDir: resolveCoreDir,
  get PATHS_JS() {
    const locator = loadLocator();
    return locator ? locator.pathsJs() : '';
  }
};
