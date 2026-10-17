'use strict';

const stateEl = document.getElementById('state');
const atEl = document.getElementById('at');
const congestionEl = document.getElementById('congestion');
const skippedEl = document.getElementById('skipped');
const reconnectingEl = document.getElementById('reconnecting');
const modeEl = document.getElementById('mode');

const STATE_CLASS = { ok: 'state-ok', degraded: 'state-degraded', bad: 'state-bad' };

let seq = 0;
let pending = '';

function call() {
  seq += 1;
  pending = String(seq);
  parent.postMessage({
    type: 'marust:call',
    id: pending,
    method: 'plugin.signal-monitor.getStatus',
    params: {}
  }, location.origin);
}

function show(result) {
  if (!result || result.ok !== true) {
    stateEl.textContent = '取得できない';
    stateEl.className = 'state';
    return;
  }
  const text = result.text && typeof result.text === 'object' ? result.text : {};
  // 文言は本体（プラグイン）が作ったものだけを表示する。
  stateEl.textContent = text.state || '-';
  stateEl.className = 'state ' + (STATE_CLASS[result.state] || '');
  atEl.textContent = text.at || '-';
  congestionEl.textContent = text.congestion || '-';
  skippedEl.textContent = text.skippedRate || '-';
  reconnectingEl.textContent = text.reconnecting || '-';
  modeEl.textContent = text.mode || '-';
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'marust:event') {
    // signal.stateChanged が来たら取り直す。
    call();
    return;
  }
  if (msg.type !== 'marust:result') return;
  if (String(msg.id) !== pending) return;
  show(msg.result);
});

// 開いた直後に今の状態を取る。
call();
