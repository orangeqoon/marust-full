'use strict';

/**
 * Google カレンダーへ session.* を記録する。
 * legacy は何もしない。shadow は dataDir の jsonl だけ。live だけが fetch する。
 * fetch の宛先は Calendar API v3（insert / get / patch）と OAuth トークン更新だけ。
 * 秘密が unavailable の間は queue.json に積むだけで、エラーにはしない。
 */

const fs = require('fs');
const path = require('path');
const { oauthState, DEFAULT_REDIRECT } = require('./lib/oauth-state');

const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_TITLE = '丸スト';
const DEFAULT_DESCRIPTION = 'Recorded by NeonTimer Compact';

const DEFAULTS = {
  mergeGapMinutes: 10,
  minEventSeconds: 60,
  provisionalCountupSeconds: 3600,
  calendarId: 'primary',
  recordSources: ['timer'],
  defaultTitle: DEFAULT_TITLE,
  description: DEFAULT_DESCRIPTION
};

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function asCode(err) {
  const code = err && err.code;
  if (typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code)) return code;
  return 'network';
}

function clipChars(value, max) {
  return Array.from(value == null ? '' : String(value)).slice(0, max).join('');
}

function isoOr(value, fallback) {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms).toISOString();
}

function expiryMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1e12) return n * 1000;
  return n;
}

function cleanCalendarId(value) {
  if (typeof value !== 'string') return DEFAULTS.calendarId;
  const id = value.trim();
  if (!id || id.length > 200) return DEFAULTS.calendarId;
  if (/[\\/?#]|\.\./.test(id)) return DEFAULTS.calendarId;
  return id;
}

function cleanSources(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string') continue;
    const text = value[i].trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(text)) continue;
    if (out.indexOf(text) === -1) out.push(text);
  }
  return out;
}

function cleanNumber(value, fallback, min, max, integer) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = integer ? Math.trunc(n) : n;
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sources = cleanSources(src.recordSources);
  const title = typeof src.defaultTitle === 'string' ? src.defaultTitle.trim() : '';
  const description = typeof src.description === 'string' ? src.description : null;
  return {
    mergeGapMinutes: cleanNumber(src.mergeGapMinutes, DEFAULTS.mergeGapMinutes, 0, 1440, false),
    minEventSeconds: cleanNumber(src.minEventSeconds, DEFAULTS.minEventSeconds, 0, 86400, true),
    provisionalCountupSeconds: cleanNumber(src.provisionalCountupSeconds, DEFAULTS.provisionalCountupSeconds, 1, 86400, true),
    calendarId: cleanCalendarId(src.calendarId),
    recordSources: sources == null ? DEFAULTS.recordSources.slice() : sources,
    defaultTitle: title || DEFAULTS.defaultTitle,
    description: description == null ? DEFAULTS.description : description.slice(0, 8192)
  };
}

function resolveTitle(title, config) {
  const text = title == null ? '' : String(title).trim();
  if (text) return text;
  return config.defaultTitle || DEFAULT_TITLE;
}

function provisionalSeconds(payload, config) {
  const n = payload ? Number(payload.plannedSec) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return config.provisionalCountupSeconds;
}

function canMerge(last, title, startIso, gapMinutes) {
  if (!last || !last.eventId || last.title !== title) return false;
  const endMs = Date.parse(last.end);
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return false;
  return (startMs - endMs) <= gapMinutes * 60 * 1000;
}

function effectiveEnd(startIso, requestedIso, minSeconds) {
  const start = Date.parse(startIso);
  const requested = Date.parse(requestedIso);
  if (!Number.isFinite(requested) && !Number.isFinite(start)) return '';
  if (!Number.isFinite(requested)) return new Date(start + Math.max(0, minSeconds) * 1000).toISOString();
  if (!Number.isFinite(start)) return new Date(requested).toISOString();
  const minEnd = start + Math.max(0, minSeconds) * 1000;
  return new Date(Math.max(minEnd, requested)).toISOString();
}

function backoffMs(attempts) {
  const step = Math.min(Math.max(attempts, 1) - 1, 8);
  const ms = RETRY_BASE_MS * (2 ** step);
  return ms > RETRY_MAX_MS ? RETRY_MAX_MS : ms;
}

