'use strict';

/**
 * Twitch の題名とカテゴリ（stream.site@1）。
 * legacy は何もしない。shadow と meta.dryRun は外に出さない。
 * live だけが fetch する。宛先は Helix（users / search / channels / streams）とトークン更新だけ。
 * 秘密は ctx.secrets の twitch.oauth。refresh に成功したら同じ名前へ書き戻す。
 * ブラウザでの再認証はしない。応答本文はログに出さない。
 */

const oauth = require('./lib/oauth');

const { SECRET, TOKEN_URL, clean, parseOauth, configured } = oauth;
const USERS_URL = 'https://api.twitch.tv/helix/users';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_TEXT = 2000;
const MAX_BODY = 1024 * 1024;

const KNOWN = new Set([
  'not-configured',
  'needs-title-or-category',
  'no-broadcaster',
  'unauthorized',
  'refresh-failed',
  'refresh-unavailable',
  'network'
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

function allowedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.origin === 'https://id.twitch.tv' && parsed.pathname === '/oauth2/token') return true;
  if (parsed.origin !== 'https://api.twitch.tv') return false;
  return parsed.pathname === '/helix/users'
    || parsed.pathname === '/helix/search/categories'
    || parsed.pathname === '/helix/channels'
    || parsed.pathname === '/helix/streams';
}

function channelUrl(id) {
  return 'https://api.twitch.tv/helix/channels?broadcaster_id=' + encodeURIComponent(id);
}

function streamUrl(id) {
  return 'https://api.twitch.tv/helix/streams?user_id=' + encodeURIComponent(id);
}

function searchUrl(query) {
  return 'https://api.twitch.tv/helix/search/categories?query=' + encodeURIComponent(query) + '&first=5';
}

function suggestUrl(query) {
  return 'https://api.twitch.tv/helix/search/categories?query=' + encodeURIComponent(query) + '&first=10';
}

function pickCategory(list, query) {
  if (!Array.isArray(list) || !list.length) return null;
  const want = query.toLowerCase();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item && typeof item.name === 'string' && item.name.toLowerCase() === want) return item;
  }
  return list[0];
}

function idOf(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.id === 'string' && item.id.trim()) return item.id.trim();
  if (typeof item.id === 'number' && Number.isFinite(item.id)) return String(item.id);
  return '';
}

