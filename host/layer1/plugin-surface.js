'use strict';

/**
 * プラグインの画面・オーバーレイ・購読パターンの検証。
 * manifest の正規化、配るファイルの拡張子、オーバーレイに載せてよい値をここだけで決める。
 */

const { EVENT_NAMES } = require('../core');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ACTION_RE = /^[a-zA-Z][a-zA-Z0-9]{0,40}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const UI_EXT = new Set(['.html', '.js', '.css', '.svg', '.json']);
const MAX_OVERLAY_STRING = 200;
const MAX_OVERLAY_CLIENTS = 20;
const SECRET_WORD = /key|token|secret|password|cookie|auth/i;

const PANEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; frame-ancestors 'self'";
const OVERLAY_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src http://127.0.0.1:18770 http://localhost:18770; img-src 'self' data:; frame-ancestors 'self'";

function containsSecretWord(name) {
  return typeof name === 'string' && SECRET_WORD.test(name);
}

function validSubscribe(pattern) {
  if (typeof pattern !== 'string' || pattern.length < 1 || pattern.length > 80) return false;
  if (EVENT_NAMES.has(pattern)) return true;
  if (!pattern.endsWith('*')) return false;
  const prefix = pattern.slice(0, -1);
  if (prefix === '') return true;
  for (const name of EVENT_NAMES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function patternCovers(declared, requested) {
  if (declared === requested) return true;
  if (typeof declared !== 'string' || !declared.endsWith('*')) return false;
  const prefix = declared.slice(0, -1);
  if (typeof requested !== 'string') return false;
  if (requested.endsWith('*')) return requested.slice(0, -1).startsWith(prefix);
  return requested.startsWith(prefix);
}

function subscribeCovered(declared, requested) {
  if (!Array.isArray(declared) || !validSubscribe(requested)) return false;
  for (let i = 0; i < declared.length; i += 1) {
    if (patternCovers(declared[i], requested)) return true;
  }
  return false;
}

function eventAllowed(subscribes, name) {
  if (!Array.isArray(subscribes) || typeof name !== 'string') return false;
  for (let i = 0; i < subscribes.length; i += 1) {
    const pattern = subscribes[i];
    if (typeof pattern !== 'string') continue;
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === name) return true;
  }
  return false;
}

function manifestAsset(file, folder) {
  if (typeof file !== 'string' || file.length < 1 || file.length > 200) return '';
  if (file.indexOf('\0') !== -1) return '';
  const norm = file.replace(/\\/g, '/');
  if (!norm.startsWith(folder + '/')) return '';
  const parts = norm.split('/');
  if (parts[0] !== folder) return '';
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === '' || parts[i] === '.' || parts[i] === '..') return '';
  }
  const dot = norm.lastIndexOf('.');
  const ext = dot >= 0 ? norm.slice(dot).toLowerCase() : '';
  if (!UI_EXT.has(ext)) return '';
  return norm;
}

// パネルの名乗り（計画 X・P1）。本体はプラグインの名前を知らず、パネルが自分で言う。
// aliases: 昔の配置に残っているパネルの id（読み替えて開く）。dock: 初めの配置で開く段階（standard／advanced）と順番。
// menu: 上のメニューに出す行（in: view／file・title・desc・order・min・orDev）。言葉はプラグインが持つ。
const PANEL_ALIAS_RE = /^[a-z][a-z0-9:_-]{0,60}$/;
function cleanPanelAliases(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((x) => { if (typeof x === 'string' && PANEL_ALIAS_RE.test(x) && out.indexOf(x) === -1 && out.length < 5) out.push(x); });
  return out;
}
function cleanPanelDock(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((x) => { if ((x === 'standard' || x === 'advanced') && out.indexOf(x) === -1) out.push(x); });
  return out;
}
function cleanPanelMenu(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.key !== 'string' || !/^[a-z][a-z0-9-]{0,24}$/.test(raw.key)) return null;
  if (typeof raw.title !== 'string' || raw.title.length < 1 || raw.title.length > 40) return null;
  return {
    key: raw.key,
    title: raw.title,
    desc: typeof raw.desc === 'string' ? raw.desc.slice(0, 160) : '',
    order: Number.isInteger(raw.order) && raw.order >= 0 && raw.order <= 999 ? raw.order : 500,
    in: raw.in === 'file' ? 'file' : (raw.in === 'none' ? 'none' : 'view'), // none ＝ 上のメニューに出さない（見本など）
    min: raw.min === 'advanced' ? 'advanced' : 'standard',
    orDev: raw.orDev === true
  };
}

