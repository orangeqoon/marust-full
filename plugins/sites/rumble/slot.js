'use strict';

/**
 * Rumble の配信枠（stream.slot@1）。
 * legacy は何もしない。shadow と meta.dryRun は外に出さない。
 * live だけが fetch する。宛先は https の rumble.com と *.rumble.com だけ。
 * 秘密は ctx.secrets だけ。ファイルは探さない。URL はログに出さない。
 */

const fs = require('fs');
const path = require('path');

const SECRET_API = 'rumble.livestream-api';
const SECRET_COOKIES = 'cookies.rumble-main';
const GET_DATA_URL = 'https://rumble.com/-livestream-api/get-data';
const CLAIM_URL = 'https://rumble.com/service.php?name=live_video.slots.claim';
const UPLOAD_PATH = '/upload.php?api=1.3&form=1&json=1';
const FALLBACK_UPLOAD = 'https://web27.rumble.com' + UPLOAD_PATH;
const UA = 'marust-rumble-slot/0.1';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const POLL_INTERVAL_MS = 5000;
const POLL_DEADLINE_MS = 30000;
const MAX_POLLS = 8;
const MAX_SECRET = 20000;
const MAX_BODY = 1024 * 1024;
const ERRORS = new Set(['no-credentials', 'busy', 'slots-exhausted', 'network', 'timeout']);

const DEFAULTS = {
  description: '',
  tags: '',
  categoryId: 13,
  defaultTitle: 'Live'
};

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function codeOf(err) {
  const code = err && err.code;
  if (ERRORS.has(code)) return code;
  return 'network';
}

function failure(code) {
  return { ok: false, error: ERRORS.has(code) ? code : 'network' };
}

function clip(value, max) {
  return Array.from(value == null ? '' : String(value)).slice(0, max).join('');
}

function slotsExhausted(text) {
  return /all your streaming slots are being used/i.test(text || '');
}

function rumbleHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  return host === 'rumble.com' || host.endsWith('.rumble.com');
}

function assertRumbleUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw fail('network');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !rumbleHost(parsed.hostname)) {
    throw fail('network');
  }
}

function uploadUrl(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.indexOf('https://') !== 0) return FALLBACK_UPLOAD;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (err) {
    return FALLBACK_UPLOAD;
  }
  if (parsed.username || parsed.password || !rumbleHost(parsed.hostname)) return FALLBACK_UPLOAD;
  return parsed.origin + UPLOAD_PATH;
}

function cleanNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = typeof src.defaultTitle === 'string' ? src.defaultTitle.trim() : '';
  const description = typeof src.description === 'string' ? src.description : '';
  const tags = typeof src.tags === 'string' ? src.tags : '';
  return {
    description: clip(description, 4000),
    tags: clip(tags.replace(/[\r\n]/g, ' '), 500),
    categoryId: cleanNumber(src.categoryId, DEFAULTS.categoryId, 1, 999999),
    defaultTitle: title ? clip(title, 200) : DEFAULTS.defaultTitle
  };
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 65536) return null;
    const data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function stripControls(value) {
  return String(value == null ? '' : value).replace(/[\u0000\r\n]/g, '');
}

function cleanIngest(value, kind) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 500 || /[\u0000\r\n]/.test(text)) return '';
  if (kind === 'server' && !/^rtmps?:\/\//i.test(text)) return '';
  return text;
}

function pickSlot(item, fallbackId) {
  if (!item || typeof item !== 'object') return null;
  const server = cleanIngest(item.server_url, 'server');
  const streamKey = cleanIngest(item.stream_key, 'key');
  if (!server || !streamKey) return null;
  let slotId = '';
  if (item.id != null && String(item.id).trim()) slotId = clip(String(item.id).trim(), 80);
  else if (fallbackId) slotId = clip(String(fallbackId).trim(), 80);
  return { server: server, key: streamKey, slotId: slotId };
}

function asLive(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'true') return true;
  return false;
}

