'use strict';

/**
 * shadow の記録を、指定した日数だけ読んでまとめる。
 * 本体のログは state/logs/marust/shadow-YYYYMMDD.jsonl（分割は -2 から）。
 * プラグインは state/data/marust/plugins/<id>/shadow-YYYYMMDD.jsonl。
 * ディレクトリは options.stateDir / options.root / options.core.STATE_DIR。
 * 未指定のときは読まない（テストが本物の state を踏まないため）。
 * 1 ファイル 20 MB、合計 200 MB を超えたら途中で止めて truncated。
 * 壊れた行は数えるだけで、投げない。出す文字列は ctx.redact（本体の safe-runner と同じ）を通す。
 */

const fs = require('fs');
const path = require('path');

// 出す文字列を通す redact は、プラグインが ctx.redact を渡す（setRedact）。渡されるまで report は unavailable を返す（隠さずに出さない）。
let redact = null;
function setRedact(fn) { redact = typeof fn === 'function' ? fn : null; }
function red(text) { return redact ? redact(text) : ''; } // 渡されていなければ何も出さない

const FILE_LIMIT = 20 * 1024 * 1024;
const TOTAL_LIMIT = 200 * 1024 * 1024;
const SAMPLE_CHARS = 20;
const MAX_SAMPLES = 8;
const ERROR_CHARS = 40;
const STAMP_CHARS = 80;
const PLUGIN_SEED = ['gcal', 'notify', 'raid'];
const NAME_RE = /^shadow-(\d{8})(?:-([1-9]\d*))?\.jsonl$/;

function emptyBucket() {
  return { count: 0, lastAt: '', lastMs: null, samples: [], errors: {} };
}

function clipChars(value, max) {
  const text = value == null ? '' : String(value);
  return Array.from(text).slice(0, max).join('');
}

function shell() {
  const plugins = {};
  PLUGIN_SEED.forEach(function (name) { plugins[name] = emitBucket(emptyBucket()); });
  return {
    ok: true,
    days: [],
    sites: {},
    plugins: plugins,
    truncated: false,
    broken: 0
  };
}

function fail(error) {
  const body = shell();
  body.ok = false;
  body.error = error;
  return body;
}

function resolveDays(value) {
  if (value == null || value === '') return 7;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 30) return null;
  return value;
}

function resolveNow(options) {
  const opts = options || {};
  if (opts.now instanceof Date && !Number.isNaN(opts.now.getTime())) return opts.now;
  if (typeof opts.now === 'number' && Number.isFinite(opts.now)) return new Date(opts.now);
  if (typeof opts.now === 'function') {
    try {
      const value = opts.now();
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
    } catch (_) { /* fall through */ }
  }
  return new Date();
}

function limitOf(value, fallback) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= fallback) return value;
  return fallback;
}

function formatYmd(date) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
}

function prettyDay(ymd) {
  return ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
}

function parseYmd(ymd) {
  if (!/^\d{8}$/.test(ymd)) return null;
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function windowSet(now, days) {
  const set = new Set();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i);
    set.add(formatYmd(date));
  }
  return set;
}

function stateDirOf(options) {
  const opts = options || {};
  if (typeof opts.stateDir === 'string' && opts.stateDir) return opts.stateDir;
  if (typeof opts.root === 'string' && opts.root) return opts.root;
  if (opts.core && typeof opts.core.STATE_DIR === 'string' && opts.core.STATE_DIR) return opts.core.STATE_DIR;
  return '';
}

function siteFilterOf(options) {
  const opts = options || {};
  if (opts.site == null || opts.site === '') return '';
  if (typeof opts.site !== 'string') return null;
  const site = opts.site.trim();
  if (!site || site.length > 64) return null;
  return site;
}

function safeId(id) {
  if (typeof id !== 'string') return '';
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) return '';
  if (id === '.' || id === '..') return '';
  return id;
}

function pluginKey(id) {
  if (id === 'notify-discord') return 'notify';
  if (id === 'raid-twitch') return 'raid';
  return id;
}

function inside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

function matchName(name) {
  const matched = NAME_RE.exec(name);
  if (!matched) return null;
  if (matched[2] != null && Number(matched[2]) < 2) return null;
  if (!parseYmd(matched[1])) return null;
  return { ymd: matched[1], part: matched[2] == null ? 1 : Number(matched[2]) };
}

function listFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    const parsed = matchName(entry.name);
    if (!parsed) continue;
    const file = path.join(dir, entry.name);
    if (path.basename(file) !== entry.name) continue;
    if (!inside(dir, file)) continue;
    let st;
    try { st = fs.lstatSync(file); } catch (_) { continue; }
    if (!st || st.isSymbolicLink() || !st.isFile()) continue;
    out.push({ file: file, ymd: parsed.ymd, part: parsed.part, size: st.size });
  }
  return out;
}

