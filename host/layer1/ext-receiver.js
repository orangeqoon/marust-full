'use strict';

/**
 * 拡張「Marust」の受け口。POST /ext/cookies、POST /ext/capture、GET /ext/status、各 OPTIONS。
 * 認証は Bearer と、Origin の拡張 id が保存済み extensionId と一致すること。kind は extension。
 * 保存は金庫。応答・イベント・監査に Cookie の値と capture の中身は入れない。
 * CORS はペア済みの拡張 Origin にだけ付ける。
 */

const { EVENTS } = require('../core');
const { createAudit } = require('./audit');
const { NAME_RE, MAX_SECRET_BYTES } = require('../core');

const SITE_ID_RE = /^[a-z0-9-]{1,32}$/;

// 拡張が預けてよいサイトは、読み込んだプラグインの manifest.site.id（名簿はサイトのプラグインが持つ）。
function siteIdsFromRows(rows) {
  const seen = new Set();
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const site = list[i] && list[i].manifest && list[i].manifest.site;
    const id = site && typeof site.id === 'string' ? site.id : '';
    if (!SITE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return out;
}
const ACCOUNT_RE = /^[a-z0-9-]{1,32}$/;
const KIND_RE = /^[a-z0-9-]{1,32}$/;
const EXTENSION_ID_RE = /^[a-p]{32}$/;
const CAPTURED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CODE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const LABEL_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const LIVE_STATES = new Set([
  'live',
  'connecting',
  'reconnecting',
  'OBS_WEBSOCKET_OUTPUT_STARTED',
  'OBS_WEBSOCKET_OUTPUT_STARTING'
]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_COOKIES = 300;
const MAX_COOKIE_BYTES = 8 * 1024;
const MAX_COOKIE_NAME = 256;
const MAX_PER_SEC = 5;
const WINDOW_MS = 1000;
const MAX_ERRORS = 8;
const PATHS = new Set(['/ext/cookies', '/ext/capture', '/ext/status']);

function extensionIdFromOrigin(origin) {
  if (typeof origin !== 'string') return '';
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return match && EXTENSION_ID_RE.test(match[1]) ? match[1] : '';
}

function originHeader(req) {
  return req && req.headers && req.headers.origin != null ? String(req.headers.origin) : '';
}

function bearerToken(req) {
  const raw = req.headers && req.headers.authorization != null ? String(req.headers.authorization) : '';
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match ? match[1] : '';
}

function pathnameOf(req) {
  const raw = req && req.url ? String(req.url) : '/';
  try {
    return decodeURIComponent(new URL(raw, 'http://127.0.0.1:18770').pathname);
  } catch (_) {
    return '/';
  }
}

function sendJson(res, status, obj, extra) {
  if (!res || res.writableEnded) return;
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  }, extra || {});
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', function (chunk) {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        const err = new Error('too-large');
        err.status = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (failed) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', function (err) {
      if (failed) return;
      failed = true;
      reject(err);
    });
  });
}

function drain(req) {
  if (req && typeof req.resume === 'function') req.resume();
}

function hasPerm(client, name) {
  return !!(client && Array.isArray(client.permissions) && client.permissions.indexOf(name) !== -1);
}

function accountOf(data) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'account') || data.account == null || data.account === '') {
    return 'main';
  }
  if (typeof data.account !== 'string' || !ACCOUNT_RE.test(data.account)) return '';
  return data.account;
}

function siteOf(data, allowed) {
  if (!data || typeof data.site !== 'string' || !allowed || !allowed.has(data.site)) return '';
  return data.site;
}

function kindOfCapture(data) {
  if (!data || typeof data.kind !== 'string' || !KIND_RE.test(data.kind)) return '';
  return data.kind;
}

function vaultName(value) {
  return typeof value === 'string' && NAME_RE.test(value) ? value : '';
}

function stampOf(value, atMs) {
  if (typeof value === 'string' && CAPTURED_AT_RE.test(value)) return value;
  const when = Number.isFinite(atMs) ? atMs : Date.now();
  return new Date(when).toISOString();
}

