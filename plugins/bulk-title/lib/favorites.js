'use strict';

/**
 * 題名・カテゴリのお気に入り。旧いアプリからの引き継ぎは、開発者プラグイン dev-legacy-import が merge で足す。
 * 置き場（K3）: プラグイン自身の dataDir/favorites.json  { version: 1, titles: [], categories: [] }（opts.dir）。旧い置き場 <STATE_DIR>/data/marust/favorites.json からは、初めて読むとき 1 回だけ写す（元は消さない）。
 * opts.core を渡す古い呼び方（試験）は、今までどおり <STATE_DIR>/data/marust/favorites.json。
 * 新しいものが先頭、最大 50 件、同じ文字列は入れない。文字数は題名 200・カテゴリ 100 まで。
 * 戻り値は件数と、保存済みの文字列だけ。
 */

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 50;
const MAX_LEN = { title: 200, category: 100 };
const KEY = { title: 'titles', category: 'categories' };
const MAX_FILE_BYTES = 1024 * 1024;

function fail(code) {
  return { ok: false, error: code };
}

function cleanText(kind, value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > MAX_LEN[kind]) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function cleanList(kind, list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length && out.length < MAX_ITEMS; i += 1) {
    const text = cleanText(kind, list[i]);
    if (text && out.indexOf(text) === -1) out.push(text);
  }
  return out;
}

function readJsonFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (_) {
    return null;
  }
}

function createFavorites(options) {
  const opts = options || {};
  const core = opts.core || {};
  const stateDir = typeof core.STATE_DIR === 'string' ? core.STATE_DIR : '';
  const dir = typeof opts.dir === 'string' && opts.dir ? opts.dir : '';
  const file = dir ? path.join(dir, 'favorites.json') : (stateDir ? path.join(stateDir, 'data', 'marust', 'favorites.json') : '');
  // dataDir は <STATE>/data/marust/plugins/<id>。旧い置き場はその 2 つ上
  const legacyFile = dir ? path.resolve(dir, '..', '..', 'favorites.json') : '';

  function load() {
    let data = file ? readJsonFile(file) : null;
    if (!data && dir && legacyFile) {
      const old = readJsonFile(legacyFile);
      if (old) {
        data = old;
        save({ titles: cleanList('title', old.titles), categories: cleanList('category', old.categories) });
      }
    }
    return {
      titles: cleanList('title', data && data.titles),
      categories: cleanList('category', data && data.categories)
    };
  }

  function save(state) {
    if (!file) return false;
    const body = { version: 1, titles: state.titles.slice(0, MAX_ITEMS), categories: state.categories.slice(0, MAX_ITEMS) };
    const write = opts.writeJson || core.atomicWriteJsonSync;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (typeof write === 'function') {
        write(file, body);
      } else if (dir) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(body) + '\n', 'utf8');
        fs.renameSync(tmp, file);
      } else {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function get() {
    const state = load();
    return { ok: true, titles: state.titles, categories: state.categories, max: MAX_ITEMS };
  }

  function kindOf(value) {
    return value === 'title' || value === 'category' ? value : '';
  }

  function add(kindRaw, value) {
    const kind = kindOf(kindRaw);
    if (!kind) return fail('bad-kind');
    const text = cleanText(kind, value);
    if (!text) return fail('bad-value');
    const state = load();
    const list = state[KEY[kind]];
    if (list.indexOf(text) !== -1) return Object.assign(get(), { added: false });
    list.unshift(text);
    if (list.length > MAX_ITEMS) list.length = MAX_ITEMS;
    if (!save(state)) return fail('not-saved');
    return Object.assign(get(), { added: true });
  }

  function remove(kindRaw, value) {
    const kind = kindOf(kindRaw);
    if (!kind) return fail('bad-kind');
    if (typeof value !== 'string') return fail('bad-value');
    const state = load();
    const list = state[KEY[kind]];
    const at = list.indexOf(value.trim());
    if (at === -1) return Object.assign(get(), { removed: false });
    list.splice(at, 1);
    if (!save(state)) return fail('not-saved');
    return Object.assign(get(), { removed: true });
  }

  // 外から集めた一覧（旧いアプリの引き継ぎなど）を足す。今ある一覧は残し、同じ文字列と上限を超える分は数えて捨てる。
  function merge(titles, categories) {
    const state = load();
    const given = { titles: cleanList('title', titles), categories: cleanList('category', categories) };
    const result = { ok: true, titlesAdded: 0, titlesSkipped: 0, categoriesAdded: 0, categoriesSkipped: 0 };
    ['title', 'category'].forEach(function (kind) {
      const list = state[KEY[kind]];
      given[KEY[kind]].forEach(function (text) {
        if (list.indexOf(text) !== -1) { result[KEY[kind] + 'Skipped'] += 1; return; }
        if (list.length >= MAX_ITEMS) { result[KEY[kind] + 'Skipped'] += 1; return; }
        list.push(text);
        result[KEY[kind] + 'Added'] += 1;
      });
    });
    if (result.titlesAdded || result.categoriesAdded) {
      if (!save(state)) return fail('not-saved');
    }
    result.titles = state.titles;
    result.categories = state.categories;
    return result;
  }

  return { get: get, add: add, remove: remove, merge: merge, MAX_ITEMS: MAX_ITEMS };
}

module.exports = { createFavorites, MAX_ITEMS };
