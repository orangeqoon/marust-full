'use strict';

/**
 * 診断の材料（K3）。診断の文（findings）はプラグイン diagnostics が作る。ここは核の中身を見て、名前と有無だけの平らな表にする。
 * 値・秘密・トークン・絶対パスは返さない。依存はすべて任意（テストは registry / engine / vault / clock / logStat / stateReader を渡す）。
 * 4.5 秒を超えたら、そこまでに揃った項目だけを返す（timedOut: true）。
 *
 * 返す形（read の API diagnostics.facts）:
 *   { ok: true, uptimeMs: number|null, gateway: boolean,
 *     plugins: [{ id, status, mode, reason, startFailed, stuck }],
 *     engines: [{ id, status: { connected, supported, mode }|null }],
 *     vault: { known, usable }, logs: { known, totalBytes, recentErrors: [] },
 *     state: { readOnly }, modes: { unreadable }, timedOut }
 */

const fs = require('fs');
const path = require('path');
const net = require('net');

const BUDGET_MS = 4500;
const CALL_MS = 1200;
const GATEWAY_PORT = 18770;
const STATE_SCHEMA = 1;

function safeCode(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(text)) return '';
  if (/token|cookie|secret|password|bearer|authorization/i.test(text)) return '';
  return text;
}

function publicId(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(text)) return 'plugin';
  if (/token|cookie|secret|password|bearer|authorization/i.test(text)) return 'plugin';
  return text;
}

function withCap(work, ms) {
  return new Promise(function (resolve) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve(null);
    }, ms);
    Promise.resolve().then(work).then(function (value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }, function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function readUptime(deps) {
  try {
    if (typeof deps.uptimeMs === 'number' && Number.isFinite(deps.uptimeMs) && deps.uptimeMs >= 0) return deps.uptimeMs;
    if (typeof deps.uptimeMs === 'function') {
      const value = deps.uptimeMs();
      if (value && typeof value.then === 'function') return null;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
      return null;
    }
    if (typeof deps.startedAt === 'number' && Number.isFinite(deps.startedAt)) {
      const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
      const ms = now - deps.startedAt;
      if (Number.isFinite(ms) && ms >= 0) return ms;
      return null;
    }
    if (deps.uptimeMs === null) return null;
    const ms = Math.round(process.uptime() * 1000);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  } catch (_) { /* unknown */ }
  return null;
}

async function uptimeFact(deps) {
  if (typeof deps.uptimeMs === 'function') {
    const value = await withCap(function () { return deps.uptimeMs(); }, CALL_MS);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  return readUptime(deps);
}

function probePort(port) {
  return new Promise(function (resolve) {
    const socket = net.connect({ host: '127.0.0.1', port: port });
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      socket.removeAllListeners();
      try { socket.destroy(); } catch (_) { /* already gone */ }
      resolve(ok === true);
    }
    socket.setTimeout(800);
    socket.once('connect', function () { finish(true); });
    socket.once('timeout', function () { finish(false); });
    socket.once('error', function () { finish(false); });
  });
}

async function gatewayFact(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, 'gateway')) {
    const gateway = deps.gateway;
    if (typeof gateway === 'boolean') return gateway;
    if (gateway && typeof gateway.listening === 'boolean') return gateway.listening;
    if (gateway && typeof gateway.listening === 'function') {
      const value = await withCap(function () { return gateway.listening(); }, CALL_MS);
      return value === true;
    }
    if (gateway && gateway.server && typeof gateway.server.listening === 'boolean') return gateway.server.listening;
    if (gateway && typeof gateway.address === 'function') {
      try {
        const addr = gateway.address();
        return !!(addr && addr.port);
      } catch (_) { return false; }
    }
    return false;
  }
  if (deps && deps.skipNetwork === true) return false;
  const open = await withCap(function () { return probePort(GATEWAY_PORT); }, CALL_MS);
  return open === true;
}

