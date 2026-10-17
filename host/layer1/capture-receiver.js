'use strict';

/**
 * marust のループバック受信。127.0.0.1:18770 だけ。
 * ルート名は NeonTimer の twitcasting_auth_receiver に合わせる。
 * 題名 API は呼ばない。18766 では listen しない。
 * 保存先は保存場所（core）の cookies / services 配下の marust 専用ディレクトリ。
 * NeonTimer が読む同名ファイルは上書きしない。
 */

const path = require('path');

const { NEON_PORT, MARUST_PORT, productPort, assertBindPort } = require('./port-lock'); // ポートの固定と禁止は port-lock.js（ここからも出す。互換）
const MAX_BODY_BYTES = 1024 * 1024;

const COOKIE_ROUTES = {
  '/twitcasting_auth': 'twitcasting-cookies.json',
  '/niconico_auth': 'niconico-cookies.json',
  '/fc2_auth': 'fc2-cookies.json',
  '/rumble_auth': 'rumble-cookies.json',
  '/api/rumble_cookies': 'rumble-cookies.json',
  '/soop_auth': 'soop-cookies.json'
};

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function resolveRoots(core) {
  if (core && core.COOKIES_DIR && core.SERVICES_DIR) {
    return {
      // 旧い経路（平文）を開くのは、作者の印（core.legacyRoutes。保存場所の差し込み plugins-author/dev-storage-locator だけが付ける）があるときだけ。印が無い・知らない値は閉じる（M7 Must 1）
      via: core.legacyRoutes === true ? 'author' : (core.via === 'local' ? 'local' : 'unknown'),
      cookiesDir: path.join(core.COOKIES_DIR, 'marust'),
      servicesDir: path.join(core.SERVICES_DIR, 'marust')
    };
  }
  const dev = path.join(__dirname, '..', '..', 'dev-state');
  return {
    via: 'dev-state',
    cookiesDir: path.join(dev, 'cookies'),
    servicesDir: path.join(dev, 'services')
  };
}

function loadExtensionAllowlist(stateDir, fs) {
  if (!stateDir) return { unrestricted: true };
  const file = path.join(stateDir, 'services', 'marust-receiver-allowlist.json');
  try {
    if (!fs.existsSync(file)) return { unrestricted: true };
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const ids = data && data.extensionIds;
    if (!Array.isArray(ids) || ids.length === 0) return { unrestricted: true };
    return { unrestricted: false, ids: ids.map((id) => String(id)) };
  } catch (_) {
    return { unrestricted: true };
  }
}

