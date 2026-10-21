'use strict';

// パネルは本体へ postMessage で頼む（直接つながない）。秘密は扱わない。文字は textContent だけで出す。
const ID = 'grok-control';
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const modeEl = document.getElementById('mode');
const lastEl = document.getElementById('last');
const textEl = document.getElementById('text');
const resultEl = document.getElementById('result');
const historyEl = document.getElementById('history');
let seq = 0;
const waiting = {};

function call(name, params, done) {
  seq += 1;
  const id = 'gc-' + seq;
  waiting[id] = done;
  parent.postMessage({ type: 'marust:call', id: id, method: 'plugin.' + ID + '.' + name, params: params || {} }, location.origin);
}

function showStatus(r) {
  modeEl.textContent = r.mode === 'live' ? '使っています' : (r.mode === 'shadow' ? '試しに動かしています（直すだけ）' : '使っていません');
  lastEl.textContent = r.lastOk === true ? '成功' : (r.lastOk === false ? '失敗 ' + (CODE_RE.test(r.lastError) ? r.lastError : '') : 'まだありません');
}

function showHistory(r) {
  while (historyEl.firstChild) historyEl.removeChild(historyEl.firstChild);
  const rows = r && Array.isArray(r.history) ? r.history : [];
  rows.forEach(function (h) {
    const li = document.createElement('li');
    const when = typeof h.at === 'string' ? h.at.replace('T', ' ').slice(0, 19) : '';
    li.textContent = when + '  「' + String(h.text || '') + '」 → ' + String(h.intent || '') + (h.method ? ' (' + h.method + ')' : '') + (h.executed ? ' 実行' : '') + (h.ok ? '' : ' 失敗');
    historyEl.appendChild(li);
  });
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'まだありません';
    historyEl.appendChild(li);
  }
}

function refresh() {
  call('getStatus', {}, showStatus);
  call('history', { n: 20 }, showHistory);
}

function send(dryRun) {
  const text = String(textEl.value || '').trim();
  if (!text) return;
  call('command', { text: text, dryRun: dryRun }, function (r) {
    resultEl.textContent = JSON.stringify(r, null, 2);
    refresh();
  });
}

window.addEventListener('message', function (ev) {
  if (ev.origin !== location.origin) return;
  const msg = ev.data;
  if (!msg || msg.type !== 'marust:result' || typeof msg.id !== 'string' || !waiting[msg.id]) return;
  const done = waiting[msg.id];
  delete waiting[msg.id];
  done(msg.result || {});
});

document.getElementById('parse').addEventListener('click', function () { send(true); });
document.getElementById('run').addEventListener('click', function () { send(false); });
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('clear').addEventListener('click', function () { call('clearHistory', {}, refresh); });
textEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') send(true); });
refresh();
