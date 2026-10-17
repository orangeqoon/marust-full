'use strict';

const MAX_BODY = 1024 * 1024;
const MAX_SECRET = 64 * 1024;
const MAX_TEXT = 200;
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * ニコ生へのコメント送信（chat.sink@1）。
 * 番組 id は GET /unama/api/v2/programs/latest の data.id。
 * 送信は PUT /watch/<lv>/operator_comment。本文は text、isPermanent は false。
 * 秘密は cookies.niconico-main。リダイレクトは追わない。
 */

const HOST = 'live2.nicovideo.jp';
const SITE = 'niconico';
const COOKIE_NAME = 'cookies.niconico-main';
const SESSION_RE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]{1,128}$/;
const PROGRAM_RE = /^lv[0-9]{1,16}$/;
const UA_GET = 'MultiCommenter/1.0';
const UA_PUT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function createSinkNiconico(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : defaultFetch;
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return Date.now(); };
  let ctx = null;
  let nextAt = 0;
  const last = { result: '', at: '', configured: false };

  function fail(code) {
    const err = new Error('sink');
    err.code = code;
    return err;
  }

  function nowMs() {
    try {
      const value = nowFn();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date.getTime();
    } catch (err) { /* 時計が壊れていても続ける */ }
    return Date.now();
  }

  function log(kind) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    try { ctx.logger('info', kind === 'ok' ? 'ok 1' : 'fail 1'); } catch (err) { /* ログで止めない */ }
  }

  function modeOf() {
    if (!ctx || typeof ctx.mode !== 'function') return 'legacy';
    try {
      const value = ctx.mode();
      if (value === 'live' || value === 'shadow' || value === 'legacy') return value;
    } catch (err) { /* legacy */ }
    return 'legacy';
  }

  function textError(text) {
    if (typeof text !== 'string') return 'empty';
    const n = Array.from(text).length;
    if (n < 1) return 'empty';
    if (n > MAX_TEXT) return 'too-long';
    return '';
  }

  async function readRaw(name) {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return '';
    let result;
    try { result = await ctx.secrets.get(name); } catch (err) { return ''; }
    if (!result || result.ok !== true || typeof result.value !== 'string') return '';
    if (!result.value || result.value.length > MAX_SECRET || result.value.indexOf('\u0000') !== -1) return '';
    return result.value;
  }

  function loadCookies(text) {
    if (!text) return null;
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const source = parsed.cookies && typeof parsed.cookies === 'object' && !Array.isArray(parsed.cookies)
      ? parsed.cookies
      : parsed;
    const cookies = Object.create(null);
    let session = '';
    const keys = Object.keys(source);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (!COOKIE_NAME_RE.test(key)) continue;
      const value = source[key];
      if (typeof value !== 'string' || !value || /[\r\n\u0000;]/.test(value)) continue;
      cookies[key] = value;
      if (key === 'user_session' && SESSION_RE.test(value)) session = value;
    }
    if (!session) return null;
    const parts = [];
    const names = Object.keys(cookies);
    for (let i = 0; i < names.length; i += 1) parts.push(names[i] + '=' + cookies[names[i]]);
    return { session: session, cookie: parts.join('; ') };
  }

  function allowedUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch (err) { return false; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;
    return parsed.hostname.toLowerCase().replace(/\.$/, '') === HOST;
  }

  async function discard(res) {
    try {
      if (res && res.body && typeof res.body.cancel === 'function') {
        await res.body.cancel();
        return;
      }
    } catch (err) { /* 本文は使わない */ }
    try { if (res && typeof res.text === 'function') await res.text(); } catch (err) { /* 本文は使わない */ }
  }

  async function readText(res) {
    let text = '';
    try { if (res && typeof res.text === 'function') text = await res.text(); } catch (err) { throw fail('http'); }
    if (typeof text !== 'string') text = '';
    if (text.length > MAX_BODY) throw fail('http');
    return text;
  }

  async function call(url, init) {
    if (!allowedUrl(url)) throw fail('domain');
    const request = Object.assign({}, init || {});
    request.redirect = 'manual';
    request.cache = 'no-store';
    let res;
    try { res = await fetchImpl(url, request); } catch (err) { throw fail('network'); }
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (REDIRECT.has(status) || status === 0) {
      await discard(res);
      throw fail('redirect');
    }
    if (res && typeof res.url === 'string' && res.url && !allowedUrl(res.url)) {
      await discard(res);
      throw fail('redirect');
    }
    const text = await readText(res);
    if (status < 200 || status >= 300) throw fail('http');
    return text;
  }

  async function perform(auth, text) {
    const latestText = await call('https://' + HOST + '/unama/api/v2/programs/latest', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-niconico-session': auth.session,
        Cookie: auth.cookie,
        'User-Agent': UA_GET
      }
    });
    let latest;
    try { latest = JSON.parse(latestText); } catch (err) { throw fail('bad-response'); }
    const programId = latest && latest.data && typeof latest.data.id === 'string' ? latest.data.id : '';
    if (!PROGRAM_RE.test(programId)) throw fail('not-live');
    const body = JSON.stringify({ text: text, isPermanent: false });
    await call('https://' + HOST + '/watch/' + programId + '/operator_comment', {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        Cookie: auth.cookie,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': UA_PUT
      },
      body: body
    });
  }

  function takeSlot() {
    const now = nowMs();
    if (now < nextAt) return false;
    nextAt = now + 1000;
    return true;
  }

  function note(ok, configured) {
    last.result = ok ? 'ok' : 'ng';
    last.at = new Date(nowMs()).toISOString();
    if (configured === true || configured === false) last.configured = configured;
  }

  async function sendComment(input, meta) {
    if (!input || input.site !== SITE) {
      log('fail');
      return { ok: false, error: 'wrong-site' };
    }
    const problem = textError(input.text);
    if (problem) {
      log('fail');
      return { ok: false, error: problem };
    }
    if (meta && meta.dryRun === true) return { ok: true, dryRun: true };
    const mode = modeOf();
    if (mode === 'legacy') {
      log('fail');
      return { ok: false, error: 'legacy' };
    }
    if (mode === 'shadow') return { ok: true, dryRun: true };
    const auth = loadCookies(await readRaw(COOKIE_NAME));
    if (!auth) {
      note(false, false);
      log('fail');
      return { ok: false, error: 'no-credentials' };
    }
    if (!takeSlot()) {
      log('fail');
      return { ok: false, error: 'rate-limit' };
    }
    try {
      await perform(auth, input.text);
      note(true, true);
      log('ok');
      return { ok: true };
    } catch (err) {
      note(false, true);
      log('fail');
      const code = err && CODE_RE.test(err.code) ? err.code : 'http';
      return { ok: false, error: code };
    }
  }

  function getStatus() {
    return { ok: true, configured: last.configured, result: last.result, at: last.at };
  }

  return {
    load(passed) { ctx = passed || null; },
    start() {},
    stop() {},
    destroy() { ctx = null; },
    health() { return { ok: true, detail: 'sink-niconico' }; },
    sendComment: sendComment,
    getStatus: getStatus,
    actions: { getStatus: getStatus }
  };
}

function defaultFetch(url, init) {
  let parsed;
  try { parsed = new URL(url); } catch (err) { return Promise.reject(Object.assign(new Error('domain'), { code: 'domain' })); }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase().replace(/\.$/, '') !== HOST) {
    return Promise.reject(Object.assign(new Error('domain'), { code: 'domain' }));
  }
  return globalThis.fetch(url, Object.assign({}, init || {}, { redirect: 'manual' }));
}

const singleton = createSinkNiconico();
singleton.createSinkNiconico = createSinkNiconico;
module.exports = singleton;
