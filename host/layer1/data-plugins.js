'use strict';

/**
 * データだけのプラグイン（V8 テーマ・V9 並べ方）の検査。
 * コードを持たない。main・secrets・provides・panels などを持っていれば読み込みを断る（警告で無視はしない）。
 * ctx も作らない。金庫（持ち主の宣言）や vault-store@1 に絡む道を、データだけのプラグインには作らない（K6-result）。
 * 値は形を決めて検査する。外への URL（url(・@import）や ; } の入った値は入る隙間が無い。
 */

const { cleanFor, cleanTags } = require('./manifest-claims');

const DATA_KINDS = Object.freeze(['theme', 'layout', 'set', 'shell']);

// manifest に書いてよい欄。これ以外が 1 つでもあれば断る。
const ALLOWED_KEYS = Object.freeze(['id', 'name', 'version', 'manifestVersion', 'coreApi', 'kind', 'tier', 'audience', 'stability', 'description', 'isDefault', 'for', 'tags', 'theme', 'layout', 'set', 'shell']);

// テーマが上書きできる変数（hub.css の :root）。名前は本体が決めた一覧だけ。値は既定のもの（現在の見た目）。
const THEME_DEFAULTS = Object.freeze({
  bg: '#0e1117',
  panel: '#161b26',
  'panel-2': '#222b3d',
  line: '#283042',
  'line-2': '#3a4660',
  text: '#e6eaf2',
  muted: '#a0aabd',
  accent: '#7aa2ff',
  ok: '#6bcf8e',
  warn: '#e0b35a',
  skip: '#8b93a7',
  danger: '#ff8f8f',
  'input-bg': '#0d1118',
  'tab-bar-bg': '#121722',
  'tab-active-bg': '#1f2840',
  'tab-inactive-bg': '#1a2133'
});
const THEME_FONTS = Object.freeze(['default', 'gothic', 'serif', 'mono']);
const SCHEMES = Object.freeze(['dark', 'light']);
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.5;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;

// 文字と地の組み合わせ（読めなくなるテーマ＝警告が見えなくなるテーマは入れない）。[前景, 背景, 最低の比]
const CONTRAST_PAIRS = Object.freeze([
  ['text', 'bg', 4.5], ['text', 'panel', 4.5], ['text', 'panel-2', 4.5], ['text', 'input-bg', 4.5],
  ['muted', 'panel', 3], ['muted', 'bg', 3], ['muted', 'panel-2', 3], ['danger', 'panel-2', 3], ['warn', 'panel-2', 3], ['danger', 'bg', 3], ['accent', 'panel', 3], ['ok', 'panel', 3], ['warn', 'panel', 3], ['danger', 'panel', 3],
  ['text', 'tab-active-bg', 4.5], ['text', 'tab-inactive-bg', 4.5], ['muted', 'tab-bar-bg', 3]
]);

// 並べ方で置けるのは、本体のタブ部品（ここにある id）とプラグインのパネルだけ。
// 秘密を入力する欄を持つ画面（secrets・obs-connect・site-add）・承認（approvals）・非常停止は置けない（外のコードのパネルの隣にも置かせない）。
const LAYOUT_CORE_PANELS = Object.freeze(['home', 'destinations', 'sites', 'features', 'about', 'migration', 'plugin-manager', 'clients']);
const PLUGIN_PANEL_RE = /^plugin:[a-z0-9][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,31}$/;
const DIRECTIONS = Object.freeze(['right', 'left', 'above', 'below', 'within']);
const LAYOUT_MAX_PLACEMENTS = 12;
const LAYOUT_LEVELS = Object.freeze(['standard', 'advanced']);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (HEX_RE.test(text)) {
    const h = text.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const m = RGB_RE.exec(text);
  if (!m) return null;
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
  return rgb.every((n) => n >= 0 && n <= 255) ? rgb : null;
}

function luminance(rgb) {
  const lin = rgb.map((n) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function labelOk(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 40 && !/[\u0000-\u001f<>]/.test(value);
}

/** theme 欄を検査し、整えた形（vars は既定値を埋めた全部）を返す。 */
function normalizeTheme(raw) {
  if (!plain(raw)) return { error: 'bad-theme' };
  const known = ['label', 'colorScheme', 'font', 'fontScale', 'vars'];
  if (Object.keys(raw).some((k) => known.indexOf(k) === -1)) return { error: 'bad-theme' };
  if (!labelOk(raw.label)) return { error: 'bad-theme' };
  const colorScheme = raw.colorScheme == null ? 'dark' : raw.colorScheme;
  if (SCHEMES.indexOf(colorScheme) === -1) return { error: 'bad-theme' };
  const font = raw.font == null ? 'default' : raw.font;
  if (THEME_FONTS.indexOf(font) === -1) return { error: 'bad-theme' };
  let fontScale = 1;
  if (raw.fontScale != null) {
    if (typeof raw.fontScale !== 'number' || !isFinite(raw.fontScale) || raw.fontScale < FONT_SCALE_MIN || raw.fontScale > FONT_SCALE_MAX) return { error: 'bad-theme' };
    fontScale = Math.round(raw.fontScale * 100) / 100;
  }
  const given = raw.vars == null ? {} : raw.vars;
  if (!plain(given)) return { error: 'bad-theme' };
  const vars = Object.assign({}, THEME_DEFAULTS);
  const rgb = {};
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(THEME_DEFAULTS, key)) return { error: 'bad-theme-var' };
    const color = parseColor(given[key]);
    if (!color) return { error: 'bad-theme-value' };
    vars[key] = given[key].trim();
    rgb[key] = color;
  }
  for (const key of Object.keys(THEME_DEFAULTS)) if (!rgb[key]) rgb[key] = parseColor(THEME_DEFAULTS[key]);
  for (const pair of CONTRAST_PAIRS) {
    if (contrast(rgb[pair[0]], rgb[pair[1]]) < pair[2]) return { error: 'low-contrast' };
  }
  return { theme: { label: raw.label.trim(), colorScheme: colorScheme, font: font, fontScale: fontScale, vars: vars } };
}