async function loadPlugins(deps) {
  if (Array.isArray(deps.plugins)) return deps.plugins;
  if (deps.registry && typeof deps.registry.snapshot === 'function') {
    const snap = await withCap(function () { return deps.registry.snapshot(); }, CALL_MS);
    if (Array.isArray(snap)) return snap;
  }
  if (typeof deps.getState === 'function') {
    const state = await withCap(function () { return deps.getState(); }, CALL_MS);
    if (state && Array.isArray(state.plugins)) return state.plugins;
  }
  return [];
}

async function stuckIds(deps) {
  const ids = new Set();
  if (!deps.orchestrator || typeof deps.orchestrator.health !== 'function') return ids;
  const rows = await withCap(function () { return deps.orchestrator.health(); }, CALL_MS);
  if (!Array.isArray(rows)) return ids;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row && row.stuck === true && row.id) ids.add(publicId(row.id));
  }
  return ids;
}

function modeOf(row, deps) {
  if (row && (row.mode === 'legacy' || row.mode === 'shadow' || row.mode === 'live')) return row.mode;
  if (deps.orchestrator && typeof deps.orchestrator.modeFor === 'function' && row && row.id) {
    try {
      const value = deps.orchestrator.modeFor(row.id);
      if (value === 'legacy' || value === 'shadow' || value === 'live') return value;
    } catch (_) { /* ignore */ }
  }
  return '';
}

async function pluginFacts(deps) {
  const rows = await loadPlugins(deps);
  const stuck = await stuckIds(deps);
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || !row.id) continue;
    const id = publicId(row.id);
    out.push({
      id: id,
      status: safeCode(row.status) || 'unknown',
      mode: modeOf(row, deps),
      reason: safeCode(row.reason),
      startFailed: row.startFailed === true || row.status === 'start-failed',
      stuck: row.stuck === true || stuck.has(id)
    });
  }
  return out;
}

async function loadEngines(deps) {
  const list = [];
  const seen = new Set();
  function add(id, engine) {
    const name = publicId(id || (engine && engine.id) || 'obs-local');
    if (seen.has(name)) return;
    seen.add(name);
    list.push({ id: name, engine: engine });
  }
  const reg = deps.engines;
  if (reg && typeof reg.list === 'function' && typeof reg.get === 'function') {
    const ids = await withCap(function () { return reg.list(); }, CALL_MS);
    if (Array.isArray(ids)) {
      for (let i = 0; i < ids.length; i += 1) add(ids[i], reg.get(ids[i]));
    }
  }
  if (deps.engine) add(deps.engine.id || 'obs-local', deps.engine);
  return list;
}

async function engineFacts(deps) {
  const engines = await loadEngines(deps);
  const out = [];
  for (let i = 0; i < engines.length; i += 1) {
    const item = engines[i];
    let status = null;
    if (item.engine && typeof item.engine.status === 'function') {
      status = await withCap(function () { return item.engine.status(); }, CALL_MS);
    }
    const mode = status && (status.mode === 'legacy' || status.mode === 'shadow' || status.mode === 'live') ? status.mode : '';
    out.push({
      id: item.id,
      status: status ? { connected: status.connected === true, supported: status.supported !== false, mode: mode } : null
    });
  }
  return out;
}

function backendAvailable() {
  try {
    const vault = require('../core');
    if (!vault || typeof vault.selectBackend !== 'function') return false;
    const backend = vault.selectBackend({});
    return !!(backend && typeof backend.available === 'function' && backend.available() === true);
  } catch (_) {
    return false;
  }
}

