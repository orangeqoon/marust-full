'use strict';

/**
 * Twitch レイド（stream.lifecycle@1）。
 * legacy は秘密も通信もしない。非常停止（reason emergency）もレイドしない。
 * shadow と meta.dryRun は候補の照会（Helix GET）まで行い、Start a raid は送らない。
 * live だけが POST /helix/raids する。宛先は api.twitch.tv の Helix だけ。
 * 秘密は ctx.secrets の twitch.oauth。ログ・パネル・dataDir の記録に値は出さない。
 * 候補は NeonTimer の raid.js と同じ順: おすすめリストで配信中（視聴者最少）、
 * いなければ相互フォローで配信中（視聴者最少）。キャッシュは ctx.dataDir。
 */

const fs = require('fs');
const path = require('path');

const SECRET = 'twitch.oauth';
const HELIX = 'https://api.twitch.tv';
const MUTUAL_FOLLOW_REFRESH_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SECRET = 20000;
const MAX_BODY = 1024 * 1024;
const MAX_PAGES = 30;
const BATCH = 100;
const MAX_LOGINS = 100;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

const KNOWN = new Set([
  'legacy',
  'emergency',
  'no-credentials',
  'no-candidate',
  'not-configured',
  'no-broadcaster',
  'unauthorized',
  'network',
  'not-ready'
]);

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function httpCode(status) {
  const n = Number(status);
  if (n === 401) return 'unauthorized';
  if (Number.isInteger(n) && n >= 400 && n <= 599) return 'http-' + n;
  return 'network';
}

function asCode(err) {
  const code = err && err.code;
  if (KNOWN.has(code)) return code;
  if (typeof code === 'string' && /^http-[45]\d\d$/.test(code)) return code;
  return 'network';
}

function clean(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 4096) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function loginOf(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().toLowerCase();
  if (!LOGIN_RE.test(text)) return '';
  return text;
}

function idOf(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function allowedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.origin !== HELIX) return false;
  return parsed.pathname === '/helix/users'
    || parsed.pathname === '/helix/channels/followed'
    || parsed.pathname === '/helix/channels/followers'
    || parsed.pathname === '/helix/streams'
    || parsed.pathname === '/helix/raids';
}

function parseOauth(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_SECRET) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return {
    client_id: clean(parsed.client_id),
    client_secret: clean(parsed.client_secret),
    refresh_token: clean(parsed.refresh_token),
    access_token: clean(parsed.access_token),
    broadcaster_id: clean(parsed.broadcaster_id)
  };
}

function configured(parsed) {
  return !!(parsed && parsed.client_id && parsed.access_token);
}

