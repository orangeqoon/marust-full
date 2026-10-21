'use strict';

/**
 * ニコ生（stream.site@1）。
 * 番組の取得と題名の更新は live2.nicovideo.jp だけ。リダイレクトは追わない。
 * セッションは cookies.niconico-main の user_session。金庫へは書き戻さない。
 * legacy は秘密を読まず通信しない。shadow と dryRun も通信しない。
 */

const HOST = 'live2.nicovideo.jp';
const HOSTS = new Set([HOST]);
const COOKIE_NAME = 'cookies.niconico-main';
const MAX_BODY = 1024 * 1024;
const MAX_SECRET = 64 * 1024;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_RE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]{1,128}$/;

function createSiteNiconico(deps) {
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

  async function readRaw(box, name) {
    if (!box || !box.secrets || typeof box.secrets.get !== 'function') return '';
    let result;
    try { result = await box.secrets.get(name); } catch (err) { return ''; }
    if (!result || result.ok !== true || typeof result.value !== 'string') return '';
    if (!result.value || result.value.length > MAX_SECRET || result.value.indexOf('\u0000') !== -1) return '';
    return result.value;
  }

  function sessionOf(text) {
    if (!text) return '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) { return ''; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const source = parsed.cookies && typeof parsed.cookies === 'object' && !Array.isArray(parsed.cookies)
      ? parsed.cookies
      : parsed;
    const keys = Object.keys(source);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!COOKIE_NAME_RE.test(key)) continue;
      const value = source[key];
      if (key === 'user_session' && typeof value === 'string' && SESSION_RE.test(value)) return value;
    }
    return '';
  }

  async function loadAuth(box) {
    const session = sessionOf(await readRaw(box, COOKIE_NAME));
    return { configured: !!session, session: session };
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

  function parseJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (err) { throw fail('bad-response'); }
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

  function headers(session, json) {
    const out = {
      Accept: 'application/json',
      'X-niconico-session': session,
      'User-Agent': 'Mozilla/5.0'
    };
    if (json) out['Content-Type'] = 'application/json';
    return out;
  }

  async function perform(session, title) {
    const latestText = await call('https://live2.nicovideo.jp/unama/api/v2/programs/latest', {
      method: 'GET',
      headers: headers(session, false)
    });
    const latest = parseJson(latestText);
    const programId = safeId(latest && latest.data && latest.data.id);
    if (!programId) throw fail('not-live');
    await call('https://live2.nicovideo.jp/unama/api/v2/programs/' + programId, {
      method: 'PATCH',
      headers: headers(session, true),
      body: JSON.stringify({ title: title })
    });
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
      await perform(auth.session, title);
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

  // 足りない物を種類だけで答える（値は返さない）。isConfigured はこれの ready と同じ答え
  async function loginNeeds() {
    if (modeOf(ctx) === 'legacy') return { ready: false, need: 'mode', how: 'toggle' }; // 送信オフ。ログインの不足ではない
    const auth = await loadAuth(ctx);
    if (!auth.configured) return { ready: false, need: 'cookies', how: 'extension' };
    return { ready: true, need: null, how: 'extension' };
  }

  async function isConfigured() {
    return (await loginNeeds()).ready;
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
    health() { return { ok: true, detail: 'site-niconico' }; },
    isConfigured: isConfigured,
    loginNeeds: loginNeeds,
    getStatus: getStatus,
    updateMetadata: updateMetadata,
    updateTitle: updateTitle,
    actions: { getStatus: getStatus }
  };
}

const singleton = createSiteNiconico();
singleton.createSiteNiconico = createSiteNiconico;
module.exports = singleton;
