'use strict';

/**
 * 画面から本体への唯一の道。call と subscribe だけを出す。
 */
(function (global) {
  var handlers = [];
  var socket = null;
  var delay = 1000;
  var nextId = 1;
  var pending = new Map();
  var reconnectTimer = null;

  function setStatus(text, ok) {
    var el = document.getElementById('connection-status');
    if (!el) return;
    el.textContent = text;
    el.className = ok ? 'ok' : 'wait';
  }

  function failPending(err) {
    pending.forEach(function (item) {
      clearTimeout(item.timer);
      item.reject(err);
    });
    pending.clear();
  }

  function connect() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    var proto = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + global.location.host + '/ws';
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      schedule();
      return;
    }
    socket = ws;
    ws.addEventListener('open', function () {
      delay = 1000;
      setStatus((typeof CORE_STR !== 'undefined' ? CORE_STR.agentOk : '丸スト: 動いています'), true);
      flushWaiting();
    });
    ws.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg && msg.method === 'event') {
        for (var i = 0; i < handlers.length; i += 1) {
          try { handlers[i](msg.params); } catch (_) { /* the page owns its errors */ }
        }
        return;
      }
      if (!msg || msg.id == null || !pending.has(msg.id)) return;
      var item = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(item.timer);
      if (msg.error) item.reject(new Error(msg.error.message || 'rpc-error'));
      else item.resolve(msg.result);
    });
    ws.addEventListener('close', function () {
      if (socket === ws) socket = null;
      setStatus((typeof CORE_STR !== 'undefined' ? CORE_STR.agentLost : '丸スト: つながっていません'), false);
      failPending(new Error('disconnected'));
      schedule();
    });
    ws.addEventListener('error', function () {
      try { ws.close(); } catch (_) { /* close follows */ }
    });
  }

  function schedule() {
    if (reconnectTimer) return;
    var wait = delay;
    delay = Math.min(10000, delay * 2);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, wait);
  }

  // つながる前（ページを開いた直後・再接続中）に呼ばれた命令は、つながるまで待たせる（最大 WAIT_OPEN_MS）。
  // 待たずに失敗させると、起動時に 1 回だけ読む画面（ウィンドウ判定など）が空振りしたままになる。
  var WAIT_OPEN_MS = 8000;
  var waiting = [];

  function send(method, params, resolve, reject) {
    var id = nextId;
    nextId += 1;
    var timer = setTimeout(function () {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error('timeout'));
    }, 15000);
    pending.set(id, { resolve: resolve, reject: reject, timer: timer });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }));
  }

  function flushWaiting() {
    var list = waiting;
    waiting = [];
    list.forEach(function (item) {
      clearTimeout(item.timer);
      if (socket && socket.readyState === 1) send(item.method, item.params, item.resolve, item.reject);
      else item.reject(new Error('no-api'));
    });
  }

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      if (socket && socket.readyState === 1) {
        send(method, params, resolve, reject);
        return;
      }
      var item = { method: method, params: params, resolve: resolve, reject: reject, timer: null };
      item.timer = setTimeout(function () {
        var index = waiting.indexOf(item);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error('no-api'));
      }, WAIT_OPEN_MS);
      waiting.push(item);
      if (!socket) connect();
    });
  }

  function subscribe(handler) {
    if (typeof handler !== 'function') return function unsubscribe() {};
    handlers.push(handler);
    return function unsubscribe() {
      var index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  }

  global.marustApi = { call: call, subscribe: subscribe };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect);
  else connect();
})(window);