function normalizePanels(raw, warn) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warn('ignore panels');
    return [];
  }
  const clean = [];
  const names = new Set();
  let bad = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      bad += 1;
      continue;
    }
    const file = manifestAsset(item.file, 'ui');
    const titleOk = typeof item.title === 'string' && item.title.length >= 1 && item.title.length <= 80;
    if (typeof item.name !== 'string' || !NAME_RE.test(item.name) || names.has(item.name) || !titleOk || !file) {
      bad += 1;
      continue;
    }
    names.add(item.name);
    const row = { name: item.name, title: item.title, file: file };
    const aliases = cleanPanelAliases(item.aliases);
    if (aliases.length) row.aliases = aliases;
    const dock = cleanPanelDock(item.dock);
    if (dock.length) { row.dock = dock; row.dockOrder = Number.isInteger(item.dockOrder) && item.dockOrder >= 0 && item.dockOrder <= 99 ? item.dockOrder : 50; }
    const menu = cleanPanelMenu(item.menu);
    if (menu) row.menu = menu;
    clean.push(row);
  }
  if (bad) warn('ignore panels count=' + bad);
  return clean;
}

// 画面の差し込み口（V7-5）。本体の決まった場所の穴の名前。増やすときはここと ui/plugin-host.js の SLOT_NAMES を揃える。
const UI_SLOTS = ['home.top', 'home.siteCard.footer'];
const UI_MAX_POPUPS = 10;
const UI_MAX_MENU = 10;
const UI_MAX_RELAY = 16;
const UI_METHOD_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/;
// 親の窓だけが実行する操作（K3）。名前ごとの持ち主のプラグインは、内蔵プラグインが manifest の owns.parentActions で名乗る（host/core/owners.js。計画 X・P1）。
// manifest の ui.parentActions に書くのは必要条件で、持ち主以外には効かない（host/core/panel-messages.js の parentActions が持ち主を確かめる）。
// 実行（確認の窓・権限の判断）は親の画面（plugins/ui-standard/shell/core/parent-actions.js）。iframe は名前と値を渡すだけ。

