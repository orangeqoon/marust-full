'use strict';

/**
 * パネル iframe と本体の postMessage。
 * 実際に iframe を開くのは W3。ここではメッセージの形と、通してよい method だけを決める。
 *
 * パネル → 本体: { type: "marust:call", id, method, params }
 * 本体 → パネル: { type: "marust:result", id, result }
 *               { type: "marust:event", name, payload }
 *
 * V7 C1（画面の部品）:
 * パネル → 本体: { type: "marust:ui", id, action: "toast" | "confirm" | "size", ... }  文字だけ・2 つのボタン・高さの申告
 *               { type: "marust:relay", id, method, params }  manifest の ui.relay に書いた method だけ。内蔵と作者用のプラグインだけ
 * 本体 → パネル: { type: "marust:event", name: "perm", payload: { read, write } }  いまの権限（見せ方だけ。本当の判定は本体）
 * 確認の門（hub.fanout）はパネルから直接呼べない。confirm で本体の窓に頼み、本物への送信は relay の窓の中継だけ。
 */

const { eventAllowed } = require('./plugin-surface');
const owners = require('../core');

const CALL = 'marust:call';
const RESULT = 'marust:result';
const EVENT = 'marust:event';
const UI = 'marust:ui';
const RELAY = 'marust:relay';

const UI_ACTIONS = ['toast', 'confirm', 'size', 'parent'];
const PARENT_PARAMS_MAX = 4096;
const TOAST_MAX = 200;
const CONFIRM_MAX = 400;
const BUTTON_MAX = 20;
const HEIGHT_MIN = 40;
const HEIGHT_MAX = 4000;
const RELAY_MAX = 16;
const METHOD_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/;
// ui.relay を信じるプラグインの出どころ（外から入れたものの宣言は無視する）
const RELAY_SOURCES = ['set'];

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validId(id) {
  if (typeof id === 'string') return id.length >= 1 && id.length <= 80;
  if (typeof id === 'number') return Number.isFinite(id);
  return false;
}

function parsePanelCall(message) {
  if (!plainObject(message)) return { ok: false, error: 'bad-message' };
  if (message.type !== CALL) return { ok: false, error: 'bad-type' };
  const id = message.id;
  if (!validId(id)) return { ok: false, error: 'bad-id' };
  if (typeof message.method !== 'string' || message.method.length < 1 || message.method.length > 120) {
    return { ok: false, error: 'bad-method' };
  }
  if (message.params != null && !plainObject(message.params)) return { ok: false, error: 'bad-params' };
  return {
    ok: true,
    call: {
      type: CALL,
      id: id,
      method: message.method,
      params: message.params == null ? {} : message.params
    }
  };
}

function resultMessage(id, result) {
  return { type: RESULT, id: id, result: result };
}

function eventMessage(name, payload) {
  return { type: EVENT, name: name, payload: payload };
}

// siblings: 同じサイトのほかの役目の id（plugins/sites/<site>/ の site・sink・slot。ホストが manifest から渡す）。
// パネルの申告は信じない。自分と siblings の操作だけ呼べる。ほかのプラグインの操作は今までどおり拒否。
function panelMethodAllowed(pluginId, method, permission, siblings) {
  if (typeof pluginId !== 'string' || typeof method !== 'string' || !method) return false;
  const owners = [pluginId].concat(Array.isArray(siblings) ? siblings.filter((id) => typeof id === 'string' && id) : []);
  const mine = owners.some((owner) => {
    const own = 'plugin.' + owner + '.';
    return method.indexOf(own) === 0 && method.length > own.length;
  });
  if (mine) {
    return permission === 'read' || permission === 'write';
  }
  if (method.indexOf('plugin.') === 0) return false;
  return permission === 'read';
}

function handlePanelCall(pluginId, message, permissionFor, siblings) {
  const parsed = parsePanelCall(message);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let permission = '';
  try {
    permission = typeof permissionFor === 'function' ? permissionFor(parsed.call.method) : '';
  } catch (_) {
    permission = '';
  }
  if (!panelMethodAllowed(pluginId, parsed.call.method, permission, siblings)) {
    return {
      ok: false,
      error: 'forbidden',
      reply: resultMessage(parsed.call.id, { ok: false, error: 'forbidden' })
    };
  }
  return { ok: true, call: parsed.call };
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

// marust:ui の形の検査。toast は文字だけ、confirm は文字と 2 つのボタン、size は高さ。HTML は通さない（親が textContent で出す）。
function parseUiMessage(message) {
  if (!plainObject(message)) return { ok: false, error: 'bad-message' };
  if (message.type !== UI) return { ok: false, error: 'bad-type' };
  if (!validId(message.id)) return { ok: false, error: 'bad-id' };
  if (UI_ACTIONS.indexOf(message.action) === -1) return { ok: false, error: 'bad-action' };
  const id = message.id;
  if (message.action === 'toast') {
    const text = cleanText(message.text, TOAST_MAX);
    if (!text) return { ok: false, error: 'bad-text' };
    return { ok: true, ui: { id: id, action: 'toast', text: text } };
  }
  if (message.action === 'confirm') {
    const text = cleanText(message.text, CONFIRM_MAX);
    if (!text) return { ok: false, error: 'bad-text' };
    return {
      ok: true,
      ui: {
        id: id,
        action: 'confirm',
        text: text,
        yes: cleanText(message.yes, BUTTON_MAX),
        no: cleanText(message.no, BUTTON_MAX)
      }
    };
  }
  if (message.action === 'parent') {
    // 親の窓だけが実行する操作。名前は固定の一覧だけ・値は小さな平らな object（確認の文は親が作る。iframe の文は使わない）
    if (typeof message.name !== 'string' || !owners.isParentAction(message.name)) return { ok: false, error: 'bad-name' };
    if (message.params != null && !plainObject(message.params)) return { ok: false, error: 'bad-params' };
    let size = 0;
    try { size = JSON.stringify(message.params || {}).length; } catch (_) { size = PARENT_PARAMS_MAX + 1; }
    if (size > PARENT_PARAMS_MAX) return { ok: false, error: 'bad-params' };
    return { ok: true, ui: { id: id, action: 'parent', name: message.name, params: message.params == null ? {} : message.params } };
  }
  const height = message.height;
  if (typeof height !== 'number' || !Number.isFinite(height)) return { ok: false, error: 'bad-height' };
  return { ok: true, ui: { id: id, action: 'size', height: Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.round(height))) } };
}

