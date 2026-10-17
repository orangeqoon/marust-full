'use strict';
/**
 * 親の窓だけが実行する操作（K3）。プラグインの iframe は名前と小さな値を渡すだけで、確認の窓・権限の判断・実際の呼び出しは全部ここ（親）。
 * 名前の一覧と持ち主は内蔵プラグインの manifest の owns.parentActions（host/core/owners.js）（ui/plugin-host.js が持ち主と宣言を見てからここへ来る）。
 *   modes.change / modes.setMany / modes.setDefault / hub.forceLegacy … モードを動かす開発者プラグインが持ち主（開発者モードが入のときだけ。窓だけ）
 *   ai.pair … AI をつなぐプラグインが持ち主（ペアリングのコードを作る。名前・種類・権限は親の固定の値。待ちは 1 つまで）
 * 確認の文は親が自分で作る（iframe の文は使わない）。モードの一覧は親が modes.list を読んで確かめる。
 */
var PAIRING_MS = 120000;

function parentIsWindow() {
  return call('hub.getState', {}).then(function (state) {
    if (state && typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
    noteDevMode(state);
    return { window: !!(state && state.clientId === 'local-window'), dev: !!(state && state.devMode === true) };
  }, function () { return { window: false, dev: false }; });
}

/** live にする前の確認で使う。配信中の送信先があるか。 */
function parentAnyDestinationLive() {
  function fromEngine() {
    return call('engine.listTargets').then(function (targets) {
      var rows = Array.isArray(targets) ? targets : [];
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].state === 'live') return true;
      }
      return false;
    }).catch(function () { return false; });
  }
  return call('destination.list').then(function (res) {
    var rows = res && Array.isArray(res.destinations) ? res.destinations : [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].status === 'live') return true;
    }
    return fromEngine();
  }).catch(function () { return fromEngine(); });
}

/** プラグイン id を打たせる確認の窓。やめる・Esc は null。 */
function parentAskPluginId(pluginId, pluginName, broadcasting) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modes-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var card = document.createElement('div');
    card.className = 'modes-dialog-card';
    var title = document.createElement('h3');
    title.textContent = STR.uiModes16;
    var body = document.createElement('p');
    body.textContent = (pluginName || pluginId) + STR.uiModes17;
    var expected = document.createElement('p');
    expected.className = 'timer-hint';
    expected.textContent = 'id: ' + pluginId;
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(expected);
    if (broadcasting) {
      var warn = document.createElement('p');
      warn.className = 'modes-warn';
      warn.textContent = STR.uiModes18;
      card.appendChild(warn);
    }
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', STR.uiModes19);
    var actions = document.createElement('div');
    actions.className = 'timer-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'timer-btn';
    cancel.textContent = STR.uiModes20;
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'timer-btn primary';
    ok.textContent = STR.uiModes21;
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(input);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var done = false;
    function finish(value) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      if (window.marustA11y && typeof window.marustA11y.restoreDialogFocus === 'function') {
        window.marustA11y.restoreDialogFocus(overlay);
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(value);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') finish(null);
      else if (ev.key === 'Enter') finish(input.value);
    }
    cancel.addEventListener('click', function () { finish(null); });
    ok.addEventListener('click', function () { finish(input.value); });
    document.addEventListener('keydown', onKey);
    if (window.marustA11y && typeof window.marustA11y.focusDialog === 'function') {
      window.marustA11y.focusDialog(overlay);
    } else {
      input.focus();
    }
  });
}

function parentModeRows() {
  return call('modes.list', {}).then(function (res) {
    return res && res.ok !== false && Array.isArray(res.plugins) ? res.plugins : null;
  }, function () { return null; });
}

var PARENT_MODE_RE = /^(legacy|shadow|live)$/;
var PARENT_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;

function parentModesChange(params) {
  var id = params && typeof params.id === 'string' ? params.id : '';
  var mode = params && typeof params.mode === 'string' ? params.mode : '';
  if (!PARENT_ID_RE.test(id)) return Promise.resolve({ ok: false, error: 'bad-id' });
  if (!PARENT_MODE_RE.test(mode)) return Promise.resolve({ ok: false, error: 'bad-mode' });
  if (mode !== 'live') return call('modes.set', { id: id, mode: mode });
  return parentModeRows().then(function (rows) {
    if (!rows) return { ok: false, error: 'unavailable' };
    var row = rows.filter(function (r) { return r && r.id === id; })[0];
    if (!row) return { ok: false, error: 'unknown-plugin' };
    if (row.requiresMet === false) return { ok: false, error: 'requires-unmet' };
    return parentAnyDestinationLive().then(function (broadcasting) {
      // 親が自分の言葉で確認する（iframe の文は出さない）
      if (confirmLiveWanted) return parentAskPluginId(row.id, row.name, broadcasting);
      if (broadcasting && !window.confirm((row.name || row.id) + STR.uiModes52)) return null;
      return row.id;
    }).then(function (typed) {
      if (typed == null) return { ok: true, canceled: true };
      return call('modes.set', { id: id, mode: 'live', confirmName: typed });
    });
  });
}

