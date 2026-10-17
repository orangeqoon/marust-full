'use strict';

/**
 * 窓口の HTTP の道具（計画 X・S8b。host/core/gateway.js から機械的に移した。動きは変えていない）。
 * 許す Host／Origin・CSP・Cookie・本文の読み取り・JSON と文書の返し方・静的ファイルの安全な場所の判定。状態を持たない。
 */

const fs = require('fs');
const path = require('path');
const { secretMask } = require('../../core');

const HOSTS = new Set(['127.0.0.1:18770', 'localhost:18770']);
const ORIGINS = new Set(['http://127.0.0.1:18770', 'http://localhost:18770']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:18770 ws://localhost:18770; img-src 'self' data:; frame-ancestors 'self'";
const MAX_WS = 64 * 1024;
const MAX_PER_SEC = 50;
const UI_EXT = new Set(['.js', '.css', '.html', '.json', '.md', '.svg', '.png', '.jpg', '.webp']);
const VENDOR_EXT = new Set(['.js', '.css', '.map', '.svg', '.woff', '.woff2']);

function sessionCookie(token) {
  return 'marust_session=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Strict; Path=/';
}

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie ? String(req.headers.cookie) : '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch (_) {
        return '';
      }
    }
  }
  return '';
}

function hostOk(req) {
  const host = req.headers && req.headers.host != null ? String(req.headers.host) : '';
  return HOSTS.has(host.toLowerCase());
}

function originOk(req) {
  const origin = req.headers && req.headers.origin != null ? String(req.headers.origin) : '';
  return ORIGINS.has(origin);
}

function originPresent(req) {
  return !!(req.headers && Object.prototype.hasOwnProperty.call(req.headers, 'origin'));
}

function bearerToken(req) {
  const raw = req.headers && req.headers.authorization != null ? String(req.headers.authorization) : '';
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match ? match[1] : '';
}

function nativeNameOk(name) {
  if (typeof name !== 'string') return '';
  const text = name.trim();
  if (text.length < 1 || text.length > 40) return '';
  if (/[\r\n\u0000]/.test(text)) return '';
  return text;
}

function pathnameOf(req) {
  const raw = req.url || '/';
  try {
    const parsed = new URL(raw, 'http://127.0.0.1:18770');
    return decodeURIComponent(parsed.pathname);
  } catch (_) {
    return '/';
  }
}

function searchOf(req) {
  const raw = req.url || '/';
  try {
    return new URL(raw, 'http://127.0.0.1:18770').search || '';
  } catch (_) {
    return '';
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.json' || ext === '.map') return 'application/json; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

function safeFile(root, rel, allowed) {
  if (!root || rel == null) return null;
  if (rel.includes('\0')) return null;
  let base;
  try {
    base = fs.realpathSync(root);
  } catch (_) {
    return null;
  }
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  const ext = path.extname(resolved).toLowerCase();
  if (!allowed.has(ext)) return null;
  if (!fs.existsSync(resolved)) return null;
  let real;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    real = fs.realpathSync(resolved);
  } catch (_) {
    return null;
  }
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return real;
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('too-large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extra) {
  if (res.writableEnded) return;
  const safeObj = secretMask ? secretMask.maskDeep(obj) : obj;
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  }, extra || {});
  res.writeHead(status, headers);
  res.end(JSON.stringify(safeObj));
}

function sendDocument(res, status, body, extra) {
  if (res.writableEnded) return;
  const headers = Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  }, extra || {});
  res.writeHead(status, headers);
  res.end(body);
}

function sendFile(res, file, asDocument, csp) {
  const body = fs.readFileSync(file);
  const headers = {
    'Content-Type': contentType(file),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  };
  if (asDocument) headers['Content-Security-Policy'] = csp || CSP;
  res.writeHead(200, headers);
  res.end(body);
}

function notFound(res) {
  if (res.writableEnded) return;
  res.writeHead(404, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end();
}

function rejectUpgrade(socket, status) {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden';
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  } catch (_) { /* already gone */ }
  socket.destroy();
}

module.exports = {
  HOSTS,
  ORIGINS,
  CSP,
  MAX_WS,
  MAX_PER_SEC,
  UI_EXT,
  VENDOR_EXT,
  sessionCookie,
  readCookie,
  hostOk,
  originOk,
  originPresent,
  bearerToken,
  nativeNameOk,
  pathnameOf,
  searchOf,
  contentType,
  safeFile,
  readBody,
  sendJson,
  sendDocument,
  sendFile,
  notFound,
  rejectUpgrade
};
