'use strict';

/**
 * 日付ごとの JSONL 追記。20 MB を超えたら同じ日の -2、-3 へ続ける。
 * 日付は audit.js の localDay と同じローカル暦（getFullYear / getMonth / getDate）。
 * 失敗は投げずに false。既存ログの中身は読まない。
 * 載せる前に文字列を redact する。省略はできない。
 */

const fs = require('fs');
const path = require('path');
const { redact } = require('./safe-runner');

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PART = 10000;

function localDay(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
}

function resolveNow(options) {
  const opts = options || {};
  if (opts.now instanceof Date) return opts.now;
  if (typeof opts.now === 'number' && Number.isFinite(opts.now)) return new Date(opts.now);
  if (typeof opts.now === 'function') {
    try {
      const value = opts.now();
      if (value instanceof Date) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
    } catch (_) { /* fall through */ }
  }
  return new Date();
}

function resolveMaxBytes(options) {
  const opts = options || {};
  if (typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0) {
    return opts.maxBytes;
  }
  return DEFAULT_MAX_BYTES;
}

function safePrefix(prefix) {
  if (typeof prefix !== 'string') return '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(prefix)) return '';
  return prefix;
}

function partName(prefix, day, index) {
  if (index <= 1) return prefix + '-' + day + '.jsonl';
  return prefix + '-' + day + '-' + String(index) + '.jsonl';
}

function fileSize(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return -1;
    return st.size;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

function scrubString(value) {
  const text = String(value);
  const cleaned = redact(text);
  const unchanged = cleaned === text || cleaned === text.slice(0, 300);
  if (!unchanged) return cleaned;
  if (/secret|password|cookie|bearer/i.test(text) && /\d/.test(text) && !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(text)) {
    return '***';
  }
  return text;
}

function scrubValue(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) out.push(scrubValue(value[i]));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) out[keys[i]] = scrubValue(value[keys[i]]);
    return out;
  }
  return value;
}

function appendJsonl(dir, prefix, record, options) {
  const namePrefix = safePrefix(prefix);
  if (typeof dir !== 'string' || !dir || !namePrefix) return false;
  let line;
  try {
    const body = JSON.stringify(scrubValue(record));
    if (typeof body !== 'string') return false;
    line = body + '\n';
  } catch (_) {
    return false;
  }
  const maxBytes = resolveMaxBytes(options);
  const day = localDay(resolveNow(options));
  const bytes = Buffer.byteLength(line, 'utf8');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const root = path.resolve(dir);
    for (let index = 1; index <= MAX_PART; index += 1) {
      const name = partName(namePrefix, day, index);
      const file = path.join(root, name);
      if (path.basename(file) !== name) return false;
      const size = fileSize(file);
      if (size < 0) return false;
      if (size > 0 && size + bytes > maxBytes) continue;
      fs.appendFileSync(file, line, 'utf8');
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

module.exports = {
  appendJsonl: appendJsonl,
  DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES
};
