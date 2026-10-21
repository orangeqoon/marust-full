'use strict';

const configuredEl = document.getElementById('configured');
const resultEl = document.getElementById('result');
const atEl = document.getElementById('at');

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
    method: 'plugin.site-picarto.getStatus',
    params: {}
  }, location.origin);
}

function show(result) {
  configuredEl.textContent = result && result.configured === true ? 'あり' : 'なし';
  const code = result && result.lastResult;
  resultEl.textContent = RESULT[code] || '-';
  resultEl.className = code === 'ng' ? 'is-bad' : '';
  const at = result && result.lastAt;
  atEl.textContent = typeof at === 'string' && TIME_RE.test(at) ? at : '-';
}

document.getElementById('refresh').addEventListener('click', call);

const tokenEl = document.getElementById('token');
const tokenStatusEl = document.getElementById('token-status');
let savePending = '';
const SAVE_TEXT = { 'bad-token': 'トークンの形が正しくありません', unavailable: '保存できませんでした', forbidden: 'この画面からは保存できません（丸ストの窓から開いてください）' };

document.getElementById('token-save').addEventListener('click', () => {
  const token = tokenEl.value;
  tokenEl.value = '';
  if (!token.trim()) { tokenStatusEl.textContent = 'トークンを入れてください'; return; }
  seq += 1;
  savePending = String(seq);
  tokenStatusEl.textContent = '保存中…';
  parent.postMessage({ type: 'marust:call', id: savePending, method: 'plugin.site-picarto.setToken', params: { token: token } }, location.origin);
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'marust:result') return;
  if (savePending && String(msg.id) === savePending) {
    savePending = '';
    const r = msg.result;
    tokenStatusEl.textContent = r && r.ok === true ? '保存しました' : (SAVE_TEXT[r && r.error] || '保存できませんでした');
    call();
    return;
  }
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

// 手順の URL の欄は、押すと全体を選ぶ（コピーしやすく）
document.querySelectorAll('#token-help .copy').forEach((el) => {
  el.addEventListener('focus', () => el.select());
});
