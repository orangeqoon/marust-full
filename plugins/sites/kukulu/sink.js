'use strict';

const MAX_BODY = 1024 * 1024;
const MAX_SECRET = 64 * 1024;
const MAX_TEXT = 200;
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * ククルへのコメント送信（chat.sink@1）。
 * GET https://live.erinn.biz/api/?category=comment&type=write&apikey&comment。
 * 配信 id は取らない。秘密は kukulu.config の apikey。
 * success === 1 だけ成功。リダイレクトは追わない。
 */

const HOST = 'live.erinn.biz';
const SITE = 'kukulu';
const SECRET = 'kukulu.config';
const PLACEHOLDER = 'YOUR_KUKULU_APIKEY_HERE';

function createSinkKukulu(deps) {
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

  function apikeyOf(text) {
    if (!text) return '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) { return ''; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const apikey = typeof parsed.apikey === 'string' ? parsed.apikey.trim() : '';
    if (!apikey || apikey === PLACEHOLDER || apikey.length > 500 || /[\r\n\u0000]/.test(apikey)) return '';
    return apikey;
  }

  function allowedUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch (err) { return false; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;
    if (parsed.hostname.toLowerCase().replace(/\.$/, '') !== HOST) return false;
    return parsed.pathname === '/api/';
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

  async function call(url) {
    if (!allowedUrl(url)) throw fail('domain');
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', redirect: 'manual', cache: 'no-store' });
    } catch (err) { throw fail('network'); }
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

  async function perform(apikey, text) {
    const url = 'https://' + HOST + '/api/?category=comment&type=write&apikey='
      + encodeURIComponent(apikey) + '&comment=' + encodeURIComponent(text);
    const body = await call(url);
    let json;
    try { json = JSON.parse(body); } catch (err) { throw fail('bad-response'); }
    if (!json || json.success !== 1) throw fail('http');
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
    const apikey = apikeyOf(await readRaw(SECRET));
    if (!apikey) {
      note(false, false);
      log('fail');
      return { ok: false, error: 'no-credentials' };
    }
    if (!takeSlot()) {
      log('fail');
      return { ok: false, error: 'rate-limit' };
    }
    try {
      await perform(apikey, input.text);
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
    health() { return { ok: true, detail: 'sink-kukulu' }; },
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

const singleton = createSinkKukulu();
singleton.createSinkKukulu = createSinkKukulu;
module.exports = singleton;