async function vaultFact(deps) {
  const vault = deps.vault;
  if (vault == null) return { known: true, usable: false };
  if (typeof vault === 'boolean') return { known: true, usable: vault };
  if (typeof vault.usable === 'boolean') return { known: true, usable: vault.usable === true };
  if (typeof vault.usable === 'function') {
    const value = await withCap(function () { return vault.usable(); }, CALL_MS);
    return { known: true, usable: value === true };
  }
  if (typeof vault.available === 'function') {
    const value = await withCap(function () { return vault.available(); }, CALL_MS);
    return { known: true, usable: value === true };
  }
  if (typeof vault.describe === 'function') {
    const result = await withCap(function () { return vault.describe('marust-diag'); }, CALL_MS);
    if (result && result.error === 'unavailable') return { known: true, usable: false };
  }
  if (vault && (typeof vault.get === 'function' || typeof vault.list === 'function' || typeof vault.describe === 'function')) {
    const usable = await withCap(function () { return backendAvailable(); }, CALL_MS);
    return { known: true, usable: usable === true };
  }
  return { known: false, usable: true };
}

function pushRecent(bucket, value) {
  const code = safeCode(value);
  if (!code || bucket.indexOf(code) !== -1) return;
  if (bucket.length >= 20) return;
  bucket.push(code);
}

function normalizeLogStat(stat, bucket) {
  if (typeof stat === 'number' && Number.isFinite(stat) && stat >= 0) return { totalBytes: stat, known: true };
  if (!stat || typeof stat !== 'object') return { totalBytes: 0, known: true };
  const listed = Array.isArray(stat.recentErrors) ? stat.recentErrors : [];
  for (let i = 0; i < listed.length; i += 1) pushRecent(bucket, listed[i]);
  const total = Number(stat.totalBytes);
  return { totalBytes: Number.isFinite(total) && total >= 0 ? total : 0, known: true };
}

function skipLink(stat) {
  return stat && typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink();
}

function collectFiles(dir, acc, depth) {
  if (depth > 3 || acc.files > 2000) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (let i = 0; i < names.length; i += 1) {
    if (acc.files > 2000) return;
    const full = path.join(dir, names[i]);
    let stat;
    try { stat = fs.lstatSync(full); } catch (_) { continue; }
    if (skipLink(stat)) continue;
    if (stat.isDirectory()) {
      collectFiles(full, acc, depth + 1);
      continue;
    }
    if (!stat.isFile()) continue;
    acc.files += 1;
    acc.total += stat.size;
    if (names[i].endsWith('.jsonl')) acc.jsonl.push({ file: full, mtime: stat.mtimeMs || 0 });
  }
}

function tailErrorCodes(file, bucket) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const len = Math.min(stat.size, 16384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    const text = buf.toString('utf8');
    const re = /"error"\s*:\s*"([^"]*)"/g;
    let match;
    while ((match = re.exec(text))) pushRecent(bucket, match[1]);
  } catch (_) { /* unreadable log is not a secret */ } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

