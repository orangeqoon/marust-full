'use strict';

/**
 * プラグインのパネルを dockview の iframe として開く。
 * メソッドの権限は起動時の api.describe。取れないときは不明を拒否する。
 * 判定は host/core/panel-messages.js。ブラウザには require が無いので、同じ判定の控えを使う。
 * sandbox の iframe は origin が null なので postMessage の宛先は '*'。秘密は載せない。
 */

var UI_EXT = { '.html': 1, '.js': 1, '.css': 1, '.svg': 1, '.json': 1 };

function validPluginId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

function validPanelName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(name);
}

function pluginPanelId(pluginId, name) {
  if (!validPluginId(pluginId) || !validPanelName(name)) return '';
  return 'plugin:' + pluginId + ':' + name;
}

function parsePluginPanelId(id) {
  if (typeof id !== 'string' || id.indexOf('plugin:') !== 0) return null;
  var rest = id.slice('plugin:'.length);
  var colon = rest.indexOf(':');
  if (colon <= 0) return null;
  var pluginId = rest.slice(0, colon);
  var name = rest.slice(colon + 1);
  if (!validPluginId(pluginId) || !validPanelName(name)) return null;
  return { pluginId: pluginId, name: name };
}

function panelSrc(pluginId, file) {
  if (!validPluginId(pluginId) || typeof file !== 'string') return '';
  if (file.indexOf('\0') !== -1) return '';
  var norm = file.replace(/\\/g, '/');
  if (norm.indexOf('ui/') !== 0) return '';
  var parts = norm.split('/');
  var i;
  for (i = 0; i < parts.length; i += 1) {
    if (!parts[i] || parts[i] === '.' || parts[i] === '..') return '';
  }
  var dot = norm.lastIndexOf('.');
  if (dot < 0 || !UI_EXT[norm.slice(dot).toLowerCase()]) return '';
  var encoded = [];
  for (i = 1; i < parts.length; i += 1) encoded.push(encodeURIComponent(parts[i]));
  return '/plugins/' + encodeURIComponent(pluginId) + '/ui/' + encoded.join('/');
}

// 本体の画面の決まった場所の穴（host/core/plugin-surface.js の UI_SLOTS と同じ）
var SLOT_NAMES = ['home.top', 'home.siteCard.footer'];

function slotPanelName(slotName) {
  return 'ui-slot-' + String(slotName).toLowerCase().replace(/\./g, '-');
}

function readUi(row) {
  var ui = row.ui;
  if ((!ui || typeof ui !== 'object') && row.manifest && typeof row.manifest === 'object') ui = row.manifest.ui;
  return ui && typeof ui === 'object' && !Array.isArray(ui) ? ui : {};
}

function cleanTitle(title, fallback) {
  var text = typeof title === 'string' ? title.replace(/[\r\n\t]+/g, ' ').trim() : '';
  if (!text) text = fallback;
  if (text.length > 80) text = text.slice(0, 80);
  return text;
}

function plainClone(value) {
  if (typeof value === 'undefined') return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return undefined;
  }
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value : null;
}

function readList(row, key) {
  var direct = listOrEmpty(row[key]);
  if (direct) return direct;
  var manifest = row.manifest;
  if (manifest && typeof manifest === 'object') return listOrEmpty(manifest[key]) || [];
  return [];
}

function readActions(row) {
  var actions = row.actions;
  if (!actions && row.manifest && typeof row.manifest === 'object') actions = row.manifest.actions;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return {};
  return actions;
}

function loadHostMessages() {
  if (typeof require === 'function') {
    try {
      var loaded = require('../host/layer1/panel-messages');
      if (loaded && typeof loaded.handlePanelCall === 'function' && typeof loaded.resultMessage === 'function' && typeof loaded.panelEventMessage === 'function'
        && typeof loaded.parseUiMessage === 'function' && typeof loaded.handleRelayCall === 'function'
        && typeof loaded.relayMethods === 'function' && typeof loaded.parentActions === 'function' && typeof loaded.permMessage === 'function') {
        return loaded;
      }
    } catch (_) { /* ブラウザ、またはパスが無い */ }
  }
  return null;
}

