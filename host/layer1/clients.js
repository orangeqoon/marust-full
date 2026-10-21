'use strict';

/**
 * ペアリング済みクライアント。トークンは保存せず SHA-256 だけを残す。
 * ファイルは core.STATE_DIR/services/marust-clients.json。
 * lastSeenAt のファイルへの保存は、同じ端末につき 60 秒に 1 回まで。
 * kind は window / browser / native / extension。古い保存データは読み込み時に補う
 * （local-window は window、native と extension は保存どおり、それ以外は browser）。
 * requiresApproval は true のときだけ真。extension の権限は read と ext-write に固定する。
 * chat-write を含む指定は read と chat-write だけにする（write と emergency は付けない）。
 * mcp: true のペアリングは kind を native、requiresApproval を true、権限を read と write だけにする。
 */

const crypto = require('crypto');
const path = require('path');

const { WINDOW_ID } = require('../core');
const WINDOW_NAME = 'この PC のウィンドウ';
const KNOWN = ['read', 'write', 'emergency', 'chat-write'];
const DEFAULT_PERMISSIONS = ['read', 'emergency'];
const EXTENSION_PERMISSIONS = ['read', 'ext-write'];
const MCP_PERMISSIONS = Object.freeze(['read', 'write']);
const EXTENSION_ID_RE = /^[a-p]{32}$/;
const SEEN_WRITE_MS = 60 * 1000;