function copyCookies(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'cookies' };
  const keys = Object.keys(input);
  if (keys.length > MAX_COOKIES) return { error: 'too-many' };
  const out = Object.create(null);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key !== 'string' || key.length < 1 || key.length > MAX_COOKIE_NAME) return { error: 'bad-cookie' };
    if (/[\r\n\u0000]/.test(key)) return { error: 'bad-cookie' };
    const value = input[key];
    if (typeof value !== 'string') return { error: 'bad-cookie' };
    if (Buffer.byteLength(value, 'utf8') > MAX_COOKIE_BYTES) return { error: 'too-large' };
    out[key] = value;
  }
  return { cookies: out, count: keys.length };
}

function safeCode(value) {
  if (typeof value !== 'string' || !value || !CODE_RE.test(value)) return '';
  return value;
}

function safeLabel(value) {
  if (typeof value !== 'string' || !LABEL_RE.test(value)) return '';
  return value;
}

// 送信中＝engineState、配信中＝siteLive（GLOSSARY）。ここで数えるのは送信中だけ。
function isLive(actual) {
  if (!actual || typeof actual !== 'object') return false;
  const state = typeof actual.engineState === 'string' ? actual.engineState : '';
  return LIVE_STATES.has(state);
}

function createExtReceiver(options) {
  const opts = options || {};
  const clients = opts.clients;
  const secrets = opts.secrets || null;
  const bus = opts.bus || null;
  const store = opts.store || null;
  const engine = opts.engine || null;
  const core = opts.core || {};
  const plugins = opts.plugins || null;
  function allowedSites() {
    const rows = plugins && typeof plugins.snapshot === 'function' ? plugins.snapshot() : [];
    return new Set(siteIdsFromRows(rows));
  }
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  const audit = opts.audit || createAudit({ core: core, now: function () { return new Date(now()); } });
  const hits = new Map();

  function record(client, method, names, ok, error) {
    if (!audit || typeof audit.write !== 'function') return;
    const list = [];
    const given = Array.isArray(names) ? names : [];
    for (let i = 0; i < given.length; i += 1) {
      if (typeof given[i] === 'string') list.push(given[i]);
    }
    try {
      audit.write({
        clientId: client && client.id ? client.id : '',
        kind: 'extension',
        method: method,
        paramNames: list,
        ok: ok === true,
        error: ok === true ? '' : (error || '')
      });
    } catch (_) { /* 監査の失敗で応答を止めない */ }
  }

  function pairedOriginId(origin) {
    const id = extensionIdFromOrigin(origin);
    if (!id || !clients || typeof clients.list !== 'function') return '';
    const rows = clients.list();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row && row.kind === 'extension' && row.extensionId === id) return id;
    }
    return '';
  }

  function corsHeaders(originId) {
    if (!originId) return {};
    return {
      'Access-Control-Allow-Origin': 'chrome-extension://' + originId,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin'
    };
  }

  function tooFast(clientId) {
    const at = now();
    const prev = hits.get(clientId) || [];
    const fresh = [];
    for (let i = 0; i < prev.length; i += 1) {
      if (at - prev[i] < WINDOW_MS) fresh.push(prev[i]);
    }
    if (fresh.length >= MAX_PER_SEC) {
      hits.set(clientId, fresh);
      return true;
    }
    fresh.push(at);
    hits.set(clientId, fresh);
    return false;
  }

  function authenticate(req) {
    const token = bearerToken(req);
    if (!token || !clients || typeof clients.authenticate !== 'function') {
      return { status: 401, error: 'unauthorized' };
    }
    const client = clients.authenticate(token);
    if (!client || client.kind !== 'extension') return { status: 401, error: 'unauthorized' };
    const originId = extensionIdFromOrigin(originHeader(req));
    if (!originId || originId !== client.extensionId) return { status: 403, error: 'origin' };
    return { client: client };
  }

  function reply(res, status, body, extra, req) {
    if (req) drain(req);
    sendJson(res, status, body, extra);
  }

  function publishCookies(site, account, count, at) {
    if (!bus || typeof bus.publish !== 'function') return;
    bus.publish(EVENTS.AUTH_UPDATED, {
      site: site,
      account: account,
      count: count,
      at: at
    }, { source: 'extension' });
  }

  function destinationView() {
    let rows = [];
    try {
      if (store && typeof store.snapshot === 'function') {
        const snap = store.snapshot();
        rows = snap && Array.isArray(snap.destinations) ? snap.destinations : [];
      }
    } catch (_) {
      rows = [];
    }
    const destinations = [];
    const errors = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;
      const actual = row.actual && typeof row.actual === 'object' ? row.actual : {};
      const name = safeLabel(row.id);
      const site = safeLabel(row.site);
      const code = safeCode(actual.lastError);
      const at = typeof actual.updatedAt === 'string' ? actual.updatedAt : '';
      if (code && name) errors.push({ name: name, code: code, at: at });
      if (!isLive(actual) || !name) continue;
      const status = safeLabel(actual.engineState);
      if (!status) continue;
      const item = { name: name, status: status };
      if (actual.siteLive === true) item.siteLive = true;
      if (site) item.site = site;
      destinations.push(item);
    }
    errors.sort(function (a, b) {
      if (a.at === b.at) return 0;
      return a.at < b.at ? 1 : -1;
    });
    const trimmed = [];
    for (let i = 0; i < errors.length && trimmed.length < MAX_ERRORS; i += 1) {
      trimmed.push({ name: errors[i].name, code: errors[i].code });
    }
    return { destinations: destinations, errors: trimmed };
  }

  function engineConnected() {
    if (!engine || typeof engine.status !== 'function') return Promise.resolve(false);
    return Promise.resolve().then(function () { return engine.status(); }).then(function (status) {
      return !!(status && status.connected === true);
    }).catch(function () { return false; });
  }

  function saveSecret(client, method, name, json, count) {
    const names = count == null ? [name] : [name, 'count:' + String(count)];
    if (!secrets || typeof secrets.set !== 'function') {
      record(client, method, names, false, 'vault-unavailable');
      return Promise.resolve({ status: 503, body: { ok: false, error: 'vault-unavailable' } });
    }
    const actor = 'extension:' + (client && client.id ? client.id : '');
    return Promise.resolve().then(function () {
      return secrets.set(name, json, actor);
    }).then(function (saved) {
      if (saved && saved.ok === true) return { status: 200 };
      const code = saved && saved.error === 'unavailable' ? 'vault-unavailable' : (saved && saved.error ? saved.error : 'vault-unavailable');
      const status = code === 'vault-unavailable' ? 503 : 400;
      const error = code === 'vault-unavailable' ? 'vault-unavailable' : code;
      record(client, method, names, false, error);
      return { status: status, body: { ok: false, error: error } };
    }).catch(function () {
      record(client, method, names, false, 'vault-unavailable');
      return { status: 503, body: { ok: false, error: 'vault-unavailable' } };
    });
  }

  function acceptCookies(client, data) {
    const site = siteOf(data, allowedSites());
    if (!site) return Promise.resolve({ status: 400, body: { ok: false, error: 'site' } });
    const account = accountOf(data);
    if (!account) return Promise.resolve({ status: 400, body: { ok: false, error: 'account' } });
    const copied = copyCookies(data.cookies);
    if (copied.error) return Promise.resolve({ status: 400, body: { ok: false, error: copied.error } });
    const name = vaultName('cookies.' + site + '-' + account);
    if (!name) return Promise.resolve({ status: 400, body: { ok: false, error: 'bad-name' } });
    const json = JSON.stringify(copied.cookies);
    if (Buffer.byteLength(json, 'utf8') > MAX_SECRET_BYTES) {
      return Promise.resolve({ status: 400, body: { ok: false, error: 'too-large' } });
    }
    const at = stampOf(data.capturedAt, now());
    return saveSecret(client, 'ext.cookies', name, json, copied.count).then(function (result) {
      if (result.status !== 200) return result;
      publishCookies(site, account, copied.count, at);
      record(client, 'ext.cookies', [name, 'count:' + String(copied.count)], true, '');
      return { status: 200, body: { ok: true, count: copied.count } };
    });
  }

  function acceptCapture(client, data) {
    const site = siteOf(data, allowedSites());
    if (!site) return Promise.resolve({ status: 400, body: { ok: false, error: 'site' } });
    const account = accountOf(data);
    if (!account) return Promise.resolve({ status: 400, body: { ok: false, error: 'account' } });
    const kind = kindOfCapture(data);
    if (!kind) return Promise.resolve({ status: 400, body: { ok: false, error: 'kind' } });
    if (!Object.prototype.hasOwnProperty.call(data, 'data') || data.data == null) {
      return Promise.resolve({ status: 400, body: { ok: false, error: 'data' } });
    }
    let json;
    try {
      json = JSON.stringify(data.data);
    } catch (_) {
      return Promise.resolve({ status: 400, body: { ok: false, error: 'data' } });
    }
    if (typeof json !== 'string') return Promise.resolve({ status: 400, body: { ok: false, error: 'data' } });
    if (Buffer.byteLength(json, 'utf8') > MAX_SECRET_BYTES) {
      return Promise.resolve({ status: 400, body: { ok: false, error: 'too-large' } });
    }
    const name = vaultName('capture.' + site + '-' + account + '.' + kind);
    if (!name) return Promise.resolve({ status: 400, body: { ok: false, error: 'bad-name' } });
    return saveSecret(client, 'ext.capture', name, json, null).then(function (result) {
      if (result.status !== 200) return result;
      record(client, 'ext.capture', [name], true, '');
      return { status: 200, body: { ok: true } };
    });
  }

  function acceptWrite(pathname, client, text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      record(client, pathname === '/ext/capture' ? 'ext.capture' : 'ext.cookies', [], false, 'bad-json');
      return Promise.resolve({ status: 400, body: { ok: false, error: 'bad-json' } });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      record(client, pathname === '/ext/capture' ? 'ext.capture' : 'ext.cookies', [], false, 'bad-json');
      return Promise.resolve({ status: 400, body: { ok: false, error: 'bad-json' } });
    }
    if (pathname === '/ext/capture') return acceptCapture(client, data);
    return acceptCookies(client, data);
  }

  function methodOk(pathname, method) {
    if (pathname === '/ext/status') return method === 'GET';
    return method === 'POST';
  }

  function handle(req, res) {
    const pathname = pathnameOf(req);
    if (!PATHS.has(pathname)) return false;
    const paired = pairedOriginId(originHeader(req));
    const extra = corsHeaders(paired);

    if (req.method === 'OPTIONS') {
      if (!paired) {
        reply(res, 403, { ok: false, error: 'origin' }, {}, req);
        return true;
      }
      if (res.writableEnded) return true;
      res.writeHead(204, Object.assign({
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Length': '0'
      }, extra));
      res.end();
      return true;
    }

    const auth = authenticate(req);
    if (!auth.client) {
      reply(res, auth.status, { ok: false, error: auth.error }, extra, req);
      return true;
    }
    const client = auth.client;
    if (!methodOk(pathname, req.method)) {
      reply(res, 405, { ok: false, error: 'method' }, extra, req);
      return true;
    }
    if (pathname === '/ext/status') {
      if (!hasPerm(client, 'read')) {
        reply(res, 403, { ok: false, error: 'forbidden' }, extra, req);
        return true;
      }
      engineConnected().then(function (connected) {
        const view = destinationView();
        sendJson(res, 200, {
          ok: true,
          running: true,
          engine: { connected: connected },
          destinations: view.destinations,
          errors: view.errors
        }, extra);
      }).catch(function () {
        sendJson(res, 200, {
          ok: true,
          running: true,
          engine: { connected: false },
          destinations: [],
          errors: []
        }, extra);
      });
      return true;
    }
    if (!hasPerm(client, 'ext-write')) {
      reply(res, 403, { ok: false, error: 'forbidden' }, extra, req);
      return true;
    }
    if (tooFast(client.id)) {
      reply(res, 429, { ok: false, error: 'rate' }, extra, req);
      return true;
    }
    readBody(req, MAX_BODY_BYTES).then(function (text) {
      return acceptWrite(pathname, client, text);
    }).then(function (result) {
      sendJson(res, result.status, result.body, extra);
    }).catch(function (err) {
      const status = err && err.status === 413 ? 413 : 400;
      sendJson(res, status, { ok: false, error: status === 413 ? 'too-large' : 'bad-body' }, extra);
    });
    return true;
  }

  return { handle: handle };
}

module.exports = {
  createExtReceiver,
  extensionIdFromOrigin,
  siteIdsFromRows,
  MAX_BODY_BYTES,
  MAX_COOKIES,
  MAX_COOKIE_BYTES,
  MAX_PER_SEC
};