function browserPanelMessages() {
  var CALL = 'marust:call';
  var RESULT = 'marust:result';
  var EVENT = 'marust:event';
  var UI = 'marust:ui';
  var RELAY = 'marust:relay';
  var UI_ACTIONS = ['toast', 'confirm', 'size', 'parent'];
  var PARENT_PARAMS_MAX = 4096;
  // 親の窓だけが実行する操作と、その持ち主のプラグイン。内蔵プラグインが manifest の owns.parentActions で名乗ったものを、
  // プラグインの一覧が届くたび setParentOwners が入れ直す（host/core/owners.js と同じ決まり。計画 X・P1）
  var PARENT_ACTION_OWNERS = {};
  function setParentOwners(rows) {
    Object.keys(PARENT_ACTION_OWNERS).forEach(function (key) { delete PARENT_ACTION_OWNERS[key]; });
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      var names = row && row.source === 'set' && row.owns && Array.isArray(row.owns.parentActions) ? row.owns.parentActions : [];
      names.forEach(function (name) {
        if (typeof name === 'string' && METHOD_RE.test(name) && !Object.prototype.hasOwnProperty.call(PARENT_ACTION_OWNERS, name)) PARENT_ACTION_OWNERS[name] = String(row.id);
      });
    });
  }
  function parentActionOwner(name) {
    return Object.prototype.hasOwnProperty.call(PARENT_ACTION_OWNERS, name) ? PARENT_ACTION_OWNERS[name] : '';
  }
  var TOAST_MAX = 200;
  var CONFIRM_MAX = 400;
  var BUTTON_MAX = 20;
  var HEIGHT_MIN = 40;
  var HEIGHT_MAX = 4000;
  var RELAY_MAX = 16;
  var METHOD_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/;
  var RELAY_SOURCES = ['set'];

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
    var id = message.id;
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

  function panelMethodAllowed(pluginId, method, permission, siblings) {
    if (typeof pluginId !== 'string' || typeof method !== 'string' || !method) return false;
    var owners = [pluginId].concat(Array.isArray(siblings) ? siblings.filter(function (id) { return typeof id === 'string' && id; }) : []);
    var mine = owners.some(function (owner) {
      var own = 'plugin.' + owner + '.';
      return method.indexOf(own) === 0 && method.length > own.length;
    });
    if (mine) {
      return permission === 'read' || permission === 'write';
    }
    if (method.indexOf('plugin.') === 0) return false;
    return permission === 'read';
  }

  function handlePanelCall(pluginId, message, permissionFor, siblings) {
    var parsed = parsePanelCall(message);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    var permission = '';
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

  function eventAllowed(subscribes, name) {
    if (!Array.isArray(subscribes) || typeof name !== 'string') return false;
    var i;
    for (i = 0; i < subscribes.length; i += 1) {
      var pattern = subscribes[i];
      if (typeof pattern !== 'string') continue;
      if (pattern.endsWith('*')) {
        if (name.startsWith(pattern.slice(0, -1))) return true;
      } else if (pattern === name) return true;
    }
    return false;
  }

  function panelEventMessage(subscribes, name, payload) {
    if (!eventAllowed(subscribes, name)) return null;
    return { type: EVENT, name: name, payload: payload };
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    var text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    return text.length > max ? text.slice(0, max) : text;
  }

  function parseUiMessage(message) {
    if (!plainObject(message)) return { ok: false, error: 'bad-message' };
    if (message.type !== UI) return { ok: false, error: 'bad-type' };
    if (!validId(message.id)) return { ok: false, error: 'bad-id' };
    if (UI_ACTIONS.indexOf(message.action) === -1) return { ok: false, error: 'bad-action' };
    var id = message.id;
    var text;
    if (message.action === 'toast') {
      text = cleanText(message.text, TOAST_MAX);
      if (!text) return { ok: false, error: 'bad-text' };
      return { ok: true, ui: { id: id, action: 'toast', text: text } };
    }
    if (message.action === 'confirm') {
      text = cleanText(message.text, CONFIRM_MAX);
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
      if (typeof message.name !== 'string' || !Object.prototype.hasOwnProperty.call(PARENT_ACTION_OWNERS, message.name)) return { ok: false, error: 'bad-name' };
      if (message.params != null && !plainObject(message.params)) return { ok: false, error: 'bad-params' };
      var size = 0;
      try { size = JSON.stringify(message.params || {}).length; } catch (_) { size = PARENT_PARAMS_MAX + 1; }
      if (size > PARENT_PARAMS_MAX) return { ok: false, error: 'bad-params' };
      return { ok: true, ui: { id: id, action: 'parent', name: message.name, params: message.params == null ? {} : message.params } };
    }
    var height = message.height;
    if (typeof height !== 'number' || !Number.isFinite(height)) return { ok: false, error: 'bad-height' };
    return { ok: true, ui: { id: id, action: 'size', height: Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.round(height))) } };
  }

  function relayMethods(source, manifest) {
    if (RELAY_SOURCES.indexOf(source) === -1) return [];
    var ui = manifest && plainObject(manifest.ui) ? manifest.ui : null;
    var list = ui && Array.isArray(ui.relay) ? ui.relay : [];
    var out = [];
    for (var i = 0; i < list.length && out.length < RELAY_MAX; i += 1) {
      var method = list[i];
      if (typeof method !== 'string' || method.length > 120 || !METHOD_RE.test(method)) continue;
      if (out.indexOf(method) === -1) out.push(method);
    }
    return out;
  }

  function parentActions(source, manifest, pluginId) {
    if (RELAY_SOURCES.indexOf(source) === -1) return [];
    var ui = manifest && plainObject(manifest.ui) ? manifest.ui : null;
    var list = ui && Array.isArray(ui.parentActions) ? ui.parentActions : [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var name = list[i];
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PARENT_ACTION_OWNERS, name)) continue;
      if (PARENT_ACTION_OWNERS[name] !== pluginId || out.indexOf(name) !== -1) continue;
      out.push(name);
    }
    return out;
  }

  // 確認の門の欄は、iframe が自分で入れることを許さない（host/core/panel-messages.js と同じ）
  var GATE_PARAMS = ['confirmName', 'confirmed', 'allowedLiveIds', 'skipConfirm'];
  function relayParams(params) {
    var out = {};
    if (!plainObject(params)) return out;
    Object.keys(params).forEach(function (key) {
      if (GATE_PARAMS.indexOf(key) === -1) out[key] = params[key];
    });
    return out;
  }

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
    var list = Array.isArray(permissions) ? permissions : [];
    return { type: EVENT, name: 'perm', payload: { read: list.indexOf('read') !== -1, write: list.indexOf('write') !== -1 } };
  }

  return {
    handlePanelCall: handlePanelCall,
    resultMessage: resultMessage,
    panelEventMessage: panelEventMessage,
    parseUiMessage: parseUiMessage,
    relayMethods: relayMethods,
    parentActions: parentActions,
    setParentOwners: setParentOwners,
    parentActionOwner: parentActionOwner,
    handleRelayCall: handleRelayCall,
    relayParams: relayParams,
    permMessage: permMessage
  };
}

