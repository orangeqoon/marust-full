'use strict';

/**
 * タイトル変更プラグインの共有状態（ドラフト題名・カテゴリ・直近の送信状態・サイト別結果）。
 * Home・題名とカテゴリパネル・タイマーのすべてがこの状態を参照・同期する。
 * 置き場: プラグイン自身の dataDir/title-state.json
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 256 * 1024;
const REAL_SITES = ['youtube', 'twitch', 'kick', 'twitcasting', 'niconico', 'fc2', 'soop', 'kukulu', 'picarto', 'rumble'];

function cleanField(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLen);
}

function normalizeSiteId(id) {
  if (typeof id !== 'string') return '';
  const s = id.replace(/^site-/, '').trim();
  return REAL_SITES.indexOf(s) !== -1 ? s : '';
}

const NEED_RE = /^[a-z0-9-]{1,40}$/;

function filterSiteRows(rows) {
  if (!Array.isArray(rows)) return [];
  const bySite = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || typeof r.id !== 'string') continue;
    if (r.message === 'no-fanout' || r.message === 'superseded-by-v2') continue;
    const site = normalizeSiteId(r.id);
    if (!site) continue;
    const prev = bySite.get(site);
    const isV2 = r.id.indexOf('site-') === 0;
    if (!prev || isV2) {
      const entry = {
        site: site,
        id: r.id,
        result: typeof r.result === 'string' ? r.result : 'skip',
        message: typeof r.message === 'string' ? r.message : '',
        mode: typeof r.mode === 'string' ? r.mode : 'legacy',
        elapsedMs: typeof r.elapsedMs === 'number' ? r.elapsedMs : 0
      };
      // 足りない物（N1）。種類の言葉だけ。形が違えば付けない
      if (typeof r.need === 'string' && NEED_RE.test(r.need) && typeof r.how === 'string' && NEED_RE.test(r.how)) {
        entry.need = r.need;
        entry.how = r.how;
      }
      bySite.set(site, entry);
    }
  }
  return Array.from(bySite.values());
}

function summarizeSiteRows(siteRows) {
  const counts = { ok: 0, error: 0, notConfigured: 0, skipped: 0, total: 0 };
  for (let i = 0; i < siteRows.length; i += 1) {
    const r = siteRows[i];
    if (r.mode === 'legacy' || r.message === 'legacy-mode') continue;
    counts.total += 1;
    if (r.result === 'ok') counts.ok += 1;
    else if (r.result === 'error') counts.error += 1;
    else if (r.message === 'not-configured' || r.message === 'not-configured-timeout') counts.notConfigured += 1;
    else counts.skipped += 1;
  }
  return counts;
}

function readJson(file) {
  try {
    if (!file) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch (_) {
    return null;
  }
}

function createTitleState(options) {
  const opts = options || {};
  const dir = typeof opts.dir === 'string' ? opts.dir : '';
  const bus = opts.bus || null;
  const file = dir ? path.join(dir, 'title-state.json') : '';

  const saved = readJson(file) || {};
  const mem = {
    title: cleanField(saved.title, 200),
    category: cleanField(saved.category, 100),
    phase: 'idle',
    lastAt: typeof saved.lastAt === 'string' ? saved.lastAt : '',
    lastSource: typeof saved.lastSource === 'string' ? saved.lastSource : '',
    lastTitle: cleanField(saved.lastTitle, 200),
    lastCategory: cleanField(saved.lastCategory, 100),
    siteResults: Array.isArray(saved.siteResults) ? filterSiteRows(saved.siteResults) : [],
    counts: saved.counts && typeof saved.counts === 'object' ? saved.counts : { ok: 0, error: 0, notConfigured: 0, skipped: 0, total: 0 }
  };

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      const body = {
        version: 1,
        title: mem.title,
        category: mem.category,
        lastAt: mem.lastAt,
        lastSource: mem.lastSource,
        lastTitle: mem.lastTitle,
        lastCategory: mem.lastCategory,
        siteResults: mem.siteResults,
        counts: mem.counts
      };
      fs.writeFileSync(tmp, JSON.stringify(body) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (_) { /* ignore */ }
  }

  function snapshot() {
    return {
      ok: true,
      title: mem.title,
      category: mem.category,
      phase: mem.phase,
      lastAt: mem.lastAt,
      lastSource: mem.lastSource,
      lastTitle: mem.lastTitle,
      lastCategory: mem.lastCategory,
      siteResults: mem.siteResults.slice(),
      counts: Object.assign({}, mem.counts)
    };
  }

  function setDraft(params) {
    let changed = false;
    if (params && typeof params.title === 'string') {
      const nextT = cleanField(params.title, 200);
      if (nextT !== mem.title) { mem.title = nextT; changed = true; }
    }
    if (params && typeof params.category === 'string') {
      const nextC = cleanField(params.category, 100);
      if (nextC !== mem.category) { mem.category = nextC; changed = true; }
    }
    if (changed) {
      persist();
      if (bus && typeof bus.publish === 'function') {
        try {
          bus.publish('stream.metadata.changed', {
            title: mem.title,
            category: mem.category,
            phase: mem.phase,
            source: (params && typeof params.source === 'string' ? params.source : 'draft')
          });
        } catch (_) { /* ignore */ }
      }
    }
    return snapshot();
  }

  function markSending(intent) {
    if (intent && typeof intent.title === 'string') mem.title = cleanField(intent.title, 200);
    if (intent && typeof intent.category === 'string') mem.category = cleanField(intent.category, 100);
    mem.phase = 'sending';
    mem.lastSource = intent && typeof intent.source === 'string' ? intent.source : 'manual';
  }

  function recordFanout(intent, rows) {
    if (intent && typeof intent.title === 'string') mem.title = cleanField(intent.title, 200);
    if (intent && typeof intent.category === 'string') mem.category = cleanField(intent.category, 100);
    mem.lastTitle = mem.title;
    mem.lastCategory = mem.category;
    mem.lastAt = new Date().toISOString();
    mem.lastSource = intent && typeof intent.source === 'string' ? intent.source : 'manual';
    mem.siteResults = filterSiteRows(rows);
    mem.counts = summarizeSiteRows(mem.siteResults);
    mem.phase = mem.counts.error > 0 ? 'error' : (mem.counts.ok > 0 ? 'done' : 'idle');
    persist();
    return snapshot();
  }

  return {
    getState: snapshot,
    setDraft: setDraft,
    markSending: markSending,
    recordFanout: recordFanout
  };
}

module.exports = { createTitleState, filterSiteRows, summarizeSiteRows };