/**
 * set 欄を検査する（計画 X・S5b。「セット」＝まとめて入／切・まとめて入れる）。コードを持たず、中身は機能（features.list）の id の一覧だけ。
 * 入れる＝中の機能をそれぞれ入れる（features.set と同じ道。外のサイトへ書く機能は guide のままで、勝手に live にはならない）。
 * 中身が入っていなければ「足りない機能」として出すだけ。勝手に取りに行かない。
 */
const SET_MEMBERS_MAX = 30;
const MEMBER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
function normalizeSet(raw) {
  if (!plain(raw)) return { error: 'bad-set' };
  if (Object.keys(raw).some((k) => ['label', 'members'].indexOf(k) === -1)) return { error: 'bad-set' };
  if (!labelOk(raw.label)) return { error: 'bad-set' };
  if (!Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > SET_MEMBERS_MAX) return { error: 'bad-set' };
  const members = [];
  for (const id of raw.members) {
    if (typeof id !== 'string' || !MEMBER_RE.test(id) || members.indexOf(id) !== -1) return { error: 'bad-set' };
    members.push(id);
  }
  return { set: { label: raw.label.trim(), members: members } };
}

/**
 * shell 欄を検査する（計画 C・C3-1。「画面の本体役」＝窓口の枠のページに入れる scripts・styles と既定のレイアウト）。
 * コードはブラウザの中で動くもので、ホストでは動かさない（main も ctx も無い）。ファイルは <プラグインのフォルダ>/shell/ の下だけ
 * （欄には shell/ からの相対で書く）。書き方の形だけ見る。ファイルがあるかは読み込むとき（discover）に見る。
 */
const SHELL_SCRIPTS_MAX = 40;
const SHELL_STYLES_MAX = 10;
const SHELL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}){0,4}$/;
function shellPathOk(value, ext) {
  if (typeof value !== 'string' || !SHELL_PATH_RE.test(value) || value.length > 200) return false;
  if (value.split('/').some((part) => part === '..' || part === '.')) return false;
  return value.toLowerCase().endsWith(ext);
}
function normalizeShell(raw) {
  if (!plain(raw)) return { error: 'bad-shell' };
  if (Object.keys(raw).some((k) => ['label', 'scripts', 'styles', 'layout', 'template'].indexOf(k) === -1)) return { error: 'bad-shell' };
  if (!labelOk(raw.label)) return { error: 'bad-shell' };
  if (!Array.isArray(raw.scripts) || raw.scripts.length < 1 || raw.scripts.length > SHELL_SCRIPTS_MAX) return { error: 'bad-shell' };
  const styles = raw.styles == null ? [] : raw.styles;
  if (!Array.isArray(styles) || styles.length > SHELL_STYLES_MAX) return { error: 'bad-shell' };
  const scripts = [];
  for (const item of raw.scripts) {
    if (!shellPathOk(item, '.js') || scripts.indexOf(item) !== -1) return { error: 'bad-shell-path' };
    scripts.push(item);
  }
  const cleanStyles = [];
  for (const item of styles) {
    if (!shellPathOk(item, '.css') || cleanStyles.indexOf(item) !== -1) return { error: 'bad-shell-path' };
    cleanStyles.push(item);
  }
  let layout = '';
  if (raw.layout != null) {
    if (!shellPathOk(raw.layout, '.json')) return { error: 'bad-shell-path' };
    layout = raw.layout;
  }
  if (raw.template != null && !shellPathOk(raw.template, '.html')) return { error: 'bad-shell-path' };
  return { shell: { label: raw.label.trim(), scripts: scripts, styles: cleanStyles, layout: layout, template: raw.template || '' } };
}

