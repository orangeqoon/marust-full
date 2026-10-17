'use strict';

const modeEl = document.getElementById('mode');
const opEl = document.getElementById('op');
const queueEl = document.getElementById('queue');
const errorEl = document.getElementById('error');

const OP_LABEL = { create: '作成', extend: '延長', finalize: '確定' };

let seq = 0;
let pending = '';

function call(method, params) {
  seq += 1;
  pending = String(seq);
  parent.postMessage({
    type: 'marust:call',
    id: pending,
    method: method,
    params: params || {}
  }, location.origin);
}

function show(result) {
  modeEl.textContent = result.mode || '-';
  if (result.lastOp && OP_LABEL[result.lastOp]) {
    opEl.textContent = OP_LABEL[result.lastOp] + (result.lastOpAt ? ' ' + result.lastOpAt : '');
  } else {
    opEl.textContent = 'なし';
  }
  queueEl.textContent = String(result.queueCount == null ? 0 : result.queueCount);
  if (result.lastError) {
    errorEl.textContent = result.lastError;
    errorEl.className = 'is-bad';
  } else {
    errorEl.textContent = 'なし';
    errorEl.className = '';
  }
}

document.getElementById('refresh').addEventListener('click', () => {
  call('plugin.gcal.getStatus', {});
});

document.getElementById('flush').addEventListener('click', () => {
  call('plugin.gcal.flushQueue', {});
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'marust:event') {
    call('plugin.gcal.getStatus', {});
    return;
  }
  if (msg.type !== 'marust:result') return;
  if (String(msg.id) !== pending) return;
  const result = msg.result;
  if (!result || result.ok !== true) {
    errorEl.textContent = result && result.error ? result.error : 'ng';
    errorEl.className = 'is-bad';
    return;
  }
  show(result);
});

call('plugin.gcal.getStatus', {});
