'use strict';

const qs = require('querystring');

const MAX_BODY = 1024 * 1024;
const MAX_SECRET = 64 * 1024;
const MAX_TEXT = 200;
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const HOST = 'live.fc2.com';
const SITE = 'fc2';
const COOKIE_NAME = 'cookies.fc2-main';
const CONFIG_NAME = 'fc2.config';
const PAGE_NAME = 'capture.fc2-main.page';
const HTTP_NAME = 'capture.fc2-main.fc2-http';
const CHANNEL_RE = /^[0-9]{1,16}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]{1,128}$/;
const UA_HTTP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_WS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * FC2 へのコメント送信（chat.sink@1）。
 * channel_id は fc2.config、無ければ capture の fc2-http / page。
 * POST /api/getControlServer.php の後、返った wss が fc2.com 配下のときだけ send_comment。
 * 既定のチャンネル番号とユーザ名は使わない。キャッシュ URL には落とさない。
 */

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

function cleanChannel(value) {
  const text = typeof value === 'number' && Number.isInteger(value)
    ? String(value)
    : (typeof value === 'string' ? value.trim() : '');
  return CHANNEL_RE.test(text) ? text : '';
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || Array.from(text).length > 80) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function nameIn(value, depth) {
  if (!value || depth > 4) return '';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 40; i += 1) {
      const found = nameIn(value[i], depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const named = cleanName(value.user_name);
  if (named) return named;
  if (value.arguments) {
    const nested = nameIn(value.arguments, depth + 1);
    if (nested) return nested;
  }
  if (typeof value.data === 'string') {
    try {
      const found = nameIn(JSON.parse(value.data), depth + 1);
      if (found) return found;
    } catch (err) { /* JSON でない */ }
  }
  if (typeof value.body === 'string') {
    const form = value.body.match(/(?:^|[&?])user_name=([^&]{1,240})/);
    if (form) {
      try {
        const decoded = cleanName(decodeURIComponent(form[1].replace(/\+/g, ' ')));
        if (decoded) return decoded;
      } catch (err) { /* 壊れたエンコード */ }
    }
    try {
      const found = nameIn(JSON.parse(value.body), depth + 1);
      if (found) return found;
    } catch (err) { /* JSON でない */ }
  }
  return '';
}

function cookieBag(text) {
  const parsed = parseObject(text);
  const empty = { cookies: Object.create(null), channel: '' };
  if (!parsed) return empty;
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
  return { cookies: cookies, channel: wrapped ? cleanChannel(parsed.channel_id) : '' };
}

function channelFromConfig(text) {
  const parsed = parseObject(text);
  return parsed ? cleanChannel(parsed.channel_id) : '';
}

function channelFromPage(text) {
  const parsed = parseObject(text);
  if (!parsed || typeof parsed.page_url !== 'string') return '';
  const matched = parsed.page_url.match(/^https:\/\/live\.fc2\.com\/(\d{1,16})(?:\/|$|\?)/);
  return matched ? matched[1] : '';
}

function channelFromBodyText(body) {
  if (typeof body !== 'string' || !body) return '';
  const stream = body.match(/(?:^|[&?])streamid=(\d{1,16})(?:&|$)/);
  if (stream) return stream[1];
  const channel = body.match(/(?:^|[&?])channel_id=(\d{1,16})(?:&|$)/);
  return channel ? channel[1] : '';
}

function channelFromHttp(text) {
  const parsed = parseObject(text);
  if (!parsed) return '';
  if (typeof parsed.body === 'string') return channelFromBodyText(parsed.body);
  if (!Array.isArray(parsed.body)) return '';
  let stream = '';
  let channel = '';
  for (let i = 0; i < parsed.body.length; i += 1) {
    const row = parsed.body[i];
    if (!row || typeof row !== 'object') continue;
    const value = cleanChannel(row.value);
    if (!value) continue;
    if (row.key === 'streamid') stream = value;
    if (row.key === 'channel_id') channel = value;
  }
  return stream || channel;
}

function cookieHeader(cookies) {
  const parts = [];
  const keys = Object.keys(cookies);
  for (let i = 0; i < keys.length; i += 1) parts.push(keys[i] + '=' + cookies[keys[i]]);
  return parts.join('; ');
}

function allowedHttp(value) {
  let parsed;
  try { parsed = new URL(value); } catch (err) { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;
  if (parsed.hostname.toLowerCase().replace(/\.$/, '') !== HOST) return false;
  return parsed.pathname === '/api/getControlServer.php';
}

function allowedWs(value) {
  let parsed;
  try { parsed = new URL(value); } catch (err) { return false; }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return host === 'fc2.com' || host.endsWith('.fc2.com');
}

function controlUrl(info) {
  if (!info || typeof info.url !== 'string' || typeof info.control_token !== 'string') return '';
  if (/[\s\u0000-\u001f\u007f]/.test(info.url) || /[\s\u0000-\u001f\u007f]/.test(info.control_token)) return '';
  const joined = info.url + '?control_token=' + info.control_token;
  return allowedWs(joined) ? joined : '';
}

function defaultConnect(spec) {
  if (!allowedWs(spec && spec.url)) {
    return Promise.reject(Object.assign(new Error('domain'), { code: 'domain' }));
  }
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    let done = false;
    const ws = new WebSocket(spec.url, {
      followRedirects: false,
      handshakeTimeout: 10000,
      headers: spec.headers || {}
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.terminate(); } catch (err) { /* 閉じている */ }
      reject(Object.assign(new Error('http'), { code: 'http' }));
    }, 10000);
    ws.on('open', () => {
      ws.send(spec.body);
      setTimeout(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch (err) { /* 閉じている */ }
        resolve({ status: 101 });
      }, 800);
    });
    ws.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Object.assign(new Error('network'), { code: 'network' }));
    });
  });
}