/** layout 欄を検査し、整えた形を返す。置く順に並べる（beside は前に出てきたパネルだけ）。 */
function normalizeLayout(raw) {
  if (!plain(raw)) return { error: 'bad-layout' };
  const known = ['label', 'levels', 'placements'];
  if (Object.keys(raw).some((k) => known.indexOf(k) === -1)) return { error: 'bad-layout' };
  if (!labelOk(raw.label)) return { error: 'bad-layout' };
  let levels = LAYOUT_LEVELS.slice();
  if (raw.levels != null) {
    if (!Array.isArray(raw.levels) || !raw.levels.length || raw.levels.some((l) => LAYOUT_LEVELS.indexOf(l) === -1)) return { error: 'bad-layout' };
    levels = LAYOUT_LEVELS.filter((l) => raw.levels.indexOf(l) !== -1);
  }
  if (!Array.isArray(raw.placements) || raw.placements.length < 1 || raw.placements.length > LAYOUT_MAX_PLACEMENTS) return { error: 'bad-layout' };
  const placements = [];
  const seen = new Set();
  for (const item of raw.placements) {
    if (!plain(item) || Object.keys(item).some((k) => ['panel', 'beside', 'direction'].indexOf(k) === -1)) return { error: 'bad-layout' };
    const panel = item.panel;
    const placeable = typeof panel === 'string' && (LAYOUT_CORE_PANELS.indexOf(panel) !== -1 || PLUGIN_PANEL_RE.test(panel));
    if (!placeable) return { error: 'bad-layout-panel' };
    if (seen.has(panel)) return { error: 'bad-layout' };
    let beside = '';
    let direction = '';
    if (placements.length) {
      beside = typeof item.beside === 'string' ? item.beside : placements[0].panel;
      direction = item.direction == null ? 'right' : item.direction;
      if (!seen.has(beside) || DIRECTIONS.indexOf(direction) === -1) return { error: 'bad-layout' };
    } else if (item.beside != null || item.direction != null) {
      return { error: 'bad-layout' };
    }
    seen.add(panel);
    placements.push({ panel: panel, beside: beside, direction: direction });
  }
  return { layout: { label: raw.label.trim(), levels: levels, placements: placements } };
}

// 共通の欄の形。データだけのプラグインは段階（tier）・hiddenPlugins では止めない（見た目と並べ方の選択肢。並べ方は levels で絞る）。
const COMMON_ENUMS = Object.freeze({
  tier: ['basic', 'standard', 'advanced'],
  audience: ['public', 'dev', 'author'],
  stability: ['stable', 'experimental']
});
const DESCRIPTION_MAX = 200;

function commonFieldsOk(manifest) {
  for (const key of Object.keys(COMMON_ENUMS)) {
    if (manifest[key] != null && COMMON_ENUMS[key].indexOf(manifest[key]) === -1) return false;
  }
  if (manifest.description != null && (typeof manifest.description !== 'string' || manifest.description.length > DESCRIPTION_MAX)) return false;
  if (manifest.for != null && (!Array.isArray(manifest.for) || cleanFor(manifest.for).length !== manifest.for.length)) return false;
  if (manifest.tags != null && (!Array.isArray(manifest.tags) || cleanTags(manifest.tags).length !== manifest.tags.length)) return false;
  if (manifest.isDefault != null && typeof manifest.isDefault !== 'boolean') return false; // テーマの「標準」の印（選んでいない・見つからないときに使う。内蔵だけが付ける）
  return true;
}

/**
 * データだけのプラグインの manifest を検査する。
 * 戻り値: { error: 理由 } か { kind, theme } か { kind, layout }。
 */
function validateDataManifest(manifest) {
  if (!plain(manifest) || DATA_KINDS.indexOf(manifest.kind) === -1) return { error: 'not-data-plugin' };
  if (Object.keys(manifest).some((k) => ALLOWED_KEYS.indexOf(k) === -1)) return { error: 'data-only-forbidden-field' };
  if (manifest.manifestVersion !== 2) return { error: 'bad-manifest' };
  if (!commonFieldsOk(manifest)) return { error: 'bad-manifest' };
  if (manifest.kind === 'shell') {
    if (manifest.theme != null || manifest.layout != null || manifest.set != null) return { error: 'data-only-forbidden-field' };
    const gotShell = normalizeShell(manifest.shell);
    return gotShell.error ? { error: gotShell.error } : { kind: 'shell', shell: gotShell.shell };
  }
  if (manifest.shell != null) return { error: 'data-only-forbidden-field' };
  if (manifest.kind === 'theme') {
    if (manifest.layout != null || manifest.set != null) return { error: 'data-only-forbidden-field' };
    const got = normalizeTheme(manifest.theme);
    return got.error ? { error: got.error } : { kind: 'theme', theme: got.theme };
  }
  if (manifest.kind === 'set') {
    if (manifest.theme != null || manifest.layout != null) return { error: 'data-only-forbidden-field' };
    const gotSet = normalizeSet(manifest.set);
    return gotSet.error ? { error: gotSet.error } : { kind: 'set', set: gotSet.set };
  }
  if (manifest.theme != null || manifest.set != null) return { error: 'data-only-forbidden-field' };
  const got = normalizeLayout(manifest.layout);
  return got.error ? { error: got.error } : { kind: 'layout', layout: got.layout };
}

module.exports = {
  DATA_KINDS,
  ALLOWED_KEYS,
  THEME_DEFAULTS,
  THEME_FONTS,
  LAYOUT_CORE_PANELS,
  validateDataManifest,
  normalizeTheme,
  normalizeLayout,
  normalizeSet,
  normalizeShell,
  contrast,
  parseColor
};