function createSiteTwitch(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  let ctx = null;
  let memory = null;
  let seen = [];
  let suggestionCache = new Map();
  let refreshes = 0;
  let chain = Promise.resolve();
  let lastOk = null;
  let lastAt = '';
  let lastError = '';

  function nowDate() {
    try {
      const value = nowFn();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date;
    } catch (err) { /* 時計が壊れても符号だけは返す */ }
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

  function needsRefresh(box) {
    return oauth.needsRefresh(box, nowMs());
  }

  function enqueue(fn) {
    const run = chain.then(fn);
    chain = run.then(function () {}, function () {});
    return run;
  }

  function finish(ok, error) {
    const code = ok ? '' : asCode({ code: error });
    lastOk = ok === true;
    lastAt = nowIso();
    lastError = code;
    if (ok) return { ok: true };
    return { ok: false, error: code };
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
    remember(parsed.client_id);
    remember(parsed.client_secret);
    remember(parsed.refresh_token);
    remember(parsed.access_token);
    return parsed;
  }

  function adopt(parsed) {
    const key = [parsed.refresh_token, parsed.access_token, parsed.client_id, parsed.client_secret].join('\n');
    if (!memory || memory.vaultKey !== key) {
      memory = {
        vaultKey: key,
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expiry_date: parsed.expiry_date,
        client_id: parsed.client_id,
        client_secret: parsed.client_secret,
        broadcaster_id: parsed.broadcaster_id
      };
    }
    remember(memory.access_token);
    remember(memory.refresh_token);
  }

  function startTimeout() {
    if (typeof AbortController !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimer(function () {
      try { controller.abort(); } catch (err) { /* すでに終わっていてもよい */ }
    }, REQUEST_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return {
      signal: controller.signal,
      cancel() {
        try { clearTimer(timer); } catch (err) { /* 二重キャンセルは無視 */ }
      }
    };
  }

  async function readText(res) {
    if (!res || typeof res.text !== 'function') return '';
    try {
      const text = await res.text();
      if (typeof text !== 'string') return '';
      if (text.length > MAX_BODY) throw fail('network');
      return text;
    } catch (err) {
      if (err && err.code) throw err;
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

  async function raw(url, init) {
    if (!allowedUrl(url)) throw fail('network');
    const timeout = startTimeout();
    try {
      const options = Object.assign({}, init, { redirect: 'manual', cache: 'no-store' });
      if (timeout) options.signal = timeout.signal;
      let res;
      try {
        res = await fetchImpl(url, options);
      } catch (err) {
        throw fail('network');
      }
      if (!res || typeof res.status !== 'number') throw fail('network');
      const status = res.status;
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        throw fail('network');
      }
      return res;
    } finally {
      if (timeout) timeout.cancel();
    }
  }

  async function doRefresh(failedToken) {
    // 他の役目が先に更新しているかもしれない。refresh の直前に金庫を読み直す（lib/oauth.js）。
    const latest = await loadParsed();
    if (latest && memory) {
      // 金庫が（自分が読んだあとで）変わっていれば adopt が memory を取り替える。
      // 取り替わって、失敗した token と違う有効な token になっていれば、他の役目が先に更新した。再 refresh しない。
      const held = memory;
      adopt(latest);
      if (memory !== held && memory.access_token !== failedToken && !needsRefresh(memory)) return;
    }
    if (!memory || !memory.refresh_token || !memory.client_id || !memory.client_secret) {
      throw fail('refresh-unavailable');
    }
    const res = await raw(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: oauth.refreshBody(memory)
    });
    if (res.status !== 200) throw fail('refresh-failed');
    const json = parseJson(await readText(res));
    const fresh = oauth.applyRefresh(memory, json, nowMs());
    if (!fresh) throw fail('refresh-failed');
    fresh.forEach(remember);
    await writeBack();
  }

  async function writeBack() {
    const target = ctx;
    if (!memory || !target || !target.secrets || typeof target.secrets.set !== 'function') return;
    try {
      await target.secrets.set(SECRET, oauth.vaultBody(memory));
    } catch (err) {
      /* 戻せなくてもメモリのトークンで続ける。値は出さない */
    }
  }

  async function currentToken() {
    if (memory.access_token && !needsRefresh(memory)) return memory.access_token;
    if (refreshes >= 1) {
      if (memory.access_token) return memory.access_token;
      throw fail('unauthorized');
    }
    await doRefresh(memory.access_token);
    refreshes += 1;
    return memory.access_token;
  }

  async function call(url, makeInit) {
    const first = await currentToken();
    let res = await raw(url, makeInit(first));
    if (res.status === 401 && refreshes < 1) {
      await doRefresh(first);
      refreshes += 1;
      res = await raw(url, makeInit(memory.access_token));
    }
    return res;
  }

  function headersFor(token, body) {
    const headers = {
      'Client-ID': memory.client_id,
      Authorization: 'Bearer ' + token
    };
    if (body != null) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async function fetchUserId() {
    const res = await call(USERS_URL, function (token) {
      return { method: 'GET', headers: headersFor(token) };
    });
    if (res.status === 401) throw fail('unauthorized');
    if (res.status !== 200) throw fail(httpCode(res.status));
    const json = parseJson(await readText(res));
    const row = json && Array.isArray(json.data) ? json.data[0] : null;
    const id = idOf(row);
    if (!id) throw fail('no-broadcaster');
    return id;
  }

  async function searchCategories(query, url) {
    const res = await call(url, function (token) {
      return { method: 'GET', headers: headersFor(token) };
    });
    if (res.status !== 200) return [];
    const json = parseJson(await readText(res));
    const list = json && Array.isArray(json.data) ? json.data : [];
    return list.slice(0, 10).map(function (item) {
      return { id: idOf(item), name: item && typeof item.name === 'string' ? item.name : '' };
    }).filter(function (item) { return item.id && item.name; });
  }

  async function searchGame(query) {
    const list = await searchCategories(query, searchUrl(query));
    const match = pickCategory(list, query);
    return idOf(match);
  }

  async function suggestCategories(input) {
    const mode = modeOf(ctx);
    if (mode === 'legacy') return { ok: false, error: 'legacy' };
    const query = typeof input === 'string' ? input.trim() : '';
    if (query.length < 2) return { ok: true, items: [] };
    if (query.length > 100) return { ok: false, error: 'query-too-long' };
    const cached = suggestionCache.get(query);
    const now = nowMs();
    if (cached && cached.expiresAt > now) return { ok: true, items: cached.items.slice() };
    try {
      const parsed = await loadParsed();
      if (!configured(parsed)) return { ok: false, error: 'not-configured' };
      adopt(parsed);
      refreshes = 0;
      const items = await searchCategories(query, suggestUrl(query));
      suggestionCache.set(query, { expiresAt: now + 5 * 60 * 1000, items: items.slice(0, 10) });
      return { ok: true, items: items.slice(0, 10) };
    } catch (err) {
      log('warn', 'suggest network');
      return { ok: false, error: asCode(err) };
    }
  }

  async function updateMetadata(input, meta) {
    return enqueue(async function () {
      const mode = resolveMode(meta);
      if (mode === 'legacy') return { ok: true };
      if (mode === 'shadow') return { ok: true, dryRun: true };
      const title = input && typeof input.title === 'string' ? input.title : '';
      const category = input && typeof input.category === 'string' ? input.category.trim() : '';
      if (!title.trim() && !category) return finish(false, 'needs-title-or-category');
      if (title.length > MAX_TEXT || category.length > MAX_TEXT) return finish(false, 'needs-title-or-category');
      try {
        const parsed = await loadParsed();
        if (!configured(parsed)) return finish(false, 'not-configured');
        adopt(parsed);
        refreshes = 0;
        const broadcasterId = await fetchUserId();
        let gameId = '';
        if (category) gameId = await searchGame(category);
        const payload = {};
        if (typeof input.title === 'string') payload.title = title;
        if (gameId) payload.game_id = gameId;
        if (Object.keys(payload).length === 0) {
          log('info', 'update ok');
          return finish(true);
        }
        const body = JSON.stringify(payload);
        const res = await call(channelUrl(broadcasterId), function (token) {
          return { method: 'PATCH', headers: headersFor(token, body), body: body };
        });
        if (res.status !== 204) return finish(false, httpCode(res.status));
        log('info', 'update ok');
        return finish(true);
      } catch (err) {
        const code = asCode(err);
        log('warn', 'update ' + code);
        return finish(false, code);
      }
    });
  }

  async function getStatus() {
    return enqueue(async function () {
      if (modeOf(ctx) !== 'live') return {};
      try {
        const parsed = await loadParsed();
        if (!configured(parsed)) return {};
        adopt(parsed);
        refreshes = 0;
        const id = await fetchUserId();
        const channelRes = await call(channelUrl(id), function (token) {
          return { method: 'GET', headers: headersFor(token) };
        });
        let title = '';
        let category = '';
        if (channelRes.status === 200) {
          const json = parseJson(await readText(channelRes));
          const row = json && Array.isArray(json.data) ? json.data[0] : null;
          if (row && typeof row.title === 'string') title = row.title;
          if (row && typeof row.game_name === 'string') category = row.game_name;
        }
        const streamRes = await call(streamUrl(id), function (token) {
          return { method: 'GET', headers: headersFor(token) };
        });
        let live = false;
        if (streamRes.status === 200) {
          const json = parseJson(await readText(streamRes));
          live = !!(json && Array.isArray(json.data) && json.data.length > 0);
        }
        const out = { live: live };
        if (title) out.title = title;
        if (category) out.category = category;
        return out;
      } catch (err) {
        log('warn', 'status ' + asCode(err));
        return {};
      }
    });
  }

  async function isConfigured() {
    try {
      return configured(await loadParsed(ctx));
    } catch (err) {
      return false;
    }
  }

  async function panelStatus(params, passed) {
    const box = passed || ctx;
    let flag = false;
    try {
      flag = configured(await loadParsed(box));
    } catch (err) {
      flag = false;
    }
    return {
      ok: true,
      configured: flag === true,
      mode: modeOf(box),
      lastOk: lastOk,
      lastAt: lastAt,
      lastError: lastError
    };
  }

  function load(passed) {
    ctx = passed || null;
  }

  function start() {}

  function stop() {}

  function destroy() {
    ctx = null;
    memory = null;
    seen = [];
    suggestionCache = new Map();
    refreshes = 0;
    lastOk = null;
    lastAt = '';
    lastError = '';
  }

  async function health() {
    let ok = false;
    try {
      ok = await isConfigured();
    } catch (err) {
      ok = false;
    }
    return { ok: ok, detail: ok ? 'configured' : 'not-configured' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    isConfigured: isConfigured,
    suggestCategories: suggestCategories,
    updateMetadata: updateMetadata,
    getStatus: getStatus,
    actions: { getStatus: panelStatus }
  };
}

createSiteTwitch.allowedUrl = allowedUrl;

const singleton = createSiteTwitch();
singleton.createSiteTwitch = createSiteTwitch;
module.exports = singleton;
