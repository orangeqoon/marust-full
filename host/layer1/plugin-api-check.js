'use strict';

/**
 * ctx.api.register の形の検査（V1）。表に触らない軽い部品。
 * host/core/api.js（表へ入れるとき）と host/core/plugin-registry.js（登録の時点・manifest の api 欄）の両方が使う。
 */

const { ID_RE, ACTION_RE } = require('./plugin-surface');

// 本体の名前空間（プラグインは使えない）。V6 の終わりまでは「移す予定」の名前空間もここには入れない
const CORE_NAMESPACES = Object.freeze(['hub', 'broadcast', 'devmode', 'obs', 'engine', 'layout', 'clients', 'destination', 'approval', 'api', 'secrets', 'vault', 'modes', 'features', 'plugins', 'plugin', 'ui', 'app', 'home', 'migration', 'settings']);
const PLUGIN_NS_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const PLUGIN_METHOD_OPTS = ['access', 'params', 'description', 'windowOnly'];
const PLUGIN_RULE_KEYS = ['type', 'required', 'min', 'max', 'integer', 'enum', 'item', 'error', 'typeError', 'rangeError', 'lengthError', 'emptyError', 'trimEmpty'];
const PLUGIN_RULE_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
const PLUGIN_METHOD_TIMEOUT_MS = 15000;
// ctx.api.call（V2-1）: 呼べない名前空間。ほかに windowOnly の行・権限が read/write でない行・プラグインが出した行は api.js が断る
const CALL_DENIED_NAMESPACES = Object.freeze(['clients', 'approval', 'modes', 'devmode', 'plugins', 'plugin']);
// 名前で断るもの（確認の門・配信キーの書き込み・全部 legacy・再起動をプラグインに持たせない。V2 の評価）。題名を送りたい内蔵は bulk-title を通す
const CALL_DENIED_METHODS = Object.freeze(['hub.fanout', 'hub.forceLegacy', 'app.restart']);
const API_CALLS_MAX = 30;
// ctx.peers（V2-10）: 内蔵プラグインが、ほかのプラグイン（サイト）の中身へ届く決まったメソッドだけ。増やすときは Opus に聞く
const PEER_METHODS = Object.freeze(['updateMetadata', 'updateStream', 'updateTitle', 'updateCategory', 'isConfigured', 'loginNeeds', 'suggestCategories', 'sendComment']);

function pluginParamRules(params) {
  if (params == null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) return null;
  const names = Object.keys(params);
  if (names.length > 20) return null;
  const out = {};
  for (let i = 0; i < names.length; i += 1) {
    const rule = params[names[i]];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const keys = Object.keys(rule);
    for (let k = 0; k < keys.length; k += 1) {
      if (PLUGIN_RULE_KEYS.indexOf(keys[k]) === -1) return null;
    }
    if (rule.type !== undefined && PLUGIN_RULE_TYPES.indexOf(rule.type) === -1) return null;
    out[names[i]] = Object.assign({}, rule);
  }
  return out;
}

// ctx.api.register の形の検査（表に触らない）。registry が登録の時点で返す答えにも、表へ入れるときにも使う
function checkPluginMethod(pluginId, method, opts, handler) {
  if (typeof pluginId !== 'string' || !ID_RE.test(pluginId)) return { ok: false, error: 'bad-id' };
  const parts = typeof method === 'string' ? method.split('.') : [];
  if (parts.length !== 2 || !PLUGIN_NS_RE.test(parts[0]) || !ACTION_RE.test(parts[1])) return { ok: false, error: 'bad-method' };
  if (CORE_NAMESPACES.indexOf(parts[0]) !== -1) return { ok: false, error: 'reserved' };
  if (typeof handler !== 'function') return { ok: false, error: 'bad-handler' };
  const given = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : null;
  if (!given) return { ok: false, error: 'bad-option' };
  if (Object.keys(given).some(function (key) { return PLUGIN_METHOD_OPTS.indexOf(key) === -1; })) return { ok: false, error: 'bad-option' };
  if (given.access !== 'read' && given.access !== 'write') return { ok: false, error: 'bad-access' };
  const rules = pluginParamRules(given.params);
  if (!rules) return { ok: false, error: 'bad-params' };
  if (given.description !== undefined && (typeof given.description !== 'string' || given.description.length > 200)) return { ok: false, error: 'bad-option' };
  if (given.windowOnly !== undefined && typeof given.windowOnly !== 'boolean') return { ok: false, error: 'bad-option' };
  return { ok: true, ns: parts[0], given: given, rules: rules };
}

// ctx.api.call の名前の形の検査（表に触らない）。manifest の api.calls にも、呼ぶときにも使う
function checkPluginCall(method) {
  const parts = typeof method === 'string' ? method.split('.') : [];
  if (parts.length !== 2 || !PLUGIN_NS_RE.test(parts[0]) || !ACTION_RE.test(parts[1])) return { ok: false, error: 'bad-method' };
  if (CALL_DENIED_NAMESPACES.indexOf(parts[0]) !== -1 || CALL_DENIED_METHODS.indexOf(method) !== -1) return { ok: false, error: 'forbidden' };
  return { ok: true };
}

module.exports = { CORE_NAMESPACES, CALL_DENIED_NAMESPACES, CALL_DENIED_METHODS, API_CALLS_MAX, PEER_METHODS, PLUGIN_NS_RE, PLUGIN_METHOD_TIMEOUT_MS, checkPluginMethod, checkPluginCall };
