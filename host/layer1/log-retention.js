'use strict';

/**
 * JSONL の寿命。消すのはファイル名の日付が寿命より厳密に古いものだけ。
 * 今日の分と、想定外のファイル名は触らない。ログの中身は読まない。
 *
 * プラグインの dataDir は host/core/plugin-registry.js の ensureDataDir と同じ
 * STATE_DIR/data/marust/plugins/<id>。core（createCore）はプラグイン一覧を持たないので、
 * そのディレクトリの直下だけを見る。ディスク全体は走査しない。
 * core.plugins（{ id | dataDir } の配列）か core.registry.snapshot() があれば、それも足す。
 */

const fs = require('fs');
const path = require('path');

const ORDINARY_DAYS = 30;
const AUDIT_DAYS = 180;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIXES = ['shadow', 'engine', 'api', 'vault', 'emergency'];
const PLUGIN_PREFIXES = ['shadow'];
const AUDIT_PREFIXES = { api: true, vault: true, emergency: true };

function emit(logger, level, message) {
  try {
    if (typeof logger === 'function') {
      logger(level, message);
      return;
    }
    if (logger && typeof logger[level] === 'function') logger[level](message);
  } catch (_) { /* logger must not break retention */ }
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addCalendarDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function currentDate(now) {
  if (typeof now === 'function') {
    try {
      const value = now();
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    } catch (_) { /* fall through */ }
  }
  return new Date();
}

function validDays(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_DAYS && value <= MAX_DAYS;
}

function configPath(core) {
  if (!core || typeof core.STATE_DIR !== 'string' || !core.STATE_DIR) return '';
  return path.join(core.STATE_DIR, 'data', 'marust', 'log-retention.json');
}

function loadPolicy(core) {
  const policy = { ordinaryDays: ORDINARY_DAYS, auditDays: AUDIT_DAYS };
  const file = configPath(core);
  if (!file) return policy;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return policy;
    return policy;
  }
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (_) {
    return policy;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return policy;
  if (Object.prototype.hasOwnProperty.call(data, 'ordinaryDays') && validDays(data.ordinaryDays)) {
    policy.ordinaryDays = data.ordinaryDays;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'auditDays') && validDays(data.auditDays)) {
    policy.auditDays = data.auditDays;
  }
  return policy;
}

function daysFor(prefix, policy) {
  if (AUDIT_PREFIXES[prefix]) return policy.auditDays;
  return policy.ordinaryDays;
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

function matchLogName(name, allowed) {
  const matched = /^(shadow|engine|api|vault|emergency)-(\d{8})(?:-(\d+))?\.jsonl$/.exec(name);
  if (!matched) return null;
  if (allowed.indexOf(matched[1]) === -1) return null;
  if (matched[3] != null) {
    if (!/^[1-9]\d*$/.test(matched[3])) return null;
    if (Number(matched[3]) < 2) return null;
  }
  const date = parseYmd(matched[2]);
  if (!date) return null;
  return { prefix: matched[1], date: date };
}

function safeId(id) {
  if (typeof id !== 'string') return '';
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) return '';
  if (id === '.' || id === '..') return '';
  return id;
}

function pushDir(list, seen, dir, prefixes) {
  if (typeof dir !== 'string' || !dir) return;
  let resolved;
  try { resolved = path.resolve(dir); } catch (_) { return; }
  const key = resolved.toLowerCase() + '\n' + prefixes.join(',');
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ dir: resolved, prefixes: prefixes });
}

function addPluginDir(list, seen, dir) {
  pushDir(list, seen, dir, PLUGIN_PREFIXES);
}

function addExplicitPlugins(core, list, seen) {
  if (!core) return;
  if (Array.isArray(core.plugins)) {
    for (let i = 0; i < core.plugins.length; i += 1) {
      const row = core.plugins[i];
      if (typeof row === 'string') {
        addPluginDir(list, seen, row);
      } else if (row && typeof row.dataDir === 'string') {
        addPluginDir(list, seen, row.dataDir);
      } else if (row && typeof core.STATE_DIR === 'string') {
        const id = safeId(row.id);
        if (id) addPluginDir(list, seen, path.join(core.STATE_DIR, 'data', 'marust', 'plugins', id));
      }
    }
  }
  const registry = core.registry;
  if (registry && typeof registry.snapshot === 'function' && typeof core.STATE_DIR === 'string') {
    let rows = [];
    try { rows = registry.snapshot() || []; } catch (_) { rows = []; }
    if (Array.isArray(rows)) {
      for (let i = 0; i < rows.length; i += 1) {
        const id = rows[i] && safeId(rows[i].id);
        if (id) addPluginDir(list, seen, path.join(core.STATE_DIR, 'data', 'marust', 'plugins', id));
      }
    }
  }
}