function collect(stateDir, allowed) {
  const rows = [];
  const logs = path.resolve(stateDir, 'logs', 'marust');
  listFiles(logs).forEach(function (row) {
    if (!allowed.has(row.ymd)) return;
    rows.push(Object.assign({ role: 'host', pluginKey: '', order: '0' }, row));
  });
  const pluginRoot = path.resolve(stateDir, 'data', 'marust', 'plugins');
  let entries = [];
  try { entries = fs.readdirSync(pluginRoot, { withFileTypes: true }); } catch (_) { entries = []; }
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const id = safeId(entry.name);
    if (!id || id !== entry.name) continue;
    const dir = path.resolve(pluginRoot, id);
    if (!inside(pluginRoot, dir)) continue;
    let dirStat;
    try { dirStat = fs.lstatSync(dir); } catch (_) { continue; }
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    listFiles(dir).forEach(function (row) {
      if (!allowed.has(row.ymd)) return;
      rows.push(Object.assign({ role: 'plugin', pluginKey: pluginKey(id), order: '1' + id }, row));
    });
  }
  rows.sort(function (a, b) {
    if (a.ymd !== b.ymd) return a.ymd < b.ymd ? -1 : 1;
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
    return a.part - b.part;
  });
  return rows;
}

function readCapped(file, cap) {
  if (cap <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(cap);
    const n = fs.readSync(fd, buf, 0, cap, 0);
    return buf.toString('utf8', 0, n);
  } catch (_) {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

function splitLines(text, dropTail) {
  const parts = String(text).split(/\r?\n/);
  if (dropTail) parts.pop();
  return parts;
}

function titleText(record) {
  const title = record && record.title;
  if (title && typeof title === 'object' && !Array.isArray(title) && typeof title.head === 'string') return title.head;
  if (typeof title === 'string') return title;
  return '';
}

function pluginSample(record) {
  if (typeof record.title === 'string' && record.title) return record.title;
  const head = titleText(record);
  if (head) return head;
  if (typeof record.content === 'string' && record.content) return record.content;
  if (typeof record.login === 'string' && record.login) return record.login;
  if (typeof record.op === 'string' && record.op) return record.op;
  if (typeof record.kind === 'string' && record.kind) return record.kind;
  return '';
}

function stampOf(record) {
  if (record && typeof record.ts === 'string' && record.ts) return record.ts;
  if (record && typeof record.at === 'string' && record.at) return record.at;
  if (record && typeof record.start === 'string' && record.start) return record.start;
  if (record && typeof record.end === 'string' && record.end) return record.end;
  return '';
}

function ensure(map, key) {
  if (!map[key]) map[key] = emptyBucket();
  return map[key];
}

function addSample(bucket, text) {
  const raw = text == null ? '' : String(text);
  if (!raw.trim()) return;
  if (bucket.samples.length >= MAX_SAMPLES) return;
  bucket.samples.push(raw);
}

function addError(bucket, code) {
  const key = code == null ? '' : String(code).trim();
  if (!key) return;
  const clipped = clipChars(key, ERROR_CHARS);
  bucket.errors[clipped] = (bucket.errors[clipped] || 0) + 1;
}

function touchTime(bucket, stamp, fallback) {
  if (!stamp) {
    if (!bucket.lastAt && fallback) bucket.lastAt = fallback;
    return;
  }
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) {
    if (!bucket.lastAt) bucket.lastAt = stamp;
    return;
  }
  if (bucket.lastMs == null || ms >= bucket.lastMs) {
    bucket.lastMs = ms;
    bucket.lastAt = stamp;
  }
}

function noteSend(bucket, stamp, sample, error, fallback) {
  bucket.count += 1;
  touchTime(bucket, stamp, fallback);
  addSample(bucket, sample);
  if (error) addError(bucket, error);
}

function shadowMode(mode) {
  return mode === 'shadow' || mode === 'orchestrator';
}

function failureOf(row) {
  const result = row && row.result != null ? String(row.result) : '';
  if (result === 'ok' || result === 'skip' || result === '') return '';
  const message = row && row.message != null ? String(row.message).trim() : '';
  return message || result || 'error';
}

function takeHost(record, totals, day, ymd, siteFilter) {
  const sites = record && Array.isArray(record.sites) ? record.sites : null;
  if (!sites) return;
  const title = titleText(record);
  const stamp = stampOf(record);
  const fallback = prettyDay(ymd);
  for (let i = 0; i < sites.length; i += 1) {
    const row = sites[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = row.id == null ? '' : String(row.id).trim();
    if (!id || id.length > 64) continue;
    if (siteFilter && id !== siteFilter) continue;
    const mode = row.mode == null ? '' : String(row.mode);
    const result = row.result == null ? '' : String(row.result);
    if (!shadowMode(mode)) continue;
    if (result === 'skip') continue;
    const error = failureOf(row);
    noteSend(ensure(totals.sites, id), stamp, title, error, fallback);
    noteSend(ensure(day.sites, id), stamp, title, error, fallback);
  }
}

function takePlugin(record, key, totals, day, ymd) {
  if (!key) return;
  if (typeof record.skipped === 'string' && record.skipped && !record.error && record.ok !== false) return;
  const stamp = stampOf(record);
  const sample = pluginSample(record);
  let error = '';
  if (typeof record.error === 'string' && record.error.trim()) error = record.error.trim();
  else if (record.ok === false) error = 'failed';
  const fallback = prettyDay(ymd);
  noteSend(ensure(totals.plugins, key), stamp, sample, error, fallback);
  noteSend(ensure(day.plugins, key), stamp, sample, error, fallback);
}

function emitBucket(bucket) {
  const src = bucket || emptyBucket();
  const samples = [];
  for (let i = 0; i < src.samples.length; i += 1) {
    const sample = clipChars(red(src.samples[i]), SAMPLE_CHARS);
    if (!sample) continue;
    samples.push(sample);
  }
  const errors = {};
  const names = Object.keys(src.errors);
  for (let i = 0; i < names.length; i += 1) {
    const safe = clipChars(red(names[i]), ERROR_CHARS) || 'error';
    errors[safe] = (errors[safe] || 0) + src.errors[names[i]];
  }
  return {
    count: src.count,
    lastAt: clipChars(red(src.lastAt || ''), STAMP_CHARS),
    samples: samples,
    errors: errors
  };
}

function emitMap(map, seed) {
  const keys = Object.keys(map);
  if (seed) {
    for (let i = 0; i < seed.length; i += 1) {
      if (keys.indexOf(seed[i]) === -1) keys.push(seed[i]);
    }
  }
  keys.sort();
  const out = {};
  for (let i = 0; i < keys.length; i += 1) {
    out[keys[i]] = emitBucket(map[keys[i]] || emptyBucket());
  }
  return out;
}

function dayActive(day) {
  const sites = Object.keys(day.sites);
  for (let i = 0; i < sites.length; i += 1) if (day.sites[sites[i]].count > 0) return true;
  const plugins = Object.keys(day.plugins);
  for (let i = 0; i < plugins.length; i += 1) if (day.plugins[plugins[i]].count > 0) return true;
  return false;
}

function report(options) {
  if (!redact) return fail('unavailable');
  try {
    const opts = options || {};
    const days = resolveDays(opts.days);
    if (days == null) return fail('bad-days');
    const siteFilter = siteFilterOf(opts);
    if (siteFilter == null) return fail('bad-site');
    const stateDir = stateDirOf(opts);
    if (!stateDir) return fail('unavailable');
    const now = resolveNow(opts);
    const allowed = windowSet(now, days);
    const fileLimit = limitOf(opts.maxFileBytes, FILE_LIMIT);
    const totalLimit = limitOf(opts.maxTotalBytes, TOTAL_LIMIT);
    const totals = { sites: {}, plugins: {} };
    const byDay = {};
    let broken = 0;
    let truncated = false;
    let used = 0;
    const files = collect(stateDir, allowed);
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (used >= totalLimit) {
        truncated = true;
        break;
      }
      const budget = totalLimit - used;
      let cap = file.size;
      let cut = false;
      if (file.size > fileLimit) {
        cap = fileLimit;
        cut = true;
        truncated = true;
      }
      if (cap > budget) {
        cap = budget;
        cut = true;
        truncated = true;
      }
      const text = readCapped(file.file, cap);
      used += cap;
      if (text == null) {
        if (cut) break;
        continue;
      }
      const dropTail = cut || cap < file.size;
      if (!byDay[file.ymd]) byDay[file.ymd] = { sites: {}, plugins: {} };
      const day = byDay[file.ymd];
      const lines = splitLines(text, dropTail);
      for (let n = 0; n < lines.length; n += 1) {
        const line = lines[n];
        if (!line || !String(line).trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch (_) {
          broken += 1;
          continue;
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          broken += 1;
          continue;
        }
        if (file.role === 'host') takeHost(record, totals, day, file.ymd, siteFilter);
        else takePlugin(record, file.pluginKey, totals, day, file.ymd);
      }
      if (cut) break;
    }
    const dayKeys = Object.keys(byDay).filter(function (ymd) { return dayActive(byDay[ymd]); });
    dayKeys.sort();
    const dayRows = [];
    for (let i = 0; i < dayKeys.length; i += 1) {
      const ymd = dayKeys[i];
      dayRows.push({
        date: prettyDay(ymd),
        sites: emitMap(byDay[ymd].sites),
        plugins: emitMap(byDay[ymd].plugins, PLUGIN_SEED)
      });
    }
    return {
      ok: true,
      days: dayRows,
      sites: emitMap(totals.sites),
      plugins: emitMap(totals.plugins, PLUGIN_SEED),
      truncated: truncated,
      broken: broken
    };
  } catch (_) {
    return fail('failed');
  }
}

module.exports = {
  report: report,
  setRedact: setRedact,
  FILE_LIMIT: FILE_LIMIT,
  TOTAL_LIMIT: TOTAL_LIMIT
};