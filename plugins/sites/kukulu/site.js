'use strict';

/**
 * ククルの題名更新（stream.site@1）。
 * 送るのは port_modify だけ。睡眠タイトルでの枠返上と、枠の取得・開始は移植していない。
 * 秘密は ctx.secrets の kukulu.config。ファイルは読まない。金庫へは書き戻さない。
 * 宛先は https://live.erinn.biz だけ。リダイレクトは追わない。
 */


const SECRET = 'kukulu.config';
const PLACEHOLDER = 'YOUR_KUKULU_APIKEY_HERE';
const ORIGIN = 'https://live.erinn.biz';
const MAX_SECRET = 262144;

function createSiteKukulu(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };

  let ctx = null;
  let lastResult = 'none';
  let lastAt = '';
  let seenTitle = '';

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

  function parseConfig(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_SECRET) return null;
    let data;
    try {
      data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (err) {
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const apikey = typeof data.apikey === 'string' ? data.apikey.trim() : '';
    if (!apikey || apikey === PLACEHOLDER || apikey.length > 500 || /[\r\n\u0000]/.test(apikey)) return null;
    return { apikey: apikey };
  }

  async function readConfig() {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return null;
    let result;
    try {
      result = await ctx.secrets.get(SECRET);
    } catch (err) {
      return null;
    }
    if (!result || result.ok !== true || typeof result.value !== 'string') return null;
    return parseConfig(result.value);
  }

  function allowed(host) {
    return host === 'live.erinn.biz';
  }

  async function call(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return { error: 'network' };
    }
    const host = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowed(host)) {
      return { error: 'network' };
    }
    const init = { method: 'GET', redirect: 'manual', cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(15000);
    }
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      return { error: 'network' };
    }
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (res && res.type === 'opaqueredirect') return { error: 'redirect', status: status };
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      return { error: 'redirect', status: status };
    }
    let text = '';
    try {
      if (res && typeof res.text === 'function') text = await res.text();
    } catch (err) {
      text = '';
    }
    if (typeof text !== 'string' || text.length > 1048576) return { error: 'network', status: status };
    return { status: status, text: text };
  }

  async function isConfigured() {
    const config = await readConfig();
    return !!config;
  }

  async function updateMetadata(input, meta) {
    const stop = held(meta);
    if (stop) return stop;
    const title = input && input.title != null ? String(input.title) : '';
    if (!title) return fail('needs-title');
    const config = await readConfig();
    if (!config) {
      note(false);
      say('warn', 'failed not-configured');
      return fail('not-configured');
    }
    const url = ORIGIN + '/api/?category=mylive&type=port_modify&apikey='
      + encodeURIComponent(config.apikey)
      + '&title=' + encodeURIComponent(title)
      + '&description=' + encodeURIComponent('');
    const res = await call(url);
    if (res.error) {
      note(false);
      say('warn', 'failed ' + res.error);
      return fail(res.error);
    }
    if (res.status === 401 || res.status === 403) {
      note(false);
      say('warn', 'failed unauthorized');
      return fail('unauthorized'); // L9b: ログイン切れ
    }
    if (res.status !== 200) {
      note(false);
      say('warn', 'failed http');
      return fail('http');
    }
    let body = null;
    try {
      body = JSON.parse(res.text);
    } catch (err) {
      body = null;
    }
    if (!body || body.success !== 1) {
      note(false);
      say('warn', 'failed bad-response');
      return fail('bad-response');
    }
    seenTitle = title;
    note(true);
    say('info', 'updated');
    return { ok: true };
  }

  function getStatus() {
    const out = {};
    if (seenTitle) out.title = seenTitle;
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
    lastResult = 'none';
    lastAt = '';
  }

  function health() {
    return { ok: true, detail: 'site-kukulu' };
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

const singleton = createSiteKukulu();
singleton.createSiteKukulu = createSiteKukulu;
module.exports = singleton;
