'use strict';

const MAX_BODY = 1024 * 1024;
const MAX_SECRET = 64 * 1024;
const MAX_TEXT = 200;
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * ツイキャスへのコメント送信（chat.sink@1）。
 * MultiCommenter と同じく apiv2.twitcasting.tv だけ。
 * 配信 id は GET /verify_credentials の user.is_live と user.last_movie_id。
 * 送信は POST /movies/<id>/comments 。本文は comment、sns は none。
 * 認証は twitcasting.config の access_token（無ければ token）。Cookie と capture は使わない。
 * リダイレクトは追わない。本文とトークンはログに出さない。
 */

const HOST = 'apiv2.twitcasting.tv';
const SITE = 'twitcasting';
const CONFIG_NAME = 'twitcasting.config';
const TOKEN_RE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const MOVIE_RE = /^[0-9]{1,20}$/;
const UA = 'MultiCommenter/1.0';

function createSinkTwitcasting(deps) {
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
    } catch (err) { /* 時計が壊れていても送信判定は続ける */ }
    return Date.now();
  }

  function log(kind) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    const message = kind === 'ok' ? 'ok 1' : 'fail 1';
    try { ctx.logger('info', message); } catch (err) { /* ログで送信を止めない */ }
  }

  function modeOf() {
    if (!ctx || typeof ctx.mode !== 'function') return 'legacy';
    try {
      const value = ctx.mode();
      if (value === 'live' || value === 'shadow' || value === 'legacy') return value;
    } catch (err) { /* 不明なモードは legacy */ }
    return 'legacy';
  }

  function chars(text) {
    return Array.from(text).length;
  }

  function textError(text) {
    if (typeof text !== 'string' || chars(text) < 1) return 'empty';
    if (chars(text) > MAX_TEXT) return 'too-long';
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

  function tokenOf(text) {
    if (!text) return '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) { return ''; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const primary = typeof parsed.access_token === 'string' ? parsed.access_token : '';
    const alternate = typeof parsed.token === 'string' ? parsed.token : '';
    const token = TOKEN_RE.test(primary) ? primary : alternate;
    return TOKEN_RE.test(token) ? token : '';
  }

  function allowedUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch (err) { return false; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return host === HOST;
  }

  async function discard(res) {
    try {
      if (res && res.body && typeof res.body.cancel === 'function') {
        await res.body.cancel();
        return;
      }
    } catch (err) { /* 本文は使わない */ }
    try {
      if (res && typeof res.text === 'function') await res.text();
    } catch (err) { /* 本文は使わない */ }
  }

  async function readText(res) {
    let text = '';
    try {
      if (res && typeof res.text === 'function') text = await res.text();
    } catch (err) {
      throw fail('http');
    }
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
    try {
      res = await fetchImpl(url, request);
    } catch (err) {
      throw fail('network');
    }
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

  function movieIdOf(user) {
    const raw = user.last_movie_id;
    const text = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : (typeof raw === 'string' ? raw : '');
    return MOVIE_RE.test(text) ? text : '';
  }

  async function perform(token, text) {
    const verifyText = await call('https://' + HOST + '/verify_credentials', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Api-Version': '2.0',
        Authorization: 'Bearer ' + token,
        'User-Agent': UA
      }
    });
    let verify;
    try { verify = JSON.parse(verifyText); } catch (err) { throw fail('bad-response'); }
    const user = verify && verify.user && typeof verify.user === 'object' ? verify.user : null;
    if (!user || !user.is_live) throw fail('not-live');
    const movieId = movieIdOf(user);
    if (!movieId) throw fail('not-live');
    const body = JSON.stringify({ comment: text, sns: 'none' });
    await call('https://' + HOST + '/movies/' + movieId + '/comments', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-Api-Version': '2.0',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': UA
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
    const site = input && input.site;
    if (site !== SITE) {
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
    const token = tokenOf(await readRaw(CONFIG_NAME));
    if (!token) {
      note(false, false);
      log('fail');
      return { ok: false, error: 'no-credentials' };
    }
    if (!takeSlot()) {
      log('fail');
      return { ok: false, error: 'rate-limit' };
    }
    try {
      await perform(token, input.text);
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

  async function getStatus() {
    return { ok: true, configured: last.configured, result: last.result, at: last.at };
  }

  return {
    load(passed) { ctx = passed || null; },
    start() {},
    stop() {},
    destroy() { ctx = null; },
    health() { return { ok: true, detail: 'sink-twitcasting' }; },
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
  const request = Object.assign({}, init || {}, { redirect: 'manual' });
  return globalThis.fetch(url, request);
}

const singleton = createSinkTwitcasting();
singleton.createSinkTwitcasting = createSinkTwitcasting;
module.exports = singleton;
