'use strict';

const modeEl = document.getElementById('mode');
const configuredEl = document.getElementById('configured');
const candidatesEl = document.getElementById('candidates');
const lastEl = document.getElementById('last');
const atEl = document.getElementById('at');
const errorEl = document.getElementById('error');

const CODE_RE = /^[a-z0-9-]{1,40}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const METHOD = 'plugin.raid-twitch.getStatus';

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

function loginText(value) {
  return typeof value === 'string' && LOGIN_RE.test(value) ? value : '';
}

function candidatesText(rows) {
  if (!Array.isArray(rows) || !rows.length) return '-';
  const lines = [];
  for (let i = 0; i < rows.length && lines.length < 100; i += 1) {
    const row = rows[i];
    const login = loginText(row && row.login);
    if (!login) continue;
    const source = row && row.source === 'mutual' ? '相互' : 'おすすめ';
    lines.push(login + ' (' + source + ')');
  }
  return lines.length ? lines.join('\n') : '-';
}

function lastText(last) {
  if (!last || typeof last !== 'object') return '-';
  const bits = [];
  if (last.dryRun === true) bits.push('予行');
  const login = loginText(last.login);
  if (login) {
    const source = last.source === 'mutual' ? '相互' : (last.source === 'suggested' ? 'おすすめ' : '');
    bits.push(login + (source ? ' / ' + source : ''));
  }
  const viewers = last.viewerCount;
  if (typeof viewers === 'number' && Number.isInteger(viewers) && viewers >= 0 && viewers <= 1000000000) {
    bits.push(String(viewers) + '人');
  }
  if (typeof last.skipped === 'string' && CODE_RE.test(last.skipped)) bits.push(last.skipped);
  if (last.ok === false && typeof last.error === 'string' && CODE_RE.test(last.error)) bits.push(last.error);
  return bits.length ? bits.join(' ') : '-';
}

function show(result) {
  const mode = result.mode;
  modeEl.textContent = mode === 'legacy' || mode === 'shadow' || mode === 'live' ? mode : '-';
  configuredEl.textContent = result.configured === true ? 'あり' : 'なし';
  candidatesEl.textContent = candidatesText(result.candidates);
  lastEl.textContent = lastText(result.last);
  const at = result.last && result.last.at;
  atEl.textContent = typeof at === 'string' && TIME_RE.test(at) ? at : '-';
  errorEl.textContent = '';
  errorEl.className = '';
}

function showError(result) {
  const code = result && typeof result.error === 'string' ? result.error : '';
  errorEl.textContent = CODE_RE.test(code) ? code : 'ng';
  errorEl.className = 'is-bad';
}

document.getElementById('refresh').addEventListener('click', function () {
  call(METHOD, {});
});

window.addEventListener('message', function (event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'marust:event') {
    call(METHOD, {});
    return;
  }
  if (msg.type !== 'marust:result') return;
  if (String(msg.id) !== pending) return;
  const result = msg.result;
  if (!result || result.ok !== true) {
    showError(result);
    return;
  }
  show(result);
});

call(METHOD, {});
