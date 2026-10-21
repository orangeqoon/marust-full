'use strict';

/**
 * FC2（stream.site@1）。
 * 設定の取得、ページ、保存は live.fc2.com だけ。リダイレクトは追わない。
 * 先に現在の設定を取り、題名だけ差し替えて送る。設定が取れなければ送らない。
 * Cookie は cookies.fc2-main。channel_id は fc2.config、なければ capture。
 * ログイン token はそのリクエストだけで使い、金庫へは書き戻さない。
 * legacy は秘密を読まず通信しない。shadow と dryRun も通信しない。
 */

const qs = require('querystring');

const HOST = 'live.fc2.com';
const HOSTS = new Set([HOST]);
const COOKIE_NAME = 'cookies.fc2-main';
const CONFIG_NAME = 'fc2.config';
const PAGE_NAME = 'capture.fc2-main.page';
const HTTP_NAME = 'capture.fc2-main.fc2-http';
const MAX_BODY = 1024 * 1024;
const MAX_SECRET = 64 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const CHANNEL_RE = /^[0-9]{1,16}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]{1,128}$/;

// L9b: 転送先（Location）。本物の fetch は headers.get、試験の偽の返事は普通のオブジェクト
function locationOf(res) {
  try {
    const h = res && res.headers;
    if (!h) return '';
    if (typeof h.get === 'function') return String(h.get('location') || '');
    return String(h.location || h.Location || '');
  } catch (_) { return ''; }
}

