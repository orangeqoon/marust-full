'use strict';

/**
 * YouTube コメント送信（chat.sink@1）。
 * legacy は何もしない。shadow と meta.dryRun は外に出さない。
 * live だけが fetch する。宛先は liveBroadcasts / liveChatMessages と OAuth トークン更新だけ。
 * 秘密は ctx.secrets の youtube.oauth。refresh に成功したら同じ名前へ書き戻す。
 * 本文・秘密はログに出さない（件数と成否だけ）。1 秒 1 件。
 */

const oauth = require('./lib/oauth');

const { SECRET, TOKEN_URL, clean, parseOauth, configured } = oauth;
const SITE = 'youtube';
const LIST_ROOT = 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts';
const MESSAGES_URL = 'https://youtube.googleapis.com/youtube/v3/liveChat/messages?part=snippet';
const REQUEST_TIMEOUT_MS = 15000;
const RATE_MS = 1000;
const MAX_TEXT = 200;
const MAX_BODY = 1024 * 1024;

const KNOWN = new Set([
  'no-credentials',
  'too-long',
  'no-livechat',
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

function allowedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token') return true;
  if (parsed.origin !== 'https://youtube.googleapis.com') return false;
  return parsed.pathname === '/youtube/v3/liveBroadcasts'
    || parsed.pathname === '/youtube/v3/liveChat/messages';
}

function listUrl(kind) {
  if (kind === 'mine') return LIST_ROOT + '?part=snippet&mine=true&maxResults=5';
  return LIST_ROOT + '?part=snippet&broadcastStatus=' + kind + '&broadcastType=all&maxResults=5';
}

function createSinkYoutube(deps) {
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

  function resetRun() {
    refreshes = 0;
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
    const res = await raw(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: oauth.refreshBody(memory)
    });
    // 400・401 だけがログイン切れ（refresh-failed）。5xx・429 などは一時的な失敗として扱う（ログインし直しを求めない）
    if (res.status !== 200) throw fail(res.status === 400 || res.status === 401 ? 'refresh-failed' : 'network');
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

  function liveChatIdOf(json) {
    const items = json && Array.isArray(json.items) ? json.items : null;
    if (!items || !items.length) return null;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const snippet = item.snippet;
      if (!snippet || typeof snippet !== 'object' || Array.isArray(snippet)) continue;
      if (typeof snippet.liveChatId === 'string' && snippet.liveChatId) return snippet.liveChatId;
    }
    return null;
  }

  async function listChatId(kind) {
    const res = await call(listUrl(kind), function (token) {
      return authInit(token, 'GET');
    });
    if (res.status === 401) throw fail('unauthorized');
    if (res.status < 200 || res.status >= 300) return null;
    return liveChatIdOf(parseJson(await readText(res)));
  }

  async function findLiveChatId() {
    const active = await listChatId('active');
    if (active) return active;
    const upcoming = await listChatId('upcoming');
    if (upcoming) return upcoming;
    return null;
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
        resetRun();
        await throttle();
        const liveChatId = await findLiveChatId();
        if (!liveChatId) return finish(false, 'no-livechat');
        const body = JSON.stringify({
          snippet: {
            liveChatId: liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: { messageText: text }
          }
        });
        const res = await call(MESSAGES_URL, function (token) {
          return authInit(token, 'POST', body);
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

createSinkYoutube.allowedUrl = allowedUrl;

const singleton = createSinkYoutube();
singleton.createSinkYoutube = createSinkYoutube;
module.exports = singleton;