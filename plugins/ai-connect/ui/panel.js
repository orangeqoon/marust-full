'use strict';

// AI をつなぐ（K3 で本体の ui/panels/ai-connect.js から移した）。コードを作るのは親の窓（marust.parent('ai.pair')）。iframe は何も指定できない。
var buttonEl = document.getElementById('ai-pair-start');
var codeEl = document.getElementById('ai-pair-code');
var statusEl = document.getElementById('ai-pair-status');
var timer = null;
var isWindow = false;

function refresh() {
  window.marust.call('hub.getState', {}).then(function (state) {
    isWindow = !!(state && state.clientId === 'local-window');
    buttonEl.disabled = !isWindow;
    var auto = !!(state && state.aiAutoPair);
    document.getElementById('ai-auto-on').hidden = !auto;
    document.getElementById('ai-auto-off').hidden = auto;
    document.getElementById('ai-auto-state').textContent = auto ? '自動でつながっています（開発中）' : '自動のつなぎは切れています（ペアリングが必要）';
  }).catch(function () {});
}

function countdown(until) {
  if (timer) clearInterval(timer);
  function tick() {
    var left = Math.max(0, Math.round((until - Date.now()) / 1000));
    statusEl.textContent = left > 0 ? 'あと ' + left + ' 秒で無効になります' : '期限が切れました。もう一度ボタンを押してください';
    if (left <= 0) {
      codeEl.textContent = '';
      clearInterval(timer);
      timer = null;
    }
  }
  tick();
  timer = setInterval(tick, 1000);
}

buttonEl.addEventListener('click', function () {
  if (!isWindow) return;
  window.marust.parent('ai.pair', {}).then(function (res) {
    if (!res || res.ok === false || !res.code) {
      codeEl.textContent = '';
      statusEl.textContent = 'コードを作れませんでした';
      return;
    }
    codeEl.textContent = String(res.code);
    countdown(Date.now() + (Number(res.expiresInSec) || 120) * 1000);
  }).catch(function () { statusEl.textContent = 'コードを作れませんでした'; });
});

refresh();
setInterval(refresh, 5000);
