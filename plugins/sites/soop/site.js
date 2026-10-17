'use strict';

/**
 * SOOP の題名更新（stream.site@1）。
 * Cookie は cookies.soop-main。題名保存の本文は capture.soop-main.soop-save。
 * 成功してもファイルにも金庫にも書き戻さない。毎回 capture を土台に題名だけ載せる。
 * 宛先は sooplive.com / sooplive.co.kr（soop.io は不可）。リダイレクトは追わない。
 */

const qs = require('querystring');

const COOKIE = 'cookies.soop-main';
const CAPTURE = 'capture.soop-main.soop-save';
const DEFAULT_URL = 'https://api-broadcast.sooplive.com/broad/setting';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_SECRET = 262144;

// L9b: 転送先（Location）。本物の fetch は headers.get、試験の偽の返事は普通のオブジェクト
function locationOf(res) {
  try {
    const h = res && res.headers;
    if (!h) return '';
    if (typeof h.get === 'function') return String(h.get('location') || '');
    return String(h.location || h.Location || '');
  } catch (_) { return ''; }
}

function createSiteSoop(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };

  let ctx = null;
  let lastResult = 'none';
  let lastAt = '';
  let seenTitle = '';
  let seenCategory = '';

  function nowIso() {
    try {
      const value = nowFn();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    } catch (err) { /* 時計が壊れても更新自体は続ける */ }
    return new Date().toISOString();
  }

  function say(level, message) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    ctx.logger(level, typeof ctx.redact === 'function' ? ctx.redact(message) : message);
  }

  function note(ok) {
    lastResult = ok ? 'ok' : 'ng';
    lastAt = nowIso();
  }

  function fail(code) {
    return { ok: false, error: code };
  }

  function modeOf() {
    try {
      const mode = ctx && typeof ctx.mode === 'function' ? ctx.mode() : 'legacy';
      if (mode === 'live' || mode === 'shadow' || mode === 'legacy') return mode;
    } catch (err) { /* モードが取れなければ外に出ない */ }
    return 'legacy';
  }

  function held(meta) {
    if (meta && meta.dryRun === true) return { ok: true, dryRun: true };
    const mode = modeOf();
    if (mode === 'shadow') return { ok: true, dryRun: true };
    if (mode !== 'live') return { ok: true };
    return null;
  }

  function parseJson(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_SECRET) return null;
    try {
      return JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (err) {
      return null;
    }
  }

  function allStringValues(obj) {
    const names = Object.keys(obj);
    if (!names.length) return false;
    for (let i = 0; i < names.length; i += 1) {
      if (typeof obj[names[i]] !== 'string') return false;
    }
    return true;
  }

  function cookieHeader(raw) {
    if (typeof raw !== 'string') return '';
    const text = raw.trim();
    if (!text || text.length > MAX_SECRET) return '';
    if (/[\r\n\u0000]/.test(text) && text.charAt(0) !== '{' && text.charAt(0) !== '[') return '';
    const data = parseJson(text);
    if (data == null) {
      if (text.indexOf('=') === -1 || /[\r\n\u0000]/.test(text)) return '';
      return text;
    }
    if (typeof data === 'string') {
      if (!data || data.indexOf('=') === -1 || /[\r\n\u0000]/.test(data)) return '';
      return data;
    }
    if (typeof data !== 'object' || Array.isArray(data)) return '';
    if (typeof data.cookieString === 'string' && data.cookieString.trim()) {
      const value = data.cookieString.trim();
      if (/[\r\n\u0000]/.test(value)) return '';
      return value;
    }
    if (typeof data.cookies === 'string' && data.cookies.trim()) {
      const value = data.cookies.trim();
      if (/[\r\n\u0000]/.test(value)) return '';
      return value;
    }
    let map = null;
    if (data.cookies && typeof data.cookies === 'object' && !Array.isArray(data.cookies)) map = data.cookies;
    else if (data.cookieObj && typeof data.cookieObj === 'object' && !Array.isArray(data.cookieObj)) map = data.cookieObj;
    else if (allStringValues(data)) map = data;
    if (!map) return '';
    const parts = [];
    const names = Object.keys(map);
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const value = map[name];
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      if (!name || name.length > 256 || /[\r\n\u0000;=]/.test(name) || /[\r\n\u0000]/.test(value)) continue;
      parts.push(name + '=' + value);
    }
    return parts.join('; ');
  }

  function formObject(value) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).length ? value : null;
    }
    if (typeof value !== 'string' || value.indexOf('=') === -1) return null;
    const params = new URLSearchParams(value);
    const out = {};
    for (const pair of params) out[pair[0]] = pair[1];
    return Object.keys(out).length ? out : null;
  }

  function soopHost(host) {
    if (host === 'soop.io' || host.endsWith('.soop.io')) return false;
    return host === 'sooplive.com' || host.endsWith('.sooplive.com')
      || host === 'sooplive.co.kr' || host.endsWith('.sooplive.co.kr');
  }

  function parseCapture(raw) {
    const data = parseJson(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.enabled === false) return null;
    const body = formObject(data.raw_body) || formObject(data.body);
    if (!body) return null;
    const url = typeof data.url === 'string' && data.url.trim() ? data.url.trim() : DEFAULT_URL;
    return { url: url, body: body };
  }

  async function readSecret(name) {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return '';
    let result;
    try {
      result = await ctx.secrets.get(name);
    } catch (err) {
      return '';
    }
    if (!result || result.ok !== true || typeof result.value !== 'string') return '';
    return result.value;
  }

  function buildFormBody(fields) {
    const out = {};
    const names = Object.keys(fields);
    for (let i = 0; i < names.length; i += 1) {
      const key = names[i];
      const value = fields[key];
      if (value === undefined || value === null) continue;
      out[key] = String(value);
    }
    return qs.stringify(out);
  }

  async function call(url, init) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return { error: 'network' };
    }
    const host = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !soopHost(host)) {
      return { error: 'network' };
    }
    const options = Object.assign({ redirect: 'manual', cache: 'no-store' }, init || {});
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(15000);
    }
    let res;
    try {
      res = await fetchImpl(url, options);
    } catch (err) {
      return { error: 'network' };
    }
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (res && res.type === 'opaqueredirect') return { error: 'redirect', status: status };
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      // L9b: ログイン画面への転送はログイン切れ（Location に login を含む）
      const place = locationOf(res);
      return { error: /login/i.test(place) ? 'unauthorized' : 'redirect', status: status };
    }
    if (status === 401 || status === 403) return { error: 'unauthorized', status: status };
    let text = '';
    try {
      if (res && typeof res.text === 'function') text = await res.text();
    } catch (err) {
      text = '';
    }
    if (typeof text !== 'string' || text.length > 1048576) return { error: 'network', status: status };
    return { status: status, text: text };
  }

  function accepted(status, text) {
    if (status < 200 || status >= 300) return false;
    try {
      const parsed = JSON.parse(text);
      if (parsed && (parsed.result === 0 || parsed.result === false || parsed.result_code === 0 || parsed.success === false)) {
        return false;
      }
    } catch (err) { /* JSON でなければ 2xx を成功とみなす */ }
    return true;
  }

  async function isConfigured() {
    const header = cookieHeader(await readSecret(COOKIE));
    const template = parseCapture(await readSecret(CAPTURE));
    return !!(header && template);
  }

  async function updateMetadata(input, meta) {
    const stop = held(meta);
    if (stop) return stop;
    const title = input && input.title != null ? String(input.title) : '';
    if (!title) return fail('needs-title');
    const header = cookieHeader(await readSecret(COOKIE));
    const template = parseCapture(await readSecret(CAPTURE));
    if (!header || !template) {
      note(false);
      say('warn', 'failed not-configured');
      return fail('not-configured');
    }
    const body = Object.assign({}, template.body);
    body.title = title;
    const category = input && input.category != null ? String(input.category).trim() : '';
    if (/^\d+$/.test(category)) body.category_no = category;
    const postData = buildFormBody(body);
    const res = await call(template.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://dashboard.sooplive.com',
        Referer: 'https://dashboard.sooplive.com/',
        'User-Agent': UA,
        Cookie: header
      },
      body: postData
    });
    if (res.error) {
      note(false);
      say('warn', 'failed ' + res.error);
      return fail(res.error === 'redirect' || res.error === 'unauthorized' ? res.error : 'network');
    }
    if (!accepted(res.status, res.text)) {
      note(false);
      say('warn', 'failed bad-response');
      return fail(res.status >= 200 && res.status < 300 ? 'bad-response' : 'http');
    }
    seenTitle = title;
    seenCategory = /^\d+$/.test(category) ? category : '';
    note(true);
    say('info', 'updated');
    return { ok: true };
  }

  function getStatus() {
    const out = {};
    if (seenTitle) out.title = seenTitle;
    if (seenCategory) out.category = seenCategory;
    return out;
  }

  async function panelStatus(params, passed) {
    const box = passed || ctx;
    const previous = ctx;
    ctx = box || null;
    try {
      const configured = await isConfigured();
      return {
        ok: true,
        configured: configured,
        lastResult: lastResult,
        lastAt: lastAt,
        mode: modeOf()
      };
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    } finally {
      ctx = previous;
    }
  }

  function load(passed) {
    ctx = passed || null;
  }

  function start() {}

  function stop() {}

  function destroy() {
    ctx = null;
    seenTitle = '';
    seenCategory = '';
    lastResult = 'none';
    lastAt = '';
  }

  function health() {
    return { ok: true, detail: 'site-soop' };
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

const singleton = createSiteSoop();
singleton.createSiteSoop = createSiteSoop;
module.exports = singleton;
