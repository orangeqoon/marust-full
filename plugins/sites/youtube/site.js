'use strict';

/**
 * YouTube の題名（stream.site@1）。
 * legacy は何もしない。shadow と meta.dryRun は外に出さない。
 * live だけが fetch する。宛先は liveBroadcasts と OAuth トークン更新だけ。
 * 秘密は ctx.secrets の youtube.oauth。refresh に成功したら同じ名前へ書き戻す。
 * ブラウザでの再認証はしない。応答本文はログに出さない。
 */

const oauth = require('./lib/oauth');

const { SECRET, TOKEN_URL, clean, parseOauth, configured } = oauth;
const LIST_ROOT = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts';
const UPDATE_URL = LIST_ROOT + '?part=snippet';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_TEXT = 2000;
const MAX_BODY = 1024 * 1024;

const KNOWN = new Set([
  'not-configured',
  'needs-title',
  'no-broadcast',
  'unauthorized',
  'refresh-failed',
  'refresh-unavailable',
  'network',
  'invalid-response'
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
  if (parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token') return true;
  if (parsed.origin === 'https://youtube.googleapis.com' && parsed.pathname === '/youtube/v3/liveBroadcasts') return true;
  return false;
}

function listUrl(kind) {
  if (kind === 'mine') return LIST_ROOT + '?part=snippet&mine=true&maxResults=5';
  return LIST_ROOT + '?part=snippet&broadcastStatus=' + kind + '&broadcastType=all&maxResults=5';
}

function copySnippet(snippet, title) {
  const out = {};
  const keys = Object.keys(snippet);
  for (let i = 0; i < keys.length; i += 1) out[keys[i]] = snippet[keys[i]];
  out.title = title;
  return out;
}

function createSiteYoutube(deps) {
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
  let refreshes = 0;
  let chain = Promise.resolve();
  let lastOk = null;
  let lastAt = '';
  let lastError = '';
  let stage = '';
  let lastStage = '';
  let lastStatusError = '';
  let lastStatusAt = '';
  let statusStage = '';
  let credentialsState = 'unchecked';
  let credentialsError = '';

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
    lastStage = stage;
    if (ok) return { ok: true };
    return { ok: false, error: code };
  }

  function resetRun() {
    refreshes = 0;
  }

  async function loadParsed(box) {
    credentialsState = 'vault-unavailable';
    credentialsError = 'unavailable';
    const target = box || ctx;
    if (!target || !target.secrets || typeof target.secrets.get !== 'function') return null;
    let got;
    try {
      got = await target.secrets.get(SECRET);
    } catch (err) {
      return null;
    }
    if (!got || got.ok !== true || typeof got.value !== 'string') {
      credentialsError = got && ['not-found', 'not-declared', 'decrypt-failed', 'unavailable'].includes(got.error) ? got.error : 'unavailable';
      credentialsState = credentialsError === 'not-found' ? 'missing' : 'vault-unavailable';
      return null;
    }
    credentialsError = '';
    const parsed = parseOauth(got.value);
    if (!parsed) { credentialsState = 'invalid-format'; return null; }
    credentialsState = configured(parsed) ? 'ready' : 'incomplete';
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
        client_secret: parsed.client_secret
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
    const resumeStage = stage;
    stage = 'refresh-token';
    const res = await raw(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: oauth.refreshBody(memory)
    });
    if (res.status !== 200) throw fail(res.status === 400 || res.status === 401 ? 'refresh-failed' : httpCode(res.status));
    const json = parseJson(await readText(res));
    const fresh = oauth.applyRefresh(memory, json, nowMs());
    if (!fresh) throw fail('refresh-failed');
    fresh.forEach(remember);
    await writeBack();
    stage = resumeStage;
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

  function authInit(token, method, body) {
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    };
    const init = { method: method, headers: headers };
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      init.body = body;
    }
    return init;
  }

  function firstBroadcast(json) {
    const items = json && Array.isArray(json.items) ? json.items : null;
    if (!items || !items.length) return null;
    const item = items[0];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof item.id !== 'string' || !item.id) return null;
    if (!item.snippet || typeof item.snippet !== 'object' || Array.isArray(item.snippet)) return null;
    return item;
  }

  async function listAt(kind) {
    stage = 'list-' + kind;
    const res = await call(listUrl(kind), function (token) {
      return authInit(token, 'GET');
    });
    if (res.status === 401) throw fail('unauthorized');
    if (res.status < 200 || res.status >= 300) throw fail(httpCode(res.status));
    const json = parseJson(await readText(res));
    if (!json || !Array.isArray(json.items)) throw fail('invalid-response');
    const item = firstBroadcast(json);
    if (json.items.length && !item) throw fail('invalid-response');
    return item;
  }

  async function findBroadcast() {
    const active = await listAt('active');
    if (active) return { item: active, live: true };
    const upcoming = await listAt('upcoming');
    if (upcoming) return { item: upcoming, live: false };
    const mine = await listAt('mine');
    if (mine) return { item: mine, live: false };
    return null;
  }

  async function updateMetadata(input, meta) {
    return enqueue(async function () {
      const mode = resolveMode(meta);
      if (mode === 'legacy') return { ok: true };
      if (mode === 'shadow') return { ok: true, dryRun: true };
      const title = input && typeof input.title === 'string' ? input.title : '';
      stage = 'validate-title';
      if (!title.trim() || title.length > MAX_TEXT) return finish(false, 'needs-title');
      stage = 'credentials';
      try {
        const parsed = await loadParsed();
        if (!configured(parsed)) return finish(false, 'not-configured');
        adopt(parsed);
        resetRun();
        const found = await findBroadcast();
        if (!found) return finish(false, 'no-broadcast');
        const body = JSON.stringify({
          id: found.item.id,
          snippet: copySnippet(found.item.snippet, title)
        });
        stage = 'update-title';
        const res = await call(UPDATE_URL, function (token) {
          return authInit(token, 'PUT', body);
        });
        if (res.status < 200 || res.status >= 300) return finish(false, httpCode(res.status));
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
      stage = 'credentials';
      try {
        const parsed = await loadParsed();
        lastStatusAt = nowIso();
        lastStatusError = '';
        if (!configured(parsed)) { lastStatusError = 'not-configured'; statusStage = stage; return {}; }
        adopt(parsed);
        resetRun();
        const found = await findBroadcast();
        statusStage = stage;
        if (!found) { lastStatusError = 'no-broadcast'; return { live: false }; }
        const out = { live: found.live };
        const title = found.item.snippet && found.item.snippet.title;
        if (typeof title === 'string' && title) out.title = title;
        return out;
      } catch (err) {
        lastStatusAt = nowIso();
        lastStatusError = asCode(err);
        statusStage = stage;
        log('warn', 'status ' + lastStatusError);
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
      lastError: lastError,
      lastStage: lastStage,
      lastStatusError: lastStatusError,
      lastStatusAt: lastStatusAt,
      statusStage: statusStage,
      credentialsState: credentialsState,
      credentialsError: credentialsError
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
    refreshes = 0;
    lastOk = null;
    lastAt = '';
    lastError = '';
    stage = lastStage = lastStatusError = lastStatusAt = statusStage = '';
    credentialsState = 'unchecked';
    credentialsError = '';
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
    updateMetadata: updateMetadata,
    getStatus: getStatus,
    actions: { getStatus: panelStatus }
  };
}

createSiteYoutube.allowedUrl = allowedUrl;

const singleton = createSiteYoutube();
singleton.createSiteYoutube = createSiteYoutube;
module.exports = singleton;
