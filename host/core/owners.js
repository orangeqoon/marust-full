'use strict';

/**
 * 持ち主の表（計画 X・P1）。本体はプラグインの名前を知らない。「このイベント／親の操作の持ち主はこのプラグイン」は、
 * 内蔵プラグインが manifest の `owns` で名乗る（登録簿が読み込みの前に claim する）。外から入れたものの名乗りは受けない。
 * - events: ['session.*', 'chat.message']（末尾 * は前方一致）
 * - parentActions: ['ai.pair']（親の窓だけが実行する操作。plugins/ui-standard/shell/core/parent-actions.js）
 * 持ち主以外が出す・使うのを断る判断は今までどおり event-bus／panel-messages が行う（ここは表を持つだけ）。
 */

const EVENT_RE = /^[a-z][A-Za-z0-9.]{0,60}(\.\*)?$/;
const ACTION_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/;

const events = new Map(); // パターン → プラグイン id
const parentActions = new Map(); // 操作の名前 → プラグイン id

function cleanOwns(raw) {
  const out = { events: [], parentActions: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  (Array.isArray(raw.events) ? raw.events : []).forEach((p) => { if (typeof p === 'string' && EVENT_RE.test(p) && out.events.indexOf(p) === -1) out.events.push(p); });
  (Array.isArray(raw.parentActions) ? raw.parentActions : []).forEach((n) => { if (typeof n === 'string' && n.length <= 120 && ACTION_RE.test(n) && out.parentActions.indexOf(n) === -1) out.parentActions.push(n); });
  return out;
}

/** 先に名乗ったものが勝つ（同じ id の名乗り直しは通す）。取れなかった名前を返す。 */
function claim(pluginId, owns) {
  const clean = cleanOwns(owns);
  const refused = [];
  clean.events.forEach((p) => { const cur = events.get(p); if (cur && cur !== pluginId) refused.push(p); else events.set(p, pluginId); });
  clean.parentActions.forEach((n) => { const cur = parentActions.get(n); if (cur && cur !== pluginId) refused.push(n); else parentActions.set(n, pluginId); });
  return refused;
}

function release(pluginId) {
  [events, parentActions].forEach((m) => Array.from(m.keys()).forEach((k) => { if (m.get(k) === pluginId) m.delete(k); }));
}

function eventOwner(name) {
  const text = typeof name === 'string' ? name : '';
  for (const [pattern, id] of events) {
    if (pattern.charAt(pattern.length - 1) === '*' ? text.indexOf(pattern.slice(0, -1)) === 0 : text === pattern) return id;
  }
  return '';
}

function parentActionOwner(name) {
  return parentActions.get(name) || '';
}

function isParentAction(name) {
  return typeof name === 'string' && parentActions.has(name);
}

function parentActionNames() {
  return Array.from(parentActions.keys());
}

function resetParentActions() {
  parentActions.clear();
}

function reset() {
  events.clear();
  parentActions.clear();
}

module.exports = { claim, release, reset, resetParentActions, cleanOwns, eventOwner, parentActionOwner, isParentAction, parentActionNames };