function scanLogs(stateDir, bucket) {
  const acc = { total: 0, files: 0, jsonl: [] };
  collectFiles(path.join(stateDir, 'logs', 'marust'), acc, 0);
  const plugins = path.join(stateDir, 'data', 'marust', 'plugins');
  let pluginNames = [];
  try { pluginNames = fs.readdirSync(plugins); } catch (_) { pluginNames = []; }
  for (let i = 0; i < pluginNames.length; i += 1) {
    const dir = path.join(plugins, pluginNames[i]);
    let stat;
    try { stat = fs.lstatSync(dir); } catch (_) { continue; }
    if (skipLink(stat) || !stat.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (let j = 0; j < files.length; j += 1) {
      if (!/^shadow-.*\.jsonl$/i.test(files[j])) continue;
      const full = path.join(dir, files[j]);
      let fileStat;
      try { fileStat = fs.lstatSync(full); } catch (_) { continue; }
      if (skipLink(fileStat) || !fileStat.isFile()) continue;
      acc.total += fileStat.size;
      acc.jsonl.push({ file: full, mtime: fileStat.mtimeMs || 0 });
    }
  }
  acc.jsonl.sort(function (a, b) { return b.mtime - a.mtime; });
  const newest = acc.jsonl.slice(0, 8);
  for (let i = 0; i < newest.length; i += 1) tailErrorCodes(newest[i].file, bucket);
  return { totalBytes: acc.total, known: true };
}

async function logFacts(deps) {
  const bucket = [];
  let stat = { totalBytes: 0, known: false };
  if (typeof deps.logStat === 'function') {
    const raw = await withCap(function () { return deps.logStat(); }, CALL_MS);
    stat = raw == null ? { totalBytes: 0, known: false } : normalizeLogStat(raw, bucket);
  } else if (deps.core && deps.core.STATE_DIR && deps.skipDisk !== true) {
    const scanned = await withCap(function () { return scanLogs(deps.core.STATE_DIR, bucket); }, CALL_MS);
    if (scanned) stat = scanned;
  }
  return { known: stat.known === true, totalBytes: stat.totalBytes, recentErrors: bucket.slice(0, 20) };
}

async function stateFact(deps) {
  if (typeof deps.stateReader === 'function') {
    const row = await withCap(function () { return deps.stateReader(); }, CALL_MS);
    if (!row || typeof row !== 'object') return { readOnly: false };
    const version = Number(row.schemaVersion);
    const newer = Number.isFinite(version) && version > STATE_SCHEMA;
    return { readOnly: row.readOnly === true || newer };
  }
  const store = deps.store;
  if (store && typeof store.isReadOnly === 'function') {
    try { return { readOnly: store.isReadOnly() === true }; } catch (_) { return { readOnly: false }; }
  }
  return { readOnly: false };
}

function modesUnreadable(row) {
  if (!row || typeof row !== 'object') return true;
  if (row.unreadable === true || row.readable === false) return true;
  if (row.missing === true) return false;
  if (row.ok === true || row.readable === true) return false;
  if (row.ok === false || row.error === 'unreadable') return true;
  return false;
}

async function modesFact(deps) {
  if (typeof deps.modesReader === 'function') {
    const row = await withCap(function () { return deps.modesReader(); }, CALL_MS);
    return { unreadable: row == null || modesUnreadable(row) };
  }
  if (deps.core && deps.core.STATE_DIR && deps.skipDisk !== true) {
    const read = await withCap(function () {
      const modes = require('./modes');
      return modes.fileView(modes.readModesDocument(deps.core));
    }, CALL_MS);
    return { unreadable: !read || read.readable !== true };
  }
  return { unreadable: false };
}

async function collectFacts(deps) {
  const src = deps && typeof deps === 'object' ? deps : {};
  const facts = {
    ok: true,
    uptimeMs: null,
    gateway: false,
    plugins: [],
    engines: [],
    vault: { known: false, usable: true },
    logs: { known: false, totalBytes: 0, recentErrors: [] },
    state: { readOnly: false },
    modes: { unreadable: false },
    timedOut: false
  };
  const tasks = [
    function () { return uptimeFact(src).then(function (v) { facts.uptimeMs = v; }); },
    function () { return gatewayFact(src).then(function (v) { facts.gateway = v === true; }); },
    function () { return pluginFacts(src).then(function (v) { facts.plugins = v; }); },
    function () { return engineFacts(src).then(function (v) { facts.engines = v; }); },
    function () { return vaultFact(src).then(function (v) { facts.vault = v; }); },
    function () { return logFacts(src).then(function (v) { facts.logs = v; }); },
    function () { return stateFact(src).then(function (v) { facts.state = v; }); },
    function () { return modesFact(src).then(function (v) { facts.modes = v; }); }
  ];
  const jobs = tasks.map(function (fn) { return Promise.resolve().then(fn).catch(function () { /* その項目は既定のまま */ }); });
  await new Promise(function (resolve) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      facts.timedOut = true;
      resolve();
    }, BUDGET_MS);
    Promise.all(jobs).then(function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
  return facts;
}

module.exports = { collectFacts, BUDGET_MS };
