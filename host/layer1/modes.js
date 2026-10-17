'use strict';

/**
 * marust-modes.json の読み書き。
 * 場所は STATE_DIR/services/marust-modes.json。
 * 形は { default?: "legacy"|"shadow"|"live", plugins?: { "<id>": "legacy"|"shadow"|"live" } }。
 * 壊れたファイルは書き換えない。書くのは setPluginMode と setDefaultMode だけ。
 * 呼び出し元はウィンドウの modes.set / modes.setDefault に限る。
 */

const fs = require('fs');
const path = require('path');
const { ID_RE } = require('./plugin-surface');

const MODES = Object.freeze(['legacy', 'shadow', 'live']);
const CHANGED_EVENT = 'modes.changed';
// サイトのプラグイン（plugins/sites/<site>/。R16）のモードのキーは "<site>:<役目>"。内部の id（site-twitch など）は変わらない。
const MODE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}:(site|sink|slot)$/;
const OLD_ID_RE = /^(site|sink|slot)-([a-z0-9][a-z0-9-]{0,31})$/;
// 内部の id が変わった役目の「もっと前の id」。モードの旧キーとして読み、起動時に新しいキーへ写し、API の入口でも 1 版のあいだ受ける。
// （rumble-slot は R16 の形 "<役目>-<site>" に合わせて slot-rumble になった。）
const LEGACY_IDS = Object.freeze({ 'slot-rumble': 'rumble-slot' });
const ID_OF_LEGACY = Object.freeze({ 'rumble-slot': 'slot-rumble' });
function legacyIdOf(id) {
  return Object.prototype.hasOwnProperty.call(LEGACY_IDS, id) ? LEGACY_IDS[id] : '';
}
function idOfLegacyId(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ID_OF_LEGACY, value) ? ID_OF_LEGACY[value] : '';
}

// レジストリが discover のたびに入れる「内部の id → モードのキー」。サイトのプラグイン以外は入らない（キー = id）。
let modeKeyMap = new Map();
let idByModeKey = new Map();
function setModeKeys(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  modeKeyMap = new Map(list);
  idByModeKey = new Map(list.map(function (pair) { return [pair[1], pair[0]]; }));
}
function modeKeyOf(id) {
  return modeKeyMap.get(id) || id;
}
function idOfModeKey(key) {
  return idByModeKey.get(key) || '';
}
function validModeId(value) {
  return typeof value === 'string' && (ID_RE.test(value) || MODE_KEY_RE.test(value));
}
// 読み取り: 新しいキー → 旧 id → （知らないサイトでも）旧 id から導いた新しいキー、の順。どれも無ければ ''。
// 最後の 1 つは、サイトのコミットを戻したあとも、新しいキーしか無い作者のファイルが読めるようにするため。
function lookupPluginMode(plugins, id) {
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return '';
  const key = modeKeyOf(id);
  const tries = key !== id ? [key] : [];
  const m = OLD_ID_RE.exec(String(id));
  if (m) tries.push(m[2] + ':' + m[1]); // 表が空でも、旧 id から導いた新キーが旧 id より先（新キー優先）
  tries.push(id);
  const legacy = legacyIdOf(id);
  if (legacy) tries.push(legacy);
  for (let i = 0; i < tries.length; i += 1) {
    const value = Object.prototype.hasOwnProperty.call(plugins, tries[i]) ? plugins[tries[i]] : undefined;
    if (isMode(value)) return value;
  }
  return '';
}

function isMode(value) {
  return value === 'legacy' || value === 'shadow' || value === 'live';
}

function modesPath(core) {
  if (!core || !core.STATE_DIR) return '';
  return path.join(core.STATE_DIR, 'services', 'marust-modes.json');
}

function readModesDocument(core, io) {
  const fsImpl = io || fs;
  const file = modesPath(core);
  if (!file) return { ok: false, error: 'unreadable', reason: 'no-state', missing: false, data: null, file: '' };
  if (!fsImpl.existsSync(file)) {
    return { ok: true, missing: true, error: '', reason: '', data: null, file: file };
  }
  let text;
  try {
    text = fsImpl.readFileSync(file); // Bufferを下でUTF-8へ。旧NodeのReadFileUtf8経路を避ける。
  } catch (_) {
    return { ok: false, error: 'unreadable', reason: 'parse', missing: false, data: null, file: file };
  }
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (_) {
    return { ok: false, error: 'unreadable', reason: 'parse', missing: false, data: null, file: file };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'unreadable', reason: 'shape', missing: false, data: null, file: file };
  }
  return { ok: true, missing: false, error: '', reason: '', data: data, file: file };
}

function writableShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (Object.prototype.hasOwnProperty.call(data, 'plugins')) {
    const plugins = data.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'default')) {
    if (typeof data.default !== 'string') return false;
  }
  return true;
}

function canWrite(read) {
  if (!read) return false;
  if (read.missing) return true;
  if (!read.ok) return false;
  return writableShape(read.data);
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function writeDocument(core, data) {
  const file = modesPath(core);
  const write = core && core.atomicWriteJsonSync;
  if (!file || typeof write !== 'function') return { ok: false, error: 'unavailable' };
  try {
    write(file, data);
  } catch (_) {
    return { ok: false, error: 'failed' };
  }
  return { ok: true, file: file };
}

function priorPlugin(read, id) {
  const data = read && read.ok && !read.missing ? read.data : null;
  const specific = data ? lookupPluginMode(data.plugins, id) : '';
  if (specific) return specific;
  if (data && typeof data.default === 'string') return data.default;
  return '';
}

function priorDefault(read) {
  const data = read && read.ok && !read.missing ? read.data : null;
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'default')) return '';
  return typeof data.default === 'string' ? data.default : '';
}