function createSinkFc2(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : defaultFetch;
  const connectImpl = typeof options.connect === 'function' ? options.connect : defaultConnect;
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

  function nonce() {
    if (typeof options.nonce === 'function') {
      const value = options.nonce();
      if (Number.isInteger(value) && value >= 0 && value <= 999999) return value;
    }
    return Math.floor(Math.random() * 9000) + 1000;
  }

  async function readRaw(name) {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return '';
    let result;
    try { result = await ctx.secrets.get(name); } catch (err) { return ''; }
    if (!result || result.ok !== true || typeof result.value !== 'string') return '';
    if (!result.value || result.value.length > MAX_SECRET || result.value.indexOf('\u0000') !== -1) return '';
    return result.value;
  }

  async function loadAuth() {
    const cookieText = await readRaw(COOKIE_NAME);
    const configText = await readRaw(CONFIG_NAME);
    const httpText = await readRaw(HTTP_NAME);
    const pageText = await readRaw(PAGE_NAME);
    const bag = cookieBag(cookieText);
    const channel = channelFromConfig(configText) || channelFromHttp(httpText) || channelFromPage(pageText) || bag.channel;
    const userName = nameIn(parseObject(configText), 0)
      || nameIn(parseObject(httpText), 0)
      || nameIn(parseObject(pageText), 0)
      || nameIn(parseObject(cookieText), 0);
    if (!Object.keys(bag.cookies).length || !channel || !userName) return null;
    return { channel: channel, userName: userName, cookie: cookieHeader(bag.cookies) };
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

  async function call(url, init) {
    if (!allowedHttp(url)) throw fail('domain');
    const request = Object.assign({}, init || {});
    request.redirect = 'manual';
    request.cache = 'no-store';
    let res;
    try { res = await fetchImpl(url, request); } catch (err) { throw fail('network'); }
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (REDIRECT.has(status) || status === 0) {
      await discard(res);
      throw fail('redirect');
    }
    if (res && typeof res.url === 'string' && res.url && !allowedHttp(res.url)) {
      await discard(res);
      throw fail('redirect');
    }
    const text = await readText(res);
    if (status < 200 || status >= 300) throw fail('http');
    return text;
  }

  async function connectSend(spec) {
    if (!allowedWs(spec.url)) throw fail('domain');
    let result;
    try { result = await connectImpl(spec); } catch (err) {
      if (err && CODE_RE.test(err.code)) throw err;
      throw fail('network');
    }
    const status = result && typeof result.status === 'number' ? result.status : 101;
    if (REDIRECT.has(status) || status === 0) throw fail('redirect');
    if (status !== 101 && (status < 200 || status >= 300)) throw fail('http');
  }

  async function perform(auth, text) {
    const body = qs.stringify({
      channel_id: auth.channel,
      mode: 'play',
      client_type: 'pc',
      client_app: 'browser_hls'
    });
    const raw = await call('https://' + HOST + '/api/getControlServer.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': UA_HTTP,
        Origin: 'https://live.fc2.com',
        Referer: 'https://live.fc2.com/' + auth.channel + '/',
        Cookie: auth.cookie,
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: body
    });
    let info;
    try { info = JSON.parse(raw); } catch (err) { throw fail('bad-response'); }
    const target = controlUrl(info);
    if (!target) throw fail('domain');
    const payload = JSON.stringify({
      name: 'send_comment',
      arguments: {
        user_name: auth.userName,
        comment: text,
        lang: 'ja',
        size: 'middle',
        color: 'black',
        image: '',
        anonymous: 0
      },
      id: nonce()
    });
    await connectSend({
      method: 'GET',
      url: target,
      headers: {
        'User-Agent': UA_WS,
        Origin: 'https://live.fc2.com'
      },
      body: payload
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
    const auth = await loadAuth();
    if (!auth) {
      note(false, false);
      log('fail');
      return { ok: false, error: 'no-credentials' };
    }
    if (!takeSlot()) {
      log('fail');
      return { ok: false, error: 'rate-limit' };
    }
    try {
      await perform(auth, input.text);
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
    health() { return { ok: true, detail: 'sink-fc2' }; },
    sendComment: sendComment,
    getStatus: getStatus,
    actions: { getStatus: getStatus }
  };
}

function defaultFetch(url, init) {
  if (!allowedHttp(url)) return Promise.reject(Object.assign(new Error('domain'), { code: 'domain' }));
  return globalThis.fetch(url, Object.assign({}, init || {}, { redirect: 'manual' }));
}

const singleton = createSinkFc2();
singleton.createSinkFc2 = createSinkFc2;
module.exports = singleton;
