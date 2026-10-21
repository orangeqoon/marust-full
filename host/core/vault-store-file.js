'use strict';

/**
 * 金庫の既定の置き場（vault-store@1 の口の核の実装）。暗号文の行だけを STATE_DIR/services/marust-vault.json に置く。
 * 形式・ファイル名は K6 の前と同じ（schemaVersion:1・entries）。壊れたファイルは .broken-<日時> へ退避して空で始める。
 * 口: list() → { ok, rows } / put(row) / delete(name) → { ok } | { ok:false, error }。値（平文）は受け取らない。
 */

const fs = require('fs');
const path = require('path');
const { hasValueField, normalizeEntry, sortedRows } = require('./vault-row');

function stampOf(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

function createFileStore(options) {
  const opts = options || {};
  const stateDir = opts.stateDir;
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('vault store requires stateDir');
  const writeJson = opts.writeJson;
  if (typeof writeJson !== 'function') throw new Error('vault store requires writeJson');
  const warn = typeof opts.warn === 'function' ? opts.warn : function () {};
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const filePath = path.join(stateDir, 'services', 'marust-vault.json');
  let rows = new Map();
  let loaded = false;
  let loadError = null;

  function quarantine(file) {
    const dest = file + '.broken-' + stampOf(now());
    const target = fs.existsSync(dest) ? dest + '-' + process.pid : dest;
    let ok = false;
    try { fs.renameSync(file, target); ok = true; }
    catch (_) { try { fs.renameSync(file, target + '-1'); ok = true; } catch (_) { ok = false; } }
    warn('vault load failed count=1');
    return ok;
  }

  function persist() {
    if (loadError) throw new Error('vault-store-protected: ' + loadError);
    writeJson(filePath, { schemaVersion: 1, entries: sortedRows(rows) });
  }

  function load() {
    rows = new Map();
    loaded = true;
    loadError = null;
    let exists = false;
    try { exists = fs.existsSync(filePath); } catch (_) { loadError = 'read-error'; warn('vault load failed count=1'); return; }
    if (!exists) return;
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); }
    catch (err) { if (err?.code !== 'ENOENT') { loadError = 'read-error'; warn('vault load failed count=1'); } return; }
    let parsed;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch (_) { if (!quarantine(filePath)) loadError = 'quarantine-failed'; return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) || parsed.entries.some(hasValueField)) {
      if (!quarantine(filePath)) loadError = 'quarantine-failed';
      return;
    }
    const next = new Map();
    let skipped = 0;
    for (let i = 0; i < parsed.entries.length; i += 1) {
      const row = normalizeEntry(parsed.entries[i]);
      if (!row) { skipped += 1; continue; }
      next.set(row.name, row);
    }
    rows = next;
    if (skipped) {
      let backedUp = false;
      try {
        const damaged = filePath + '.damaged-' + stampOf(now());
        fs.copyFileSync(filePath, fs.existsSync(damaged) ? damaged + '-' + process.pid : damaged);
        backedUp = true;
      } catch (_) { backedUp = false; }
      if (backedUp) {
        try { persist(); } catch (_) { warn('vault load failed count=1'); }
      } else {
        loadError = 'backup-failed';
        warn('vault load failed count=1');
      }
    }
  }

  function list() {
    load();
    return loadError ? { ok: false, error: 'unavailable', rows: [] } : { ok: true, rows: sortedRows(rows) };
  }

  function put(row) {
    if (!loaded) load();
    if (loadError) return { ok: false, error: 'unavailable' };
    const clean = normalizeEntry(row);
    if (!clean) return { ok: false, error: 'bad-row' };
    const previous = rows.get(clean.name);
    rows.set(clean.name, clean);
    try { persist(); }
    catch (_) {
      if (previous) rows.set(clean.name, previous); else rows.delete(clean.name);
      return { ok: false, error: 'unavailable' };
    }
    return { ok: true };
  }

  function remove(name) {
    if (!loaded) load();
    if (loadError) return { ok: false, error: 'unavailable' };
    if (!rows.has(name)) return { ok: true };
    const previous = rows.get(name);
    rows.delete(name);
    try { persist(); }
    catch (_) {
      rows.set(name, previous);
      return { ok: false, error: 'unavailable' };
    }
    return { ok: true };
  }

  return { id: 'file', file: filePath, list: list, put: put, delete: remove };
}

module.exports = { createFileStore };