function isMarked(event) {
  const priv = event && event.extendedProperties && event.extendedProperties.private;
  return !!(priv && String(priv.marust) === '1');
}

const EVENT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

function base32hexEncode(buffer) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    acc = (acc << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += EVENT_ID_ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += EVENT_ID_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function calendarEventId(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : '';
  let id = 'mru' + base32hexEncode(Buffer.from(text, 'utf8'));
  if (id.length < 5) id = (id + '00000').slice(0, 5);
  if (id.length > 1024) id = id.slice(0, 1024);
  return id;
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 1024 * 1024) return null;
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.copyFileSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

function assertAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw fail('bad-url');
  }
  if (parsed.username || parsed.password || parsed.protocol !== 'https:') throw fail('bad-url');
  const calendar = parsed.origin === 'https://www.googleapis.com' && parsed.pathname.indexOf('/calendar/v3/') === 0;
  const token = parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token';
  if (!calendar && !token) throw fail('bad-url');
}

function createGcal(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return global.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  let ctx = null;
  let config = normalizeConfig(null);
  let active = null;
  let last = null;
  let queue = [];
  let lastOp = null;
  let lastOpAt = null;
  let lastError = null;
  let creds = null;
  let timer = null;
  let draining = null;
  let chain = Promise.resolve();
  let seq = 0;
  let sentCount = 0;

  function nowDate() {
    try {
      const value = nowFn();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date;
    } catch (err) { /* 時計が壊れていても記録自体は止めない */ }
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
    try { ctx.logger(level, message); } catch (err) { /* ログ失敗で記録を止めない */ }
  }

  function currentMode(passed) {
    const box = passed || ctx;
    if (!box || typeof box.mode !== 'function') return 'legacy';
    try {
      const value = box.mode();
      if (value === 'legacy' || value === 'shadow' || value === 'live') return value;
    } catch (err) { /* 不明なモードは legacy */ }
    return 'legacy';
  }

  function reloadConfig() {
    if (!ctx || !ctx.dataDir) {
      config = normalizeConfig(null);
      return;
    }
    config = normalizeConfig(readJson(path.join(ctx.dataDir, 'config.json')));
  }

  function statePath() {
    return path.join(ctx.dataDir, 'state.json');
  }

  function queuePath() {
    return path.join(ctx.dataDir, 'queue.json');
  }

  function persist() {
    if (!ctx || !ctx.dataDir) return;
    try {
      writeJson(statePath(), {
        version: 1,
        active: active ? {
          eventId: active.eventId || '',
          sessionId: active.sessionId || '',
          title: active.title || '',
          start: active.start || '',
          end: active.end || '',
          pending: active.pending === true,
          finalized: active.finalized === true,
          finalEndAt: active.finalEndAt || ''
        } : null,
        last: last ? {
          eventId: last.eventId || '',
          sessionId: last.sessionId || '',
          title: last.title || '',
          start: last.start || '',
          end: last.end || ''
        } : null,
        lastOp: lastOp,
        lastOpAt: lastOpAt,
        lastError: lastError
      });
    } catch (err) {
      lastError = 'disk';
    }
  }

  function saveQueue() {
    if (!ctx || !ctx.dataDir) return;
    try {
      writeJson(queuePath(), { version: 1, items: queue });
    } catch (err) {
      lastError = 'disk';
    }
  }

  function readState() {
    const data = readJson(statePath());
    active = null;
    last = null;
    lastOp = null;
    lastOpAt = null;
    lastError = null;
    if (!data || typeof data !== 'object') return;
    if (data.active && typeof data.active === 'object') active = data.active;
    if (data.last && typeof data.last === 'object' && data.last.eventId) last = data.last;
    if (data.lastOp === 'create' || data.lastOp === 'extend' || data.lastOp === 'finalize') lastOp = data.lastOp;
    if (typeof data.lastOpAt === 'string') lastOpAt = data.lastOpAt;
    if (typeof data.lastError === 'string' && /^[a-z0-9-]{1,40}$/.test(data.lastError)) lastError = data.lastError;
  }

  function readQueue() {
    const data = readJson(queuePath());
    const items = data && Array.isArray(data.items) ? data.items : [];
    queue = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || (item.op !== 'create' && item.op !== 'extend' && item.op !== 'finalize')) continue;
      queue.push({
        id: typeof item.id === 'string' ? item.id : ('q' + (++seq)),
        op: item.op,
        eventId: typeof item.eventId === 'string' ? item.eventId : '',
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        title: typeof item.title === 'string' ? item.title : '',
        start: typeof item.start === 'string' ? item.start : '',
        end: typeof item.end === 'string' ? item.end : '',
        activityStart: typeof item.activityStart === 'string' ? item.activityStart : '',
        activityEnd: typeof item.activityEnd === 'string' ? item.activityEnd : '',
        description: typeof item.description === 'string' ? item.description : '',
        calendarId: cleanCalendarId(item.calendarId),
        attempts: Number.isFinite(Number(item.attempts)) ? Number(item.attempts) : 0,
        nextAt: Number.isFinite(Number(item.nextAt)) ? Number(item.nextAt) : 0
      });
    }
  }

  function needsRefresh(box) {
    if (!box || box.expiry_date == null) return false;
    const expiry = Number(box.expiry_date);
    if (!Number.isFinite(expiry)) return false;
    return expiry <= nowMs() + REFRESH_SKEW_MS;
  }

  async function loadCreds() {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') throw fail('unavailable');
    let got;
    try {
      got = await ctx.secrets.get('google.oauth');
    } catch (err) {
      throw fail('unavailable');
    }
    if (!got || got.ok !== true || typeof got.value !== 'string') {
      if (got && got.error === 'unavailable') throw fail('unavailable');
      throw fail(got && got.ok === false ? asCode({ code: got.error }) : 'bad-secret');
    }
    let parsed;
    try {
      parsed = JSON.parse(got.value);
    } catch (err) {
      throw fail('bad-secret');
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw fail('bad-secret');
    }
    return {
      access_token: parsed.access_token,
      refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
      expiry_date: expiryMs(parsed.expiry_date),
      client_id: typeof parsed.client_id === 'string' ? parsed.client_id : '',
      client_secret: typeof parsed.client_secret === 'string' ? parsed.client_secret : ''
    };
  }

  async function refresh(box) {
    if (!box.refresh_token || !box.client_id || !box.client_secret) throw fail('refresh-unavailable');
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', box.refresh_token);
    body.set('client_id', box.client_id);
    body.set('client_secret', box.client_secret);
    const res = await rawFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: body.toString()
    });
    if (!res || res.ok !== true) throw fail('refresh-failed');
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw fail('refresh-failed');
    }
    if (!json || typeof json.access_token !== 'string' || json.access_token === '') throw fail('refresh-failed');
    return json;
  }

  async function accessToken(force) {
    const loaded = await loadCreds();
    if (!creds || creds.refresh_token !== loaded.refresh_token) creds = {
      access_token: loaded.access_token,
      refresh_token: loaded.refresh_token,
      expiry_date: loaded.expiry_date,
      client_id: loaded.client_id,
      client_secret: loaded.client_secret
    };
    if (!needsRefresh(loaded) && loaded.access_token) {
      creds.access_token = loaded.access_token;
      creds.expiry_date = loaded.expiry_date;
    }
    if (force || needsRefresh(creds)) {
      const json = await refresh(creds);
      creds.access_token = json.access_token;
      const seconds = Number(json.expires_in);
      creds.expiry_date = nowMs() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    }
    if (typeof creds.access_token !== 'string' || creds.access_token === '') throw fail('bad-secret');
    return creds.access_token;
  }

  async function rawFetch(url, init) {
    assertAllowed(url);
    try {
      const res = await fetchImpl(url, init);
      if (!res || typeof res.status !== 'number') throw fail('network');
      return res;
    } catch (err) {
      if (err && typeof err.code === 'string' && /^[a-z0-9-]{1,40}$/.test(err.code)) throw err;
      throw fail('network');
    }
  }

  async function calendar(url, method, body) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    const init = { method: method, headers: headers, redirect: 'manual' };
    if (body) init.body = JSON.stringify(body);
    let token = await accessToken(false);
    headers.Authorization = 'Bearer ' + token;
    let res = await rawFetch(url, init);
    if (res.status === 401) {
      token = await accessToken(true);
      headers.Authorization = 'Bearer ' + token;
      res = await rawFetch(url, init);
    }
    if (res.status >= 300 && res.status < 400) throw fail('redirect');
    if (res.ok !== true) throw fail('http-' + res.status);
    let data = {};
    if (typeof res.json === 'function') {
      try {
        const parsed = await res.json();
        if (parsed && typeof parsed === 'object') data = parsed;
      } catch (err) {
        if (method === 'POST') throw fail('bad-response');
      }
    }
    if (method === 'POST' && (typeof data.id !== 'string' || data.id === '')) throw fail('bad-response');
    return data;
  }

  function eventsUrl(calendarId) {
    return 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events';
  }

  function eventUrl(calendarId, eventId) {
    return eventsUrl(calendarId) + '/' + encodeURIComponent(eventId);
  }

  function insertBody(item) {
    return {
      summary: clipChars(item.title, 1024),
      description: item.description == null ? '' : String(item.description).slice(0, 8192),
      start: { dateTime: item.start },
      end: { dateTime: item.end },
      extendedProperties: {
        private: {
          marust: '1',
          sessionId: String(item.sessionId || '')
        }
      }
    };
  }

  function findEventId(sessionId) {
    if (active && active.sessionId === sessionId && active.eventId) return active.eventId;
    if (last && last.sessionId === sessionId && last.eventId) return last.eventId;
    return '';
  }

  function remember(sent) {
    if (sent.eventId) {
      for (let i = 0; i < queue.length; i += 1) {
        const item = queue[i];
        if (item.sessionId === sent.sessionId && !item.eventId && item.op !== 'create') item.eventId = sent.eventId;
      }
    }
    if (sent.op === 'create' || sent.op === 'extend') {
      if (active && active.sessionId === sent.sessionId) {
        active.eventId = sent.eventId || active.eventId || '';
        active.pending = false;
        if (sent.op === 'create') {
          active.start = sent.start;
          active.end = sent.end;
        } else if (sent.end) {
          active.end = sent.end;
        }
      }
    } else if (sent.op === 'finalize') {
      last = {
        eventId: sent.eventId,
        sessionId: sent.sessionId,
        title: sent.title,
        start: sent.start,
        end: sent.end
      };
      if (active && active.sessionId === sent.sessionId) active = null;
    }
    if (sent.op === 'create' || sent.op === 'extend' || sent.op === 'finalize') {
      lastOp = sent.op;
      lastOpAt = nowIso();
    }
  }

  function writeShadow(plan) {
    if (!ctx || typeof ctx.dataDir !== 'string' || !ctx.dataDir) throw new Error('shadow');
    const ok = ctx.log.appendJsonl('shadow', {
      op: plan.op,
      title: clipChars(plan.title, 20),
      start: plan.start,
      end: plan.end
    }, { now: nowDate() });
    if (!ok) throw new Error('shadow');
  }

  function applyShadow(plan) {
    const eventId = plan.op === 'create' ? ('shadow:' + (plan.sessionId || 'session')) : (plan.eventId || '');
    const end = plan.op === 'finalize' ? effectiveEnd(plan.start, plan.end, config.minEventSeconds) : plan.end;
    writeShadow({ op: plan.op, title: plan.title, start: plan.start, end: end });
    remember({
      op: plan.op,
      eventId: eventId,
      sessionId: plan.sessionId,
      title: plan.title,
      start: plan.start,
      end: end
    });
    persist();
    log('info', plan.op);
  }

  function enqueue(plan) {
    if (plan.op === 'finalize') {
      for (let i = 0; i < queue.length; i += 1) {
        const existing = queue[i];
        if (existing.op === 'finalize' && existing.sessionId === plan.sessionId) {
          existing.end = plan.end;
          existing.title = plan.title;
          existing.start = plan.start;
          if (plan.eventId) existing.eventId = plan.eventId;
          saveQueue();
          return;
        }
      }
    }
    queue.push({
      id: 'q' + (++seq),
      op: plan.op,
      eventId: plan.eventId || '',
      sessionId: plan.sessionId || '',
      title: plan.title || '',
      start: plan.start || '',
      end: plan.end || '',
      activityStart: plan.activityStart || '',
      activityEnd: plan.activityEnd || '',
      description: plan.description == null ? config.description : plan.description,
      calendarId: plan.calendarId || config.calendarId,
      attempts: 0,
      nextAt: 0
    });
    saveQueue();
  }

  function convertExtendToCreate(item) {
    const skipped = item.eventId;
    item.op = 'create';
    item.eventId = '';
    if (item.activityStart) item.start = item.activityStart;
    if (item.activityEnd) item.end = item.activityEnd;
    if (last && skipped && last.eventId === skipped) last = null;
    if (active && active.sessionId === item.sessionId) {
      active.eventId = '';
      active.start = item.start;
      active.end = item.end;
      active.pending = true;
    }
    for (let i = 0; i < queue.length; i += 1) {
      const other = queue[i];
      if (other !== item && other.op === 'finalize' && other.sessionId === item.sessionId) other.eventId = '';
    }
  }

  function disarm() {
    if (timer == null) return;
    try { clearTimer(timer); } catch (err) { /* タイマー解除の失敗は無視 */ }
    timer = null;
  }

  function arm(ms) {
    disarm();
    const delay = Math.max(0, Math.floor(ms));
    try {
      timer = setTimer(() => {
        timer = null;
        kickDrain().catch(() => {});
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch (err) {
      timer = null;
    }
  }

  async function send(item) {
    if (item.op === 'create') {
      const eventId = calendarEventId(item.sessionId);
      const body = insertBody(item);
      body.id = eventId;
      try {
        const data = await calendar(eventsUrl(item.calendarId), 'POST', body);
        return {
          op: 'create',
          eventId: data.id,
          sessionId: item.sessionId,
          title: item.title,
          start: item.start,
          end: item.end
        };
      } catch (err) {
        if (err && err.code === 'http-409') {
          return {
            op: 'create',
            eventId: eventId,
            sessionId: item.sessionId,
            title: item.title,
            start: item.start,
            end: item.end
          };
        }
        throw err;
      }
    }
    if (item.op === 'extend') {
      let data;
      try {
        data = await calendar(eventUrl(item.calendarId, item.eventId), 'GET');
      } catch (err) {
        if (err && err.code === 'http-404') throw fail('unmarked');
        throw err;
      }
      if (!isMarked(data)) throw fail('unmarked');
      await calendar(eventUrl(item.calendarId, item.eventId), 'PATCH', {
        end: { dateTime: item.end },
        extendedProperties: {
          private: {
            marust: '1',
            sessionId: String(item.sessionId || '')
          }
        }
      });
      return {
        op: 'extend',
        eventId: item.eventId,
        sessionId: item.sessionId,
        title: item.title,
        start: item.start,
        end: item.end
      };
    }
    if (item.op === 'finalize') {
      let data;
      try {
        data = await calendar(eventUrl(item.calendarId, item.eventId), 'GET');
      } catch (err) {
        if (err && err.code === 'http-404') throw fail('http-404');
        throw err;
      }
      if (!isMarked(data)) throw fail('unmarked');
      const start = data.start && data.start.dateTime ? isoOr(data.start.dateTime, '') : '';
      if (!start) throw fail('not-timed');
      const end = effectiveEnd(start, item.end, config.minEventSeconds);
      await calendar(eventUrl(item.calendarId, item.eventId), 'PATCH', {
        end: { dateTime: end }
      });
      return {
        op: 'finalize',
        eventId: item.eventId,
        sessionId: item.sessionId,
        title: item.title,
        start: start,
        end: end
      };
    }
    throw fail('bad-op');
  }

  function dropPermanent(item, code) {
    queue.shift();
    lastError = code;
    if (item.op === 'finalize' || item.op === 'extend') {
      if (active && active.sessionId === item.sessionId) active = null;
      if (last && item.eventId && last.eventId === item.eventId) last = null;
    }
    saveQueue();
    persist();
    log('warn', code);
  }

  async function loop() {
    while (queue.length) {
      const item = queue[0];
      if (item.nextAt > nowMs()) {
        arm(item.nextAt - nowMs());
        return;
      }
      if ((item.op === 'finalize' || item.op === 'extend') && !item.eventId) {
        const id = findEventId(item.sessionId);
        if (id) item.eventId = id;
        else {
          arm(RETRY_BASE_MS);
          return;
        }
      }
      try {
        const sent = await send(item);
        queue.shift();
        remember(sent);
        sentCount += 1;
        lastError = null;
        saveQueue();
        persist();
        log('info', sent.op);
      } catch (err) {
        const code = asCode(err);
        if (code === 'unmarked' && item.op === 'extend') {
          convertExtendToCreate(item);
          saveQueue();
          continue;
        }
        if (code === 'unmarked' || code === 'not-timed' || code === 'http-404' || code === 'bad-op') {
          dropPermanent(item, code);
          continue;
        }
        item.attempts = (Number(item.attempts) || 0) + 1;
        const delay = backoffMs(item.attempts);
        item.nextAt = nowMs() + delay;
        if (code !== 'unavailable') lastError = code;
        saveQueue();
        arm(delay);
        log('warn', 'queued ' + code);
        return;
      }
    }
    disarm();
  }

  function kickDrain() {
    if (draining) return draining;
    draining = (async () => {
      try {
        if (currentMode() !== 'live') return;
        await loop();
      } finally {
        draining = null;
      }
    })();
    return draining;
  }

  async function commit(plan) {
    const mode = currentMode();
    if (mode === 'shadow') {
      applyShadow(plan);
      return;
    }
    if (mode !== 'live') return;
    enqueue(plan);
    persist();
    await kickDrain();
  }

  function activityStart(name, payload, meta) {
    if (name === 'session.resumed') {
      const segs = payload && Array.isArray(payload.segments) ? payload.segments : [];
      for (let i = segs.length - 1; i >= 0; i -= 1) {
        const seg = segs[i];
        if (seg && seg.startedAt && !seg.endedAt) {
          const iso = isoOr(seg.startedAt, '');
          if (iso) return iso;
        }
      }
      if (meta && meta.occurredAt) return isoOr(meta.occurredAt, nowIso());
    }
    if (payload && payload.startedAt) return isoOr(payload.startedAt, nowIso());
    if (meta && meta.occurredAt) return isoOr(meta.occurredAt, nowIso());
    return nowIso();
  }

  function requestedEnd(name, payload, meta) {
    if (name === 'session.ended') {
      if (payload && payload.recovered) {
        return isoOr(payload.endedAt, '') || isoOr(payload.lastAliveAt, '') || isoOr(meta && meta.occurredAt, '') || nowIso();
      }
      return isoOr(payload && payload.endedAt, '') || isoOr(meta && meta.occurredAt, '') || nowIso();
    }
    return isoOr(meta && meta.occurredAt, '') || nowIso();
  }

  function accept(name, payload, meta) {
    const mode = currentMode();
    if (mode !== 'shadow' && mode !== 'live') return false;
    if (!meta || meta.source !== 'session') return false;
    if (name !== 'session.started' && name !== 'session.resumed' && name !== 'session.paused' && name !== 'session.ended') {
      return false;
    }
    if (!payload || typeof payload !== 'object') return false;
    const source = payload.source == null ? '' : String(payload.source);
    return config.recordSources.indexOf(source) !== -1;
  }

  async function closeActive(at) {
    if (!active) return;
    active.finalized = true;
    active.finalEndAt = at;
    await commit({
      op: 'finalize',
      eventId: active.eventId || '',
      sessionId: active.sessionId,
      title: active.title,
      start: active.start,
      end: at,
      description: config.description,
      calendarId: config.calendarId
    });
  }

  async function openSession(name, payload, meta) {
    const title = resolveTitle(payload.title, config);
    const start = activityStart(name, payload, meta);
    const end = new Date(Date.parse(start) + provisionalSeconds(payload, config) * 1000).toISOString();
    const sessionId = payload.id == null ? '' : String(payload.id);
    if (active && active.sessionId !== sessionId) await closeActive(start);
    if (active && active.sessionId === sessionId) return;
    if (canMerge(last, title, start, config.mergeGapMinutes)) {
      active = {
        eventId: last.eventId,
        sessionId: sessionId,
        title: title,
        start: last.start,
        end: end,
        pending: false,
        finalized: false,
        finalEndAt: ''
      };
      await commit({
        op: 'extend',
        eventId: last.eventId,
        sessionId: sessionId,
        title: title,
        start: last.start,
        end: end,
        activityStart: start,
        activityEnd: end,
        description: config.description,
        calendarId: config.calendarId
      });
      return;
    }
    active = {
      eventId: '',
      sessionId: sessionId,
      title: title,
      start: start,
      end: end,
      pending: true,
      finalized: false,
      finalEndAt: ''
    };
    await commit({
      op: 'create',
      eventId: '',
      sessionId: sessionId,
      title: title,
      start: start,
      end: end,
      description: config.description,
      calendarId: config.calendarId
    });
  }

  async function closeSession(name, payload, meta) {
    if (!active) return;
    const sessionId = payload.id == null ? '' : String(payload.id);
    if (sessionId && active.sessionId && sessionId !== active.sessionId) return;
    await closeActive(requestedEnd(name, payload, meta));
  }

  async function handle(name, payload, meta) {
    if (!ctx) return;
    reloadConfig();
    if (!accept(name, payload, meta)) return;
    if (name === 'session.started' || name === 'session.resumed') {
      await openSession(name, payload, meta);
      return;
    }
    await closeSession(name, payload, meta);
  }

  function onEvent(name, payload, meta) {
    const job = chain.then(() => handle(name, payload, meta));
    chain = job.then(() => {}, () => {});
    return job.catch((err) => {
      lastError = asCode(err);
    });
  }

  function statusBody(mode, sent) {
    const body = {
      ok: true,
      mode: mode,
      lastOp: lastOp,
      lastOpAt: lastOpAt,
      queueCount: queue.length,
      lastError: lastError
    };
    if (sent != null) body.sent = sent;
    return body;
  }

  function getStatus(params, passed) {
    if (!ctx) return { ok: false, error: 'not-ready' };
    return statusBody(currentMode(passed));
  }

  function flushQueue(params, passed) {
    const job = chain.then(() => doFlush(passed));
    chain = job.then(() => {}, () => {});
    return job;
  }

  async function doFlush(passed) {
    if (!ctx) return { ok: false, error: 'not-ready' };
    const mode = currentMode(passed);
    if (mode !== 'live') return statusBody(mode, 0);
    try {
      for (let i = 0; i < queue.length; i += 1) queue[i].nextAt = 0;
      saveQueue();
      const before = sentCount;
      await kickDrain();
      return statusBody(mode, sentCount - before);
    } catch (err) {
      return { ok: false, error: 'flush-failed' };
    }
  }

  /** ログイン状態（V4。本体の calendar.loginStatus と同じ名前・形）。値は返さず、状態と既定の戻り先だけ。 */
  async function loginStatus() {
    const row = { ok: true, state: 'none', defaultRedirect: DEFAULT_REDIRECT };
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return { ok: false, error: 'unavailable' };
    let got;
    try {
      got = await ctx.secrets.get('google.oauth');
    } catch (err) {
      log('warn', 'login-status-read-failed unavailable');
      return row;
    }
    if (!got || got.ok !== true || typeof got.value !== 'string') {
      // 金庫に無い（not-found）以外の失敗は、原因が分かるようコードだけログに残す（値は出さない）
      if (got && got.error && got.error !== 'not-found') log('warn', 'login-status-read-failed ' + String(got.error).slice(0, 40));
      return row;
    }
    let doc = null;
    try { doc = JSON.parse(got.value); } catch (err) { doc = null; }
    row.state = oauthState(doc, nowMs());
    return row;
  }

  function registerApi(passed) {
    if (!passed || !passed.api || typeof passed.api.register !== 'function') return;
    const res = passed.api.register('calendar.loginStatus', loginStatus, {
      access: 'read',
      windowOnly: true,
      description: 'Google カレンダー連携のログイン状態（none / keys-only / logged-in / expired）を返す。値は返さない',
      params: {}
    });
    if (res && res.ok === false) log('warn', 'api-register-failed calendar.loginStatus ' + res.error);
  }

  function load(passed) {
    registerApi(passed);
    const job = chain.then(async () => {
      ctx = passed;
      creds = null;
      reloadConfig();
      readState();
      readQueue();
      if (currentMode() === 'live' && queue.length) await kickDrain();
    });
    chain = job.then(() => {}, () => {});
    return job.catch((err) => {
      lastError = asCode(err);
    });
  }

  function start() {
    if (!ctx || currentMode() !== 'live' || !queue.length) return undefined;
    return kickDrain();
  }

  function stop() {
    disarm();
  }

  function destroy() {
    disarm();
    creds = null;
  }

  function health() {
    return { ok: true, detail: 'gcal' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    onEvent: onEvent,
    health: health,
    actions: {
      getStatus: getStatus,
      flushQueue: flushQueue
    }
  };
}

const singleton = createGcal();
singleton.createGcal = createGcal;
module.exports = singleton;
