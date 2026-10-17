'use strict';

/**
 * Kick コメント送信（chat.sink@1）。
 * legacy は何もしない。shadow と meta.dryRun は外に出さない。
 * live だけが fetch する。宛先は api.kick.com の users / chat とトークン更新だけ。
 * 秘密は ctx.secrets の kick.oauth。refresh に成功したら同じ名前へ書き戻す。
 * 本文・秘密はログに出さない（件数と成否だけ）。1 秒 1 件。
 */

const SECRET = 'kick.oauth';
const SITE = 'kick';
const USERS_URL = 'https://api.kick.com/public/v1/users';
const CHAT_URL = 'https://api.kick.com/public/v1/chat';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const KICK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFRESH_SKEW_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const RATE_MS = 1000;
const MAX_SECRET = 20000;
const MAX_TEXT = 200;
const MAX_BODY = 1024 * 1024;

const KNOWN = new Set([
  'no-credentials',
  'too-long',
  'no-broadcaster',
  'unauthorized',
  'refresh-failed',
  'refresh-unavailable',
  'network',
  'wrong-site'
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

function expiryMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1e12) return n * 1000;
  return n;
}

function allowedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.origin === 'https://id.kick.com' && parsed.pathname === '/oauth/token') return true;
  if (parsed.origin !== 'https://api.kick.com') return false;
  return parsed.pathname === '/public/v1/users' || parsed.pathname === '/public/v1/chat';
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
  let broadcaster = clean(parsed.broadcaster_user_id);
  if (!broadcaster && parsed.broadcaster_user_id != null && Number.isFinite(Number(parsed.broadcaster_user_id))) {
    broadcaster = String(parsed.broadcaster_user_id);
  }
  return {
    client_id: clean(parsed.client_id),
    client_secret: clean(parsed.client_secret),
    refresh_token: clean(parsed.refresh_token),
    access_token: clean(parsed.access_token),
    broadcaster_user_id: broadcaster,
    expiry_date: expiryMs(parsed.expiry_date)
  };
}

function configured(parsed) {
  return !!(parsed && parsed.client_id && parsed.access_token);
}

function userIdOf(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.user_id === 'number' && Number.isFinite(row.user_id)) return String(row.user_id);
  if (typeof row.user_id === 'string' && row.user_id.trim()) return row.user_id.trim();
  if (typeof row.id === 'number' && Number.isFinite(row.id)) return String(row.id);
  if (typeof row.id === 'string' && row.id.trim()) return row.id.trim();
  return '';
}

