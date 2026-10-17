'use strict';

/**
 * 保存場所（core）を作る。
 *
 * 作者の PC の保存場所の探し方は、プラグインの読み込みより前に決まるので「差し込み」にしてある:
 * 作者用のフォルダ plugins-author/<役割 storage.locator@1 を名乗るプラグイン>/locator.js があれば、それが createCore / resolveCoreDir / pathsJs を出す。
 * 配り物（plugins-author が入らない）には無いので、丸スト自身の小さな代わり（paths-local.js。R10）を使う。本体は作者の保存場所の探し方を知らない。
 *
 * locator が NOT_FOUND を投げたとき（見つからない。配った exe など）は止まらず、代わりを使う。
 * ただし locator が指定ミス（misconfigured）と言うときは止まる。
 * 作者用の build（plugins-author がある）は、見失っても黙って空の保存場所へ切り替えない（M5 評価 Must 1）。MARUST_STATE を明示したときだけ許す。
 */

const fs = require('fs');
const path = require('path');
const { createLocalCore } = require('./paths-local');
const { resolveSetDirs, isAuthorBuild } = require('./set-dirs');

const NOT_FOUND = 'MARUST_SCRIPTS_CORE_NOT_FOUND'; // 差し込みが「見つからない」と言うときのコード
const LOCATOR_ROLE = 'storage.locator@1'; // 差し込みが名乗る役割（manifest の provides）

const APP_ROOT = path.join(__dirname, '..', '..');

/** セットの置き場のうち、作者用の印（plugins-author）が付いたもの（決め方は set-dirs.js。作者の版は exe の外のリポジトリを指す）。無ければ []。 */
function authorDirs() {
  try { return resolveSetDirs({ appRoot: APP_ROOT }).dirs.filter((row) => row.author).map((row) => row.dir); } catch (_) { return []; }
}

/** plugins-author の中で、provides に storage.locator@1 を持つプラグインの locator.js の場所。無ければ ''。 */
function findLocatorFile(authorDir) {
  let names = [];
  try { names = fs.readdirSync(authorDir); } catch (_) { return ''; }
  for (let i = 0; i < names.length; i += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(authorDir, names[i], 'manifest.json'), 'utf8'));
      if (Array.isArray(manifest.provides) && manifest.provides.indexOf(LOCATOR_ROLE) !== -1) return path.join(authorDir, names[i], 'locator.js');
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
    const dirs = authorDirs();
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
  if (locator) {
    try {
      const opts = options ? Object.assign({}, options, { startDir: options.startDir || __dirname }) : undefined;
      return locator.createCore(opts);
    } catch (err) {
      if (!(err && err.code === NOT_FOUND) || err.misconfigured === true) throw err;
      // 作者用の build は、見失っても黙って空の保存場所へ切り替えない。MARUST_STATE を明示したときだけ許す。
      const stateEnv = (localOpts && localOpts.env ? localOpts.env : process.env).MARUST_STATE;
      const authorBuild = options && typeof options.authorBuild === 'boolean' ? options.authorBuild : isAuthorBuild(APP_ROOT);
      if (authorBuild && !stateEnv) throw err;
      return useLocal(localOpts, '作者用の保存場所が見つからないので');
    }
  }
  // 作者用の build（plugins-author がある）なのに差し込みが無い = 配り物が壊れている。黙って空の保存場所で起動しない（V6 評価 Must 1）。MARUST_STATE を明示したときだけ許す。
  const stateEnv = (localOpts && localOpts.env ? localOpts.env : process.env).MARUST_STATE;
  const authorBuild = options && typeof options.authorBuild === 'boolean' ? options.authorBuild : isAuthorBuild(APP_ROOT);
  if (authorBuild && !stateEnv) {
    const err = new Error('保存場所の差し込み（plugins-author の中の役割 ' + LOCATOR_ROLE + '）がありません。作者用の配り物が壊れています。');
    err.code = NOT_FOUND;
    throw err;
  }
  return useLocal(localOpts, '');
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