function sha256(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function hashEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createClients(options) {
  const opts = options || {};
  const core = opts.core || {};
  const fs = opts.fs || require('fs');
  const writeJson = opts.writeJson || core.atomicWriteJsonSync;
  if (typeof writeJson !== 'function') throw new Error('clients require atomicWriteJsonSync');
  if (!core.STATE_DIR) throw new Error('clients require STATE_DIR');
  const file = path.join(core.STATE_DIR, 'services', 'marust-clients.json');
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  const randomInt = typeof opts.randomInt === 'function' ? opts.randomInt : function (min, max) {
    return crypto.randomInt(min, max);
  };
  let onRevoke = null;
  let pending = null;
  const seenAt = new Map();
  const seenWrittenAt = new Map();

  function load() {
    try {
      if (!fs.existsSync(file)) return [];
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const rows = data && Array.isArray(data.clients) ? data.clients : [];
      return rows.map(normalizeRow);
    } catch (_) {
      return [];
    }
  }

  function save(rows) {
    writeJson(file, { clients: rows });
  }

  function kindOf(row) {
    if (row && row.id === WINDOW_ID) return 'window';
    if (row && row.kind === 'native') return 'native';
    if (row && row.kind === 'extension') return 'extension';
    return 'browser';
  }

  function channelOf(kind) {
    if (kind === 'native') return 'native';
    if (kind === 'extension') return 'extension';
    return 'browser';
  }

  function approvalOf(row) {
    if (!row || row.id === WINDOW_ID) return false;
    return row.requiresApproval === true;
  }

  function normalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    return Object.assign({}, row, {
      kind: kindOf(row),
      requiresApproval: approvalOf(row)
    });
  }

  function publicView(row) {
    const filed = row.lastSeenAt;
    const memory = seenAt.get(row.id);
    let lastSeenAt = filed;
    if (memory && (!filed || memory > filed)) lastSeenAt = memory;
    const view = {
      id: row.id,
      name: row.name,
      kind: kindOf(row),
      requiresApproval: approvalOf(row),
      permissions: Array.isArray(row.permissions) ? row.permissions.slice() : [],
      createdAt: row.createdAt,
      lastSeenAt: lastSeenAt
    };
    if (view.kind === 'extension') {
      view.extensionId = typeof row.extensionId === 'string' ? row.extensionId : '';
    }
    return view;
  }

  function normalizePermissions(input) {
    if (input == null) return DEFAULT_PERMISSIONS.slice();
    if (!Array.isArray(input)) return null;
    const out = [];
    for (let i = 0; i < input.length; i += 1) {
      const item = input[i];
      if (KNOWN.indexOf(item) !== -1 && out.indexOf(item) === -1) out.push(item);
    }
    if (!out.length) return null;
    if (out.indexOf('chat-write') !== -1) return ['read', 'chat-write'];
    if (out.indexOf('read') === -1) out.unshift('read');
    return out;
  }

  function normalizeName(name) {
    const text = name == null || name === '' ? 'ブラウザ' : String(name);
    if (text.length < 1 || text.length > 40) return '';
    if (/[\r\n\u0000]/.test(text)) return '';
    return text;
  }

  function ensureWindowClient() {
    const token = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date(now()).toISOString();
    const rows = load();
    let createdAt = nowIso;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === WINDOW_ID && rows[i].createdAt) createdAt = rows[i].createdAt;
    }
    const next = rows.filter(function (row) { return row && row.id !== WINDOW_ID; });
    const row = {
      id: WINDOW_ID,
      name: WINDOW_NAME,
      kind: 'window',
      requiresApproval: false,
      permissions: ['read', 'write', 'emergency'],
      tokenHash: sha256(token),
      createdAt: createdAt,
      lastSeenAt: nowIso
    };
    next.push(row);
    save(next);
    return { token: token, client: publicView(row) };
  }

  function authenticate(token) {
    if (typeof token !== 'string' || token.length < 32) return null;
    const hash = sha256(token);
    const rows = load();
    const row = rows.find(function (item) { return item && hashEquals(item.tokenHash || '', hash); });
    if (!row) return null;
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    seenAt.set(row.id, nowIso);
    const written = seenWrittenAt.get(row.id);
    if (written == null || nowMs - written >= SEEN_WRITE_MS) {
      row.lastSeenAt = nowIso;
      save(rows);
      seenWrittenAt.set(row.id, nowMs);
    }
    return publicView(row);
  }

  function list() {
    return load().map(publicView);
  }

  function revoke(id) {
    const key = typeof id === 'string' ? id : '';
    if (!key) return { ok: false, error: 'bad-id' };
    if (key === WINDOW_ID) return { ok: false, error: 'cannot-revoke-window' };
    const rows = load();
    const row = rows.find(function (item) { return item && item.id === key; });
    if (!row) return { ok: false, error: 'not-found' };
    seenAt.delete(key);
    seenWrittenAt.delete(key);
    save(rows.filter(function (item) { return item && item.id !== key; }));
    if (typeof onRevoke === 'function') onRevoke(key);
    return { ok: true };
  }

  function beginPairing(input) {
    const row = input && typeof input === 'object' ? input : {};
    const name = normalizeName(row.name);
    if (!name) return { ok: false, error: 'name' };
    if (row.mcp === true) {
      const code = String(randomInt(0, 1000000)).padStart(6, '0');
      pending = {
        code: code,
        name: name,
        permissions: MCP_PERMISSIONS.slice(),
        kind: 'native',
        requiresApproval: true,
        expiresAt: now() + 120000,
        failures: 0
      };
      return { ok: true, code: code, expiresAt: new Date(pending.expiresAt).toISOString() };
    }
    if (row.kind != null && row.kind !== 'browser' && row.kind !== 'native' && row.kind !== 'extension') {
      return { ok: false, error: 'kind' };
    }
    const kind = row.kind === 'native' || row.kind === 'extension' ? row.kind : 'browser';
    let permissions;
    let requiresApproval;
    if (kind === 'extension') {
      permissions = EXTENSION_PERMISSIONS.slice();
      requiresApproval = false;
    } else {
      permissions = normalizePermissions(row.permissions);
      if (!permissions) return { ok: false, error: 'permissions' };
      requiresApproval = row.requiresApproval === true;
    }
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    pending = {
      code: code,
      name: name,
      permissions: permissions,
      kind: kind,
      requiresApproval: requiresApproval,
      expiresAt: now() + 120000,
      failures: 0
    };
    return { ok: true, code: code, expiresAt: new Date(pending.expiresAt).toISOString() };
  }

  // 開発中の自動ペアリング用（host/core/dev-autopair.js）: コード無しで native の端末を 1 つ作る。権限は read / write だけ（非常停止は付けない）。
  function issueNative(input) {
    const row = input && typeof input === 'object' ? input : {};
    const name = normalizeName(row.name);
    if (!name) return { ok: false, error: 'name' };
    const permissions = normalizePermissions(row.permissions);
    if (!permissions || permissions.indexOf('emergency') !== -1) return { ok: false, error: 'permissions' };
    const token = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date(now()).toISOString();
    const saved = {
      id: crypto.randomBytes(8).toString('hex'),
      name: name,
      kind: 'native',
      requiresApproval: row.requiresApproval === true,
      permissions: permissions,
      tokenHash: sha256(token),
      createdAt: nowIso,
      lastSeenAt: nowIso
    };
    const rows = load();
    rows.push(saved);
    save(rows);
    return { ok: true, token: token, client: publicView(saved) };
  }

  // 凍結中の Web 操作盤用: コード無しでブラウザの端末を 1 つ作る（docs/FROZEN.md）。
  function issueBrowserSession(name) {
    const token = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date(now()).toISOString();
    const row = {
      id: crypto.randomBytes(8).toString('hex'),
      name: normalizeName(name) || 'ブラウザ',
      kind: 'browser',
      requiresApproval: false,
      permissions: ['read', 'write', 'emergency'],
      tokenHash: sha256(token),
      createdAt: nowIso,
      lastSeenAt: nowIso
    };
    const rows = load();
    rows.push(row);
    save(rows);
    return { ok: true, token: token, client: publicView(row) };
  }

  // ブラウザ拡張機能の自動ペアリング用: コード無しで extension 端末を作る／更新する
  function issueExtension(input) {
    const row = input && typeof input === 'object' ? input : {};
    const extensionId = typeof row.extensionId === 'string' ? row.extensionId.trim() : '';
    if (!EXTENSION_ID_RE.test(extensionId)) return { ok: false, error: 'origin' };
    const name = normalizeName(row.name) || 'Marust';
    if (!name || (typeof row.name === 'string' && (row.name.trim() !== row.name || /[\r\n\u0000]/.test(row.name)))) {
      return { ok: false, error: 'name' };
    }
    const token = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date(now()).toISOString();
    const rows = load();
    const saved = {
      id: crypto.randomBytes(8).toString('hex'),
      name: name,
      kind: 'extension',
      extensionId: extensionId,
      requiresApproval: false,
      permissions: EXTENSION_PERMISSIONS.slice(),
      tokenHash: sha256(token),
      createdAt: nowIso,
      lastSeenAt: nowIso
    };
    rows.push(saved);
    save(rows);
    return { ok: true, token: token, client: publicView(saved) };
  }

  function failCode() {
    pending.failures += 1;
    if (pending.failures >= 5) {
      pending = null;
      return { ok: false, error: 'locked' };
    }
    return { ok: false, error: 'bad-code' };
  }

  function redeem(code, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const channel = channelOf(opts.kind);
    const text = typeof code === 'string' ? code.trim() : '';
    if (!pending) return { ok: false, error: 'no-code' };
    if (now() > pending.expiresAt) {
      pending = null;
      return { ok: false, error: 'expired' };
    }
    if (text !== pending.code) return failCode();
    if ((pending.kind || 'browser') !== channel) return failCode();
    let name = pending.name;
    if (typeof opts.name === 'string') {
      const chosen = normalizeName(opts.name);
      if (!chosen || opts.name.trim() !== opts.name || /[\r\n\u0000]/.test(opts.name)) {
        return { ok: false, error: 'name' };
      }
      name = chosen;
    }
    if (channel === 'extension' && (typeof opts.extensionId !== 'string' || !EXTENSION_ID_RE.test(opts.extensionId))) {
      return { ok: false, error: 'origin' };
    }
    const info = pending;
    pending = null;
    const token = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date(now()).toISOString();
    const savedKind = info.kind === 'native' || info.kind === 'extension' ? info.kind : 'browser';
    const row = {
      id: crypto.randomBytes(8).toString('hex'),
      name: name,
      kind: savedKind,
      requiresApproval: info.requiresApproval === true,
      permissions: info.permissions.slice(),
      tokenHash: sha256(token),
      createdAt: nowIso,
      lastSeenAt: nowIso
    };
    if (savedKind === 'extension') row.extensionId = opts.extensionId;
    const rows = load();
    rows.push(row);
    save(rows);
    return { ok: true, token: token, client: publicView(row) };
  }

  return {
    file: file,
    ensureWindowClient: ensureWindowClient,
    authenticate: authenticate,
    list: list,
    revoke: revoke,
    beginPairing: beginPairing,
    redeem: redeem,
    issueBrowserSession: issueBrowserSession,
    issueNative: issueNative,
    issueExtension: issueExtension,
    setOnRevoke: function (fn) { onRevoke = fn; },
    pendingCode: function () { return pending ? pending.code : ''; }
  };
}

module.exports = {
  createClients,
  WINDOW_ID,
  WINDOW_NAME,
  DEFAULT_PERMISSIONS,
  MCP_PERMISSIONS,
  sha256
};
