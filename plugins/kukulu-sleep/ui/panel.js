'use strict';

const configuredEl = document.getElementById('configured');
const opEl = document.getElementById('op');
const resultEl = document.getElementById('result');
const atEl = document.getElementById('at');
const sleepEl = document.getElementById('sleep');

const OP = { release: '枠返上', acquire: '枠確保', none: 'なし' };
const RESULT = { ok: '成功', ng: '失敗', none: 'なし' };
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

let seq = 0;
let pending = '';

function call() {
  seq += 1;
  pending = String(seq);
  parent.postMessage({
    type: 'marust:call',
    id: pending,
    method: 'plugin.kukulu-sleep.getStatus',
    params: {}
  }, location.origin);
}

function show(result) {
  configuredEl.textContent = result && result.configured === true ? 'あり' : 'なし';
  const op = result && result.lastOp;
  opEl.textContent = OP[op] || '-';
  const code = result && result.lastResult;
  resultEl.textContent = RESULT[code] || '-';
  resultEl.className = code === 'ng' ? 'is-bad' : '';
  const at = result && result.lastAt;
  atEl.textContent = typeof at === 'string' && TIME_RE.test(at) ? at : '-';
  if (!result || result.sleep == null) sleepEl.textContent = '-';
  else sleepEl.textContent = result.sleep === true ? '睡眠' : '通常';
}

document.getElementById('refresh').addEventListener('click', call);

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'marust:result') return;
  if (String(msg.id) !== pending) return;
  const result = msg.result;
  if (!result || result.ok !== true) {
    resultEl.textContent = '失敗';
    resultEl.className = 'is-bad';
    return;
  }
  show(result);
});

call();
setInterval(call, 3000);