function setPluginMode(core, id, mode) {
  if (!validModeId(id)) return { ok: false, error: 'bad-id' };
  if (!isMode(mode)) return { ok: false, error: 'bad-mode' };
  const read = readModesDocument(core);
  if (!canWrite(read)) return { ok: false, error: 'unreadable' };
  // 書き込みは、サイトのプラグインなら新しいキー（"<サイト>:site"）へ。引数が新しいキーそのものでもよい。
  const isKey = MODE_KEY_RE.test(id);
  let key = isKey ? id : modeKeyOf(id);
  if (!isKey && key === id) {
    // 表がまだ空のとき（discover の前）でも、移しかえ済みのファイルなら新しいキーへ書く。書いたのに効かない、を防ぐ（M6 Should 2）。
    const m = OLD_ID_RE.exec(id);
    const plugins = read.data && read.data.plugins;
    const derived = m ? m[2] + ':' + m[1] : '';
    if (derived && plugins && typeof plugins === 'object' && Object.prototype.hasOwnProperty.call(plugins, derived)) key = derived;
  }
  const from = priorPlugin(read, isKey ? (idOfModeKey(id) || id) : id);
  const next = read.missing ? {} : cloneData(read.data);
  if (!next.plugins || typeof next.plugins !== 'object' || Array.isArray(next.plugins)) next.plugins = {};
  next.plugins[key] = mode;
  // 同じ役目の旧キーが残っていたら、新しいキーと食い違わないよう消す
  if (!isKey && key !== id && Object.prototype.hasOwnProperty.call(next.plugins, id)) delete next.plugins[id];
  const legacyId = isKey ? '' : legacyIdOf(id);
  if (legacyId && Object.prototype.hasOwnProperty.call(next.plugins, legacyId)) delete next.plugins[legacyId];
  const wrote = writeDocument(core, next);
  if (!wrote.ok) return wrote;
  return { ok: true, id: id, mode: mode, from: from };
}

function setDefaultMode(core, mode) {
  if (mode === 'live') return { ok: false, error: 'live-default' };
  if (mode !== 'legacy' && mode !== 'shadow') return { ok: false, error: 'bad-mode' };
  const read = readModesDocument(core);
  if (!canWrite(read)) return { ok: false, error: 'unreadable' };
  const from = priorDefault(read);
  const next = read.missing ? {} : cloneData(read.data);
  next.default = mode;
  const wrote = writeDocument(core, next);
  if (!wrote.ok) return wrote;
  return { ok: true, mode: mode, from: from };
}

function explainMode(id, read, forced, fallbackMode) {
  if (forced) return { mode: 'legacy', source: 'forceLegacy' };
  const data = read && read.ok && !read.missing ? read.data : null;
  const specific = data ? lookupPluginMode(data.plugins, id) : '';
  if (specific) return { mode: specific, source: 'plugins' };
  if (data && isMode(data.default)) return { mode: data.default, source: 'default' };
  const mode = isMode(fallbackMode) ? fallbackMode : 'legacy';
  return { mode: mode, source: 'defaultMode' };
}

function explainDefault(read, forced) {
  if (forced) return { mode: 'legacy', source: 'forceLegacy' };
  const data = read && read.ok && !read.missing ? read.data : null;
  if (data && isMode(data.default)) return { mode: data.default, source: 'default' };
  return { mode: '', source: 'defaultMode' };
}

function fileView(read) {
  if (!read || read.reason === 'no-state') return { readable: false, error: 'unreadable' };
  if (read.missing) return { readable: true, error: '' };
  if (!read.ok || !writableShape(read.data)) return { readable: false, error: 'unreadable' };
  return { readable: true, error: '' };
}

function roleList(row, key) {
  if (row && Array.isArray(row[key])) return row[key];
  const manifest = row && row.manifest;
  if (manifest && Array.isArray(manifest[key])) return manifest[key];
  return [];
}

function providerOk(row) {
  if (!row || row.status === 'skip') return false;
  if (row.status == null || row.status === '' || row.status === 'running') return true;
  return false;
}

function missingRequires(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  let target = null;
  const provided = Object.create(null);
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (!row || row.status === 'skip') continue;
    if (target == null && String(row.id) === String(id)) target = row;
    if (!providerOk(row)) continue;
    const gives = roleList(row, 'provides');
    for (let j = 0; j < gives.length; j += 1) {
      if (typeof gives[j] === 'string' && gives[j]) provided[gives[j]] = true;
    }
  }
  const needs = target ? roleList(target, 'requires') : [];
  const missing = [];
  for (let k = 0; k < needs.length; k += 1) {
    const role = needs[k];
    if (typeof role !== 'string' || !role || provided[role] || missing.indexOf(role) !== -1) continue;
    missing.push(role);
  }
  return { found: !!target, missing: missing, met: !!target && missing.length === 0 };
}

function auditToken(value) {
  if (value === 'legacy' || value === 'shadow' || value === 'live') return value;
  if (value == null || value === '') return 'unset';
  return 'invalid';
}

module.exports = {
  MODES,
  CHANGED_EVENT,
  ID_RE,
  MODE_KEY_RE,
  setModeKeys,
  modeKeyOf,
  idOfModeKey,
  legacyIdOf,
  idOfLegacyId,
  validModeId,
  lookupPluginMode,
  isMode,
  modesPath,
  readModesDocument,
  writableShape,
  explainMode,
  explainDefault,
  fileView,
  setPluginMode,
  setDefaultMode,
  missingRequires,
  auditToken
};
