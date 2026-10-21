'use strict';

/**
 * 窓口。127.0.0.1:18770 の HTTP と WebSocket。
 * 画面・静的ファイル・ペアリング・Cookie 受信（capture-receiver）をここから配る。
 * Origin が付いている接続は、今までどおり許可リストと Cookie だけを見る（Bearer では入らない）。
 * Origin が無い接続だけ native。Authorization: Bearer が必須で、持ち主の kind は native。
 * 拡張は POST /pair/extension と /ext/* だけ。WebSocket には入れない。
 */

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { assertBindPort, MARUST_PORT } = require('../port-lock');
const { createClients } = require('../clients');
const { createExtReceiver, extensionIdFromOrigin } = require('../ext-receiver');
const { PANEL_CSP, OVERLAY_CSP } = require('../plugin-surface');
const { secretMask } = require('../../core');
const util = require('./http-util');
const { createSockets } = require('./sockets');
const { createPluginServe } = require('./plugin-serve');
const { CSP, HOSTS, MAX_PER_SEC, MAX_WS, ORIGINS, UI_EXT, VENDOR_EXT, bearerToken, hostOk, nativeNameOk, originOk, originPresent, pathnameOf, readBody, readCookie, rejectUpgrade, safeFile, searchOf, sendFile, sendJson, sessionCookie } = util;

