'use strict';

/**
 * Picarto の題名更新（stream.site@1）。
 * POST https://api.picarto.tv/api/v1/user/title 。秘密は picarto.config の token。
 * ファイル（わんコメの設定を含む）は読まない。リダイレクトは追わない。
 */


const SECRET = 'picarto.config';
const ORIGIN = 'https://api.picarto.tv';
const PATH = '/api/v1/user/title';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MAX_SECRET = 262144;

function createSitePicarto(deps) {
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
    const token = typeof data.token === 'string' ? data.token.trim() : '';
    if (!token || token.indexOf('ここに') !== -1 || token.length > 2000 || /[\r\n\u0000]/.test(token)) return null;
    return { token: token };
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

  async function call(url, init) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return { error: 'network' };
    }
    const host = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || host !== 'api.picarto.tv') {
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

  // 足りない物を種類だけで答える（値は返さない）。isConfigured はこれの ready と同じ答え
  async function loginNeeds() {
    const config = await readConfig();
    return config ? { ready: true, need: null, how: 'paste' } : { ready: false, need: 'token', how: 'paste' };
  }

  async function isConfigured() {
    return (await loginNeeds()).ready;
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
    const body = new URLSearchParams({ title: title }).toString();
    const res = await call(ORIGIN + PATH, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.token,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
        'User-Agent': UA
      },
      body: body
    });
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
    if (res.status < 200 || res.status >= 300) {
      note(false);
      say('warn', 'failed http');
      return fail('http');
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

  // パネルの入力欄から Picarto のトークンを金庫に入れる（値は答えにも記録にも出さない）。今ある他の項目（channel など）は残す。
  async function setToken(params, passed) {
    const box = passed || ctx;
    const raw = params && typeof params.token === 'string' ? params.token.trim() : '';
    if (!raw || raw.length > 2000 || /[\r\n\u0000]/.test(raw) || raw.indexOf('ここに') !== -1) return { ok: false, error: 'bad-token' };
    if (!box || !box.secrets || typeof box.secrets.set !== 'function') return { ok: false, error: 'unavailable' };
    let base = {};
    try {
      const got = await box.secrets.get(SECRET);
      if (got && got.ok === true && typeof got.value === 'string') {
        const old = JSON.parse(got.value.replace(/^\uFEFF/, ''));
        if (old && typeof old === 'object' && !Array.isArray(old)) base = old;
      }
    } catch (_) { base = {}; }
    base.token = raw;
    try {
      const saved = await box.secrets.set(SECRET, JSON.stringify(base));
      if (!saved || saved.ok !== true) return { ok: false, error: 'unavailable' };
    } catch (_) { return { ok: false, error: 'unavailable' }; }
    return { ok: true };
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
    return { ok: true, detail: 'site-picarto' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    isConfigured: isConfigured,
    loginNeeds: loginNeeds,
    updateMetadata: updateMetadata,
    getStatus: getStatus,
    actions: { getStatus: panelStatus, setToken: setToken }
  };
}

const singleton = createSitePicarto();
singleton.createSitePicarto = createSitePicarto;
module.exports = singleton;
