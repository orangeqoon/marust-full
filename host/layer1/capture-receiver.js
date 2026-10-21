'use strict';

/**
 * marust のループバック受信の入口。127.0.0.1:18770 だけ。18766 では listen しない。
 * 拡張からの受け取りは ext-receiver（/ext/*。ペアリングと金庫）。ここには平文の受け口は無い。
 * 同じ口に載せる CORS の確認（evaluateAccess）と、ポートの固定（port-lock.js）を出す。
 */

const path = require('path');

const { RESERVED_PORTS, MARUST_PORT, productPort, assertBindPort } = require('./port-lock'); // ポートの固定と禁止は port-lock.js（ここからも出す。互換）

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
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

function createCaptureReceiver(options) {
  const opts = options || {};
  const fs = opts.fs || require('fs');
  const core = opts.core || {};
  const stateDir = core.STATE_DIR || '';

  function access(req) {
    return evaluateAccess(req, stateDir, fs);
  }

  // 平文で Cookie・キャプチャを書く旧い受け口は無い。拡張は /ext/*（ペアリングと金庫）だけを使う。ここは何も受けない（false = 次の窓口へ）。
  function handle() {
    return false;
  }

  return {
    handle,
    evaluateAccess: access
  };
}

module.exports = {
  MARUST_PORT,
  RESERVED_PORTS,
  createCaptureReceiver,
  productPort,
  assertBindPort,
  evaluateAccess
};
