'use strict';

/**
 * Rumble の題名更新（stream.site@1）。枠の確保は rumble-slot。
 * Cookie は cookies.rumble-main。編集先の sid / id / apiKey はページから検出するか、
 * capture.rumble-main.rumble-save と、このプロセスのメモリから取る。
 * Live Stream API の鍵は使わない。検出した apiKey はメモリにだけ残し、金庫へは書き戻さない。
 * 宛先は https://rumble.com と https://*.rumble.com。リダイレクトは追わない。
 */


const COOKIE = 'cookies.rumble-main';
const CAPTURE = 'capture.rumble-main.rumble-save';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const MAX_SECRET = 262144;
const DISCOVER_URLS = [
  'https://rumble.com/account/live-streaming',
  'https://rumble.com/account/content?type=all'
];

// L9b: 転送先（Location）。本物の fetch は headers.get、試験の偽の返事は普通のオブジェクト
function locationOf(res) {
  try {
    const h = res && res.headers;
    if (!h) return '';
    if (typeof h.get === 'function') return String(h.get('location') || '');
    return String(h.location || h.Location || '');
  } catch (_) { return ''; }
}

function createSiteRumble(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };

  let ctx = null;
  let lastResult = 'none';
  let lastAt = '';
  let seenTitle = '';
  let memory = null;

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
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || value.indexOf('=') === -1) return null;
    const params = new URLSearchParams(value);
    const out = {};
    for (const pair of params) out[pair[0]] = pair[1];
    return out;
  }

  function textField(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return '';
    if (/[\u0000]/.test(value)) return '';
    return value;
  }

  function idPart(value) {
    const text = textField(value).trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(text)) return '';
    return text;
  }

  function safeKey(value) {
    const text = textField(value).trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(text)) return '';
    return text;
  }

  function parseCapture(raw) {
    const data = parseJson(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const url = typeof data.url === 'string' ? data.url : '';
    const body = formObject(data.raw_body) || formObject(data.body) || {};
    const sid = (url.match(/[?&]sid=(\d+)/) || [])[1] || idPart(data.sid);
    const id = (url.match(/[?&]id=(\d+)/) || [])[1] || idPart(data.id) || idPart(body.id);
    let apiKey = (url.match(/[?&]apiKey=([a-fA-F0-9]+)/) || [])[1] || '';
    if (!apiKey) apiKey = safeKey(data.apiKey) || safeKey(body.apiKey);
    return {
      sid: sid,
      id: id,
      apiKey: apiKey,
      description: textField(body.description) || textField(data.description),
      tags: textField(body.tags) || textField(data.tags),
      visibility: textField(body.visibility).trim() || textField(data.visibility).trim() || 'public',
      channelId: textField(body.channelId) || textField(data.channelId),
      siteChannelId: textField(body.siteChannelId) || textField(data.siteChannelId),
      mediaChannelId: textField(body.mediaChannelId) || textField(data.mediaChannelId)
    };
  }

  function rumbleHost(host) {
    return host === 'rumble.com' || host.endsWith('.rumble.com');
  }

  async function call(url, init) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return { error: 'network' };
    }
    const host = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !rumbleHost(host)) {
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

  function parseDiscover(html) {
    if (typeof html !== 'string' || !html) return null;
    const api = html.match(/Account\(\s*["']AccountContent["']\s*,\s*["']([^"']+)["']\s*\)/);
    let apiKey = api ? safeKey(api[1]) : '';
    const item = html.match(/class="info-video"\s+id="(\d+)_(\d+)_([a-zA-Z0-9]+)_item"/)
      || html.match(/id="(\d+)_(\d+)_([a-zA-Z0-9]+)_item"/);
    if (!item) return null;
    const sid = item[1];
    const id = item[2];
    if (!apiKey) {
      const ak = html.match(new RegExp('id=["\']ak_' + sid + '_' + id + '["\'][^>]*>([^<]+)'));
      if (ak) apiKey = safeKey(ak[1].trim());
    }
    return { sid: sid, id: id, apiKey: apiKey };
  }

  async function discover(cookie) {
    let sawRedirect = false;
    let sawLogin = false;
    for (let i = 0; i < DISCOVER_URLS.length; i += 1) {
      const res = await call(DISCOVER_URLS[i], {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Cookie: cookie,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (res.error === 'unauthorized') sawLogin = true;
      if (res.error === 'redirect') {
        sawRedirect = true;
        continue;
      }
      if (res.error || res.status < 200 || res.status >= 300) continue;
      const found = parseDiscover(res.text);
      if (found) return { found: found, sawRedirect: sawRedirect, sawLogin: sawLogin };
    }
    return { found: null, sawRedirect: sawRedirect, sawLogin: sawLogin };
  }

  function parseForm(html) {
    const out = {};
    if (typeof html !== 'string' || !html) return out;
    const desc = html.match(/<textarea[^>]*name="description"[^>]*>([\s\S]*?)<\/textarea>/);
    if (desc && desc[1].trim()) out.description = desc[1];
    const tags = html.match(/<input[^>]*name="tags"[^>]*value="([^"]*)"/);
    if (tags && tags[1].trim()) out.tags = tags[1];
    return out;
  }

  function choose(primary, secondary, fallback) {
    if (typeof primary === 'string' && primary !== '') return primary;
    if (typeof secondary === 'string' && secondary !== '') return secondary;
    return fallback;
  }

  function targetFrom(found, captured) {
    const base = captured || {};
    const remembered = memory || {};
    if (found && found.id && found.apiKey) {
      return {
        sid: found.sid || '8',
        id: found.id,
        apiKey: found.apiKey,
        description: choose(base.description, remembered.description, ''),
        tags: choose(base.tags, remembered.tags, ''),
        visibility: choose(base.visibility, remembered.visibility, 'public'),
        channelId: choose(base.channelId, remembered.channelId, ''),
        siteChannelId: choose(base.siteChannelId, remembered.siteChannelId, '13'),
        mediaChannelId: choose(base.mediaChannelId, remembered.mediaChannelId, '0')
      };
    }
    const id = choose(remembered.id, base.id, '');
    const apiKey = choose(remembered.apiKey, base.apiKey, '');
    if (!id || !apiKey) return null;
    return {
      sid: choose(remembered.sid, base.sid, '8'),
      id: id,
      apiKey: apiKey,
      description: choose(remembered.description, base.description, ''),
      tags: choose(remembered.tags, base.tags, ''),
      visibility: choose(remembered.visibility, base.visibility, 'public'),
      channelId: choose(remembered.channelId, base.channelId, ''),
      siteChannelId: choose(remembered.siteChannelId, base.siteChannelId, '13'),
      mediaChannelId: choose(remembered.mediaChannelId, base.mediaChannelId, '0')
    };
  }

  function formBody(title, fields) {
    const params = new URLSearchParams();
    params.set('title', title);
    params.set('description', fields.description || '');
    params.set('visibility', fields.visibility || 'public');
    params.set('tags', fields.tags || 'drawing, art, reading');
    params.set('channelId', fields.channelId || '');
    params.set('siteChannelId', fields.siteChannelId || '13');
    params.set('mediaChannelId', fields.mediaChannelId || '0');
    params.set('closed_captions', '{"uploads": [], "removals": []}');
    params.set('priceCents', '');
    params.set('paywallPlaceholder', '');
    params.set('lsPlaceholder', '');
    params.set('license', '');
    return params.toString();
  }

  function saved(status, text) {
    if (status !== 200 || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    if (lower.indexOf('saved') !== -1 || lower.indexOf('success') !== -1) return true;
    return text.length > 0 && lower.indexOf('<html') === -1;
  }

  function saveHeaders(cookie) {
    return {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://rumble.com',
      Referer: 'https://rumble.com/account/live-streaming',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: '*/*',
      Cookie: cookie
    };
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

  async function isConfigured() {
    return !!cookieHeader(await readSecret(COOKIE));
  }

  async function updateMetadata(input, meta) {
    const stop = held(meta);
    if (stop) return stop;
    const title = input && input.title != null ? String(input.title) : '';
    if (!title) return fail('needs-title');
    const cookie = cookieHeader(await readSecret(COOKIE));
    if (!cookie) {
      note(false);
      say('warn', 'failed not-configured');
      return fail('not-configured');
    }
    const captured = parseCapture(await readSecret(CAPTURE));
    const looked = await discover(cookie);
    const target = targetFrom(looked.found, captured);
    if (!target) {
      note(false);
      const code = looked.sawLogin ? 'unauthorized' : (looked.sawRedirect ? 'redirect' : 'no-target');
      say('warn', 'failed ' + code);
      return fail(code);
    }
    const editUrl = 'https://rumble.com/account/content?a=edit&sid='
      + encodeURIComponent(target.sid)
      + '&id=' + encodeURIComponent(target.id)
      + '&apiKey=' + encodeURIComponent(target.apiKey);
    const headers = saveHeaders(cookie);
    const form = await call(editUrl, { method: 'POST', headers: headers, body: '' });
    if (form.error === 'redirect' || form.error === 'unauthorized') {
      note(false);
      say('warn', 'failed ' + form.error);
      return fail(form.error);
    }
    let description = target.description || '';
    let tags = target.tags || '';
    if (!form.error && form.status >= 200 && form.status < 300) {
      const parsed = parseForm(form.text);
      if (parsed.description) description = parsed.description;
      if (parsed.tags) tags = parsed.tags;
    }
    if (!tags) tags = 'drawing, art, reading';
    const save = await call(editUrl, {
      method: 'POST',
      headers: headers,
      body: formBody(title, {
        description: description,
        tags: tags,
        visibility: target.visibility,
        channelId: target.channelId,
        siteChannelId: target.siteChannelId,
        mediaChannelId: target.mediaChannelId
      })
    });
    if (save.error) {
      note(false);
      say('warn', 'failed ' + save.error);
      return fail(save.error === 'redirect' || save.error === 'unauthorized' ? save.error : 'network');
    }
    if (!saved(save.status, save.text)) {
      note(false);
      say('warn', 'failed bad-response');
      return fail(save.status === 200 ? 'bad-response' : 'http');
    }
    memory = {
      sid: target.sid,
      id: target.id,
      apiKey: target.apiKey,
      description: description,
      tags: tags,
      visibility: target.visibility || 'public',
      channelId: target.channelId || '',
      siteChannelId: target.siteChannelId || '13',
      mediaChannelId: target.mediaChannelId || '0'
    };
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
    memory = null;
    seenTitle = '';
    lastResult = 'none';
    lastAt = '';
  }

  function health() {
    return { ok: true, detail: 'site-rumble' };
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

const singleton = createSiteRumble();
singleton.createSiteRumble = createSiteRumble;
module.exports = singleton;
