'use strict';

/**
 * 配信先（ARCHITECTURE §4.1）を保持する。核が覚えるのは配信先の一覧とストリームキーまわりだけ（L6b: セッション・出したい状態・題名・カテゴリは持たない）。
 * 保存先は STATE_DIR/data/marust/state.json。atomic write。schemaVersion 1。
 * 配信先は自動では作らない。
 * enabled が true でない配信先は destinationSummary の対象外。
 * 壊れた行は読み込み時に捨て、件数だけ warn する。schemaVersion が 1 より大きいときは退避せず読み取り専用。
 * 読み込み失敗は state.json.broken-<日時> に退避して空で起動する。ログは件数だけ。
 */

const fs = require('fs');
const path = require('path');
const { defaultLogger } = require('./safe-runner');

function emptyState() {
  return { schemaVersion: 1, destinations: [] };
}

function stampOf(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    pad(d.getMilliseconds(), 3)
  );
}

function asText(value) {
  return value == null ? '' : String(value);
}

function blankActual() {
  return {
    engineState: '',
    siteLive: false,
    lastError: '',
    updatedAt: null,
    observed: {}
  };
}

function migrateDestination(row) {
  const next = Object.assign({}, row);
  // 前の版の行にあった印は読むとき黙って捨てる（次に保存するとき書かない。古い行の値は何でも同じ扱い）
  ['keyPolicy', 'keyKind', 'desired'].forEach((name) => { delete next[name]; }); // legacy-drop
  if ((!next.engine || typeof next.engine !== 'object') && next.obsTargetId) {
    next.engine = { id: 'obs-local', targetId: String(next.obsTargetId) };
  }
  if (Object.prototype.hasOwnProperty.call(next, 'obsTargetId')) delete next.obsTargetId;
  if (next.accountId == null || next.accountId === '') next.accountId = next.id;
  const actual = Object.assign(blankActual(), next.actual && typeof next.actual === 'object' ? next.actual : {});
  ['title', 'category'].forEach((name) => { delete actual[name]; }); // legacy-drop（題名・カテゴリは核が持たない）
  if (!actual.engineState && actual.obsState) actual.engineState = String(actual.obsState);
  if (Object.prototype.hasOwnProperty.call(actual, 'obsState')) delete actual.obsState;
  if (!actual.observed || typeof actual.observed !== 'object' || Array.isArray(actual.observed)) actual.observed = {};
  next.actual = actual;
  if (!next.engine) next.engine = null;
  else next.engine = { id: String(next.engine.id || ''), targetId: next.engine.targetId == null ? '' : String(next.engine.targetId) };
  return next;
}

