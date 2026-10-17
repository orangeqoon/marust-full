'use strict';

/**
 * ツイキャス（stream.site@1）。
 * テロップは apiv2.twitcasting.tv、メイン題名は twitcasting.tv。リダイレクトは追わない。
 * Cookie は cookies.twitcasting-main。access_token は twitcasting.config。
 * csrf と画面の user_id は capture.twitcasting-main.page。金庫へは書き戻さない。
 * legacy は秘密を読まず通信しない。shadow と dryRun も通信しない。
 */

const API_HOST = 'apiv2.twitcasting.tv';
const WEB_HOST = 'twitcasting.tv';
const HOSTS = new Set([API_HOST, WEB_HOST]);
const COOKIE_NAME = 'cookies.twitcasting-main';
const CONFIG_NAME = 'twitcasting.config';
const PAGE_NAME = 'capture.twitcasting-main.page';
const MAX_BODY = 1024 * 1024;
const MAX_SECRET = 64 * 1024;
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]{1,128}$/;

function createSiteTwitcasting(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };

  let ctx = null;
  let chain = Promise.resolve();
  const last = { result: '', at: '', live: null, title: '' };

  function fail(code) {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  function modeOf(box) {
    if (!box || typeof box.mode !== 'function') return 'legacy';
    try {
      const value = box.mode();
      if (value === 'live' || value === 'shadow' || value === 'legacy') return value;
    } catch (err) { /* 不明なモードは legacy */ }
    return 'legacy';
  }

  function log(code) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    if (!CODE_RE.test(code)) return;
    try { ctx.logger('info', code); } catch (err) { /* ログで本処理を止めない */ }
  }

  function nowIso() {
    try {
      const value = nowFn();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    } catch (err) { /* 時計が壊れていても更新結果は残す */ }
    return new Date().toISOString();
  }

  function clip(value) {
    const text = typeof value === 'string' ? value : '';
    return text.length > 200 ? text.slice(0, 200) : text;
  }

  function note(ok, title, live) {
    last.result = ok ? 'ok' : 'ng';
    last.at = nowIso();
    if (ok) last.title = clip(title);
    if (live === true || live === false) last.live = live;
  }

  function safeId(value) {
    const text = typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : (typeof value === 'string' ? value : '');
    return ID_RE.test(text) ? text : '';
  }

  function safeToken(value) {
    return typeof value === 'string' && TOKEN_RE.test(value) ? value : '';
  }

  async function readRaw(box, name) {
    if (!box || !box.secrets || typeof box.secrets.get !== 'function') return '';
    let result;
    try { result = await box.secrets.get(name); } catch (err) { return ''; }
    if (!result || result.ok !== true || typeof result.value !== 'string') return '';
    if (!result.value || result.value.length > MAX_SECRET || result.value.indexOf('\u0000') !== -1) return '';
    return result.value;
  }

  function parseObject(text) {
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function cookieBag(text) {
    const parsed = parseObject(text);
    if (!parsed) return { cookies: Object.create(null), csrf: '', userId: '' };
    const wrapped = parsed.cookies && typeof parsed.cookies === 'object' && !Array.isArray(parsed.cookies);
    const source = wrapped ? parsed.cookies : parsed;
    const cookies = Object.create(null);
    const keys = Object.keys(source);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (!COOKIE_NAME_RE.test(key)) continue;
      const value = source[key];
      if (typeof value !== 'string' || !value || /[\r\n\u0000;]/.test(value)) continue;
      cookies[key] = value;
    }
    const csrf = wrapped ? safeToken(parsed.csrf_token) : '';
    const userId = wrapped ? safeId(parsed.user_id) : '';
    return { cookies: cookies, csrf: csrf, userId: userId };
  }

  function pageFields(text) {
    const parsed = parseObject(text);
    if (!parsed) return { csrf: '', userId: '' };
    return { csrf: safeToken(parsed.csrf_token), userId: safeId(parsed.user_id) };
  }

  function accessToken(text) {
    const parsed = parseObject(text);
    if (!parsed) return '';
    return safeToken(parsed.access_token);
  }

  async function loadAuth(box) {
    const bag = cookieBag(await readRaw(box, COOKIE_NAME));
    const token = accessToken(await readRaw(box, CONFIG_NAME));
    const page = pageFields(await readRaw(box, PAGE_NAME));
    const names = Object.keys(bag.cookies);
    const csrf = page.csrf || bag.csrf || safeToken(bag.cookies.tc_token) || '';
    const userId = page.userId || bag.userId;
    return {
      configured: names.length > 0 && !!token,
      cookies: bag.cookies,
      token: token,
      csrf: csrf,
      userId: userId
    };
  }

  function allowedUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch (err) { return false; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return HOSTS.has(host);
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

  function parseJson(text, required) {
    if (!text) return null;
    let data;
    try { data = JSON.parse(text); } catch (err) { throw fail('bad-response'); }
    if (!required) return data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('bad-response');
    return data;
  }

  async function call(url, init) {
    if (!allowedUrl(url)) throw fail('domain');
    const options = Object.assign({ cache: 'no-store' }, init || {});
    options.redirect = 'manual';
    let res;
    try {
      res = await fetchImpl(url, options);
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
    if (status === 401 || status === 403) throw fail('unauthorized'); // L9b: ログイン切れ
    if (status < 200 || status >= 300) {
      const bad = fail('http');
      // 原因の切り分け用（秘密ではない）: HTTP ステータスと、呼び先のホストの先頭ラベル。
      bad.status = status;
      bad.method = String((init && init.method) || 'get').toLowerCase().replace(/[^a-z]/g, '').slice(0, 8);
      try { bad.host = new URL(url).hostname.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20); } catch (e) { bad.host = ''; }
      throw bad;
    }
    return text;
  }

  function cookieHeader(cookies) {
    const parts = [];
    const keys = Object.keys(cookies);
    for (let i = 0; i < keys.length; i += 1) parts.push(keys[i] + '=' + cookies[keys[i]]);
    return parts.join('; ');
  }

  async function postSubtitle(token, title) {
    const text = await call('https://apiv2.twitcasting.tv/movies/subtitle', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-Api-Version': '2.0',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ subtitle: title })
    });
    parseJson(text, false);
  }

  async function verify(token) {
    const text = await call('https://apiv2.twitcasting.tv/verify_credentials', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Api-Version': '2.0',
        Authorization: 'Bearer ' + token
      }
    });
    const data = parseJson(text, true);
    if (!data.user || typeof data.user !== 'object' || Array.isArray(data.user)) throw fail('bad-response');
    return data.user;
  }

  async function postMain(movieId, userId, title, auth) {
    const body = new URLSearchParams({ title: title }).toString();
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(auth.cookies),
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://twitcasting.tv/' + userId,
      Origin: 'https://twitcasting.tv',
      'User-Agent': WEB_UA
    };
    if (auth.csrf) headers['X-TC-Token'] = auth.csrf;
    await call('https://twitcasting.tv/api/v1/movies/' + movieId, {
      method: 'POST',
      headers: headers,
      body: body
    });
  }

  async function perform(auth, title) {
    try {
      await postSubtitle(auth.token, title);
    } catch (err) {
      // ライブ中の枠が無いと、テロップの API は 404 を返す（2026-10-06 実測）。枠なしとして扱う。
      if (err && err.code === 'http' && err.status === 404) throw fail('not-live');
      throw err;
    }
    const user = await verify(auth.token);
    const movieId = safeId(user.last_movie_id);
    if (!movieId) throw fail('not-live');
    const userId = safeId(user.screen_id) || safeId(user.id) || auth.userId;
    if (!userId) throw fail('bad-response');
    await postMain(movieId, userId, title, auth);
  }

  async function runUpdate(input, meta) {
    const mode = modeOf(ctx);
    if (mode === 'legacy') {
      log('legacy');
      return { ok: false, error: 'legacy' };
    }
    const title = input && typeof input.title === 'string' ? input.title : '';
    if (title.trim() === '') {
      log('needs-title');
      return { ok: false, error: 'needs-title' };
    }
    const auth = await loadAuth(ctx);
    if (!auth.configured) {
      log('unset');
      return { ok: false, error: 'not-configured' };
    }
    if (mode === 'shadow' || (meta && meta.dryRun === true)) {
      log('dry-run');
      return { ok: true, dryRun: true };
    }
    try {
      await perform(auth, title);
      note(true, title, true);
      log('updated');
      return { ok: true };
    } catch (err) {
      const code = err && CODE_RE.test(err.code) ? err.code : 'http';
      note(false, '', code === 'not-live' ? false : null);
      log('failed' + (err && Number.isInteger(err.status) ? '-' + err.status + (err.host ? '-' + err.host : '') + (err.method ? '-' + err.method : '') : ''));
      return { ok: false, error: code };
    }
  }

  function enqueue(work) {
    const job = chain.then(work, work);
    chain = job.then(() => {}, () => {});
    return job;
  }

  async function isConfigured() {
    if (modeOf(ctx) === 'legacy') return false;
    const auth = await loadAuth(ctx);
    return auth.configured === true;
  }

  async function getStatus(params, passed) {
    const box = passed || ctx;
    let configured = false;
    if (modeOf(box) !== 'legacy') {
      try {
        const auth = await loadAuth(box);
        configured = auth.configured === true;
      } catch (err) {
        configured = false;
      }
    }
    return {
      ok: true,
      configured: configured,
      result: last.result,
      at: last.at,
      live: last.live,
      title: last.title,
      category: ''
    };
  }

  function updateMetadata(input, meta) {
    return enqueue(() => runUpdate(input, meta));
  }

  function updateTitle(title, meta) {
    const category = meta && typeof meta.category === 'string' ? meta.category : '';
    return updateMetadata({ title: title, category: category }, meta);
  }

  return {
    load(passed) { ctx = passed || null; },
    start() {},
    stop() {},
    destroy() { ctx = null; },
    onEvent() {},
    health() { return { ok: true, detail: 'site-twitcasting' }; },
    isConfigured: isConfigured,
    getStatus: getStatus,
    updateMetadata: updateMetadata,
    updateTitle: updateTitle,
    actions: { getStatus: getStatus }
  };
}

const singleton = createSiteTwitcasting();
singleton.createSiteTwitcasting = createSiteTwitcasting;
module.exports = singleton;