function readCreateComponent(dockview) {
  try {
    if (dockview && dockview.component && dockview.component.options && typeof dockview.component.options.createComponent === 'function') {
      return dockview.component.options.createComponent;
    }
  } catch (_) { /* API の形が違う */ }
  try {
    if (dockview && dockview.options && typeof dockview.options.createComponent === 'function') {
      return dockview.options.createComponent;
    }
  } catch (_) { /* 同上 */ }
  if (dockview && typeof dockview.createComponent === 'function') return dockview.createComponent;
  return null;
}

function installCreateComponent(dockview, mine) {
  if (!dockview || typeof dockview.updateOptions !== 'function') return;
  var previous = readCreateComponent(dockview);
  dockview.updateOptions({
    createComponent: function (options) {
      var view = mine(options);
      if (view) return view;
      if (typeof previous === 'function') return previous(options);
      return null;
    }
  });
}

function createPluginHost(opts) {
  var options = opts || {};
  var api = options.api || null;
  var dockview = options.dockview || null;
  var win = options.window || (typeof window !== 'undefined' ? window : null);
  var doc = options.document || (win && win.document) || (typeof document !== 'undefined' ? document : null);
  var messages = options.messages && typeof options.messages.handlePanelCall === 'function'
    ? options.messages
    : (loadHostMessages() || browserPanelMessages());
  var slots = new Map();
  var catalog = [];
  var subscribesByPlugin = new Map();
  var actionsByPlugin = new Map();
  var siblingsByPlugin = new Map();
  var relayByPlugin = new Map();
  var parentByPlugin = new Map();
  var menuRows = [];
  var slotOwners = {};
  var permissions = [];
  var described = null;
  var describedSig = null;
  var unsub = null;

  function currentSiblings(pluginId) {
    var list = siblingsByPlugin.get(pluginId);
    return Array.isArray(list) ? list : [];
  }

  function currentSubscribes(pluginId) {
    var list = subscribesByPlugin.get(pluginId);
    return Array.isArray(list) ? list : [];
  }

  function declaredActionPermission(method) {
    if (typeof method !== 'string' || method.indexOf('plugin.') !== 0) return '';
    var rest = method.slice('plugin.'.length);
    var dot = rest.indexOf('.');
    if (dot <= 0) return '';
    var pluginId = rest.slice(0, dot);
    var action = rest.slice(dot + 1);
    var actions = actionsByPlugin.get(pluginId);
    if (!actions) return '';
    var value = actions[action];
    if (value === 'read' || value === 'write') return value;
    return '';
  }

  function permissionFor(method) {
    if (typeof options.permissionFor === 'function') {
      try { return options.permissionFor(method) || ''; } catch (_) { return ''; }
    }
    var known = '';
    if (api && typeof api.permissionFor === 'function') {
      try { known = api.permissionFor(method) || ''; } catch (_) { known = ''; }
      if (known === 'read' || known === 'write' || known === 'emergency') return known;
      if (typeof method === 'string' && method.indexOf('plugin.') === 0) {
        return declaredActionPermission(method) || 'write';
      }
      return '';
    }
    if (typeof method === 'string' && method.indexOf('plugin.') === 0) {
      return declaredActionPermission(method) || 'write';
    }
    if (described && typeof method === 'string' && Object.prototype.hasOwnProperty.call(described, method)) {
      return described[method];
    }
    return '';
  }

  // 機能（プラグイン）を入れ・切りすると、使える API の一覧（api.describe）が変わる。取り直すあいだも、前の一覧は使い続ける。
  function loadDescribed() {
    if (!api || typeof api.call !== 'function') return Promise.resolve();
    var pending;
    try {
      pending = api.call('api.describe', {});
    } catch (_) {
      return Promise.resolve();
    }
    return Promise.resolve(pending).then(function (result) {
      var methods = result && result.ok === true && Array.isArray(result.methods) ? result.methods : null;
      if (!methods) return;
      var next = {};
      var i;
      for (i = 0; i < methods.length; i += 1) {
        var row = methods[i];
        if (!row || typeof row.method !== 'string') continue;
        if (row.permission !== 'read' && row.permission !== 'write' && row.permission !== 'emergency') continue;
        next[row.method] = row.permission;
      }
      described = next;
    }, function () {});
  }

  function findCatalog(pluginId, name) {
    var i;
    for (i = 0; i < catalog.length; i += 1) {
      if (catalog[i].pluginId === pluginId && catalog[i].name === name) return catalog[i];
    }
    return null;
  }

  function findSlot(source) {
    if (!source) return null;
    var found = null;
    slots.forEach(function (slot) {
      if (found || slot.disposed) return;
      if (slot.iframe && slot.iframe.contentWindow === source) found = slot;
    });
    return found;
  }

  function post(slot, message) {
    if (!slot || slot.disposed || !slot.iframe) return;
    var target = slot.iframe.contentWindow;
    if (!target || typeof target.postMessage !== 'function') return;
    var body = plainClone(message);
    if (!body || typeof body !== 'object') return;
    target.postMessage(body, '*');
  }

  function postPerm(slot) {
    post(slot, messages.permMessage(permissions));
  }

  // iframe パネルへのテーマ（V8）。本体の画面に当たっている検査済みの色だけを、形を確かめ直して値だけ渡す（CSS の文字列・URL は渡さない）。
  var THEME_NAMES = ['bg', 'panel', 'panel-2', 'line', 'line-2', 'text', 'muted', 'accent', 'ok', 'warn', 'skip', 'danger', 'input-bg', 'tab-bar-bg', 'tab-active-bg', 'tab-inactive-bg'];
  var THEME_COLOR = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;
  function themeMessage() {
    if (typeof document === 'undefined' || !document.documentElement || !document.documentElement.style) return null;
    var style = document.documentElement.style;
    var vars = {};
    THEME_NAMES.forEach(function (name) {
      var value = typeof style.getPropertyValue === 'function' ? String(style.getPropertyValue('--' + name) || '').trim() : '';
      if (THEME_COLOR.test(value)) vars[name] = value;
    });
    var scheme = typeof style.getPropertyValue === 'function' && String(style.getPropertyValue('color-scheme')).trim() === 'light' ? 'light' : 'dark';
    return { type: 'marust:event', name: 'theme', payload: { vars: vars, colorScheme: scheme } };
  }

  function postTheme(slot) {
    var message = themeMessage();
    if (message) post(slot, message);
  }

  function postThemeAll() {
    slots.forEach(function (slot) { postTheme(slot); });
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('marust:theme-applied', postThemeAll);
  }

  function postPermAll() {
    slots.forEach(function (slot) { postPerm(slot); });
  }

  function errorResult(slot, id, error) {
    post(slot, messages.resultMessage(id, { ok: false, error: error }));
  }

  // marust:ui。iframe が親に頼めるのは、文字の通知・確認の窓・高さの申告の 3 つだけ。確認の窓は親（本体）が出す。
  function handleUi(slot, data) {
    var parsed;
    try { parsed = messages.parseUiMessage(data); } catch (_) { return; }
    if (!parsed || parsed.ok !== true) return;
    var ui = parsed.ui;
    if (ui.action === 'toast') {
      if (typeof options.toast === 'function') {
        try { options.toast(ui.text, slot.pluginId); } catch (_) { /* 通知が出せなくても止めない */ }
      }
      post(slot, messages.resultMessage(ui.id, { ok: true }));
      return;
    }
    if (ui.action === 'size') {
      slot.height = ui.height;
      if (slot.iframe && slot.iframe.style) {
        try { slot.iframe.style.height = ui.height + 'px'; } catch (_) { /* 閉じたあと */ }
      }
      post(slot, messages.resultMessage(ui.id, { ok: true, height: ui.height }));
      return;
    }
    if (ui.action === 'parent') {
      // 親だけが実行する操作。宣言（manifest の ui.parentActions）と持ち主の固定の両方がそろわなければ forbidden。実行・確認・権限の判断は親（options.parentAction）
      var allowedParent = parentByPlugin.get(slot.pluginId) || [];
      if (allowedParent.indexOf(ui.name) === -1 || typeof options.parentAction !== 'function') {
        // 断ったことを、そのプラグインのログに 1 行（窓の権限で。失敗しても何もしない）
        try { if (api && typeof api.call === 'function') Promise.resolve(api.call('ui.logRefusal', { pluginId: slot.pluginId, name: ui.name })).catch(function () {}); } catch (_) { /* 記録できなくても断るのは変わらない */ }
        post(slot, messages.resultMessage(ui.id, { ok: false, error: 'forbidden' }));
        return;
      }
      var ran;
      try { ran = options.parentAction(ui.name, ui.params, { pluginId: slot.pluginId, owner: typeof messages.parentActionOwner === 'function' ? messages.parentActionOwner(ui.name) : '' }); } catch (_) { ran = { ok: false, error: 'failed' }; }
      Promise.resolve(ran).then(function (result) {
        if (slot.disposed) return;
        var safe = plainClone(result);
        post(slot, messages.resultMessage(ui.id, typeof safe === 'undefined' ? { ok: false, error: 'failed' } : safe));
      }, function () {
        if (slot.disposed) return;
        post(slot, messages.resultMessage(ui.id, { ok: false, error: 'failed' }));
      });
      return;
    }
    // confirm: 窓を出せないときは「いいえ」（安全側）
    var asked;
    try {
      asked = typeof options.confirm === 'function'
        ? options.confirm(ui.text, { yes: ui.yes, no: ui.no, pluginId: slot.pluginId })
        : false;
    } catch (_) {
      asked = false;
    }
    Promise.resolve(asked).then(function (yes) {
      if (slot.disposed) return;
      post(slot, messages.resultMessage(ui.id, { ok: true, confirmed: yes === true }));
    }, function () {
      if (slot.disposed) return;
      post(slot, messages.resultMessage(ui.id, { ok: true, confirmed: false }));
    });
  }

  // marust:relay。manifest の ui.relay に書いた method だけを、窓（本体）の権限で呼ぶ。hub.fanout はここだけが通れる。
  function handleRelay(slot, data) {
    var decision;
    try { decision = messages.handleRelayCall(data, relayByPlugin.get(slot.pluginId) || []); } catch (_) { return; }
    if (!decision || decision.ok !== true) {
      if (decision && decision.reply) post(slot, decision.reply);
      return;
    }
    var call = decision.call;
    if (!api || typeof api.call !== 'function') {
      errorResult(slot, call.id, 'unavailable');
      return;
    }
    var pending;
    try {
      pending = api.call(call.method, call.params);
    } catch (_) {
      errorResult(slot, call.id, 'unavailable');
      return;
    }
    if (call.method === 'hub.fanout') {
      // 確認の門は親（本体）が持つ（V7-3）。needsConfirm なら親が確認の窓を出し、「はい」のときだけ親が confirmed を付けて呼び直す。iframe は何も付けられない。
      pending = Promise.resolve(pending).then(function (res) {
        if (!res || res.needsConfirm !== true) return res;
        var ids = Array.isArray(res.liveIds) ? res.liveIds.filter(function (id) { return typeof id === 'string'; }) : [];
        var asked;
        try { asked = typeof options.confirmFanout === 'function' ? options.confirmFanout(ids) : false; } catch (_) { asked = false; }
        return Promise.resolve(asked).then(function (yes) {
          if (yes !== true) return { ok: true, canceled: true };
          return api.call('hub.fanout', Object.assign({}, call.params, { confirmed: true, allowedLiveIds: ids }));
        });
      });
    }
    Promise.resolve(pending).then(function (result) {
      if (slot.disposed) return;
      var safe = plainClone(result);
      if (typeof safe === 'undefined') safe = { ok: false, error: 'unavailable' };
      post(slot, messages.resultMessage(call.id, safe));
    }, function () {
      if (slot.disposed) return;
      errorResult(slot, call.id, 'unavailable');
    });
  }

  function dropSlot(panelId) {
    var slot = slots.get(panelId);
    if (!slot) return;
    slot.disposed = true;
    slots.delete(panelId);
    if (slot.iframe && typeof slot.iframe.setAttribute === 'function') {
      try { slot.iframe.setAttribute('src', 'about:blank'); } catch (_) { /* 閉じたあと */ }
    }
  }

  function handleMessage(event) {
    if (!event) return;
    var slot = findSlot(event.source);
    if (!slot) return;
    var kind = event.data && typeof event.data === 'object' ? event.data.type : '';
    if (kind === 'marust:ui') { handleUi(slot, event.data); return; }
    if (kind === 'marust:relay') { handleRelay(slot, event.data); return; }
    var decision;
    try {
      decision = messages.handlePanelCall(slot.pluginId, event.data, permissionFor, currentSiblings(slot.pluginId));
    } catch (_) {
      return;
    }
    if (!decision || decision.ok !== true) {
      if (decision && decision.reply) post(slot, decision.reply);
      return;
    }
    var call = decision.call;
    if (!call || !api || typeof api.call !== 'function') {
      post(slot, messages.resultMessage(call ? call.id : '', { ok: false, error: 'unavailable' }));
      return;
    }
    var pending;
    try {
      pending = api.call(call.method, call.params);
    } catch (_) {
      post(slot, messages.resultMessage(call.id, { ok: false, error: 'unavailable' }));
      return;
    }
    Promise.resolve(pending).then(function (result) {
      if (slot.disposed) return;
      var safe = plainClone(result);
      if (typeof safe === 'undefined') safe = { ok: false, error: 'unavailable' };
      post(slot, messages.resultMessage(call.id, safe));
    }, function () {
      if (slot.disposed) return;
      post(slot, messages.resultMessage(call.id, { ok: false, error: 'unavailable' }));
    });
  }

  // 開いているそのプラグインのパネル（iframe）だけを読み直す。id が '*' なら全部。src に ?r=<時刻> を付けて取り直させる。
  function reloadPlugin(pluginId) {
    var count = 0;
    slots.forEach(function (slot) {
      if (slot.disposed || !slot.iframe || typeof slot.iframe.getAttribute !== 'function') return;
      if (pluginId !== '*' && slot.pluginId !== pluginId) return;
      var current = slot.iframe.getAttribute('src');
      if (!current || current === 'about:blank') return;
      var base = current.replace(/[?&]r=\d+$/, '');
      slot.iframe.setAttribute('src', base + (base.indexOf('?') === -1 ? '?' : '&') + 'r=' + Date.now());
      count += 1;
    });
    return count;
  }

  function reloadTarget(msg) {
    var payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    if (msg.name === 'plugin.reloaded' && typeof payload.id === 'string') return payload.id === '*' || validPluginId(payload.id) ? payload.id : '';
    if (msg.name === 'ui.reloadRequested' && typeof payload.target === 'string') {
      if (payload.target.indexOf('plugin:') === 0) return validPluginId(payload.target.slice(7)) ? payload.target.slice(7) : '';
    }
    return '';
  }

  function onBus(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.name !== 'string') return;
    var reloadId = reloadTarget(msg);
    if (reloadId) {
      // 直したあとで panels の宣言が変わっていることがあるので、一覧を取り直してから iframe を付け直す
      pull().then(function () { reloadPlugin(reloadId); });
      return;
    }
    var payload = plainClone(msg.payload);
    if (typeof payload === 'undefined') {
      if (typeof msg.payload === 'undefined') payload = null;
      else return;
    }
    slots.forEach(function (slot) {
      if (slot.disposed) return;
      var out;
      try {
        out = messages.panelEventMessage(currentSubscribes(slot.pluginId), msg.name, payload);
      } catch (_) {
        out = null;
      }
      if (out) post(slot, out);
    });
  }

  function createPluginView(createOptions) {
    if (!doc || typeof doc.createElement !== 'function') return null;
    var rawId = createOptions && (createOptions.id || createOptions.name);
    var parsed = parsePluginPanelId(rawId);
    if (!parsed && createOptions) parsed = parsePluginPanelId(createOptions.name);
    if (!parsed) return null;
    var panelId = pluginPanelId(parsed.pluginId, parsed.name);
    // 穴に置くものは同じ穴を何か所にも置けるよう、呼び出し側の鍵で slots に入れる（dock のパネルは panelId）
    var key = createOptions && typeof createOptions.key === 'string' ? createOptions.key : panelId;
    var entry = findCatalog(parsed.pluginId, parsed.name);
    var root = doc.createElement('div');
    root.className = 'dock-panel-root plugin-host-root';
    var frame = doc.createElement('iframe');
    frame.className = 'plugin-host-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', entry ? entry.title : parsed.name);
    root.appendChild(frame);
    if (typeof frame.addEventListener === 'function') {
      frame.addEventListener('load', function () {
        var mine = slots.get(key);
        if (mine && mine.iframe === frame) { postPerm(mine); postTheme(mine); }
      });
    }
    if (typeof options.decorate === 'function' && key === panelId) {
      try { options.decorate(panelId, root, frame); } catch (_) { /* 付け足しが失敗しても本体のパネルは出す */ }
    }
    var slot = {
      panelId: key,
      pluginId: parsed.pluginId,
      name: parsed.name,
      iframe: frame,
      disposed: false
    };
    var previous = slots.get(key);
    if (previous) dropSlot(key);
    slots.set(key, slot);

    function applyParams(params, title) {
      var file = params && typeof params.file === 'string' ? params.file : (entry && entry.file);
      var src = panelSrc(parsed.pluginId, file || '');
      if (src) frame.setAttribute('src', src);
      var label = title || (entry && entry.title) || parsed.name;
      if (label) frame.setAttribute('title', label);
    }

    if (entry) applyParams({ file: entry.file }, entry.title);
    return {
      element: root,
      init: function (arg) {
        entry = findCatalog(parsed.pluginId, parsed.name) || entry;
        var params = arg && arg.params && typeof arg.params === 'object' ? arg.params : null;
        var title = arg && typeof arg.title === 'string' ? arg.title : '';
        applyParams(params, title);
      },
      dispose: function () {
        dropSlot(key);
      }
    };
  }

  function applyPlugins(plugins) {
    catalog = [];
    subscribesByPlugin = new Map();
    actionsByPlugin = new Map();
    siblingsByPlugin = new Map();
    relayByPlugin = new Map();
    parentByPlugin = new Map();
    menuRows = [];
    slotOwners = {};
    var offIds = [];
    var seen = {};
    var rows = Array.isArray(plugins) ? plugins : [];
    if (typeof messages.setParentOwners === 'function') messages.setParentOwners(rows);
    var i;
    for (i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || typeof row !== 'object' || row.status === 'skip') continue;
      if (!validPluginId(row.id)) continue;
      subscribesByPlugin.set(row.id, readList(row, 'subscribes').filter(function (item) {
        return typeof item === 'string';
      }));
      actionsByPlugin.set(row.id, readActions(row));
      siblingsByPlugin.set(row.id, readList(row, 'siblings').filter(function (item) {
        return typeof item === 'string' && validPluginId(item);
      }));
      // 窓の中継の宣言。出どころ（source）は本体の登録簿の値。外から入れたものは空になる
      relayByPlugin.set(row.id, messages.relayMethods(row.source, row.manifest && typeof row.manifest === 'object' ? row.manifest : row));
      // 親の窓だけが実行する操作（K3）。持ち主の固定と宣言の両方がそろった名前だけ
      parentByPlugin.set(row.id, messages.parentActions(row.source, row.manifest && typeof row.manifest === 'object' ? row.manifest : row, row.id));
      var panels = readList(row, 'panels');
      var p;
      // 「機能」として入／切するプラグイン（feature.activation が live）が切（legacy）のあいだは、画面を一覧に出さず、開いていれば閉じる（V7-7）
      if (row.mode === 'legacy' && row.feature && typeof row.feature === 'object' && row.feature.activation === 'live') {
        for (p = 0; p < panels.length; p += 1) {
          if (panels[p] && validPanelName(panels[p].name)) offIds.push(pluginPanelId(row.id, panels[p].name));
        }
        continue;
      }
      for (p = 0; p < panels.length; p += 1) {
        var panel = panels[p];
        if (!panel || typeof panel !== 'object' || !validPanelName(panel.name)) continue;
        var file = typeof panel.file === 'string' ? panel.file : '';
        if (!panelSrc(row.id, file)) continue;
        var id = pluginPanelId(row.id, panel.name);
        if (seen[id]) continue;
        seen[id] = true;
        catalog.push({
          id: id,
          pluginId: row.id,
          name: panel.name,
          title: cleanTitle(panel.title, panel.name),
          file: file,
          kind: 'panel',
          aliases: Array.isArray(panel.aliases) ? panel.aliases.slice() : [],
          dock: Array.isArray(panel.dock) ? panel.dock.slice() : [],
          dockOrder: typeof panel.dockOrder === 'number' ? panel.dockOrder : 50,
          menu: panel.menu && typeof panel.menu === 'object' && !Array.isArray(panel.menu) ? plainClone(panel.menu) : null
        });
      }
      if (row.mode !== 'legacy') collectUi(row, seen); // 穴・メニュー・小窓・設定は、切のあいだ出さない（外から入れたものも）
    }
    offIds.forEach(function (offId) { if (offId && isOpen(offId)) close(offId); });
    slots.forEach(function (slot) {
      if (slot.disposed || !slot.iframe || typeof slot.iframe.getAttribute !== 'function') return;
      if (slot.iframe.getAttribute('src')) return;
      var known = findCatalog(slot.pluginId, slot.name);
      if (!known) return;
      var src = panelSrc(slot.pluginId, known.file);
      if (src) slot.iframe.setAttribute('src', src);
    });
  }

  // ui.popup / ui.settings / ui.slots / ui.menu（V7-5）。小窓・設定・穴の iframe は dock のパネルと同じ道具で作り、kind で見分ける。
  function addExtra(row, kind, name, title, file, seen) {
    if (!validPanelName(name) || !panelSrc(row.id, file)) return null;
    var id = pluginPanelId(row.id, name);
    if (seen[id]) return null;
    seen[id] = true;
    var entry = { id: id, pluginId: row.id, name: name, title: cleanTitle(title, name), file: file, kind: kind };
    catalog.push(entry);
    return entry;
  }

  function collectUi(row, seen) {
    var ui = readUi(row);
    var list;
    var i;
    list = Array.isArray(ui.popup) ? ui.popup : [];
    for (i = 0; i < list.length; i += 1) {
      if (list[i] && typeof list[i] === 'object' && typeof list[i].name === 'string') {
        addExtra(row, 'popup', 'ui-popup-' + list[i].name, list[i].title, list[i].file, seen);
      }
    }
    if (ui.settings && typeof ui.settings === 'object') addExtra(row, 'settings', 'ui-settings', ui.settings.title, ui.settings.file, seen);
    list = Array.isArray(ui.slots) ? ui.slots : [];
    for (i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item || typeof item !== 'object' || SLOT_NAMES.indexOf(item.slot) === -1) continue;
      var made = addExtra(row, 'slot', slotPanelName(item.slot), item.title || item.slot, item.file, seen);
      if (!made) continue;
      // 同じ穴を 2 つが使うときは、あとから並んだ方を使う（V7-6）
      if (!slotOwners[item.slot]) slotOwners[item.slot] = [];
      slotOwners[item.slot].push(made);
    }
    list = Array.isArray(ui.menu) ? ui.menu : [];
    for (i = 0; i < list.length; i += 1) {
      var m = list[i];
      if (!m || typeof m !== 'object' || typeof m.label !== 'string' || !m.label) continue;
      if (typeof m.openPanel === 'string' && validPanelName(m.openPanel)) {
        menuRows.push({ pluginId: row.id, label: cleanTitle(m.label, row.id), openPanel: m.openPanel });
      } else if (typeof m.method === 'string' && m.method.indexOf('plugin.' + row.id + '.') === 0) {
        // 呼べるのは自分のプラグインの操作だけ（V7-2）
        menuRows.push({ pluginId: row.id, label: cleanTitle(m.label, row.id), method: m.method });
      }
    }
  }

  function slotEntry(slotName) {
    var list = slotOwners[slotName];
    return list && list.length ? list[list.length - 1] : null;
  }

  // 穴に iframe を置く。置くたびに別の鍵で slots に入れる（サイトのカードごとなど）。戻り値の dispose で外す。
  var mountCount = 0;
  var slotNotices = {};
  function mountSlot(slotName, container) {
    var entry = slotEntry(slotName);
    if (!entry || !container || typeof container.appendChild !== 'function') return null;
    mountCount += 1;
    var view = createPluginView({ id: entry.id, key: entry.id + '#' + mountCount });
    if (!view) return null;
    view.element.className = 'plugin-slot-root';
    container.appendChild(view.element);
    view.init({});
    var owners = slotOwners[slotName] || [];
    var noticeKey = slotName + '>' + entry.pluginId + '/' + owners.length;
    if (owners.length > 1 && !slotNotices[noticeKey] && typeof options.toast === 'function') {
      slotNotices[noticeKey] = true;
      try { options.toast(slotName + ' を使うプラグインが ' + owners.length + ' 個あります。' + entry.pluginId + ' を表示しています。', entry.pluginId); } catch (_) { /* 通知だけ */ }
    }
    return {
      pluginId: entry.pluginId,
      dispose: function () {
        view.dispose();
        if (view.element && view.element.parentNode) view.element.parentNode.removeChild(view.element);
      }
    };
  }

  function runMenu(item) {
    if (!item || typeof item !== 'object') return Promise.resolve(null);
    if (typeof item.openPanel === 'string') return ready.then(function () { return openOne(item.pluginId, item.openPanel); });
    if (typeof item.method === 'string' && item.method.indexOf('plugin.' + item.pluginId + '.') === 0 && api && typeof api.call === 'function') {
      return Promise.resolve().then(function () { return api.call(item.method, {}); });
    }
    return Promise.resolve(null);
  }

  function pull() {
    if (!api || typeof api.call !== 'function') return Promise.resolve();
    var pending;
    try {
      pending = api.call('hub.getState', {});
    } catch (_) {
      return Promise.resolve();
    }
    return Promise.resolve(pending).then(function (state) {
      permissions = state && Array.isArray(state.permissions) ? state.permissions.filter(function (item) { return typeof item === 'string'; }) : [];
      applyPlugins(state && state.plugins);
      postPermAll();
    }, function () {});
  }

  function isOpen(id) {
    try {
      return !!(dockview && typeof dockview.getPanel === 'function' && dockview.getPanel(id));
    } catch (_) {
      return false;
    }
  }

  var pendingPosition = null;

  function place(entry) {
    if (!dockview || typeof dockview.addPanel !== 'function' || !entry) return null;
    if (isOpen(entry.id)) return dockview.getPanel(entry.id);
    var opt = {
      id: entry.id,
      component: entry.id,
      title: entry.title,
      params: { pluginId: entry.pluginId, name: entry.name, file: entry.file }
    };
    if (entry.kind === 'popup') opt.floating = true;
    else if (pendingPosition) opt.position = pendingPosition;
    else if (isOpen('plugins')) opt.position = { referencePanel: 'plugins', direction: 'within' };
    try {
      return dockview.addPanel(opt);
    } catch (_) {
      try {
        delete opt.position;
        delete opt.floating;
        return dockview.addPanel(opt);
      } catch (err) {
        return null;
      }
    }
  }

  function openOne(pluginId, name) {
    var id = '';
    var panelName = name;
    var idOnly = pluginId;
    if (typeof name !== 'string') {
      var parsed = parsePluginPanelId(pluginId);
      if (!parsed) return null;
      idOnly = parsed.pluginId;
      panelName = parsed.name;
    }
    id = pluginPanelId(idOnly, panelName);
    var entry = findCatalog(idOnly, panelName);
    if (!entry && id) {
      var i;
      for (i = 0; i < catalog.length; i += 1) if (catalog[i].id === id) entry = catalog[i];
    }
    return place(entry);
  }

  function openAll() {
    var i;
    var opened = [];
    for (i = 0; i < catalog.length; i += 1) {
      if (catalog[i].kind !== 'panel') continue;
      var panel = place(catalog[i]);
      if (panel) opened.push(catalog[i].id);
    }
    return opened;
  }

  function close(id) {
    if (!dockview || typeof dockview.removePanel !== 'function') return;
    var panel = null;
    try { panel = dockview.getPanel(id); } catch (_) { panel = null; }
    if (panel) dockview.removePanel(panel);
  }

  installCreateComponent(dockview, createPluginView);
  if (win && typeof win.addEventListener === 'function') win.addEventListener('message', handleMessage);
  if (api && typeof api.subscribe === 'function') {
    try { unsub = api.subscribe(onBus); } catch (_) { unsub = null; }
  }
  if (dockview && typeof dockview.onDidRemovePanel === 'function') {
    try {
      dockview.onDidRemovePanel(function (ev) {
        var id = '';
        if (ev && typeof ev.id === 'string') id = ev.id;
        else if (ev && ev.panel && typeof ev.panel.id === 'string') id = ev.panel.id;
        if (parsePluginPanelId(id)) dropSlot(id);
      });
    } catch (_) { /* ドックがイベントを持たない */ }
  }

  var ready = Promise.all([pull(), loadDescribed()]).then(function () {});

  return {
    panelId: pluginPanelId,
    parsePanelId: parsePluginPanelId,
    ready: ready,
    sync: function (plugins) {
      applyPlugins(plugins);
      // プラグインのモードが変わったら、使える API の一覧も取り直す（切のあいだは隠れていた API が増える）
      var sig = JSON.stringify((Array.isArray(plugins) ? plugins : []).map(function (row) { return row && [row.id, row.mode]; }));
      if (sig !== describedSig) {
        var first = describedSig === null;
        describedSig = sig;
        if (!first) loadDescribed();
      }
    },
    reloadPlugin: reloadPlugin,
    listPanels: function () {
      return catalog.filter(function (entry) { return entry.kind === 'panel'; }).map(function (entry) {
        return {
          id: entry.id,
          pluginId: entry.pluginId,
          name: entry.name,
          title: entry.title,
          file: entry.file,
          aliases: entry.aliases || [],
          dock: entry.dock || [],
          dockOrder: typeof entry.dockOrder === 'number' ? entry.dockOrder : 50,
          menu: entry.menu || null,
          open: isOpen(entry.id)
        };
      });
    },
    isOpen: isOpen,
    listMenu: function () { return menuRows.map(function (row) { return Object.assign({}, row); }); },
    runMenu: runMenu,
    mountSlot: function (slotName, container) { return mountSlot(slotName, container); },
    hasSlot: function (slotName) { return !!slotEntry(slotName); },
    openPopup: function (pluginId, name) { return ready.then(function () { return openOne(pluginId, 'ui-popup-' + name); }); },
    openSettings: function (pluginId) { return ready.then(function () { return openOne(pluginId, 'ui-settings'); }); },
    open: function (pluginId, name) { return ready.then(function () { return openOne(pluginId, name); }); },
    // 位置（dockview の position）を指定して開く。カテゴリのウィンドウ（同じタブ）にまとめるときに使う。
    openAt: function (id, position) {
      return ready.then(function () {
        pendingPosition = position || null;
        try { return openOne(id); } finally { pendingPosition = null; }
      });
    },
    openAll: function () { return ready.then(function () { return openAll(); }); },
    close: close,
    dispose: function () {
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('message', handleMessage);
      if (typeof unsub === 'function') {
        try { unsub(); } catch (_) { /* 購読解除 */ }
      }
      unsub = null;
      Array.from(slots.keys()).forEach(dropSlot);
    }
  };
}

var pluginHostApi = {
  createPluginHost: createPluginHost,
  pluginPanelId: pluginPanelId,
  parsePluginPanelId: parsePluginPanelId,
  browserPanelMessages: browserPanelMessages
};

if (typeof module === 'object' && module.exports) module.exports = pluginHostApi;
if (typeof window !== 'undefined') {
  window.createPluginHost = createPluginHost;
  window.pluginPanelId = pluginPanelId;
  window.parsePluginPanelId = parsePluginPanelId;
}
