'use strict';
/**
 * テーマ（V8）。データだけのプラグイン（kind:theme）の色・字を、画面の変数へ当てる。
 * 当て方は CSSOM（style.setProperty）だけ。<style> も style 属性も作らないので、窓口の CSP（style-src 'self'）のまま。
 * 受け取った値は、ここでも形を確かめる（色は #rgb / #rrggbb / rgb()。字は本体が持つ一覧から。外への URL を入れる隙間は無い）。
 */
var THEME_FONTS = {
  'default': '"Segoe UI", "Yu Gothic UI", "Meiryo", sans-serif',
  gothic: '"Yu Gothic UI", "Meiryo", "Segoe UI", sans-serif',
  serif: '"Yu Mincho", "Hiragino Mincho ProN", Georgia, serif',
  mono: 'ui-monospace, Consolas, "Yu Gothic UI", monospace'
};
var THEME_VAR_NAMES = ['bg', 'panel', 'panel-2', 'line', 'line-2', 'text', 'muted', 'accent', 'ok', 'warn', 'skip', 'danger', 'input-bg', 'tab-bar-bg', 'tab-active-bg', 'tab-inactive-bg'];
var THEME_COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;
var THEME_CACHE_KEY = 'marust.theme.v1';
var currentThemeId = '';
var themeList = [];

function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return false;
  var root = document.documentElement;
  var vars = theme.vars && typeof theme.vars === 'object' ? theme.vars : {};
  THEME_VAR_NAMES.forEach(function (name) {
    var value = vars[name];
    if (typeof value === 'string' && THEME_COLOR_RE.test(value)) root.style.setProperty('--' + name, value);
    else root.style.removeProperty('--' + name);
  });
  root.style.setProperty('--font-ui', THEME_FONTS[theme.font] || THEME_FONTS['default']);
  var scale = Number(theme.fontScale);
  root.style.setProperty('--font-scale', scale >= 0.85 && scale <= 1.5 ? String(scale) : '1');
  root.style.setProperty('color-scheme', theme.colorScheme === 'light' ? 'light' : 'dark');
  try { document.dispatchEvent(new CustomEvent('marust:theme-applied')); } catch (_) { /* 古い環境では iframe パネルに届かないだけ */ }
  return true;
}

function cacheTheme(theme) {
  try { window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(theme)); } catch (_) { /* 使えなければ、毎回本体から読む */ }
}

// 前回の見た目を、本体の答えを待たずに当てる（起動のたびに暗い色がちらつかないように）。
function applyCachedTheme() {
  try {
    var text = window.localStorage.getItem(THEME_CACHE_KEY);
    if (text) applyTheme(JSON.parse(text));
  } catch (_) { /* 壊れていれば、本体の答えで当て直す */ }
}

function adoptThemeAnswer(res) {
  if (!res || res.ok === false) return;
  currentThemeId = typeof res.id === 'string' ? res.id : '';
  themeList = Array.isArray(res.themes) ? res.themes : [];
  if (applyTheme(res)) cacheTheme({ vars: res.vars, font: res.font, fontScale: res.fontScale, colorScheme: res.colorScheme });
}

function initTheme() {
  applyCachedTheme();
  return call('ui.getTheme').then(adoptThemeAnswer).catch(function () { /* 読めなければ同梱の見た目のまま */ });
}

function chooseTheme(id) {
  return call('ui.setTheme', { id: id }).then(function (res) {
    if (res && res.ok !== false) adoptThemeAnswer(res);
    else window.alert('見た目を変えられませんでした');
  }).catch(function () { window.alert('見た目を変えられませんでした'); });
}