function lockIdOf(dest) {
  if (dest && typeof dest === 'object') {
    if (dest.id != null && String(dest.id).trim()) return 'id:' + String(dest.id).trim().slice(0, 200);
    const site = dest.site == null ? '' : String(dest.site).slice(0, 80);
    const account = dest.accountId == null ? '' : String(dest.accountId).slice(0, 80);
    if (site || account) return 'account:' + site + ':' + account;
  }
  return 'dest:none';
}

function titleOf(session, config) {
  const text = session && session.title != null ? String(session.title).trim() : '';
  if (text) return clip(text, 200);
  return config.defaultTitle || DEFAULTS.defaultTitle;
}

function categoryOf(session, config) {
  if (!session) return config.categoryId;
  return cleanNumber(session.category, config.categoryId, 1, 999999);
}

function createRumbleSlot(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : null;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  let ctx = null;
  let config = normalizeConfig(null);
  let lastOp = '';
  let lastOpAt = '';
  const inflight = new Set();

  function nowDate() {
    try {
      const value = nowFn();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date;
    } catch (err) { /* 時計が壊れても符号だけは残す */ }
    return new Date();
  }

  function nowMs() {
    return nowDate().getTime();
  }

  function nowIso() {
    return nowDate().toISOString();
  }

  function log(level, message) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    let text = message == null ? '' : String(message);
    if (typeof ctx.redact === 'function') text = ctx.redact(text);
    if (/https?:|api[_-]?key|stream[_-]?key|cookie|\bkey\s*=/i.test(text)) text = 'redacted';
    try { ctx.logger(level, text); } catch (err) { /* ログで本処理を止めない */ }
  }

  function note(op) {
    lastOp = typeof op === 'string' ? op : '';
    lastOpAt = nowIso();
  }

  function modeOf(box) {
    if (!box || typeof box.mode !== 'function') return 'legacy';
    try {
      const value = box.mode();
      if (value === 'legacy' || value === 'shadow' || value === 'live') return value;
    } catch (err) { /* 不明なモードは legacy */ }
    return 'legacy';
  }

  function resolveMode(meta) {
    if (meta && meta.dryRun === true) return 'shadow';
    return modeOf(ctx);
  }

  function reloadConfig() {
    config = normalizeConfig(null);
    if (!ctx) return;
    let dir = '';
    try { dir = ctx.dataDir; } catch (err) { return; }
    if (typeof dir !== 'string' || !dir) return;
    config = normalizeConfig(readJson(path.join(dir, 'config.json')));
  }

  function sleepMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
    if (sleepFn) return Promise.resolve(sleepFn(n));
    return new Promise((resolve) => { setTimer(resolve, n); });
  }

  function startTimeout(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0 || typeof AbortController !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimer(() => {
      try { controller.abort(); } catch (err) { /* すでに終わっていてもよい */ }
    }, n);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return {
      signal: controller.signal,
      cancel() {
        try { clearTimer(timer); } catch (err) { /* 二重キャンセルは無視 */ }
      }
    };
  }

  async function request(url, init, timeoutMs) {
    assertRumbleUrl(url);
    const timeout = startTimeout(timeoutMs);
    try {
      const options = Object.assign({ redirect: 'manual', cache: 'no-store' }, init || {});
      if (timeout) options.signal = timeout.signal;
      let res;
      try {
        res = await fetchImpl(url, options);
      } catch (err) {
        throw fail('network');
      }
      const status = res && res.status;
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        throw fail('network');
      }
      return res;
    } finally {
      if (timeout) timeout.cancel();
    }
  }

  async function readBody(res) {
    try {
      if (res && typeof res.text === 'function') return await res.text();
    } catch (err) { /* 本文が読めなければ空として扱う */ }
    return '';
  }

  async function parseJson(res, checkSlots) {
    const text = await readBody(res);
    const sample = text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
    if (checkSlots && slotsExhausted(sample)) throw fail('slots-exhausted');
    if (!res || res.ok !== true || text.length > MAX_BODY) throw fail('network');
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('network');
      return data;
    } catch (err) {
      if (err && err.code === 'network') throw err;
      if (err && err.code === 'slots-exhausted') throw err;
      throw fail('network');
    }
  }

  async function readSecret(box, name) {
    if (!box || !box.secrets || typeof box.secrets.get !== 'function') return { present: false, value: '' };
    let result;
    try {
      result = await box.secrets.get(name);
    } catch (err) {
      return { present: false, value: '' };
    }
    if (!result || result.ok !== true || typeof result.value !== 'string') return { present: false, value: '' };
    const value = result.value.trim();
    if (!value || value.length > MAX_SECRET || /[\u0000\r\n]/.test(value)) return { present: false, value: '' };
    return { present: true, value: value };
  }

  function formHeaders(cookie, referer) {
    return {
      'User-Agent': BROWSER_UA,
      'Cookie': stripControls(cookie),
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://rumble.com',
      'Referer': referer,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    };
  }

  async function getLivestreams(apiKey, timeoutMs) {
    try {
      const url = GET_DATA_URL + '?key=' + encodeURIComponent(apiKey);
      const res = await request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept': 'application/json' }
      }, timeoutMs || 10000);
      const data = await parseJson(res, false);
      if (data.livestreams == null) return { ok: true, list: [] };
      if (!Array.isArray(data.livestreams)) return { ok: false, error: 'network' };
      return { ok: true, list: data.livestreams };
    } catch (err) {
      return { ok: false, error: codeOf(err) };
    }
  }

  async function claimSlot(cookie) {
    try {
      const res = await request(CLAIM_URL, {
        method: 'POST',
        headers: formHeaders(cookie, 'https://rumble.com/live'),
        body: ''
      }, 15000);
      const data = await parseJson(res, true);
      const inner = data.data && typeof data.data === 'object' ? data.data : null;
      const claimId = inner && inner.claim_id != null ? String(inner.claim_id).trim() : '';
      const success = inner && (inner.success === true || inner.success === 1 || inner.success === '1');
      if (!success || !claimId || claimId.length > 200) return { ok: false, error: 'network' };
      const endpoint = data.user && data.user.upload ? data.user.upload.endpoint : '';
      return { ok: true, claimId: claimId, uploadUrl: uploadUrl(endpoint) };
    } catch (err) {
      return { ok: false, error: codeOf(err) };
    }
  }

  async function uploadProgram(cookie, claim, session) {
    try {
      const fields = new URLSearchParams();
      fields.set('isLiveStream', '1');
      fields.set('liveStreamingClaimId', claim.claimId);
      fields.set('liveStreamingUnlistReplay', '0');
      fields.set('liveStreamingSourcePassthrough', '0');
      fields.set('title', titleOf(session, config));
      fields.set('description', config.description);
      fields.set('featured', '');
      fields.set('rights', '1');
      fields.set('terms', '1');
      fields.set('infoWho', '');
      fields.set('infoWhere', '');
      fields.set('tags', config.tags);
      fields.set('channelId', '0');
      fields.set('siteChannelId', String(categoryOf(session, config)));
      fields.set('mediaChannelId', '0');
      fields.set('isGamblingRelated', '0');
      fields.set('set_default_channel_id', '0');
      fields.set('setFeaturedForUser', '0');
      fields.set('setFeaturedForChannel', '0');
      fields.set('visibility', 'public');
      fields.set('availability', 'free');
      const res = await request(claim.uploadUrl, {
        method: 'POST',
        headers: formHeaders(cookie, 'https://rumble.com/live?template=0'),
        body: fields.toString()
      }, 20000);
      const data = await parseJson(res, true);
      const success = data.success === true || Number(data.success) === 1;
      if (!success) return { ok: false, error: 'network' };
      const fid = data.data && data.data.fid != null ? String(data.data.fid).trim() : '';
      return { ok: true, fid: fid && fid.length <= 80 ? fid : '' };
    } catch (err) {
      return { ok: false, error: codeOf(err) };
    }
  }

  async function pollSlot(apiKey, fallbackId) {
    const started = nowMs();
    const deadline = started + POLL_DEADLINE_MS;
    let when = started;
    let polls = 0;
    let sawEmpty = false;
    let sawNetwork = false;
    while (polls < MAX_POLLS && when <= deadline) {
      const wait = when - nowMs();
      if (wait > 0) await sleepMs(wait);
      if (nowMs() > deadline) break;
      polls += 1;
      const remaining = deadline - nowMs();
      const looked = await getLivestreams(apiKey, Math.min(10000, Math.max(1000, remaining)));
      if (!looked.ok) {
        sawNetwork = true;
      } else if (!looked.list.length) {
        sawEmpty = true;
      } else {
        const slot = pickSlot(looked.list[0], fallbackId);
        if (slot) return { ok: true, slot: slot };
        sawEmpty = true;
      }
      when += POLL_INTERVAL_MS;
    }
    if (sawEmpty || !sawNetwork) return { ok: false, error: 'timeout' };
    return { ok: false, error: 'network' };
  }

  function done(op, level) {
    note(op);
    log(level, level === 'info' ? 'prepare ' + op : 'prepare failed ' + op);
  }

  async function prepareLive(dest, session) {
    const lockId = lockIdOf(dest);
    if (inflight.has(lockId)) {
      done('busy', 'warn');
      return failure('busy');
    }
    inflight.add(lockId);
    let api = '';
    let cookie = '';
    try {
      reloadConfig();
      const apiSecret = await readSecret(ctx, SECRET_API);
      const cookieSecret = await readSecret(ctx, SECRET_COOKIES);
      if (!apiSecret.present || !cookieSecret.present) {
        done('no-credentials', 'warn');
        return failure('no-credentials');
      }
      api = apiSecret.value;
      cookie = cookieSecret.value;
      const looked = await getLivestreams(api, 10000);
      if (!looked.ok) {
        done(looked.error, 'warn');
        return failure(looked.error);
      }
      if (looked.list.length) {
        const existing = pickSlot(looked.list[0], '');
        if (!existing) {
          done('network', 'warn');
          return failure('network');
        }
        done('reused', 'info');
        return { ok: true, server: existing.server, key: existing.key, slotId: existing.slotId, reused: true };
      }
      const claim = await claimSlot(cookie);
      if (!claim.ok) {
        done(claim.error, 'warn');
        return failure(claim.error);
      }
      const uploaded = await uploadProgram(cookie, claim, session);
      if (!uploaded.ok) {
        done(uploaded.error, 'warn');
        return failure(uploaded.error);
      }
      const polled = await pollSlot(api, uploaded.fid);
      if (!polled.ok) {
        done(polled.error, 'warn');
        return failure(polled.error);
      }
      done('created', 'info');
      return {
        ok: true,
        server: polled.slot.server,
        key: polled.slot.key,
        slotId: polled.slot.slotId,
        reused: false
      };
    } catch (err) {
      const error = codeOf(err);
      done(error, 'warn');
      return failure(error);
    } finally {
      api = '';
      cookie = '';
      inflight.delete(lockId);
    }
  }

  async function prepareBroadcast(dest, session, meta) {
    const mode = resolveMode(meta);
    if (mode === 'legacy') {
      note('legacy');
      log('info', 'prepare legacy');
      return { ok: true };
    }
    if (mode === 'shadow') {
      note('dry-run');
      log('info', 'prepare dry-run');
      return { ok: true, dryRun: true };
    }
    return prepareLive(dest, session);
  }

  async function verifyLive(dest, meta) {
    const mode = resolveMode(meta);
    if (mode === 'legacy') return { ok: true };
    if (mode === 'shadow') return { ok: true, dryRun: true };
    let api = '';
    try {
      const apiSecret = await readSecret(ctx, SECRET_API);
      if (!apiSecret.present) {
        note('no-credentials');
        log('warn', 'verify failed no-credentials');
        return failure('no-credentials');
      }
      api = apiSecret.value;
      const looked = await getLivestreams(api, 10000);
      if (!looked.ok) {
        note(looked.error);
        log('warn', 'verify failed ' + looked.error);
        return failure(looked.error);
      }
      const live = looked.list.length ? asLive(looked.list[0].is_live) : false;
      return { ok: true, live: live };
    } catch (err) {
      const error = codeOf(err);
      note(error);
      log('warn', 'verify failed ' + error);
      return failure(error);
    } finally {
      api = '';
    }
  }

  function endBroadcast(dest, meta) {
    if (resolveMode(meta) === 'shadow') return { ok: true, dryRun: true };
    return { ok: true };
  }

  async function getStatus(params, passed) {
    try {
      const box = passed || ctx;
      const api = await readSecret(box, SECRET_API);
      const cookies = await readSecret(box, SECRET_COOKIES);
      return {
        ok: true,
        mode: modeOf(box),
        lastOp: lastOp,
        lastOpAt: lastOpAt,
        credentials: { api: api.present, cookies: cookies.present }
      };
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    }
  }

  const BULLETS = '••••';
  function tailOf(value) {
    if (typeof value !== 'string' || value.length === 0) return '';
    if (value.length >= 12) {
      return BULLETS + value.slice(-4);
    }
    return BULLETS;
  }

  const SENDING_STATUS = new Set(['live', 'connecting', 'reconnecting']);

  async function prepareSlot(params, passed) {
    const box = passed || ctx;
    const mode = modeOf(box);
    if (mode === 'legacy') return { ok: false, error: 'off' };
    if (mode === 'shadow') return { ok: true, dryRun: true };

    const p = params && typeof params === 'object' ? params : {};

    if (!box || !box.api || typeof box.api.call !== 'function') {
      return { ok: false, error: 'unavailable' };
    }

    const listRes = await box.api.call('destination.list', {});
    if (!listRes || listRes.ok !== true || !Array.isArray(listRes.destinations)) {
      return { ok: false, error: (listRes && listRes.error) || 'destination-list-failed' };
    }

    const allDests = listRes.destinations;
    const rumbleDests = allDests.filter(function (d) {
      return d && d.site === 'rumble' && !d.main && d.id !== 'obs-main';
    });

    let targetDest = null;
    if (p.destinationId != null && String(p.destinationId).trim()) {
      const givenId = String(p.destinationId).trim();
      const matched = allDests.find(function (d) { return d && String(d.id) === givenId; });
      if (!matched || matched.site !== 'rumble' || matched.main || matched.id === 'obs-main') {
        return { ok: false, error: 'not-own-site' };
      }
      targetDest = matched;
    } else {
      if (rumbleDests.length === 0) return { ok: false, error: 'no-destination' };
      if (rumbleDests.length > 1) return { ok: false, error: 'ambiguous' };
      targetDest = rumbleDests[0];
    }

    if (targetDest.status && SENDING_STATUS.has(String(targetDest.status))) {
      return { ok: false, error: 'streaming' };
    }

    const session = {};
    if (typeof p.title === 'string' && p.title.trim()) {
      session.title = p.title.trim();
    }
    const dest = { id: targetDest.id, site: 'rumble' };

    const live = await prepareLive(dest, session);
    if (!live || live.ok !== true) {
      return live || failure('network');
    }

    const setRes = await box.api.call('destination.setKey', {
      id: targetDest.id,
      key: live.key,
      server: live.server
    });
    if (!setRes || setRes.ok !== true) {
      return setRes || { ok: false, error: 'failed' };
    }

    note('prepare-slot');
    log('info', 'prepareSlot ok');

    const result = {
      ok: true,
      destinationId: targetDest.id,
      reused: live.reused === true,
      keyTail: tailOf(live.key)
    };
    live.key = '';
    live.server = '';
    return result;
  }

  function load(passed) {
    ctx = passed || null;
    reloadConfig();
  }

  function start() {}

  function stop() {}

  function destroy() {
    ctx = null;
  }

  function health() {
    return { ok: true, detail: 'rumble-slot' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    prepareBroadcast: prepareBroadcast,
    verifyLive: verifyLive,
    endBroadcast: endBroadcast,
    actions: { getStatus: getStatus, prepareSlot: prepareSlot }
  };
}

const singleton = createRumbleSlot();
singleton.createRumbleSlot = createRumbleSlot;
module.exports = singleton;
