'use strict';

/**
 * 秘密の末尾 4 文字を作る（直す所 34・ADR 0006）。
 * 画面に秘密の値を直接出さず、事故防止のため末尾 4 文字だけを見せる。
 * 値が 12 文字以上なら '••••' + 末尾 4 文字。
 * 12 文字未満なら '••••' のみ（短い値の末尾は値の大半なので見せない）。
 * 値が無ければ ''。
 */

const BULLETS = '••••';

function tailOf(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length >= 12) {
    return BULLETS + value.slice(-4);
  }
  return BULLETS;
}

module.exports = {
  tailOf,
  BULLETS
};