function createSiteFc2(deps) {
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

  function note(ok, title) {
    last.result = ok ? 'ok' : 'ng';
    last.at = nowIso();
    if (ok) last.title = clip(title);
  }

  function cleanChannel(value) {
    const text = typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : (typeof value === 'string' ? value.trim() : '');
    return CHANNEL_RE.test(text) ? text : '';
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
    if (!parsed) return { cookies: Object.create(null), channel: '' };
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

  async function loadAuth(box) {
    const bag = cookieBag(await readRaw(box, COOKIE_NAME));
    const fromConfig = channelFromConfig(await readRaw(box, CONFIG_NAME));
    const fromHttp = channelFromHttp(await readRaw(box, HTTP_NAME));
    const fromPage = channelFromPage(await readRaw(box, PAGE_NAME));
    const channel = fromConfig || fromHttp || fromPage || bag.channel;
    return {
      configured: Object.keys(bag.cookies).length > 0 && !!channel,
      cookies: bag.cookies,
      channel: channel
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

  function parseJson(text) {
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      return data;
    } catch (err) {
      throw fail('bad-response');
    }
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
      // L9b: ログイン画面への転送はログイン切れ（Location に login を含む）。それ以外の転送は今のまま
      const place = locationOf(res);
      await discard(res);
      throw fail(/login/i.test(place) ? 'unauthorized' : 'redirect');
    }
    if (res && typeof res.url === 'string' && res.url && !allowedUrl(res.url)) {
      await discard(res);
      throw fail('redirect');
    }
    const text = await readText(res);
    if (status === 401 || status === 403) throw fail('unauthorized'); // L9b: ログイン切れ
    if (status < 200 || status >= 300) throw fail('http');
    return text;
  }

  function cookieHeader(cookies) {
    const parts = [];
    const keys = Object.keys(cookies);
    for (let i = 0; i < keys.length; i += 1) parts.push(keys[i] + '=' + cookies[keys[i]]);
    return parts.join('; ');
  }

  function formHeaders(cookies, channel) {
    return {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieHeader(cookies),
      Origin: 'https://live.fc2.com',
      Referer: 'https://live.fc2.com/' + channel + '/',
      'User-Agent': UA
    };
  }

  function loginToken(html) {
    if (typeof html !== 'string' || !html) return '';
    const login = html.match(/loginToken:\s*['"]([a-f0-9]{32,64})['"]/i);
    if (login) return login[1];
    const token = html.match(/token:\s*['"]([a-f0-9]{32,64})['"]/i);
    return token ? token[1] : '';
  }

  function setPayload(channel, title, cur, token) {
    return {
      mode: 'set',
      type: 'json',
      streamid: channel,
      title: title,
      info: cur.info || '',
      adultflg: cur.adultFlg ?? 0,
      tweetflg: cur.tweetFlg ?? 0,
      tfollowflg: cur.tfollowFlg ?? 0,
      loginonly: cur.loginFlg ?? 0,
      giftlimit: cur.giftLimitFlg ?? 0,
      image: cur.image || '',
      feeflg: cur.feeFlg ?? 0,
      recordflg: cur.recordFlg ?? 1,
      embedflg: cur.embedFlg ?? 1,
      feesetting: cur.feeSetting ?? 0,
      stereo3d: cur.stereo3d ?? 0,
      mapping: cur.mapping ?? 0,
      horizontalview: cur.horizontalView ?? 0,
      token: token
    };
  }

  async function perform(auth, title) {
    const channel = auth.channel;
    const getText = await call('https://live.fc2.com/api/channelEdit.php', {
      method: 'POST',
      headers: formHeaders(auth.cookies, channel),
      body: qs.stringify({ mode: 'get', streamid: channel, type: 'json' })
    });
    const current = parseJson(getText);
    if (current && current.status === 0) {
      const msg = Array.isArray(current.msg) ? current.msg.join(' ') : String(current.msg || '');
      if (/ログイン|login/i.test(msg)) {
        throw fail('unauthorized');
      }
    }
    if (!current || current.status !== 1 || !current.data || typeof current.data !== 'object' || Array.isArray(current.data)) {
      throw fail('settings-unavailable');
    }
    const pageText = await call('https://live.fc2.com/' + channel + '/', {
      method: 'GET',
      headers: {
        Cookie: cookieHeader(auth.cookies),
        'User-Agent': UA
      }
    });
    const token = loginToken(pageText);
    if (!token) throw fail('token-missing');
    const setText = await call('https://live.fc2.com/api/channelEdit.php', {
      method: 'POST',
      headers: formHeaders(auth.cookies, channel),
      body: qs.stringify(setPayload(channel, title, current.data, token))
    });
    const saved = parseJson(setText);
    if (saved && saved.status === 0) {
      const msg = Array.isArray(saved.msg) ? saved.msg.join(' ') : String(saved.msg || '');
      if (/ログイン|login/i.test(msg)) throw fail('unauthorized');
    }
    if (!saved || (saved.status !== 1 && saved.status !== 2)) throw fail('http');
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
      note(true, title);
      log('updated');
      return { ok: true };
    } catch (err) {
      const code = err && CODE_RE.test(err.code) ? err.code : 'http';
      note(false, '');
      log('failed');
      return { ok: false, error: code };
    }
  }

  function enqueue(work) {
    const job = chain.then(work, work);
    chain = job.then(() => {}, () => {});
    return job;
  }

  // 足りない物を種類だけで答える（値・チャンネル ID は返さない）。isConfigured はこれの ready と同じ答え
  async function loginNeeds() {
    if (modeOf(ctx) === 'legacy') return { ready: false, need: 'mode', how: 'toggle' }; // 送信オフ。ログインの不足ではない
    const auth = await loadAuth(ctx);
    if (Object.keys(auth.cookies).length === 0) return { ready: false, need: 'cookies', how: 'extension' };
    if (!auth.channel) return { ready: false, need: 'channel', how: 'extension' };
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
    health() { return { ok: true, detail: 'site-fc2' }; },
    isConfigured: isConfigured,
    loginNeeds: loginNeeds,
    getStatus: getStatus,
    updateMetadata: updateMetadata,
    updateTitle: updateTitle,
    actions: { getStatus: getStatus }
  };
}

const singleton = createSiteFc2();
singleton.createSiteFc2 = createSiteFc2;
module.exports = singleton;
