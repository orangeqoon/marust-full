'use strict';

// 親の画面（丸スト本体）との橋。iframe は親にだけ話す（postMessage）。秘密・トークンは渡らない。
// call: 読む API とこのプラグインの操作（plugin.hotkeys.*）。relay: manifest の ui.relay に書いた method だけ。
// ui: 通知（toast）・確認（confirm。親の窓）・高さの申告（size）。
(function () {
  var seq = 0;
  var waiting = {};
  var perm = { read: true, write: false };
  var permCallbacks = [];
  var eventCallbacks = [];

  function post(message) {
    parent.postMessage(message, '*');
  }

  function request(message, timeoutMs) {
    seq += 1;
    var id = 'b' + seq;
    message.id = id;
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        delete waiting[id];
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs || 30000);
      waiting[id] = function (result) {
        clearTimeout(timer);
        resolve(result);
      };
      post(message);
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'marust:result') {
      var done = waiting[String(msg.id)];
      if (done) {
        delete waiting[String(msg.id)];
        done(msg.result);
      }
      return;
    }
    if (msg.type !== 'marust:event') return;
    if (msg.name === 'theme') {
      // 親の画面の検査済みの色だけを、形を確かめ直して当てる（CSSOM だけ。CSS の文字列は受け取らない）
      var t = msg.payload || {};
      var names = ['bg', 'panel', 'panel-2', 'line', 'line-2', 'text', 'muted', 'accent', 'ok', 'warn', 'skip', 'danger', 'input-bg', 'tab-bar-bg', 'tab-active-bg', 'tab-inactive-bg'];
      var color = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;
      var root = document.documentElement;
      var vars = t.vars && typeof t.vars === 'object' ? t.vars : {};
      names.forEach(function (name) {
        var value = vars[name];
        if (typeof value === 'string' && color.test(value)) root.style.setProperty('--' + name, value);
        else root.style.removeProperty('--' + name);
      });
      root.style.setProperty('color-scheme', t.colorScheme === 'light' ? 'light' : 'dark');
      return;
    }
    if (msg.name === 'perm') {
      var p = msg.payload || {};
      perm = { read: p.read === true, write: p.write === true };
      permCallbacks.forEach(function (fn) { fn(perm); });
      return;
    }
    eventCallbacks.forEach(function (fn) { fn(msg.name, msg.payload); });
  });

  window.marust = {
    call: function (method, params) {
      return request({ type: 'marust:call', method: method, params: params || {} });
    },
    relay: function (method, params) {
      return request({ type: 'marust:relay', method: method, params: params || {} }, 120000);
    },
    toast: function (text) {
      return request({ type: 'marust:ui', action: 'toast', text: text });
    },
    // 親が確認の窓を出す（文字と 2 つのボタン）。文はプラグインが書くので、親は頭にプラグインの id を付ける
    confirm: function (text, options) {
      var o = options || {};
      return request({ type: 'marust:ui', action: 'confirm', text: text, yes: o.yes, no: o.no }, 600000)
        .then(function (r) { return !!(r && r.ok === true && r.confirmed === true); });
    },
    // 親の窓だけが実行する操作（K3）。名前は固定の一覧（modes.change など）・持ち主のプラグインだけ通る。確認の窓も権限の判断も親
    parent: function (name, params) {
      return request({ type: 'marust:ui', action: 'parent', name: name, params: params || {} }, 600000);
    },
    size: function (height) {
      return request({ type: 'marust:ui', action: 'size', height: height });
    },
    can: function () { return perm; },
    onPerm: function (fn) { permCallbacks.push(fn); },
    onEvent: function (fn) { eventCallbacks.push(fn); }
  };
})();
