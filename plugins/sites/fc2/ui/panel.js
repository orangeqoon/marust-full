'use strict';

const configuredEl = document.getElementById('configured');
const resultEl = document.getElementById('result');
const atEl = document.getElementById('at');

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

let seq = 0;
let pending = '';

function call() {
  seq += 1;
  pending = String(seq);
  parent.postMessage({
    type: 'marust:call',
    id: pending,
    method: 'plugin.site-fc2.getStatus',
    params: {}
  }, location.origin);
}

function show(result) {
  configuredEl.textContent = result && result.configured === true ? '済み' : '未設定';
  const code = result && result.result;
  let label = '-';
  if (code === 'ok') label = '成功';
  else if (code === 'ng') label = '失敗';
  resultEl.textContent = label;
  const at = result && result.at;
  atEl.textContent = typeof at === 'string' && TIME_RE.test(at) ? at : '-';
}

document.getElementById('refresh').addEventListener('click', () => {
  call();
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'marust:event') {
    call();
    return;
  }
  if (msg.type !== 'marust:result') return;
  if (String(msg.id) !== pending) return;
  show(msg.result);
});

call();
setInterval(call, 3000);