function loadJson(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function createRaidTwitch(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };

  let ctx = null;
  let seen = [];
  let chain = Promise.resolve();
  let last = null;

  function nowDate() {
    try {
      const value = nowFn();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date;
    } catch (err) { /* 時計が壊れても処理は続ける */ }
    return new Date();
  }

  function nowMs() {
    return nowDate().getTime();
  }

  function nowIso() {
    return nowDate().toISOString();
  }

  function remember(value) {
    if (typeof value !== 'string' || value.length < 8) return;
    if (seen.indexOf(value) === -1) seen.push(value);
  }

  function scrub(message) {
    let out = message == null ? '' : String(message);
    for (let i = 0; i < seen.length; i += 1) {
      if (out.indexOf(seen[i]) !== -1) out = out.split(seen[i]).join('***');
    }
    out = out.replace(/\bBearer\s+\S+/gi, 'Bearer ***');
    return out.slice(0, 300);
  }

  function log(level, message) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    try { ctx.logger(level, scrub(message)); } catch (err) { /* ログで本処理を止めない */ }
  }

  function modeOf(box) {
    const target = box || ctx;
    if (!target || typeof target.mode !== 'function') return 'legacy';
    try {
      const value = target.mode();
      if (value === 'legacy' || value === 'shadow' || value === 'live') return value;
    } catch (err) { /* 不明なモードは legacy */ }
    return 'legacy';
  }

  function resolveMode(meta) {
    if (meta && meta.dryRun === true) return 'shadow';
    return modeOf(ctx);
  }

  function dataFile(name) {
    if (!ctx || typeof ctx.dataDir !== 'string' || !ctx.dataDir) return '';
    return path.join(ctx.dataDir, name);
  }

  function readSuggested() {
    const data = loadJson(dataFile('raid-suggested-channels.json'), { channels: [] });
    const rows = data && Array.isArray(data.channels) ? data.channels : [];
    const out = [];
    for (let i = 0; i < rows.length && out.length < MAX_LOGINS; i += 1) {
      const login = loginOf(rows[i]);
      if (login && out.indexOf(login) === -1) out.push(login);
    }
    return out;
  }

  function readMutualCache() {
    const data = loadJson(dataFile('raid-cache.json'), null);
    if (!data || !Array.isArray(data.mutuals)) return null;
    const mutuals = [];
    for (let i = 0; i < data.mutuals.length && mutuals.length < MAX_LOGINS; i += 1) {
      const login = loginOf(data.mutuals[i]);
      if (login && mutuals.indexOf(login) === -1) mutuals.push(login);
    }
    const updatedAt = Number(data.updatedAt);
    return {
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      mutuals: mutuals
    };
  }

  function writeMutualCache(mutuals) {
    const file = dataFile('raid-cache.json');
    if (!file) return;
    const body = { updatedAt: nowMs(), mutuals: mutuals };
    fs.writeFileSync(file, JSON.stringify(body));
  }

  function writeLast(record) {
    last = record;
    const file = dataFile('last-raid.json');
    if (!file) return;
    const body = {
      at: record.at || '',
      mode: record.mode || '',
      dryRun: record.dryRun === true,
      ok: record.ok === true,
      skipped: record.skipped || '',
      error: record.error || '',
      login: record.login || '',
      source: record.source || '',
      viewerCount: Number.isFinite(record.viewerCount) ? record.viewerCount : null
    };
    try {
      fs.writeFileSync(file, JSON.stringify(body));
    } catch (err) {
      log('warn', 'record failed');
    }
  }

  function readLast() {
    if (last) return last;
    const data = loadJson(dataFile('last-raid.json'), null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    last = {
      at: typeof data.at === 'string' ? data.at : '',
      mode: typeof data.mode === 'string' ? data.mode : '',
      dryRun: data.dryRun === true,
      ok: data.ok === true,
      skipped: typeof data.skipped === 'string' ? data.skipped : '',
      error: typeof data.error === 'string' ? data.error : '',
      login: loginOf(data.login),
      source: data.source === 'suggested' || data.source === 'mutual' ? data.source : '',
      viewerCount: Number.isFinite(data.viewerCount) ? data.viewerCount : null
    };
    return last;
  }

  async function loadParsed(box) {
    const target = box || ctx;
    if (!target || !target.secrets || typeof target.secrets.get !== 'function') return null;
    let got;
    try {
      got = await target.secrets.get(SECRET);
    } catch (err) {
      return null;
    }
    if (!got || got.ok !== true || typeof got.value !== 'string') return null;
    const parsed = parseOauth(got.value);
    if (!parsed) return null;
    remember(parsed.client_secret);
    remember(parsed.refresh_token);
    remember(parsed.access_token);
    remember(parsed.client_id);
    return parsed;
  }

  async function readText(res) {
    if (!res || typeof res.text !== 'function') return '';
    try {
      const text = await res.text();
      if (typeof text !== 'string' || text.length > MAX_BODY) return '';
      return text;
    } catch (err) {
      return '';
    }
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  }

  async function raw(url, token, clientId, method) {
    if (!allowedUrl(url)) throw fail('network');
    const init = {
      method: method || 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        'Client-Id': clientId,
        Authorization: 'Bearer ' + token
      }
    };
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      throw fail('network');
    }
    if (!res || typeof res.status !== 'number') throw fail('network');
    const status = res.status;
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      throw fail('network');
    }
    return res;
  }

  async function helix(url, auth, method) {
    const res = await raw(url, auth.access_token, auth.client_id, method);
    if (res.status === 401) throw fail('unauthorized');
    if (res.status !== 200) throw fail(httpCode(res.status));
    return parseJson(await readText(res));
  }

  async function broadcasterId(auth) {
    if (auth.broadcaster_id) return auth.broadcaster_id;
    const json = await helix(HELIX + '/helix/users', auth, 'GET');
    const row = json && Array.isArray(json.data) ? json.data[0] : null;
    const id = idOf(row && row.id);
    if (!id) throw fail('no-broadcaster');
    return id;
  }

  async function fetchAllPages(auth, build) {
    const items = [];
    let cursor = '';
    const seenCursor = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const json = await helix(build(cursor), auth, 'GET');
      const data = json && Array.isArray(json.data) ? json.data : [];
      for (let i = 0; i < data.length; i += 1) items.push(data[i]);
      const next = json && json.pagination && typeof json.pagination.cursor === 'string'
        ? json.pagination.cursor
        : '';
      if (!next || seenCursor.has(next)) break;
      seenCursor.add(next);
      cursor = next;
    }
    return items;
  }

  async function computeMutuals(auth, fromId) {
    const followed = await fetchAllPages(auth, function (cursor) {
      let url = HELIX + '/helix/channels/followed?user_id=' + encodeURIComponent(fromId) + '&first=100';
      if (cursor) url += '&after=' + encodeURIComponent(cursor);
      return url;
    });
    const followers = await fetchAllPages(auth, function (cursor) {
      let url = HELIX + '/helix/channels/followers?broadcaster_id=' + encodeURIComponent(fromId) + '&first=100';
      if (cursor) url += '&after=' + encodeURIComponent(cursor);
      return url;
    });
    const followerIds = new Set();
    for (let i = 0; i < followers.length; i += 1) {
      const id = idOf(followers[i] && followers[i].user_id);
      if (id) followerIds.add(id);
    }
    const mutuals = [];
    for (let i = 0; i < followed.length; i += 1) {
      const row = followed[i];
      const id = idOf(row && row.broadcaster_id);
      const login = loginOf(row && row.broadcaster_login);
      if (!id || !login || !followerIds.has(id)) continue;
      if (mutuals.indexOf(login) === -1) mutuals.push(login);
      if (mutuals.length >= MAX_LOGINS) break;
    }
    return mutuals;
  }

  async function mutualLogins(auth, fromId) {
    const cache = readMutualCache();
    const fresh = cache && (nowMs() - cache.updatedAt) < MUTUAL_FOLLOW_REFRESH_MS;
    if (fresh) return cache.mutuals;
    const mutuals = await computeMutuals(auth, fromId);
    writeMutualCache(mutuals);
    return mutuals;
  }

  async function liveStreams(auth, logins) {
    const results = [];
    for (let i = 0; i < logins.length; i += BATCH) {
      const batch = logins.slice(i, i + BATCH);
      if (!batch.length) continue;
      const query = ['first=100'];
      for (let j = 0; j < batch.length; j += 1) {
        query.push('user_login=' + encodeURIComponent(batch[j]));
      }
      const json = await helix(HELIX + '/helix/streams?' + query.join('&'), auth, 'GET');
      const data = json && Array.isArray(json.data) ? json.data : [];
      for (let j = 0; j < data.length; j += 1) results.push(data[j]);
    }
    return results;
  }

  function pickLowest(streams) {
    let best = null;
    for (let i = 0; i < streams.length; i += 1) {
      const row = streams[i];
      const userId = idOf(row && row.user_id);
      const login = loginOf(row && row.user_login);
      if (!row || !userId || !login) continue;
      if (!best || row.viewer_count < best.viewer_count) {
        best = {
          user_id: userId,
          user_login: login,
          viewer_count: row.viewer_count
        };
      }
    }
    return best;
  }

  async function pickFrom(auth, logins, source) {
    if (!logins.length) return null;
    const live = await liveStreams(auth, logins);
    const pick = pickLowest(live);
    if (!pick) return null;
    return {
      userId: pick.user_id,
      login: pick.user_login,
      viewerCount: Number.isFinite(Number(pick.viewer_count)) ? Number(pick.viewer_count) : null,
      source: source
    };
  }

  async function pickTarget(auth, fromId) {
    const suggested = await pickFrom(auth, readSuggested(), 'suggested');
    if (suggested) return suggested;
    const mutuals = await mutualLogins(auth, fromId);
    return pickFrom(auth, mutuals, 'mutual');
  }

  function publicLast(record) {
    if (!record) return null;
    return {
      at: record.at || '',
      mode: record.mode || '',
      dryRun: record.dryRun === true,
      ok: record.ok === true,
      skipped: record.skipped || '',
      error: record.error || '',
      login: record.login || '',
      source: record.source || '',
      viewerCount: Number.isFinite(record.viewerCount) ? record.viewerCount : null
    };
  }

  function candidateRows() {
    const out = [];
    const suggested = readSuggested();
    for (let i = 0; i < suggested.length; i += 1) {
      out.push({ login: suggested[i], source: 'suggested' });
    }
    const cache = readMutualCache();
    const mutuals = cache ? cache.mutuals : [];
    for (let i = 0; i < mutuals.length; i += 1) {
      if (suggested.indexOf(mutuals[i]) !== -1) continue;
      out.push({ login: mutuals[i], source: 'mutual' });
    }
    return out;
  }

  function finish(mode, fields) {
    const record = {
      at: nowIso(),
      mode: mode,
      dryRun: fields.dryRun === true,
      ok: fields.ok !== false,
      skipped: fields.skipped || '',
      error: fields.error || '',
      login: fields.login || '',
      source: fields.source || '',
      viewerCount: Number.isFinite(fields.viewerCount) ? fields.viewerCount : null
    };
    writeLast(record);
    const result = { ok: record.ok, dryRun: record.dryRun };
    if (record.skipped) result.skipped = record.skipped;
    if (record.error) result.error = record.error;
    if (record.login) {
      result.login = record.login;
      result.source = record.source;
      result.viewerCount = record.viewerCount;
    }
    return result;
  }

  async function handleStopping(payload, meta) {
    const reason = payload && payload.reason;
    if (reason === 'emergency') {
      log('info', 'skip emergency');
      return finish('live', { ok: true, skipped: 'emergency' });
    }
    const mode = resolveMode(meta);
    if (mode === 'legacy') {
      log('info', 'skip legacy');
      return finish('legacy', { ok: true, skipped: 'legacy' });
    }
    let auth;
    try {
      auth = await loadParsed(ctx);
    } catch (err) {
      auth = null;
    }
    if (!configured(auth)) {
      log('info', 'skip no-credentials');
      return finish(mode, { ok: true, skipped: 'no-credentials' });
    }
    try {
      const fromId = await broadcasterId(auth);
      const target = await pickTarget(auth, fromId);
      if (!target) {
        log('info', 'skip no-candidate');
        return finish(mode, { ok: true, skipped: 'no-candidate' });
      }
      if (mode === 'shadow') {
        log('info', 'dry-run ' + target.login + ' source=' + target.source);
        if (ctx && ctx.log && typeof ctx.log.appendJsonl === 'function') {
          ctx.log.appendJsonl('shadow', {
            at: nowIso(),
            op: 'raid',
            login: target.login,
            source: target.source,
            viewerCount: Number.isFinite(target.viewerCount) ? target.viewerCount : null,
            ok: true
          });
        }
        return finish(mode, {
          ok: true,
          dryRun: true,
          login: target.login,
          source: target.source,
          viewerCount: target.viewerCount
        });
      }
      const url = HELIX + '/helix/raids?from_broadcaster_id=' + encodeURIComponent(fromId)
        + '&to_broadcaster_id=' + encodeURIComponent(target.userId);
      await helix(url, auth, 'POST');
      log('info', 'raid ' + target.login + ' source=' + target.source);
      return finish(mode, {
        ok: true,
        login: target.login,
        source: target.source,
        viewerCount: target.viewerCount
      });
    } catch (err) {
      const code = asCode(err);
      log('warn', 'raid failed ' + code);
      return finish(mode, { ok: false, error: code });
    }
  }

  function enqueue(work) {
    const job = chain.then(function () { return work(); });
    chain = job.then(function () {}, function () {});
    return job;
  }

  function onEvent(name, payload, meta) {
    if (name !== 'stream.stopping') return undefined;
    return enqueue(function () { return handleStopping(payload, meta); });
  }

  async function getStatus(params, passed) {
    const box = passed || ctx;
    if (!box) return { ok: false, error: 'not-ready' };
    let flag = false;
    try {
      flag = configured(await loadParsed(box));
    } catch (err) {
      flag = false;
    }
    const saved = box === ctx ? readLast() : null;
    return {
      ok: true,
      mode: modeOf(box),
      configured: flag === true,
      candidates: candidateRows(),
      last: publicLast(saved)
    };
  }

  function setSuggested(params, passed) {
    const box = passed || ctx;
    if (!box || typeof box.dataDir !== 'string' || !box.dataDir) {
      return { ok: false, error: 'not-ready' };
    }
    const rows = params && Array.isArray(params.channels) ? params.channels : null;
    if (!rows) return { ok: false, error: 'bad-channels' };
    const channels = [];
    for (let i = 0; i < rows.length && channels.length < MAX_LOGINS; i += 1) {
      const login = loginOf(rows[i]);
      if (login && channels.indexOf(login) === -1) channels.push(login);
    }
    try {
      fs.writeFileSync(
        path.join(box.dataDir, 'raid-suggested-channels.json'),
        JSON.stringify({ channels: channels })
      );
    } catch (err) {
      return { ok: false, error: 'write-failed' };
    }
    log('info', 'suggested count=' + channels.length);
    return { ok: true, count: channels.length };
  }

  function load(passed) {
    ctx = passed || null;
    seen = [];
    last = null;
  }

  function start() {}

  function stop() {}

  function destroy() {
    ctx = null;
    seen = [];
    last = null;
  }

  function health() {
    return { ok: true, detail: 'raid-twitch' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    onEvent: onEvent,
    actions: {
      getStatus: getStatus,
      setSuggested: setSuggested
    }
  };
}

createRaidTwitch.allowedUrl = allowedUrl;

const singleton = createRaidTwitch();
singleton.createRaidTwitch = createRaidTwitch;
module.exports = singleton;