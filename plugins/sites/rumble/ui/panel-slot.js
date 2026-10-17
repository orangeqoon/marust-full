'use strict';

// 枠の確保（slot の役目）の節。ID は slot- で始まる。
(function () {
const ID = 'slot-rumble';
const modeEl = document.getElementById('slot-mode');
const opEl = document.getElementById('slot-op');
const atEl = document.getElementById('slot-at');
const apiEl = document.getElementById('slot-api');
const cookiesEl = document.getElementById('slot-cookies');

const OP_LABEL = {
  reused: '再利用',
  created: '新規作成',
  'dry-run': '影',
  legacy: '何もしない',
  busy: '失敗 busy',
  'no-credentials': '失敗 no-credentials',
  'slots-exhausted': '失敗 slots-exhausted',
  network: '失敗 network',
  timeout: '失敗 timeout'
};

const CODE_RE = /^[a-z0-9-]{1,40}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

let seq = 0;
let pending = '';

function call(method, params) {
  seq += 1;
  pending = 'slot-' + seq; // site の節の id（数字だけ）と混ざらないように
  parent.postMessage({
    type: 'marust:call',
    id: pending,
    method: method,
    params: params || {}
  }, location.origin);
}

function opText(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return 'なし';
  if (OP_LABEL[code]) return OP_LABEL[code];
  return '失敗 ' + code;
}

function show(result) {
  const mode = result.mode;
  modeEl.textContent = mode === 'legacy' || mode === 'shadow' || mode === 'live' ? mode : '-';
  const op = opText(result.lastOp);
  opEl.textContent = op;
  opEl.className = op.indexOf('失敗') === 0 ? 'is-bad' : '';
  atEl.textContent = typeof result.lastOpAt === 'string' && TIME_RE.test(result.lastOpAt) ? result.lastOpAt : '-';
  const creds = result.credentials && typeof result.credentials === 'object' ? result.credentials : {};
  apiEl.textContent = creds.api === true ? 'あり' : 'なし';
  cookiesEl.textContent = creds.cookies === true ? 'あり' : 'なし';
}

document.getElementById('slot-refresh').addEventListener('click', () => {
  call('plugin.' + ID + '.getStatus', {});
});

window.addEventListener('message', (event) => {
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

call('plugin.' + ID + '.getStatus', {});
setInterval(() => call('plugin.' + ID + '.getStatus', {}), 3000);
})();
