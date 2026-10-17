'use strict';

/**
 * 設定の書き出しと読み込み。許可した項目だけを拾う。
 * 金庫・Cookie・トークン・端末一覧・ログ・配信先の actual は読まない。
 * schemaVersion は 1 だけ。反映の前に data/marust/backups へ今の設定を控える。
 */

const fs = require('fs');
const path = require('path');
const { secretMask } = require('../core');
const { createLayouts, normalizeLayoutName } = require('./layouts');
const { ID_RE } = require('./plugin-surface');
const { isMode, readModesDocument, MODE_KEY_RE } = require('./modes');
const { readAppSettings } = require('./tray');

const SCHEMA_VERSION = 1;
const SECTION_IDS = Object.freeze([
  'layout',
  'modes',
  'hotkeys',
  'destinations',
  'pluginConfigs',
  'autostart'
]);
const SECTION_NAMES = Object.freeze({
  layout: 'レイアウト',
  modes: 'モード',
  hotkeys: 'ホットキー',
  destinations: '配信先',
  pluginConfigs: 'プラグインの設定',
  autostart: '自動起動'
});

const MAX_LAYOUT = 256 * 1024;
const MAX_HOTKEYS = 64 * 1024;
const MAX_MODES = 256 * 1024;
const MAX_STATE = 2 * 1024 * 1024;
const MAX_CONFIG = 64 * 1024;
const MAX_SETTINGS = 64 * 1024;
const MAX_BINDINGS = 32;
const SENSITIVE_KEY = /cookie|token|secret|password|vault|authorization|credential|bearer/i;

