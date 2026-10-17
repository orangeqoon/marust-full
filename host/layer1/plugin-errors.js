// @ts-check
'use strict';

/**
 * プラグインの例外・ログを AI に見せてよい形にする（V0.5 D4）。
 * 絶対パスは <plugin>（プラグインのフォルダ）・<app>（本体）・~（ホーム）に置き換え、最後に redact を通す。
 * where は「プラグインのフォルダからの相対パス:行」。フォルダの外の行は捨てる。パスに空白があっても取れる。
 */

const os = require('os');
const { redact } = require('../core');

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanText(value, pluginDir, appRoot) {
  let text = value == null ? '' : String(value);
  const swaps = [[pluginDir, '<plugin>'], [appRoot, '<app>'], [os.homedir(), '~']];
  for (const pair of swaps) {
    const base = pair[0];
    if (typeof base !== 'string' || base.length < 3) continue;
    const trimmed = base.replace(/[\\/]+$/, '');
    // スラッシュ・バックスラッシュのどちらでも、大文字小文字を問わず当てる
    const pattern = escapeRe(trimmed).replace(/\\\\|\//g, '[\\\\/]');
    text = text.replace(new RegExp(pattern, 'gi'), pair[1]);
  }
  // 最後の網: 8.3 の短い名前（MISTER~1）などで上の置き換えから漏れたホームの下のパスと、ユーザー名そのもの
  text = text.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s:'"()]+/gi, '~');
  let user = '';
  try { user = os.userInfo().username; } catch (_) { user = ''; }
  if (user && user.length >= 3) text = text.replace(new RegExp(escapeRe(user), 'gi'), '<user>');
  return redact(text);
}

function cleanError(err, pluginDir, appRoot) {
  const rawMessage = err && err.message != null ? err.message : err;
  const stack = err && typeof err.stack === 'string' ? err.stack : '';
  let where = '';
  const root = typeof pluginDir === 'string'
    ? pluginDir.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
    : '';
  if (root && stack) {
    // スラッシュにそろえた文字列の中で「<フォルダ>/」を探し、その後ろの「相対パス:行」を取る（空白を含んでよい。':' と改行と括弧は含まない）
    const norm = stack.replace(/\\/g, '/');
    const low = norm.toLowerCase();
    let from = 0;
    while (from < low.length) {
      const at = low.indexOf(root + '/', from);
      if (at === -1) break;
      const rest = norm.slice(at + root.length + 1);
      const m = /^([^\n():]+?):(\d+)/.exec(rest);
      if (m) { where = m[1] + ':' + m[2]; break; }
      from = at + root.length + 1;
    }
  }
  return { message: cleanText(rawMessage, pluginDir, appRoot).slice(0, 300), where };
}

module.exports = { cleanText, cleanError };