function loopbackHttpOrigin(originHeader) {
  let parsed;
  try {
    parsed = new URL(originHeader);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname;
  // WHATWG hostname may be ::1. This Node reports [::1]. Allow both.
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function extensionAllowed(origin, stateDir, fs) {
  const match = /^chrome-extension:\/\/([^/]+)/.exec(origin || '');
  if (!match) return false;
  const list = loadExtensionAllowlist(stateDir, fs);
  if (list.unrestricted) return true;
  return list.ids.indexOf(match[1]) !== -1;
}

function evaluateAccess(req, stateDir, fs) {
  const remote = req && req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
  const originHeader = req && req.headers && req.headers.origin != null ? String(req.headers.origin) : '';
  if (!isLoopbackAddress(remote)) return { allow: false, status: 400, acao: null };
  if (!originHeader) return { allow: true, status: 200, acao: null };
  if (loopbackHttpOrigin(originHeader)) {
    return { allow: true, status: 200, acao: originHeader };
  }
  if (extensionAllowed(originHeader, stateDir, fs)) {
    return { allow: true, status: 200, acao: originHeader };
  }
  return { allow: false, status: 403, acao: null };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('too-large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function plainCookieObject(data) {
  if (!data || !data.cookies || typeof data.cookies !== 'object' || Array.isArray(data.cookies)) return null;
  if (Object.keys(data.cookies).length === 0) return null;
  return data.cookies;
}

function createCaptureReceiver(options) {
  const opts = options || {};
  const fs = opts.fs || require('fs');
  const core = opts.core || {};
  const writeJson = opts.writeJson || core.atomicWriteJsonSync;
  if (typeof writeJson !== 'function') throw new Error('capture receiver requires atomicWriteJsonSync');
  const roots = resolveRoots(core);
  const stateDir = core.STATE_DIR || '';

  function access(req) {
    return evaluateAccess(req, stateDir, fs);
  }

  function inside(root, file) {
    const base = path.resolve(root);
    const resolved = path.resolve(file);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error('refusing path outside marust state dir');
    }
    return resolved;
  }

  function handle(req, res) {
    const url = (req.url || '/').split('?')[0];
    const isOptions = req.method === 'OPTIONS';
    const isCookie = req.method === 'POST' && Object.prototype.hasOwnProperty.call(COOKIE_ROUTES, url);
    const isCapture = req.method === 'POST' && (url === '/api/rumble_capture' || url === '/api/soop_capture');
    if (!isOptions && !isCookie && !isCapture) return false;
    // 旧い経路（NeonTimer 互換のルート名）はペアリングが無く、平文で書く。作者の PC（作者の印があるとき）だけで受ける。
    // 配る版（local・dev-state）では他のルートと同じく 404 にする。配る拡張は /ext/* で金庫へ入る。
    // OPTIONS はこのファイルのルートの事前確認だけ。/ext/* の OPTIONS は先に ext-receiver が返す。
    if (roots.via !== 'author') return false;

    const decision = access(req);
    if (!decision.allow) {
      sendJson(res, decision.status, { ok: false });
      return true;
    }
    if (decision.acao) res.setHeader('Access-Control-Allow-Origin', decision.acao);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (isOptions) {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (isCookie) {
      readBody(req)
        .then((text) => {
          let data;
          try {
            data = JSON.parse(text);
          } catch (_) {
            sendJson(res, 400, { ok: false });
            return;
          }
          const cookies = plainCookieObject(data);
          if (cookies) {
            const file = inside(roots.cookiesDir, path.join(roots.cookiesDir, COOKIE_ROUTES[url]));
            writeJson(file, data);
            console.log('[marust] cookies saved route=' + url + ' count=' + Object.keys(cookies).length);
          }
          sendJson(res, 200, { ok: true });
        })
        .catch((err) => sendJson(res, err && err.status ? err.status : 400, { ok: false }));
      return true;
    }

    readBody(req)
      .then((text) => {
        let data;
        try {
          data = JSON.parse(text);
        } catch (_) {
          sendJson(res, 400, { ok: false });
          return;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          sendJson(res, 400, { ok: false });
          return;
        }
        const soop = url === '/api/soop_capture';
        const capturedName = soop ? 'soop_captured.json' : 'rumble_captured.json';
        const configName = soop ? 'soop-config.json' : 'rumble-config.json';
        const capturedPath = inside(roots.servicesDir, path.join(roots.servicesDir, capturedName));
        const configPath = inside(roots.servicesDir, path.join(roots.servicesDir, configName));
        writeJson(capturedPath, data);
        const configData = soop
          ? {
              enabled: true,
              platform: 'soop',
              url: data.url,
              method: data.method || 'POST',
              title: data.title || '',
              description: data.description || '',
              cookies: data.cookies || '',
              cookieObj: data.cookieObj || {},
              headers: data.headers || {},
              raw_body: data.body || {},
              pageUrl: data.pageUrl || '',
              updated_at: Date.now()
            }
          : {
              enabled: true,
              url: data.url,
              method: data.method || 'POST',
              description: data.description || '',
              cookies: data.cookies || '',
              headers: data.headers || {},
              raw_body: data.body || {}
            };
        writeJson(configPath, configData);
        console.log('[marust] capture saved route=' + url);
        sendJson(res, 200, { ok: true, success: true });
      })
      .catch((err) => sendJson(res, err && err.status ? err.status : 400, { ok: false }));
    return true;
  }

  return {
    handle,
    roots,
    evaluateAccess: access
  };
}

module.exports = {
  COOKIE_ROUTES,
  MARUST_PORT,
  NEON_PORT,
  createCaptureReceiver,
  productPort,
  assertBindPort,
  resolveRoots,
  evaluateAccess
};
