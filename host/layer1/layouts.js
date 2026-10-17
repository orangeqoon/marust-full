'use strict';

/**
 * 画面レイアウト。state/data/marust/layouts/<正規化名>.json。
 * 名前は前後の空白を除いて 1〜40 文字。大文字・小文字の違いは同じ名前。
 * 1 件 256 KB まで。初期レイアウト「標準」は同梱。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;
const BUNDLED_NAME = '標準';
const NAME_RE = /^(?=.{1,40}$)[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9 _\u3000-]+$/u;

function normalizeLayoutName(name) {
  if (typeof name !== 'string') return '';
  const text = name.trim();
  if (!text || !NAME_RE.test(text)) return '';
  return text;
}

const SECRET_FIELD = /^(key|token|password|secret|cookie)s?$/i;

function dropSecretFields(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) out.push(dropSecretFields(value[i]));
    return out;
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (SECRET_FIELD.test(key)) continue;
    out[key] = dropSecretFields(value[key]);
  }
  return out;
}

function validName(name) {
  return normalizeLayoutName(name) !== '';
}

function createLayouts(options) {
  const opts = options || {};
  const core = opts.core || {};
  const fsImpl = opts.fs || fs;
  const writeJson = opts.writeJson || core.atomicWriteJsonSync;
  if (typeof writeJson !== 'function') throw new Error('layouts require atomicWriteJsonSync');
  if (!core.STATE_DIR) throw new Error('layouts require STATE_DIR');
  const dir = path.join(core.STATE_DIR, 'data', 'marust', 'layouts');
  const lastFile = path.join(core.STATE_DIR, 'data', 'marust', 'layout-last.json');
  const bundledFile = opts.bundledFile || '';

  function fileFor(name) {
    const text = normalizeLayoutName(name);
    if (!text) return null;
    const base = encodeURIComponent(text.toLowerCase()) + '.json';
    const root = path.resolve(dir);
    const resolved = path.resolve(root, base);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    if (path.basename(resolved) !== base) return null;
    return resolved;
  }

  function readJson(file) {
    const data = JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data;
  }

  function bundled() {
    if (typeof opts.bundledLayout === 'function') return opts.bundledLayout();
    return bundledFile ? readJson(bundledFile) : { panels: [] };
  }

  function readLast() {
    try {
      if (!fsImpl.existsSync(lastFile)) return BUNDLED_NAME;
      const data = readJson(lastFile);
      const name = data && normalizeLayoutName(data.name);
      if (name) return name;
    } catch (_) { /* fall through */ }
    return BUNDLED_NAME;
  }

  function writeLast(name) {
    writeJson(lastFile, { name: name });
  }

  function list() {
    const names = [];
    const seen = new Set();
    function add(name) {
      const text = normalizeLayoutName(name);
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(text);
    }
    if (fsImpl.existsSync(dir)) {
      const entries = fsImpl.readdirSync(dir);
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry.endsWith('.json')) continue;
        const resolved = path.resolve(dir, entry);
        if (!resolved.startsWith(path.resolve(dir) + path.sep)) continue;
        try {
          const data = readJson(resolved);
          if (data) add(data.name);
        } catch (_) { /* skip broken files */ }
      }
    }
    if (!seen.has(BUNDLED_NAME.toLowerCase())) names.unshift(BUNDLED_NAME);
    else {
      names.sort(function (a, b) {
        if (a === BUNDLED_NAME) return -1;
        if (b === BUNDLED_NAME) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    return { ok: true, names: names, last: readLast() };
  }

  function get(name) {
    const text = normalizeLayoutName(name);
    if (!text) return { ok: false, error: 'layout-name' };
    const file = fileFor(text);
    if (!file) return { ok: false, error: 'layout-name' };
    try {
      if (fsImpl.existsSync(file)) {
        const stored = readJson(file);
        const storedName = normalizeLayoutName(stored && stored.name) || text;
        writeLast(storedName);
        return { ok: true, name: storedName, data: dropSecretFields(stored.data), builtin: false };
      }
    } catch (_) {
      return { ok: false, error: 'layout-read' };
    }
    if (text.toLowerCase() === BUNDLED_NAME.toLowerCase()) {
      try {
        writeLast(BUNDLED_NAME);
        return { ok: true, name: BUNDLED_NAME, data: dropSecretFields(bundled()), builtin: true };
      } catch (_) {
        return { ok: false, error: 'layout-read' };
      }
    }
    return { ok: false, error: 'not-found' };
  }

  function save(name, data) {
    const text = normalizeLayoutName(name);
    if (!text) return { ok: false, error: 'layout-name' };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'layout-type' };
    const file = fileFor(text);
    if (!file) return { ok: false, error: 'layout-name' };
    const clean = dropSecretFields(data);
    const body = JSON.stringify(clean);
    if (Buffer.byteLength(body) > MAX_BYTES) return { ok: false, error: 'too-large' };
    writeJson(file, { name: text, data: clean });
    writeLast(text);
    return { ok: true, name: text };
  }

  function remove(name) {
    const text = normalizeLayoutName(name);
    if (!text) return { ok: false, error: 'layout-name' };
    const file = fileFor(text);
    if (!file) return { ok: false, error: 'layout-name' };
    let removed = false;
    if (fsImpl.existsSync(file)) {
      fsImpl.unlinkSync(file);
      removed = true;
    }
    if (readLast().toLowerCase() === text.toLowerCase()) writeLast(BUNDLED_NAME);
    if (!removed && text.toLowerCase() === BUNDLED_NAME.toLowerCase()) return { ok: true, name: BUNDLED_NAME, builtin: true };
    if (!removed) return { ok: false, error: 'not-found' };
    return { ok: true, name: text };
  }

  // 表示の細かさ（中級 standard・上級 advanced）ごとの配置。離れるときに自動で保存し、戻ったとき使う。
  // 名前つきの配置（list / get / save）とは別の場所に置くので、一覧には出ない。初級（basic）は配置固定なので保存しない。
  const levelDir = path.join(core.STATE_DIR, 'data', 'marust', 'level-layouts');
  const LEVELS = ['standard', 'advanced'];

  function levelFile(level) {
    if (LEVELS.indexOf(level) === -1) return null;
    return path.join(levelDir, level + '.json');
  }

  function getLevel(level) {
    const file = levelFile(level);
    if (!file) return { ok: false, error: 'bad-level' };
    try {
      if (!fsImpl.existsSync(file)) return { ok: false, error: 'not-found' };
      const stored = readJson(file);
      if (!stored || stored.level !== level || !stored.data || typeof stored.data !== 'object' || Array.isArray(stored.data) || !stored.data.dockview) {
        return { ok: false, error: 'layout-read' };
      }
      return { ok: true, level: level, data: dropSecretFields(stored.data) };
    } catch (_) {
      return { ok: false, error: 'layout-read' };
    }
  }

  function saveLevel(level, data) {
    const file = levelFile(level);
    if (!file) return { ok: false, error: 'bad-level' };
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.dockview || typeof data.dockview !== 'object') return { ok: false, error: 'layout-type' };
    const clean = dropSecretFields(data);
    if (Buffer.byteLength(JSON.stringify(clean)) > MAX_BYTES) return { ok: false, error: 'too-large' };
    writeJson(file, { level: level, data: clean });
    return { ok: true, level: level };
  }

  return { list: list, get: get, save: save, remove: remove, getLevel: getLevel, saveLevel: saveLevel, dir: dir, fileFor: fileFor };
}

module.exports = { createLayouts, validName, normalizeLayoutName, BUNDLED_NAME, MAX_BYTES, NAME_RE };