function createSinkKick(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const sleepFn = typeof options.sleep === 'function'
    ? options.sleep
    : function defaultSleep(ms) {
      return new Promise(function (resolve) {
        const t = setTimer(resolve, ms);
        if (t && typeof t.unref === 'function') t.unref();
      });
    };

  let ctx = null;
  let memory = null;
  let seen = [];
  let refreshes = 0;
  let chain = Promise.resolve();
  let lastOk = null;
  let lastAt = '';
  let lastError = '';
  let lastSendAt = 0;
  let sendCount = 0;

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
    if (!box || !box.access_token) return true;
    if (box.expiry_date == null) return false;
    return box.expiry_date <= nowMs() + REFRESH_SKEW_MS;
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

  async function throttle() {
    if (!lastSendAt) return;
    const wait = RATE_MS - (nowMs() - lastSendAt);
    if (wait > 0) await sleepFn(wait);
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
        broadcaster_user_id: parsed.broadcaster_user_id
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

  function kickHeaders(token, extra) {
    const headers = {
      'User-Agent': KICK_UA,
      Accept: 'application/json'
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (extra) {
      const names = Object.keys(extra);
      for (let i = 0; i < names.length; i += 1) headers[names[i]] = extra[names[i]];
    }
    return headers;
  }

  async function doRefresh() {
    if (!memory || !memory.refresh_token || !memory.client_id || !memory.client_secret) {
      throw fail('refresh-unavailable');
    }
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', memory.refresh_token);
    body.set('client_id', memory.client_id);
    body.set('client_secret', memory.client_secret);
    const res = await raw(TOKEN_URL, {
      method: 'POST',
      headers: kickHeaders(null, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: body.toString()
    });
    if (res.status !== 200) throw fail('refresh-failed');
    const json = parseJson(await readText(res));
    const access = json && clean(json.access_token);
    if (!access) throw fail('refresh-failed');
    memory.access_token = access;
    remember(access);
    const rotated = json && clean(json.refresh_token);
    if (rotated) {
      memory.refresh_token = rotated;
      remember(rotated);
    }
    const seconds = Number(json.expires_in);
    memory.expiry_date = nowMs() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    await writeBack();
  }

  async function writeBack() {
    const target = ctx;
    if (!memory || !target || !target.secrets || typeof target.secrets.set !== 'function') return;
    const fields = {};
    const put = (key, value) => {
      if (typeof value === 'string' && value) fields[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
    };
    put('access_token', memory.access_token);
    put('broadcaster_user_id', memory.broadcaster_user_id);
    put('client_id', memory.client_id);
    put('client_secret', memory.client_secret);
    put('expiry_date', memory.expiry_date);
    put('refresh_token', memory.refresh_token);
    const keys = Object.keys(fields).sort();
    const body = {};
    for (let i = 0; i < keys.length; i += 1) body[keys[i]] = fields[keys[i]];
    try {
      await target.secrets.set(SECRET, JSON.stringify(body));
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
    await doRefresh();
    refreshes += 1;
    return memory.access_token;
  }

  async function call(url, makeInit) {
    const first = await currentToken();
    let res = await raw(url, makeInit(first));
    if (res.status === 401 && refreshes < 1) {
      await doRefresh();
      refreshes += 1;
      res = await raw(url, makeInit(memory.access_token));
    }
    return res;
  }

  async function fetchUserId() {
    if (memory.broadcaster_user_id) return memory.broadcaster_user_id;
    const res = await call(USERS_URL, function (token) {
      return { method: 'GET', headers: kickHeaders(token) };
    });
    if (res.status === 401) throw fail('unauthorized');
    if (res.status !== 200) throw fail(httpCode(res.status));
    const json = parseJson(await readText(res));
    const row = json && Array.isArray(json.data) ? json.data[0] : null;
    const id = userIdOf(row);
    if (!id) throw fail('no-broadcaster');
    memory.broadcaster_user_id = id;
    return id;
  }

  async function sendComment(input, meta) {
    return enqueue(async function () {
      const mode = resolveMode(meta);
      if (mode === 'legacy') return { ok: true };
      if (mode === 'shadow') return { ok: true, dryRun: true };
      const text = input && typeof input.text === 'string' ? input.text : '';
      if (text.length < 1 || text.length > MAX_TEXT) return finish(false, 'too-long');
      if (input && input.site != null && input.site !== SITE) return finish(false, 'wrong-site');
      try {
        const parsed = await loadParsed();
        if (!configured(parsed)) return finish(false, 'no-credentials');
        adopt(parsed);
        refreshes = 0;
        await throttle();
        const broadcasterId = await fetchUserId();
        const body = JSON.stringify({
          type: 'user',
          broadcaster_user_id: Number(broadcasterId),
          content: text
        });
        const res = await call(CHAT_URL, function (token) {
          return {
            method: 'POST',
            headers: kickHeaders(token, { 'Content-Type': 'application/json' }),
            body: body
          };
        });
        lastSendAt = nowMs();
        sendCount += 1;
        if (res.status < 200 || res.status >= 300) return finish(false, httpCode(res.status));
        log('info', 'send ok count=' + sendCount);
        return finish(true);
      } catch (err) {
        lastSendAt = nowMs();
        const code = asCode(err);
        log('warn', 'send ' + code);
        return finish(false, code);
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
    refreshes = 0;
    lastOk = null;
    lastAt = '';
    lastError = '';
    lastSendAt = 0;
    sendCount = 0;
  }

  async function health() {
    let ok = false;
    try {
      ok = await isConfigured();
    } catch (err) {
      ok = false;
    }
    return { ok: ok, detail: ok ? 'configured' : 'no-credentials' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    isConfigured: isConfigured,
    sendComment: sendComment,
    actions: { getStatus: panelStatus }
  };
}

createSinkKick.allowedUrl = allowedUrl;

const singleton = createSinkKick();
singleton.createSinkKick = createSinkKick;
module.exports = singleton;