function discover(core) {
  const list = [];
  const seen = new Set();
  if (core && typeof core.STATE_DIR === 'string' && core.STATE_DIR) {
    pushDir(list, seen, path.join(core.STATE_DIR, 'logs', 'marust'), LOG_PREFIXES);
    const pluginRoot = path.resolve(core.STATE_DIR, 'data', 'marust', 'plugins');
    let entries = [];
    try {
      entries = fs.readdirSync(pluginRoot, { withFileTypes: true });
    } catch (_) {
      entries = [];
    }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.' || entry.name === '..') continue;
      const child = path.resolve(pluginRoot, entry.name);
      const rel = path.relative(pluginRoot, child);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      addPluginDir(list, seen, child);
    }
  }
  addExplicitPlugins(core, list, seen);
  return list;
}

function labelOf(dir, name) {
  return path.basename(dir) + '/' + name;
}

function eachMatch(groups, visit) {
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    let names = [];
    try {
      names = fs.readdirSync(group.dir);
    } catch (_) {
      continue;
    }
    for (let n = 0; n < names.length; n += 1) {
      const name = names[n];
      const parsed = matchLogName(name, group.prefixes);
      if (!parsed) continue;
      const file = path.join(group.dir, name);
      if (path.basename(file) !== name) continue;
      let size = 0;
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        size = st.size;
      } catch (_) {
        continue;
      }
      visit({
        file: file,
        name: name,
        dir: group.dir,
        prefix: parsed.prefix,
        date: parsed.date,
        size: size
      });
    }
  }
}

function createLogRetention(options) {
  const opts = options || {};
  const core = opts.core || {};
  const logger = opts.logger;
  const now = opts.now;
  const setIntervalFn = opts.setIntervalFn;
  let timer = null;

  function runOnce() {
    const policy = loadPolicy(core);
    const today = startOfLocalDay(currentDate(now));
    let deleted = 0;
    let bytes = 0;
    let kept = 0;
    eachMatch(discover(core), function (row) {
      const limit = daysFor(row.prefix, policy);
      const cutoff = addCalendarDays(today, -limit);
      const stale = row.date.getTime() < cutoff.getTime();
      const isToday = row.date.getTime() === today.getTime();
      if (!stale || isToday) {
        kept += 1;
        return;
      }
      try {
        fs.unlinkSync(row.file);
      } catch (_) {
        emit(logger, 'warn', 'delete failed ' + labelOf(row.dir, row.name));
        kept += 1;
        return;
      }
      deleted += 1;
      bytes += row.size;
      emit(logger, 'info', 'deleted ' + labelOf(row.dir, row.name) + ' bytes ' + String(row.size));
    });
    emit(logger, 'info', 'retention deleted ' + deleted + ' bytes ' + bytes + ' kept ' + kept);
    return { deleted: deleted, bytes: bytes, kept: kept };
  }

  function status() {
    let files = 0;
    let bytes = 0;
    eachMatch(discover(core), function (row) {
      files += 1;
      bytes += row.size;
    });
    return { files: files, bytes: bytes };
  }

  function start() {
    if (timer != null) return;
    try { runOnce(); } catch (_) { /* one sweep must not break startup */ }
    const schedule = typeof setIntervalFn === 'function' ? setIntervalFn : setInterval;
    try {
      timer = schedule(function () {
        try { runOnce(); } catch (_) { /* keep the interval */ }
      }, INTERVAL_MS);
    } catch (_) {
      timer = null;
      return;
    }
    if (timer && typeof timer.unref === 'function') {
      try { timer.unref(); } catch (_) { /* ignore */ }
    }
  }

  function stop() {
    if (timer == null) return;
    const handle = timer;
    timer = null;
    try { clearInterval(handle); } catch (_) { /* ignore */ }
  }

  return {
    runOnce: runOnce,
    start: start,
    stop: stop,
    status: status
  };
}

module.exports = { createLogRetention: createLogRetention };
