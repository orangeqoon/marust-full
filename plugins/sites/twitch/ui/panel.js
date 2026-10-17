'use strict';

const modeEl = document.getElementById('mode');
const configuredEl = document.getElementById('configured');
const opEl = document.getElementById('op');
const atEl = document.getElementById('at');

const CODE_RE = /^[a-z0-9-]{1,40}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const METHOD = 'plugin.site-twitch.getStatus';

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

function opText(result) {
  if (result.lastOk === true) return '成功';
  if (result.lastOk === false) {
    const code = result.lastError;
    if (typeof code === 'string' && CODE_RE.test(code)) return '失敗 ' + code;
    return '失敗';
  }
  return 'なし';
}

function show(result) {
  const mode = result.mode;
  modeEl.textContent = mode === 'legacy' || mode === 'shadow' || mode === 'live' ? mode : '-';
  configuredEl.textContent = result.configured === true ? 'あり' : 'なし';
  const op = opText(result);
  opEl.textContent = op;
  opEl.className = op.indexOf('失敗') === 0 ? 'is-bad' : '';
  atEl.textContent = typeof result.lastAt === 'string' && TIME_RE.test(result.lastAt) ? result.lastAt : '-';
}

document.getElementById('refresh').addEventListener('click', function () {
  call(METHOD, {});
});

window.addEventListener('message', function (event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'marust:result') return;
  if (String(msg.id) !== pending) return;
  const result = msg.result;
  if (!result || result.ok !== true) {
    opEl.textContent = result && typeof result.error === 'string' && CODE_RE.test(result.error) ? result.error : 'ng';
    opEl.className = 'is-bad';
    return;
  }
  show(result);
});

call(METHOD, {});