function createGateway(options) {
  const opts = options || {};
  const core = opts.core || {};
  const receiver = opts.receiver;
  if (!receiver || typeof receiver.handle !== 'function') throw new Error('gateway requires capture receiver handle');
  const uiRoot = opts.uiRoot || path.join(__dirname, '..', '..', '..', 'ui');
  const vendorRoot = opts.vendorRoot || path.join(__dirname, '..', '..', '..', 'node_modules', 'dockview');
  const clients = opts.clients || createClients({ core: core });
  // false なら、ブラウザは 6 桁コード無しで入れる（凍結中。docs/FROZEN.md）。既定は従来どおり認証あり。
  const webAuth = opts.webAuth !== false;
  const layouts = opts.layouts || null;
  const api = opts.api || null;
  const bus = opts.bus || null;
  const pluginSource = opts.plugins || opts.registry || null;
  const overlayHub = opts.overlayHub || (pluginSource && pluginSource.overlayHub) || null;
  const onStatus = opts.onStatus;
  const sockets = new Map();
  const socketGrants = new WeakMap();
  const extReceiver = opts.extReceiver || createExtReceiver({
    clients: clients,
    secrets: opts.secrets || null,
    bus: bus,
    audit: opts.audit || null,
    core: core,
    store: opts.store || null,
    engine: opts.engine || null,
    now: opts.now,
    plugins: pluginSource
  });

  function sessionClient(req) {
    return clients.authenticate(readCookie(req, 'marust_session'));
  }

  function nativeClient(req) {
    const token = bearerToken(req);
    if (!token) return null;
    const client = clients.authenticate(token);
    if (!client || client.kind !== 'native') return null;
    return client;
  }

  function servePair(res) {
    const file = path.join(uiRoot, 'pair.html');
    sendFile(res, file, true);
  }

  // 部品どうしの呼び合い（S.fn）
  const fn = {};
  const S = { opts, fn, core, receiver, uiRoot, vendorRoot, clients, webAuth, layouts, api, bus, pluginSource, overlayHub, onStatus, sockets, socketGrants, extReceiver, sessionClient, nativeClient, servePair };
  Object.assign(fn, createSockets(S));
  Object.assign(fn, createPluginServe(S));
  const { broadcast, closeClient, servePluginSurface, track } = fn;

  const server = http.createServer(function (req, res) {
    if (!hostOk(req)) {
      sendJson(res, 421, { ok: false, error: 'bad-host' });
      return;
    }
    const pathname = pathnameOf(req);
    if (servePluginSurface(req, res, pathname)) return;
    if (req.method === 'POST' && pathname === '/pair/native') {
      if (originPresent(req)) {
        sendJson(res, 403, { ok: false, error: 'origin' });
        return;
      }
      readBody(req, 65536).then(function (text) {
        let data;
        try { data = JSON.parse(text); } catch (_) {
          sendJson(res, 400, { ok: false, error: 'bad-json' });
          return;
        }
        const name = nativeNameOk(data && data.name);
        if (!name) {
          sendJson(res, 400, { ok: false, error: 'name' });
          return;
        }
        const code = data && typeof data.code === 'string' ? data.code : '';
        const result = clients.redeem(code, { kind: 'native', name: name });
        if (!result.ok) {
          sendJson(res, 401, { ok: false, error: result.error || 'bad-code' });
          return;
        }
        sendJson(res, 200, { ok: true, token: result.token, client: result.client });
      }).catch(function (err) {
        sendJson(res, err && err.status ? err.status : 400, { ok: false });
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/pair/extension') {
      const extensionId = extensionIdFromOrigin(req.headers && req.headers.origin != null ? String(req.headers.origin) : '');
      if (!extensionId) {
        sendJson(res, 403, { ok: false, error: 'origin' });
        return;
      }
      readBody(req, 65536).then(function (text) {
        let data;
        try { data = JSON.parse(text); } catch (_) {
          sendJson(res, 400, { ok: false, error: 'bad-json' });
          return;
        }
        const name = nativeNameOk(data && data.name);
        if (!name) {
          sendJson(res, 400, { ok: false, error: 'name' });
          return;
        }
        const rawCode = data && typeof data.code === 'string' ? data.code.trim() : '';
        const isAuto = !rawCode || data.auto === true;
        let result;
        if (isAuto && typeof clients.issueExtension === 'function') {
          result = clients.issueExtension({ name: name, extensionId: extensionId });
        } else {
          result = clients.redeem(rawCode, { kind: 'extension', name: name, extensionId: extensionId });
        }
        if (!result.ok) {
          const error = result.error || 'bad-code';
          const status = error === 'name' ? 400 : (error === 'origin' ? 403 : 401);
          sendJson(res, status, { ok: false, error: error });
          return;
        }
        sendJson(res, 200, { ok: true, token: result.token, clientId: result.client.id });
      }).catch(function (err) {
        sendJson(res, err && err.status ? err.status : 400, { ok: false });
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/pair') {
      if (!originOk(req)) {
        sendJson(res, 403, { ok: false, error: 'origin' });
        return;
      }
      readBody(req, 65536).then(function (text) {
        let data;
        try { data = JSON.parse(text); } catch (_) {
          sendJson(res, 400, { ok: false, error: 'bad-json' });
          return;
        }
        const code = data && typeof data.code === 'string' ? data.code : '';
        const result = clients.redeem(code);
        if (!result.ok) {
          sendJson(res, 401, { ok: false, error: result.error || 'bad-code' });
          return;
        }
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(result.token) });
      }).catch(function (err) {
        sendJson(res, err && err.status ? err.status : 400, { ok: false });
      });
      return;
    }
    if (extReceiver.handle(req, res) === true) return;
    if (receiver.handle(req, res) === true) return;

    if (req.method === 'GET' && pathname === '/health') {
      Promise.resolve().then(function () {
        return typeof onStatus === 'function' ? onStatus() : { name: 'marust', receiver: true };
      }).then(function (body) {
        sendJson(res, 200, body);
      }).catch(function () {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }

    if (!webAuth && req.method === 'GET' && (pathname === '/pair' || pathname === '/' || pathname === '/index.html') && !sessionClient(req)) {
      const issued = clients.issueBrowserSession('ブラウザ');
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': sessionCookie(issued.token),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/pair') {
      if (sessionClient(req)) {
        res.writeHead(302, {
          Location: '/',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        });
        res.end();
        return;
      }
      servePair(res);
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (!sessionClient(req)) {
        servePair(res);
        return;
      }
      sendFile(res, path.join(uiRoot, 'hub.html'), true);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/ui/')) {
      const rel = pathname.slice('/ui/'.length);
      const file = safeFile(uiRoot, rel, UI_EXT);
      if (!file) {
        res.writeHead(404, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendFile(res, file, path.extname(file).toLowerCase() === '.html');
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/vendor/dockview/')) {
      const rel = pathname.slice('/vendor/dockview/'.length);
      if (!rel.startsWith('dist/')) {
        res.writeHead(404, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const file = safeFile(vendorRoot, rel, VENDOR_EXT);
      if (!file) {
        res.writeHead(404, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendFile(res, file, false);
      return;
    }

    res.writeHead(404, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS });

  server.on('upgrade', function (req, socket, head) {
    if (!hostOk(req)) {
      rejectUpgrade(socket, 403);
      return;
    }
    let client = null;
    if (originPresent(req)) {
      if (!originOk(req)) {
        rejectUpgrade(socket, 403);
        return;
      }
      const pathname = pathnameOf(req);
      if (pathname !== '/ws') {
        rejectUpgrade(socket, 404);
        return;
      }
      client = sessionClient(req);
    } else {
      const pathname = pathnameOf(req);
      if (pathname !== '/ws') {
        rejectUpgrade(socket, 404);
        return;
      }
      client = nativeClient(req);
    }
    if (!client || client.kind === 'extension') {
      rejectUpgrade(socket, 401);
      return;
    }
    wss.handleUpgrade(req, socket, head, function (ws) {
      track(client.id, ws, client.permissions);
      ws.on('error', function () {
        try { ws.close(1009, 'size'); } catch (_) { /* already closing */ }
      });
      const times = [];
      ws.on('message', function (data) {
        const now = Date.now();
        while (times.length && now - times[0] >= 1000) times.shift();
        times.push(now);
        if (times.length > MAX_PER_SEC) {
          ws.close(1008, 'rate');
          return;
        }
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        if (Buffer.byteLength(text) > MAX_WS) {
          ws.close(1009, 'size');
          return;
        }
        let msg;
        try {
          msg = JSON.parse(text);
        } catch (_) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || (msg.jsonrpc != null && msg.jsonrpc !== '2.0') || typeof msg.method !== 'string') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null,
            error: { code: -32600, message: 'Invalid Request' }
          }));
          return;
        }
        const ctx = {
          permissions: client.permissions,
          via: 'ws',
          clientId: client.id,
          kind: client.kind,
          requiresApproval: client.requiresApproval === true
        };
        const call = api && typeof api.call === 'function'
          ? api.call(msg.method, msg.params, ctx)
          : Promise.resolve({ ok: false, error: 'no-api' });
        Promise.resolve(call).then(function (result) {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id == null ? null : msg.id, result: secretMask.maskDeep(result) }));
        }).catch(function () {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id == null ? null : msg.id, result: secretMask.maskDeep({ ok: false, error: 'failed' }) }));
        });
      });
    });
  });

  server.on('error', function (err) {
    const code = err && err.code ? err.code : 'error';
    console.error('[marust] gateway ' + code);
  });

  function listen(port) {
    const n = assertBindPort(port == null ? MARUST_PORT : port);
    return new Promise(function (resolve, reject) {
      const onError = function (err) { reject(err); };
      server.once('error', onError);
      server.listen(n, '127.0.0.1', function () {
        server.removeListener('error', onError);
        resolve(server);
      });
    });
  }

  function close() {
    try {
      for (const set of sockets.values()) {
        for (const ws of set) {
          try { ws.terminate(); } catch (_) {}
        }
      }
      sockets.clear();
    } catch (_) {}
    try {
      if (wss && typeof wss.close === 'function') wss.close();
    } catch (_) {}
    try {
      if (server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      if (server && typeof server.close === 'function') {
        server.close();
      }
    } catch (_) {}
  }

  return {
    server: server,
    listen: listen,
    clients: clients,
    layouts: layouts,
    closeClient: closeClient,
    broadcast: broadcast,
    searchOf: searchOf,
    close: close
  };
}

module.exports = {
  createGateway,
  HOSTS,
  ORIGINS,
  CSP,
  PANEL_CSP,
  OVERLAY_CSP,
  sessionCookie,
  MAX_WS,
  MAX_PER_SEC
};