function parentModesSetMany(params) {
  var mode = params && typeof params.mode === 'string' ? params.mode : '';
  if (!PARENT_MODE_RE.test(mode)) return Promise.resolve({ ok: false, error: 'bad-mode' });
  var ids = Array.isArray(params.ids) ? params.ids.filter(function (item) { return typeof item === 'string' && PARENT_ID_RE.test(item); }).slice(0, 64) : null;
  if (mode !== 'live') return call('modes.setMany', ids ? { mode: mode, ids: ids } : { mode: mode });
  // live は、対象を全部並べて 1 回だけ確認する（対象は親が modes.list から作る）
  return parentModeRows().then(function (rows) {
    if (!rows) return { ok: false, error: 'unavailable' };
    var targets = rows.map(function (r) { return String(r.id); }).filter(function (id) {
      return ids ? ids.indexOf(id) !== -1 : /^site-/.test(id);
    });
    if (!targets.length) return { ok: true, results: [] };
    if (!window.confirm((ids ? STR.uiModes22 : STR.uiModes27) + '\n' + targets.join(', '))) return { ok: true, canceled: true };
    return call('modes.setMany', ids ? { mode: mode, ids: targets } : { mode: mode });
  });
}

function parentAiPair() {
  // 待ちは 1 つまで: 新しく始めると、核（clients）が前のコードを取り消す（K3 評価 Should 3）
  return call('clients.beginPairing', {
    name: STR.uiAiConnect1,
    kind: 'native',
    requiresApproval: true,
    permissions: ['read', 'write'],
    mcp: true
  }).then(function (res) {
    if (!res || res.ok === false || !res.code) return { ok: false, error: 'failed' };
    return { ok: true, code: String(res.code), expiresInSec: Math.round(PAIRING_MS / 1000) };
  }, function () { return { ok: false, error: 'failed' }; });
}

/** options.parentAction。名前は plugin-host が持ち主と宣言を見たあと。ここでも窓・開発者モードを確かめる（二重）。 */
function pluginParentAction(name, params, info) {
  var p = params && typeof params === 'object' ? params : {};
  return parentIsWindow().then(function (who) {
    if (!who.window) return { ok: false, error: 'forbidden' };
    // 持ち主は内蔵プラグインが manifest の owns.parentActions で名乗ったもの（plugin-host が引いて info.owner に入れる）。持ち主以外には効かない
    var owned = !!info && !!info.owner && info.owner === info.pluginId;
    if (name === 'ai.pair') return owned ? parentAiPair() : { ok: false, error: 'forbidden' };
    // モードを動かす操作は、開発者モードが入で、持ち主のプラグインのときだけ
    if (!who.dev) return { ok: false, error: 'dev-only' };
    if (!owned) return { ok: false, error: 'forbidden' };
    if (name === 'modes.change') return parentModesChange(p);
    if (name === 'modes.setMany') return parentModesSetMany(p);
    if (name === 'modes.setDefault') return call('modes.setDefault', { mode: typeof p.mode === 'string' ? p.mode : '' });
    if (name === 'hub.forceLegacy') return call('hub.forceLegacy', {});
    return { ok: false, error: 'forbidden' };
  });
}

PLUGIN_HOST_UI.parentAction = pluginParentAction;

// メニュー（開発者モードの「全部 live にする」）から呼ぶ。ユーザーが画面で押したときだけ。確認つき。
function setAllLive(statusNode) {
  if (!can.write) return Promise.resolve();
  if (!window.confirm(STR.uiModes22)) return Promise.resolve();
  return call('modes.list', {}).then(function (res) {
    var ids = (res && res.ok !== false && Array.isArray(res.plugins) ? res.plugins : []).map(function (row) { return row.id; });
    return call('modes.setMany', { mode: 'live', ids: ids });
  }).then(function (res) {
    if (!statusNode) return;
    var rows = res && res.results ? res.results : [];
    var bad = rows.filter(function (r) { return !r.ok; }).length;
    statusNode.textContent = STR.uiModes23 + (rows.length - bad) + STR.uiMenubar79 + (bad ? STR.uiModes24 + bad + STR.uiModes25 : '');
  }).catch(function () {
    if (statusNode) statusNode.textContent = STR.uiViewdock8;
  });
}