function createSettingsExport(options) {
  const opts = options || {};
  const core = opts.core || null;
  const fsImpl = opts.fs || fs;
  const writeJson = opts.writeJson || (core && core.atomicWriteJsonSync);
  const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  const appSettings = opts.appSettings || null;
  const hotkeys = opts.hotkeys || null;
  const store = opts.store || null;
  let layoutsApi = opts.layouts || null;
  let backupSeq = 0;

  function ready() {
    return !!(core && typeof core.STATE_DIR === 'string' && core.STATE_DIR && typeof writeJson === 'function');
  }

  function layouts() {
    if (!layoutsApi) layoutsApi = createLayouts({ core: core, fs: fsImpl });
    return layoutsApi;
  }

  function marustDir() {
    return path.join(core.STATE_DIR, 'data', 'marust');
  }

  function isRealFile(file) {
    let st;
    try { st = fsImpl.lstatSync(file); } catch (_) { return false; }
    return !!st && st.isFile() && !st.isSymbolicLink();
  }

  function contained(root, target) {
    try {
      let base = fsImpl.realpathSync(root);
      let file = fsImpl.realpathSync(target);
      if (process.platform === 'win32') {
        base = base.toLowerCase();
        file = file.toLowerCase();
      }
      return file === base || file.startsWith(base + path.sep);
    } catch (_) {
      return false;
    }
  }

  function readJsonFile(file, maxBytes) {
    if (!isRealFile(file)) return { ok: false, missing: true };
    let st;
    try { st = fsImpl.lstatSync(file); } catch (_) { return { ok: false }; }
    if (st.size > maxBytes) return { ok: false, error: 'too-large' };
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (_) {
      return { ok: false };
    }
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch (_) {
      return { ok: false, error: 'parse' };
    }
  }

  function scrub(value, depth) {
    if (depth > 30) return undefined;
    if (value === null) return null;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean') return value;
    if (kind === 'number') return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
      if (value.length > 5000) return undefined;
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        const child = scrub(value[i], depth + 1);
        if (child !== undefined) out.push(child);
      }
      return out;
    }
    if (kind === 'object') {
      const keys = Object.keys(value);
      if (keys.length > 5000) return undefined;
      const out = {};
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (SENSITIVE_KEY.test(key) || String(key).toLowerCase() === 'key') continue;
        const child = scrub(value[key], depth + 1);
        if (child !== undefined) out[key] = child;
      }
      return out;
    }
    return undefined;
  }

  function clip(value, max) {
    if (value == null) return '';
    const text = String(value);
    return text.length > max ? text.slice(0, max) : text;
  }

  function tokyoParts(date) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      const map = {};
      const parts = fmt.formatToParts(date);
      for (let i = 0; i < parts.length; i += 1) {
        if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
      }
      if (map.hour === '24') map.hour = '00';
      if (map.year && map.month && map.day && map.hour && map.minute && map.second) return map;
    } catch (_) { /* 端末の現地時刻へ */ }
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return {
      year: String(date.getFullYear()),
      month: pad(date.getMonth() + 1),
      day: pad(date.getDate()),
      hour: pad(date.getHours()),
      minute: pad(date.getMinutes()),
      second: pad(date.getSeconds())
    };
  }

  function atDate() {
    const value = now();
    if (value instanceof Date) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
    return new Date();
  }

  function filename(date) {
    const parts = tokyoParts(date || atDate());
    return 'marust-settings-' + parts.year + parts.month + parts.day + '.json';
  }

  function exportedAt(date) {
    const parts = tokyoParts(date);
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute + ':' + parts.second + '+09:00';
  }

  function pluginRoot() {
    return path.join(marustDir(), 'plugins');
  }

  function pluginConfigPath(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return '';
    const root = path.resolve(pluginRoot());
    const file = path.resolve(root, id, 'config.json');
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return file;
  }

  function eachPluginDir(fn) {
    const root = pluginRoot();
    if (!fsImpl.existsSync(root)) return;
    let entries;
    try { entries = fsImpl.readdirSync(root); } catch (_) { return; }
    for (let i = 0; i < entries.length; i += 1) {
      const name = entries[i];
      if (!ID_RE.test(name)) continue;
      const dir = path.join(root, name);
      let st;
      try { st = fsImpl.lstatSync(dir); } catch (_) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (!contained(root, dir)) continue;
      fn(name, dir);
    }
  }

  function exportLayout() {
    const listed = layouts().list();
    const names = listed && Array.isArray(listed.names) ? listed.names : [];
    const items = [];
    const root = path.join(marustDir(), 'layouts');
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const file = layouts().fileFor(name);
      if (!file || !isRealFile(file)) continue;
      if (fsImpl.existsSync(root) && !contained(root, file)) continue;
      const read = readJsonFile(file, MAX_LAYOUT);
      if (!read.ok || !read.data || typeof read.data !== 'object') continue;
      const storedName = normalizeLayoutName(read.data.name) || normalizeLayoutName(name);
      if (!storedName) continue;
      if (!read.data.data || typeof read.data.data !== 'object' || Array.isArray(read.data.data)) continue;
      const data = scrub(read.data.data, 0);
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      items.push({ name: storedName, data: data });
    }
    return { last: normalizeLayoutName(listed && listed.last) || '', items: items };
  }

  function exportModes() {
    const read = readModesDocument(core, fsImpl);
    const out = { plugins: {} };
    if (!read || !read.ok || read.missing || !read.data) return out;
    if (isMode(read.data.default)) out.default = read.data.default;
    const plugins = read.data.plugins;
    if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
      const keys = Object.keys(plugins);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if ((ID_RE.test(key) || MODE_KEY_RE.test(key)) && isMode(plugins[key])) out.plugins[key] = plugins[key];
      }
    }
    return out;
  }

  function exportHotkeys() {
    const file = path.join(marustDir(), 'hotkeys.json');
    const read = readJsonFile(file, MAX_HOTKEYS);
    if (!read.ok || !Array.isArray(read.data)) return [];
    const out = [];
    for (let i = 0; i < read.data.length && out.length < MAX_BINDINGS; i += 1) {
      const row = read.data[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if (typeof row.accelerator !== 'string' || !row.accelerator || row.accelerator.length > 100) continue;
      if (typeof row.method !== 'string' || !row.method || row.method.length > 120) continue;
      let params = {};
      if (row.params && typeof row.params === 'object' && !Array.isArray(row.params)) {
        const scrubbed = scrub(row.params, 0);
        if (scrubbed && typeof scrubbed === 'object' && !Array.isArray(scrubbed)) params = scrubbed;
      }
      out.push({
        accelerator: row.accelerator,
        method: row.method,
        params: params,
        label: typeof row.label === 'string' ? row.label.slice(0, 80) : ''
      });
    }
    return out;
  }

  function destinationFromRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || id.length > 80) return null;
    let engine = null;
    if (row.engine && typeof row.engine === 'object' && !Array.isArray(row.engine)) {
      engine = { id: clip(row.engine.id, 80), targetId: clip(row.engine.targetId, 80) };
    }
    return {
      id: id,
      site: clip(row.site, 40),
      accountId: clip(row.accountId, 80) || id,
      enabled: row.enabled === true,
      engine: engine
    };
  }

  function exportDestinations() {
    let rows = [];
    if (store && typeof store.snapshot === 'function') {
      try {
        const snap = store.snapshot();
        rows = snap && Array.isArray(snap.destinations) ? snap.destinations : [];
      } catch (_) {
        rows = [];
      }
    } else {
      const read = readJsonFile(path.join(marustDir(), 'state.json'), MAX_STATE);
      if (read.ok && read.data && Array.isArray(read.data.destinations)) rows = read.data.destinations;
    }
    const out = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      const item = destinationFromRow(rows[i]);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  function exportPluginConfigs() {
    const out = {};
    eachPluginDir(function (name, dir) {
      const file = path.join(dir, 'config.json');
      if (!contained(dir, file) && isRealFile(file)) return;
      const read = readJsonFile(file, MAX_CONFIG);
      if (!read.ok || !read.data || typeof read.data !== 'object' || Array.isArray(read.data)) return;
      const scrubbed = scrub(read.data, 0);
      if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return;
      out[name] = scrubbed;
    });
    return out;
  }

  function exportAutostart() {
    try {
      const row = readAppSettings(core);
      return { openAtLogin: !!(row && row.openAtLogin === true) };
    } catch (_) {
      return { openAtLogin: false };
    }
  }

  function exportAll() {
    if (!ready()) return null;
    const date = atDate();
    let layout;
    let modes;
    let hotkeysDoc;
    let destinations;
    let pluginConfigs;
    let autostart;
    try { layout = exportLayout(); } catch (_) { layout = { last: '', items: [] }; }
    try { modes = exportModes(); } catch (_) { modes = { plugins: {} }; }
    try { hotkeysDoc = exportHotkeys(); } catch (_) { hotkeysDoc = []; }
    try { destinations = exportDestinations(); } catch (_) { destinations = []; }
    try { pluginConfigs = exportPluginConfigs(); } catch (_) { pluginConfigs = {}; }
    try { autostart = exportAutostart(); } catch (_) { autostart = { openAtLogin: false }; }
    return secretMask.maskDeep({
      schemaVersion: SCHEMA_VERSION,
      exportedAt: exportedAt(date),
      layout: layout,
      modes: modes,
      hotkeys: hotkeysDoc,
      destinations: destinations,
      pluginConfigs: pluginConfigs,
      autostart: autostart
    });
  }

  function schemaProblem(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'bad-document';
    if (data.schemaVersion !== SCHEMA_VERSION) return 'schema-version';
    return '';
  }

  function asDocument(json) {
    let data = json;
    if (typeof json === 'string') {
      try { data = JSON.parse(String(json).replace(/^\uFEFF/, '')); } catch (_) { return { ok: false, error: 'bad-document' }; }
    }
    const problem = schemaProblem(data);
    if (problem) return { ok: false, error: problem };
    return { ok: true, data: data };
  }

  function normalizeLayout(raw) {
    if (raw == null) return { last: '', items: [] };
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const items = [];
    const source = raw.items == null ? [] : raw.items;
    if (!Array.isArray(source)) return null;
    const seen = new Set();
    for (let i = 0; i < source.length; i += 1) {
      const row = source[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const name = normalizeLayoutName(row.name);
      if (!name) return null;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)) return null;
      const data = scrub(row.data, 0);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      items.push({ name: name, data: data });
    }
    return { last: normalizeLayoutName(raw.last) || '', items: items };
  }

  function normalizeModes(raw) {
    if (raw == null) return { plugins: {} };
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = { plugins: {} };
    if (Object.prototype.hasOwnProperty.call(raw, 'default')) {
      if (!isMode(raw.default)) return null;
      out.default = raw.default;
    }
    if (raw.plugins == null) return out;
    if (typeof raw.plugins !== 'object' || Array.isArray(raw.plugins)) return null;
    const keys = Object.keys(raw.plugins);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!(ID_RE.test(key) || MODE_KEY_RE.test(key)) || !isMode(raw.plugins[key])) return null;
      out.plugins[key] = raw.plugins[key];
    }
    return out;
  }

  function normalizeHotkeys(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_BINDINGS) return null;
    const out = [];
    for (let i = 0; i < raw.length; i += 1) {
      const row = raw[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      if (typeof row.accelerator !== 'string' || !row.accelerator || row.accelerator.length > 100) return null;
      if (typeof row.method !== 'string' || !row.method || row.method.length > 120) return null;
      let params = {};
      if (row.params != null) {
        if (typeof row.params !== 'object' || Array.isArray(row.params)) return null;
        const scrubbed = scrub(row.params, 0);
        if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return null;
        params = scrubbed;
      }
      out.push({
        accelerator: row.accelerator,
        method: row.method,
        params: params,
        label: typeof row.label === 'string' ? row.label.slice(0, 80) : ''
      });
    }
    return out;
  }

  function normalizeDestinations(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw) || raw.length > 100) return null;
    const out = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      const item = destinationFromRow(raw[i]);
      if (!item) return null;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }

  function normalizePlugins(raw) {
    if (raw == null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length > 200) return null;
    const out = {};
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!ID_RE.test(key)) return null;
      const value = raw[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const scrubbed = scrub(value, 0);
      if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return null;
      out[key] = scrubbed;
    }
    return out;
  }

  function normalizeAutostart(raw) {
    if (raw == null) return { openAtLogin: false, present: false };
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    return { openAtLogin: raw.openAtLogin === true, present: true };
  }

  function buildImported(data) {
    const layout = normalizeLayout(data.layout);
    const modes = normalizeModes(data.modes);
    const hotkeysDoc = normalizeHotkeys(data.hotkeys);
    const destinations = normalizeDestinations(data.destinations);
    const pluginConfigs = normalizePlugins(data.pluginConfigs);
    const autostart = normalizeAutostart(data.autostart);
    if (!layout || !modes || !hotkeysDoc || !destinations || !pluginConfigs || !autostart) {
      return { ok: false, error: 'bad-document' };
    }
    return {
      ok: true,
      data: {
        layout: layout,
        modes: modes,
        hotkeys: hotkeysDoc,
        destinations: destinations,
        pluginConfigs: pluginConfigs,
        autostart: autostart
      }
    };
  }

  function chosenSections(sections) {
    if (!Array.isArray(sections)) return [];
    const allow = new Set(SECTION_IDS);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < sections.length; i += 1) {
      const id = sections[i];
      if (typeof id !== 'string' || !allow.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function modeNames(modes) {
    const names = [];
    if (modes && modes.default) names.push('default');
    const plugins = modes && modes.plugins ? modes.plugins : {};
    const keys = Object.keys(plugins);
    keys.sort();
    for (let i = 0; i < keys.length; i += 1) names.push(keys[i]);
    return names;
  }

  function preview(json) {
    if (!ready()) return { ok: false, error: 'unavailable' };
    const parsed = asDocument(json);
    if (!parsed.ok) return parsed;
    const built = buildImported(parsed.data);
    if (!built.ok) return built;
    const data = built.data;
    const autostartNames = data.autostart.present ? ['openAtLogin'] : [];
    return {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      items: [
        { section: 'layout', name: SECTION_NAMES.layout, count: data.layout.items.length, names: data.layout.items.map(function (item) { return item.name; }) },
        { section: 'modes', name: SECTION_NAMES.modes, count: modeNames(data.modes).length, names: modeNames(data.modes) },
        { section: 'hotkeys', name: SECTION_NAMES.hotkeys, count: data.hotkeys.length, names: data.hotkeys.map(function (row) { return row.label || row.accelerator; }) },
        { section: 'destinations', name: SECTION_NAMES.destinations, count: data.destinations.length, names: data.destinations.map(function (row) { return row.id; }) },
        { section: 'pluginConfigs', name: SECTION_NAMES.pluginConfigs, count: Object.keys(data.pluginConfigs).length, names: Object.keys(data.pluginConfigs) },
        { section: 'autostart', name: SECTION_NAMES.autostart, count: autostartNames.length, names: autostartNames }
      ]
    };
  }

  function backupName(date) {
    backupSeq += 1;
    const parts = tokyoParts(date);
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return 'settings-' + parts.year + parts.month + parts.day + 'T' + parts.hour + parts.minute + parts.second + ms + '-' + String(backupSeq) + '.json';
  }

  function writeBackup(document) {
    const date = atDate();
    const dir = path.join(marustDir(), 'backups');
    const file = path.join(dir, backupName(date));
    writeJson(file, document);
    return file;
  }

  function applyLayout(layout) {
    const wanted = new Set();
    for (let i = 0; i < layout.items.length; i += 1) wanted.add(layout.items[i].name.toLowerCase());
    const listed = layouts().list();
    const names = listed && Array.isArray(listed.names) ? listed.names : [];
    const root = path.join(marustDir(), 'layouts');
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const file = layouts().fileFor(name);
      if (!file || !isRealFile(file)) continue;
      if (fsImpl.existsSync(root) && !contained(root, file)) continue;
      if (wanted.has(String(name).toLowerCase())) continue;
      const removed = layouts().remove(name);
      if (!removed || removed.ok === false) return { ok: false, error: (removed && removed.error) || 'failed' };
    }
    for (let j = 0; j < layout.items.length; j += 1) {
      const saved = layouts().save(layout.items[j].name, layout.items[j].data);
      if (!saved || saved.ok !== true) return { ok: false, error: (saved && saved.error) || 'failed' };
    }
    if (layout.last) writeJson(path.join(marustDir(), 'layout-last.json'), { name: layout.last });
    return { ok: true };
  }

  function applyModes(modes) {
    const data = { plugins: modes.plugins };
    if (modes.default) data.default = modes.default;
    const file = path.join(core.STATE_DIR, 'services', 'marust-modes.json');
    const read = readJsonFile(file, MAX_MODES);
    if (read.ok && read.data && typeof read.data.schemaVersion === 'number' && read.data.schemaVersion > SCHEMA_VERSION) {
      return { ok: false, error: 'read-only' };
    }
    writeJson(file, data);
    return { ok: true };
  }

  function applyHotkeys(bindings) {
    writeJson(path.join(marustDir(), 'hotkeys.json'), bindings);
    if (hotkeys && typeof hotkeys.reload === 'function') {
      try {
        const result = hotkeys.reload();
        if (result && typeof result.then === 'function') result.catch(function () {});
      } catch (_) { /* ファイルは書き終わっている */ }
    }
    return { ok: true };
  }

  function previousDestinations() {
    if (store && typeof store.snapshot === 'function') {
      if (typeof store.isReadOnly === 'function' && store.isReadOnly()) return { ok: false, error: 'read-only' };
      try {
        const snap = store.snapshot() || {};
        return {
          ok: true,
          rows: Array.isArray(snap.destinations) ? snap.destinations : []
        };
      } catch (_) {
        return { ok: false, error: 'failed' };
      }
    }
    const file = path.join(marustDir(), 'state.json');
    const read = readJsonFile(file, MAX_STATE);
    if (!read.ok || !read.data) return { ok: true, rows: [] };
    if (typeof read.data.schemaVersion === 'number' && read.data.schemaVersion > SCHEMA_VERSION) {
      return { ok: false, error: 'read-only' };
    }
    return {
      ok: true,
      rows: Array.isArray(read.data.destinations) ? read.data.destinations : []
    };
  }

  function applyDestinations(destinations) {
    const prior = previousDestinations();
    if (!prior.ok) return prior;
    const byId = new Map();
    for (let i = 0; i < prior.rows.length; i += 1) {
      const row = prior.rows[i];
      if (row && typeof row.id === 'string') byId.set(row.id, row);
    }
    const next = [];
    for (let j = 0; j < destinations.length; j += 1) {
      const row = destinations[j];
      const prev = byId.get(row.id);
      const item = {
        id: row.id,
        site: row.site,
        accountId: row.accountId,
        enabled: row.enabled === true,
        engine: row.engine
      };
      if (prev && prev.actual && typeof prev.actual === 'object' && !Array.isArray(prev.actual)) {
        item.actual = Object.assign({}, prev.actual);
        ['title', 'category'].forEach((name) => { delete item.actual[name]; }); // legacy-drop
      }
      next.push(item);
    }
    const file = path.join(marustDir(), 'state.json');
    writeJson(file, { schemaVersion: 1, destinations: next });
    if (store && typeof store.load === 'function') {
      try { store.load(); } catch (_) { return { ok: false, error: 'failed' }; }
    }
    return { ok: true };
  }

  function applyPluginConfigs(configs) {
    const keep = new Set(Object.keys(configs));
    const ids = Object.keys(configs);
    for (let i = 0; i < ids.length; i += 1) {
      const file = pluginConfigPath(ids[i]);
      if (!file) return { ok: false, error: 'failed' };
      writeJson(file, configs[ids[i]]);
    }
    eachPluginDir(function (name, dir) {
      if (keep.has(name)) return;
      const file = path.join(dir, 'config.json');
      if (isRealFile(file)) fsImpl.unlinkSync(file);
    });
    return { ok: true };
  }

  function applyAutostart(autostart) {
    const openAtLogin = autostart.openAtLogin === true;
    const file = path.join(marustDir(), 'app-settings.json');
    const read = readJsonFile(file, MAX_SETTINGS);
    if (read.ok === false && read.error === 'too-large') return { ok: false, error: 'too-large' };
    writeJson(file, { openAtLogin: openAtLogin });
    if (appSettings && typeof appSettings.set === 'function') {
      try {
        const row = appSettings.set(openAtLogin);
        if (row && row.ok === false) return { ok: false, error: row.error || 'failed' };
      } catch (_) {
        return { ok: false, error: 'failed' };
      }
    }
    return { ok: true };
  }

  function applySection(section, data) {
    if (section === 'layout') return applyLayout(data.layout);
    if (section === 'modes') return applyModes(data.modes);
    if (section === 'hotkeys') return applyHotkeys(data.hotkeys);
    if (section === 'destinations') return applyDestinations(data.destinations);
    if (section === 'pluginConfigs') return applyPluginConfigs(data.pluginConfigs);
    if (section === 'autostart') return applyAutostart(data.autostart);
    return { ok: false, error: 'no-sections' };
  }

  function importSelected(json, sections) {
    if (!ready()) return { ok: false, error: 'unavailable' };
    const parsed = asDocument(json);
    if (!parsed.ok) return parsed;
    const chosen = chosenSections(sections);
    if (!chosen.length) return { ok: false, error: 'no-sections' };
    const built = buildImported(parsed.data);
    if (!built.ok) return built;
    const current = exportAll();
    if (!current) return { ok: false, error: 'unavailable' };
    let backupFile = '';
    try {
      backupFile = writeBackup(current);
    } catch (_) {
      return { ok: false, error: 'backup-failed' };
    }
    for (let i = 0; i < chosen.length; i += 1) {
      let applied;
      try {
        applied = applySection(chosen[i], built.data);
      } catch (_) {
        applied = { ok: false, error: 'failed' };
      }
      if (!applied || applied.ok !== true) {
        return {
          ok: false,
          error: (applied && applied.error) || 'failed',
          backup: path.basename(backupFile)
        };
      }
    }
    return { ok: true, backup: path.basename(backupFile), applied: chosen.slice() };
  }

  return {
    exportAll: exportAll,
    preview: preview,
    importSelected: importSelected,
    filename: filename
  };
}

module.exports = {
  createSettingsExport: createSettingsExport,
  SCHEMA_VERSION: SCHEMA_VERSION,
  SECTION_IDS: SECTION_IDS
};
