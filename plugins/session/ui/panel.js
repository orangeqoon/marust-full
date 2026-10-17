'use strict';

// 配信の経過時間（K3 で本体の ui/panels/session.js から移した）。読むだけ。
var summaryEl = document.getElementById('session-summary');

function pad(n) { return String(n).padStart(2, '0'); }
function formatTimer(ms) {
  var total = Math.max(0, Math.floor(Number(ms) / 1000));
  return pad(Math.floor(total / 3600)) + ':' + pad(Math.floor((total % 3600) / 60)) + ':' + pad(total % 60);
}

function refresh() {
  window.marust.call('session.view', {}).then(function (session) {
    if (!session || session.ok === false || !session.active) {
      summaryEl.textContent = 'なし';
      return;
    }
    var label = session.state === 'paused' ? '一時停止' : '進行中';
    summaryEl.textContent = label + ': ' + (session.title || '(題名なし)') + ' / 経過 ' + formatTimer(session.elapsedMs || 0);
  }).catch(function () {});
}

refresh();
setInterval(refresh, 1000);