function plainObj(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// manifest の ui を検査して { panels, popup, settings, menu, slots, relay } にする。
// おかしい項目は捨てて warn（プラグインは落とさない）。panels は今の `panels` の別名で、登録簿が manifest.panels に混ぜる。
function normalizeUi(raw, warn) {
  const out = { panels: [], popup: [], settings: null, menu: [], slots: [], relay: [], parentActions: [] };
  if (raw == null) return out;
  if (!plainObj(raw)) {
    warn('ignore ui');
    return out;
  }
  let bad = 0;
  out.panels = normalizePanels(raw.panels, warn);
  if (raw.popup != null) {
    const list = Array.isArray(raw.popup) ? raw.popup : null;
    if (!list) bad += 1;
    else {
      const names = new Set();
      for (let i = 0; i < list.length; i += 1) {
        const item = list[i];
        const file = plainObj(item) ? manifestAsset(item.file, 'ui') : '';
        const titleOk = plainObj(item) && typeof item.title === 'string' && item.title.length >= 1 && item.title.length <= 80;
        if (!file || !titleOk || typeof item.name !== 'string' || !/^[a-z][a-z0-9-]{0,21}$/.test(item.name) || names.has(item.name) || out.popup.length >= UI_MAX_POPUPS) {
          bad += 1;
          continue;
        }
        names.add(item.name);
        out.popup.push({ name: item.name, title: item.title, file: file });
      }
    }
  }
  if (raw.settings != null) {
    const item = raw.settings;
    const file = plainObj(item) ? manifestAsset(item.file, 'ui') : '';
    const title = plainObj(item) && typeof item.title === 'string' && item.title.length >= 1 && item.title.length <= 80 ? item.title : '';
    if (file && title) out.settings = { title: title, file: file };
    else bad += 1;
  }
  if (raw.menu != null) {
    const list = Array.isArray(raw.menu) ? raw.menu : null;
    if (!list) bad += 1;
    else {
      for (let i = 0; i < list.length; i += 1) {
        const item = list[i];
        const labelOk = plainObj(item) && typeof item.label === 'string' && item.label.length >= 1 && item.label.length <= 40;
        const hasMethod = plainObj(item) && typeof item.method === 'string' && item.method.length <= 120 && UI_METHOD_RE.test(item.method);
        const hasPanel = plainObj(item) && typeof item.openPanel === 'string' && NAME_RE.test(item.openPanel);
        if (!labelOk || hasMethod === hasPanel || out.menu.length >= UI_MAX_MENU) {
          bad += 1;
          continue;
        }
        out.menu.push(hasMethod ? { label: item.label, method: item.method } : { label: item.label, openPanel: item.openPanel });
      }
    }
  }
  if (raw.slots != null) {
    const list = Array.isArray(raw.slots) ? raw.slots : null;
    if (!list) bad += 1;
    else {
      const used = new Set();
      for (let i = 0; i < list.length; i += 1) {
        const item = list[i];
        const file = plainObj(item) ? manifestAsset(item.file, 'ui') : '';
        const titleOk = plainObj(item) && (item.title == null || (typeof item.title === 'string' && item.title.length >= 1 && item.title.length <= 80));
        if (!file || !titleOk || typeof item.slot !== 'string' || UI_SLOTS.indexOf(item.slot) === -1 || used.has(item.slot)) {
          bad += 1;
          continue;
        }
        used.add(item.slot);
        out.slots.push({ slot: item.slot, title: item.title || item.slot, file: file });
      }
    }
  }
  if (raw.relay != null) {
    const list = Array.isArray(raw.relay) ? raw.relay : null;
    if (!list) bad += 1;
    else {
      for (let i = 0; i < list.length; i += 1) {
        const method = list[i];
        if (typeof method !== 'string' || method.length > 120 || !UI_METHOD_RE.test(method) || out.relay.indexOf(method) !== -1 || out.relay.length >= UI_MAX_RELAY) {
          bad += 1;
          continue;
        }
        out.relay.push(method);
      }
    }
  }
  if (raw.parentActions != null) {
    const list = Array.isArray(raw.parentActions) ? raw.parentActions : null;
    if (!list) bad += 1;
    else {
      for (let i = 0; i < list.length; i += 1) {
        const name = list[i];
        if (typeof name !== 'string' || name.length > 120 || !UI_METHOD_RE.test(name) || out.parentActions.indexOf(name) !== -1) {
          bad += 1;
          continue;
        }
        out.parentActions.push(name);
      }
    }
  }
  if (bad) warn('ignore ui count=' + bad);
  return out;
}

function normalizeOverlays(raw, warn) {
  if (raw == null) return { overlays: [] };
  if (!Array.isArray(raw)) {
    warn('ignore overlays');
    return { overlays: [] };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const fields = item && Array.isArray(item.fields) ? item.fields : [];
    for (let j = 0; j < fields.length; j += 1) {
      if (containsSecretWord(fields[j])) return { error: 'forbidden-overlay-field' };
    }
  }
  const clean = [];
  const names = new Set();
  let bad = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      bad += 1;
      continue;
    }
    const file = manifestAsset(item.file, 'overlay');
    if (typeof item.name !== 'string' || !NAME_RE.test(item.name) || names.has(item.name) || !file || !Array.isArray(item.fields)) {
      bad += 1;
      continue;
    }
    const fields = [];
    for (let j = 0; j < item.fields.length; j += 1) {
      const field = item.fields[j];
      if (typeof field === 'string' && FIELD_RE.test(field) && fields.indexOf(field) === -1) fields.push(field);
      else bad += 1;
    }
    names.add(item.name);
    clean.push({ name: item.name, file: file, fields: fields });
  }
  if (bad) warn('ignore overlays count=' + bad);
  return { overlays: clean };
}

function normalizeActions(raw, warn) {
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('ignore actions');
    return {};
  }
  const clean = {};
  let bad = 0;
  const names = Object.keys(raw);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    const permission = raw[name];
    if (!ACTION_RE.test(name) || (permission !== 'read' && permission !== 'write')) bad += 1;
    else clean[name] = permission;
  }
  if (bad) warn('ignore actions count=' + bad);
  return clean;
}

function sanitizeOverlayValues(fields, values) {
  const allowed = Array.isArray(fields) ? fields : [];
  const out = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
  const names = Object.keys(values);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (allowed.indexOf(name) === -1) continue;
    const value = values[name];
    if (typeof value === 'string') {
      if (value.length <= MAX_OVERLAY_STRING) out[name] = value;
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[name] = value;
    } else if (typeof value === 'boolean') {
      out[name] = value;
    }
  }
  return out;
}

module.exports = {
  ID_RE,
  NAME_RE,
  ACTION_RE,
  FIELD_RE,
  UI_EXT,
  MAX_OVERLAY_STRING,
  MAX_OVERLAY_CLIENTS,
  PANEL_CSP,
  OVERLAY_CSP,
  containsSecretWord,
  validSubscribe,
  patternCovers,
  subscribeCovered,
  eventAllowed,
  manifestAsset,
  UI_SLOTS,
  normalizePanels,
  normalizeUi,
  normalizeOverlays,
  normalizeActions,
  sanitizeOverlayValues
};