// manifest の ui.relay（method の並び）から、中継してよい method を取り出す。
// source が builtin / author 以外（外から入れたもの）は空。形の悪い項目は捨てる。
function relayMethods(source, manifest) {
  if (RELAY_SOURCES.indexOf(source) === -1) return [];
  const ui = manifest && plainObject(manifest.ui) ? manifest.ui : null;
  const list = ui && Array.isArray(ui.relay) ? ui.relay : [];
  const out = [];
  for (let i = 0; i < list.length && out.length < RELAY_MAX; i += 1) {
    const method = list[i];
    if (typeof method !== 'string' || method.length > 120 || !METHOD_RE.test(method)) continue;
    if (out.indexOf(method) === -1) out.push(method);
  }
  return out;
}

// manifest の ui.parentActions のうち、このプラグインが持ち主の名前だけ（K3）。外から入れたものは空。
// プラグインの一覧（hub.getState の plugins）から、内蔵が名乗った親の操作の持ち主を入れ直す（試験・画面を host の道で動かすとき用。登録簿を通らない）
function setParentOwners(rows) {
  owners.resetParentActions();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (row && row.source === 'set' && row.owns && Array.isArray(row.owns.parentActions)) owners.claim(String(row.id), { parentActions: row.owns.parentActions });
  });
}

function parentActionOwner(name) { return owners.parentActionOwner(name); }

function parentActions(source, manifest, pluginId) {
  if (RELAY_SOURCES.indexOf(source) === -1) return [];
  const ui = manifest && plainObject(manifest.ui) ? manifest.ui : null;
  const list = ui && Array.isArray(ui.parentActions) ? ui.parentActions : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const name = list[i];
    if (typeof name !== 'string' || !owners.isParentAction(name)) continue;
    if (owners.parentActionOwner(name) !== pluginId || out.indexOf(name) !== -1) continue;
    out.push(name);
  }
  return out;
}

// 確認の門の欄は、iframe が自分で入れることを許さない（確認は親が出して、親が付ける）。
const GATE_PARAMS = ['confirmName', 'confirmed', 'allowedLiveIds', 'skipConfirm'];
function relayParams(params) {
  const out = {};
  if (!plainObject(params)) return out;
  Object.keys(params).forEach((key) => {
    if (GATE_PARAMS.indexOf(key) === -1) out[key] = params[key];
  });
  return out;
}

// marust:relay。宣言（allowed）にない method は forbidden。宣言があっても本体の権限で足りなければ親が api で断る。
function handleRelayCall(message, allowed) {
  if (!plainObject(message)) return { ok: false, error: 'bad-message' };
  if (message.type !== RELAY) return { ok: false, error: 'bad-type' };
  if (!validId(message.id)) return { ok: false, error: 'bad-id' };
  if (typeof message.method !== 'string' || message.method.length < 1 || message.method.length > 120) {
    return { ok: false, error: 'bad-method' };
  }
  if (message.params != null && !plainObject(message.params)) return { ok: false, error: 'bad-params' };
  if (!Array.isArray(allowed) || allowed.indexOf(message.method) === -1) {
    return { ok: false, error: 'forbidden', reply: resultMessage(message.id, { ok: false, error: 'forbidden' }) };
  }
  return {
    ok: true,
    call: { type: RELAY, id: message.id, method: message.method, params: relayParams(message.params) }
  };
}

function permMessage(permissions) {
  const list = Array.isArray(permissions) ? permissions : [];
  return eventMessage('perm', { read: list.indexOf('read') !== -1, write: list.indexOf('write') !== -1 });
}

function panelEventMessage(subscribes, name, payload) {
  if (!eventAllowed(subscribes, name)) return null;
  return eventMessage(name, payload);
}

module.exports = {
  CALL,
  RESULT,
  EVENT,
  UI,
  RELAY,
  parsePanelCall,
  parseUiMessage,
  relayParams,
  relayMethods,
  parentActions,
  setParentOwners,
  parentActionOwner,
  handleRelayCall,
  permMessage,
  resultMessage,
  eventMessage,
  panelMethodAllowed,
  handlePanelCall,
  panelEventMessage
};
