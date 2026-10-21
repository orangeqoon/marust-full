'use strict';

/**
 * セット（配るプラグインのまとまり）の置き場の決め方（計画 C・D6）。先に見つかったものを使う:
 *   1. 環境変数 MARUST_SET_DIR（複数はパスの区切り。Windows は ;。フォルダ名が plugins-author のものは作者用の印）
 *   2. appRoot の build-info.json の setDirs（作者の build が書く。文字列か { dir, author, community } の並び）
 *   3. exe の横の plugins/（配る版。appRoot が resources/app のとき、exe のフォルダの plugins）
 *   4. ソースから起動したとき: リポジトリの plugins・隣の marust-plugins/plugins・plugins-author（今までどおり）
 * 配る版（resources/app）で 1〜3 のどれも見つからないときは空（核だけで起動）。リポジトリの置き場は探さない。
 * 返す行: { dir, source: 'set', author, community }。author は置き場の印（フォルダ名 plugins-author。版の判定や守りには使わない）、community はみんなのプラグインの置き場（三層目）。
 */

const fs = require('fs');
const path = require('path');

const PACKAGED_RE = /[\\/]resources[\\/]app(\.asar)?$/;

function isPackagedRoot(appRoot) {
  return PACKAGED_RE.test(path.resolve(appRoot));
}

function isDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function rowOf(item) {
  // 文字列は、フォルダ名が plugins-author なら作者用の印、それ以外は印なし（環境変数で作者の手元をリポジトリに向けるとき用）
  if (typeof item === 'string') {
    if (!item) return null;
    const dir = path.resolve(item);
    return { dir, source: 'set', author: path.basename(dir) === 'plugins-author', community: false };
  }
  if (!item || typeof item.dir !== 'string' || !item.dir) return null;
  return { dir: path.resolve(item.dir), source: 'set', author: item.author === true, community: item.community === true };
}

function readBuildSetDirs(appRoot) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(appRoot, 'build-info.json'), 'utf8'));
    return Array.isArray(info && info.setDirs) ? info.setDirs.map(rowOf).filter(Boolean) : [];
  } catch (_) { return []; }
}

function resolveSetDirs(opts) {
  const appRoot = opts.appRoot;
  const env = opts.env || process.env;
  const exists = (rows) => rows.filter((row) => isDir(row.dir));

  const envRows = String(env.MARUST_SET_DIR || '').split(path.delimiter).map((p) => rowOf(p.trim())).filter(Boolean);
  const fromEnv = exists(envRows);
  if (fromEnv.length) return { from: 'env', dirs: fromEnv };
  const envMissing = envRows.length > 0; // 環境変数を付けたのに 1 つも無かった（下の段へ落ちた）

  const fromInfo = exists(readBuildSetDirs(appRoot));
  if (fromInfo.length) return { from: 'build-info', dirs: fromInfo, envMissing };

  const packaged = isPackagedRoot(appRoot);
  if (packaged) {
    const beside = path.join(path.dirname(path.dirname(path.resolve(appRoot))), 'plugins');
    return isDir(beside) ? { from: 'exe', dirs: [rowOf(beside)], envMissing } : { from: 'none', dirs: [], envMissing };
  }

  const dirs = [];
  const own = path.join(appRoot, 'plugins');
  if (isDir(own)) dirs.push({ dir: own, source: 'set', author: false, community: false });
  const sibling = path.join(appRoot, '..', 'marust-plugins', 'plugins');
  if (isDir(sibling)) dirs.push({ dir: path.resolve(sibling), source: 'set', author: false, community: true });
  const author = path.join(appRoot, 'plugins-author');
  if (isDir(author)) dirs.push({ dir: author, source: 'set', author: true, community: false });
  return { from: 'source', dirs, envMissing };
}

module.exports = { resolveSetDirs, isPackagedRoot };
