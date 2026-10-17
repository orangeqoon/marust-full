'use strict';

/**
 * 画面のソースを文字列で見るテスト用（R15 の続き）。
 * ui/ の直書きの日本語は plugins/ui-standard/shell/strings.js の STR.ui… へ移した。ソースの中の文言を調べるテストが元の文言のまま調べられるよう、
 * ui/ の .js を読むとき STR.ui<名前> をその文字列（' で囲む）に戻して返す。あわせて、パネルを node で動かすテスト用に global.STR を用意する。
 * テストの先頭で require('./_ui-inline') するだけ。
 */

const fs = require('fs');
const path = require('path');

const STR = require('../plugins/ui-standard/shell/strings');
global.STR = global.STR || STR;

const UI_DIR = path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell') + path.sep;
const original = fs.readFileSync;

function quote(value) {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function inline(text) {
  return text.replace(/STR\.(ui[A-Za-z0-9]+)\b/g, (whole, key) => {
    const value = STR[key];
    return typeof value === 'string' ? quote(value) : whole;
  });
}

fs.readFileSync = function patched(file) {
  const result = original.apply(this, arguments);
  if (typeof result !== 'string' || typeof file !== 'string') return result;
  const normal = path.resolve(file);
  if (normal.startsWith(UI_DIR) && normal.endsWith('.js') && path.basename(normal) !== 'strings.js') return inline(result);
  return result;
};

module.exports = { inline };
