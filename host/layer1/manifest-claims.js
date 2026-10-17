'use strict';

/**
 * manifest の「名乗り」（計画 X・P1/P8）の検査。本体はプラグインの名前を知らず、名乗ったものを並べるだけ。
 * - category: 種類 1 つ。決まった語だけ（画面の「種類ごと」の分け方に使う。旧 feature.group の置き換え）
 * - for: 効くサイトの id の配列（["<サイトの id>"]・全部に効くなら ["*"]・サイトに関係なければ書かない）
 * - tags: 自由な語（検索だけ。分け方には使わない）
 * - owns: { events, parentActions }（内蔵だけ。host/core/owners.js）
 * 壊れた欄は捨てて warn する（プラグインは落とさない）。
 */

const CATEGORY_WORDS = Object.freeze({
  destination: '配信先',
  title: '題名とカテゴリ',
  comment: 'コメント',
  slot: '自動枠取り',
  login: 'ログイン',
  look: '見た目',
  layout: '並べ方',
  tool: '便利',
  connect: 'AI・外とつなぐ',
  dev: '開発者',
  set: 'セット'
});
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TAG_RE = /^[^\s,]{1,24}$/;

function isCategory(word) {
  return typeof word === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_WORDS, word);
}

function cleanFor(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  list.forEach((x) => { if (typeof x === 'string' && (x === '*' || SITE_ID_RE.test(x)) && out.indexOf(x) === -1) out.push(x); });
  return out.slice(0, 20);
}

function cleanTags(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  list.forEach((x) => { if (typeof x === 'string' && TAG_RE.test(x) && out.indexOf(x) === -1) out.push(x); });
  return out.slice(0, 8);
}

/** manifest（正規化の途中）に category・for・tags を整えて書き戻す。 */
function normalizeClaims(manifest, id, log) {
  if (Object.prototype.hasOwnProperty.call(manifest, 'category')) {
    if (!isCategory(manifest.category)) { log('warn', 'ignore category on ' + id); delete manifest.category; }
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'for')) {
    const clean = cleanFor(manifest.for);
    if (!Array.isArray(manifest.for) || clean.length !== manifest.for.length) log('warn', 'ignore for count on ' + id);
    if (clean.length) manifest.for = clean; else delete manifest.for;
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'tags')) {
    const clean = cleanTags(manifest.tags);
    if (!Array.isArray(manifest.tags) || clean.length !== manifest.tags.length) log('warn', 'ignore tags count on ' + id);
    if (clean.length) manifest.tags = clean; else delete manifest.tags;
  }
}

module.exports = { CATEGORY_WORDS, isCategory, cleanFor, cleanTags, normalizeClaims, SITE_ID_RE };