function createStateStore(options) {
  const opts = options || {};
  const core = opts.core;
  if (!core || !core.STATE_DIR) throw new Error('state store requires core.STATE_DIR');
  const writeJson = opts.atomicWriteJsonSync || core.atomicWriteJsonSync;
  if (typeof writeJson !== 'function') throw new Error('state store requires atomic write');
  const logger = typeof opts.logger === 'function' ? opts.logger : defaultLogger;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  let state = emptyState();
  let readOnly = false;
  let warningText = '';

  function filePath() {
    return path.join(core.STATE_DIR, 'data', 'marust', 'state.json');
  }

  function quarantine(file) {
    const dest = file + '.broken-' + stampOf(now());
    const target = fs.existsSync(dest) ? dest + '-' + process.pid : dest;
    try {
      fs.renameSync(file, target);
    } catch (err) {
      try {
        fs.renameSync(file, target + '-1');
      } catch (_) {
        /* leave the broken file; start empty anyway */
      }
    }
    logger('warn', 'state load failed count=1');
  }

  function keepDestinationRows(rows) {
    const kept = [];
    let dropped = 0;
    for (const row of rows) {
      if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string') kept.push(migrateDestination(row));
      else dropped += 1;
    }
    if (dropped) logger('warn', 'state destinations dropped count=' + dropped);
    return kept;
  }

  function load() {
    const file = filePath();
    if (!fs.existsSync(file)) {
      state = emptyState();
      return snapshot();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad-shape');
      if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > 1) {
        readOnly = true;
        warningText = '状態ファイルの版が新しいため、読み取り専用です';
        logger('warn', 'state schema newer count=1');
        state = {
          schemaVersion: parsed.schemaVersion,
          destinations: Array.isArray(parsed.destinations) ? keepDestinationRows(parsed.destinations) : []
        };
        return snapshot();
      }
      if (parsed.schemaVersion !== 1) throw new Error('bad-schema');
      if (!Array.isArray(parsed.destinations)) throw new Error('bad-destinations');
      state = {
        schemaVersion: 1,
        destinations: keepDestinationRows(parsed.destinations)
      };
      return snapshot();
    } catch (err) {
      quarantine(file);
      state = emptyState();
      return snapshot();
    }
  }

  function save() {
    if (readOnly) return;
    writeJson(filePath(), {
      schemaVersion: 1,
      destinations: state.destinations
    });
  }

  function snapshot() {
    return structuredClone(state);
  }

  function putDestination(input) {
    if (readOnly) return { ok: false, reason: 'read-only' };
    const id = input && typeof input.id === 'string' ? input.id : '';
    if (!id) return { ok: false, reason: 'bad-id' };
    const existing = state.destinations.find((row) => row.id === id);
    const actual = Object.assign(
      blankActual(),
      existing && existing.actual ? existing.actual : {},
      input.actual || {}
    );
    if (input.actual && input.actual.obsState && !input.actual.engineState && !actual.engineState) {
      actual.engineState = String(input.actual.obsState);
    }
    let engine = existing ? existing.engine || null : null;
    if (input && Object.prototype.hasOwnProperty.call(input, 'engine')) engine = input.engine;
    else if (input && input.obsTargetId != null) engine = { id: 'obs-local', targetId: String(input.obsTargetId) };
    const accountId = input && input.accountId != null && String(input.accountId) !== ''
      ? String(input.accountId)
      : (existing && existing.accountId ? existing.accountId : id);
    const row = migrateDestination({
      id,
      site: input.site != null ? String(input.site) : (existing ? existing.site : ''),
      accountId,
      engine,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : (existing ? existing.enabled === true : false),
      actual
    });
    if (existing) {
      const index = state.destinations.indexOf(existing);
      state.destinations[index] = row;
    } else {
      state.destinations.push(row);
    }
    save();
    return { ok: true, destination: structuredClone(row) };
  }

  function updateActual(id, patch, meta) {
    if (readOnly) return { ok: false, reason: 'read-only' };
    const row = state.destinations.find((item) => item && item.id === id);
    if (!row) return { ok: false, reason: 'unknown-destination' };
    const info = meta && typeof meta === 'object' ? meta : {};
    const observedAt = typeof info.observedAt === 'string' && info.observedAt ? info.observedAt : now().toISOString();
    const source = info.source == null ? '' : String(info.source);
    const incoming = patch && typeof patch === 'object' ? patch : {};
    const actual = Object.assign(blankActual(), row.actual || {});
    if (!actual.observed || typeof actual.observed !== 'object' || Array.isArray(actual.observed)) actual.observed = {};
    let applied = 0;
    for (const key of Object.keys(incoming)) {
      if (key === 'observed' || key === 'obsState' || key === 'title' || key === 'category') continue; // 題名・カテゴリは核が持たない（L6b）
      const prev = actual.observed[key];
      if (prev && typeof prev.at === 'string' && observedAt < prev.at) continue;
      actual[key] = incoming[key];
      actual.observed[key] = { at: observedAt, source: source };
      applied += 1;
    }
    if (applied === 0) return { ok: true, dropped: true };
    if (!Object.prototype.hasOwnProperty.call(incoming, 'updatedAt') || observedAt < (actual.observed.updatedAt && actual.observed.updatedAt.at || '')) {
      if (!actual.observed.updatedAt || !(observedAt < actual.observed.updatedAt.at)) {
        actual.updatedAt = observedAt;
        actual.observed.updatedAt = { at: observedAt, source: source };
      }
    }
    row.actual = actual;
    save();
    return { ok: true };
  }

  function destinationSummary() {
    let count = 0;
    for (const row of state.destinations) {
      if (!row || row.enabled !== true) continue;
      count += 1;
    }
    return { count: count };
  }

  function warning() {
    return warningText;
  }

  load();

  return {
    load,
    save,
    snapshot,
    putDestination,
    updateActual,
    destinationSummary,
    filePath,
    warning,
    isReadOnly() {
      return readOnly;
    }
  };
}

module.exports = {
  createStateStore
};
