'use strict';

/**
 * 試験の部品: みんなのプラグイン（隣の streaming/marust-plugins/plugins/<id>/。計画 X・S10）の場所を引く。
 * 本体の試験は、一覧に出したプラグイン（timer・gcal など）の中身を読むときだけこれを使う。
 * 一覧のフォルダが無い木（公開の書き出し）では exists() が false になり、使う試験は飛ばす。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'marust-plugins', 'plugins');

/** みんなのプラグインの id の置き場の絶対パス。 */
function dir(id) { return path.join(ROOT, id); }

/** 'plugins/<id>/…' 形の相対パスを、一覧の置き場の絶対パスに直す（一覧に無い id は本体の木のまま）。 */
function resolveRel(rel) {
  const m = /^plugins\/([^/]+)(\/.*)?$/.exec(rel);
  if (m && fs.existsSync(dir(m[1]))) return path.join(dir(m[1]), (m[2] || '').slice(1));
  return path.join(__dirname, '..', rel);
}

module.exports = { ROOT, dir, resolveRel, exists: () => fs.existsSync(ROOT) };
