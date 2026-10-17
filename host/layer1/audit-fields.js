'use strict';

/**
 * 記録（shadow.jsonl）の行を作る小さな部品。orchestrator の dispatchObs と、題名の一斉変更（plugins/bulk-title）が同じ形を使う。
 * V2 で host/layer1/orchestrator.js から移した。中身は移す前と同じ。
 */

const { redact } = require('../core');

function localIso(date) {
  const d = date || new Date();
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    '.' +
    pad(d.getMilliseconds(), 3) +
    sign +
    pad(Math.floor(abs / 60)) +
    ':' +
    pad(abs % 60)
  );
}

function clipField(value) {
  const text = value == null ? '' : String(value);
  const chars = Array.from(text);
  return { length: chars.length, head: chars.slice(0, 20).join('') };
}

function summarizeSites(rows) {
  return (rows || []).map((row) => ({
    id: row && row.id != null ? String(row.id) : '',
    result: row && row.result != null ? String(row.result) : '',
    message: redact(row && row.message != null ? row.message : ''),
    mode: row && row.mode != null ? String(row.mode) : ''
  }));
}

module.exports = { localIso, clipField, summarizeSites };
