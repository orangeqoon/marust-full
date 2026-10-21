'use strict';

/**
 * 「OBS とつなぐ」画面の裏側（R3）。
 * 接続設定（host・port・password）は金庫の obs.websocket に JSON で持つ。
 * 読む順番: 金庫 → <STATE_DIR>/services/obs-config.json → 旧いアプリの場所（開発者モードだけ）。
 * 答えにパスワードは入れない（あるかどうかだけ）。ログにも出さない。
 * testConnection は使い捨ての接続で、読み取りの 3 つ（GetVersion・get_api_version・list_capabilities）しか呼ばない。
 * OBS の配信開始・停止はしない。改造プラグインは自動では入れない。
 */

const fs = require('fs');
const path = require('path');
const { readObsConfigFile, normalizeConfig, DEFAULT_CONFIG, VENDOR_NAME } = require('../core');
const { REQUIRED } = require('../core');

const SECRET_NAME = 'obs.websocket';
const TEST_TIMEOUT_MS = 8000;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]{2,45}\]$/;
const MAX_PASSWORD = 256;

function checkHost(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 253 && HOST_RE.test(value);
}

function checkPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** つなぐのに失敗した理由を短いコードにする。メッセージ本文は返さない（パスワードを含みうる）。 */
function failureCode(err) {
  const code = err && err.code != null ? err.code : '';
  const text = err && typeof err.message === 'string' ? err.message : '';
  if (code === 4009 || code === '4009' || /authentication/i.test(text)) return 'wrong-password';
  if (err && err.__marustTimeout === true) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/.test(text + ' ' + String(code))
    || code === 1006 || code === '1006') return 'unreachable';
  return 'failed';
}

function createObsSetup(options) {
  const opts = options || {};
  const core = opts.core || {};
  const secrets = opts.secrets || null;
  // 値を読む道。持ち主（読んでよい名前）は組み立てる側が決める（vault.coreReader）
  const reader = opts.reader || null;
  const getEngine = typeof opts.getEngine === 'function' ? opts.getEngine : () => opts.engine || null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TEST_TIMEOUT_MS;

  // 画面が定期的に呼ぶ getConnection のたびに金庫を読まない（読むたびに金庫の監査が 1 行増える）。
  // 金庫を読むのは「つなぐとき（readStored）」と「保存したとき」だけ。それ以外はこの控えを使う。
  let memo = { loaded: false, stored: null };

  /** 金庫の接続設定。無い・読めないときは null。つなぐときに呼ばれる（控えも更新する）。 */
  async function readStored() {
    let value = null;
    if (reader && typeof reader.get === 'function') {
      try {
        const got = await reader.get(SECRET_NAME);
        if (got && got.ok === true && typeof got.value === 'string') {
          value = normalizeConfig(JSON.parse(got.value), DEFAULT_CONFIG);
        }
      } catch (_) {
        value = null;
      }
    }
    memo = { loaded: true, stored: value };
    return value;
  }

  async function effective(fresh) {
    const stored = fresh === true || !memo.loaded ? await readStored() : memo.stored;
    if (stored) return { config: stored, source: 'vault' };
    return readObsConfigFile(core);
  }

  function connectionStatus() {
    const engine = getEngine();
    try {
      const conn = engine && engine.connection && typeof engine.connection.getStatus === 'function'
        ? engine.connection.getStatus() : null;
      return { connected: !!(conn && conn.connected) };
    } catch (_) {
      return { connected: false };
    }
  }

  async function getConnection() {
    const now = await effective();
    return {
      ok: true,
      host: now.config.host,
      port: now.config.port,
      hasPassword: now.config.password.length > 0,
      source: now.source,
      connected: connectionStatus().connected
    };
  }

  async function setConnection(input) {
    const given = input && typeof input === 'object' ? input : {};
    const now = (await effective(true)).config;
    const host = given.host == null ? now.host : given.host;
    const port = given.port == null ? now.port : given.port;
    // password を省いたときは今のまま。ただしホストを変えたときは引き継がない（別の場所へ保存済みのパスワードを渡さない）。
    // 空文字は「パスワードなし」にする。
    const password = given.password == null ? (host === now.host ? now.password : '') : given.password;
    if (!checkHost(host)) return { ok: false, error: 'bad-host' };
    if (!checkPort(port)) return { ok: false, error: 'bad-port' };
    if (typeof password !== 'string' || password.length > MAX_PASSWORD) return { ok: false, error: 'bad-password' };
    if (!secrets || typeof secrets.set !== 'function') return { ok: false, error: 'unavailable' };
    const saved = await secrets.set(SECRET_NAME, JSON.stringify({ host: host, port: port, password: password }), 'host');
    if (!saved || saved.ok !== true) return { ok: false, error: saved && typeof saved.error === 'string' ? saved.error : 'unavailable' };
    memo = { loaded: true, stored: { host: host, port: port, password: password } };
    const engine = getEngine();
    let connected = false;
    if (engine && typeof engine.reconnect === 'function') {
      try { await engine.reconnect(); } catch (_) { /* 結果は connected で伝える */ }
      connected = connectionStatus().connected;
    }
    return { ok: true, connected: connected };
  }

  /** OBS 自身の obs-websocket 設定（config.json）の場所。差し替えは試験用。APPDATA が無ければ null。 */
  function obsWebsocketConfigPath() {
    if (typeof opts.obsWebsocketConfigPath === 'string' && opts.obsWebsocketConfigPath) return opts.obsWebsocketConfigPath;
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json') : null;
  }

  /**
   * 「OBS の設定を読んでつなぐ」。押されたときだけ呼ぶ。config.json は読むだけ（書き換えない・作らない）。
   * 答えに値は入れない（パスワードはあったかどうかだけ）。
   */
  async function importFromObs() {
    const file = obsWebsocketConfigPath();
    if (!file) return { ok: false, error: 'not-found' };
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (err) {
      return { ok: false, error: err && err.code === 'ENOENT' ? 'not-found' : 'unreadable' };
    }
    let doc;
    try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (_) { return { ok: false, error: 'unreadable' }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'unreadable' };
    if (doc.server_enabled !== true) return { ok: false, error: 'server-disabled' };
    if (!checkPort(doc.server_port)) return { ok: false, error: 'bad-port' };
    const password = doc.auth_required === true && typeof doc.server_password === 'string' ? doc.server_password : '';
    const saved = await setConnection({ host: '127.0.0.1', port: doc.server_port, password: password });
    if (!saved || saved.ok !== true) return { ok: false, error: saved && typeof saved.error === 'string' ? saved.error : 'unavailable' };
    return { ok: true, port: doc.server_port, hasPassword: password.length > 0, connected: saved.connected === true };
  }

  async function probe(config) {
    const loaded = opts.ObsWebSocket ? null : require('obs-websocket-js');
    const Ctor = opts.ObsWebSocket || loaded.default || loaded.OBSWebSocket || loaded;
    const client = new Ctor();
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('timeout');
        err.__marustTimeout = true;
        reject(err);
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    async function work() {
      await client.connect('ws://' + config.host + ':' + config.port, config.password, {
        eventSubscriptions: 0
      });
      const version = await client.call('GetVersion');
      const out = { ok: true, obsVersion: version && typeof version.obsVersion === 'string' ? version.obsVersion.slice(0, 40) : '' };
      out.plugin = await checkPlugin(client);
      return out;
    }
    try {
      return await Promise.race([work(), timeout]);
    } catch (err) {
      return { ok: false, error: failureCode(err) };
    } finally {
      if (timer) clearTimeout(timer);
      try { await client.disconnect(); } catch (_) { /* もう切れている */ }
    }
  }

  async function vendorRead(client, requestType) {
    const raw = await client.call('CallVendorRequest', { vendorName: VENDOR_NAME, requestType: requestType, requestData: {} });
    if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'responseData')) {
      return raw.responseData && typeof raw.responseData === 'object' ? raw.responseData : {};
    }
    return raw && typeof raw === 'object' ? raw : {};
  }

  /** 改造プラグイン（obs-multi-rtmp）の有無と版。state: ok／missing（入っていない）／old（古い）。 */
  async function checkPlugin(client) {
    let apiVersion = 0;
    try {
      const body = await vendorRead(client, 'get_api_version');
      const value = body && body.apiVersion;
      apiVersion = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 1);
    } catch (_) {
      // 答えが無い（OBS がベンダー名を知らない）＝ 入っていない。get_api_version が無い古い版は list_capabilities で拾う。
      apiVersion = 0;
    }
    let names = null;
    try {
      const caps = await vendorRead(client, 'list_capabilities');
      const rows = caps && Array.isArray(caps.requests) ? caps.requests : [];
      names = new Set(rows.map((row) => (typeof row === 'string' ? row : (row && row.name))).filter((n) => typeof n === 'string'));
    } catch (_) {
      names = null;
    }
    if (!names) return { state: 'missing', apiVersion: 0, missing: [] };
    const missing = REQUIRED.filter((name) => !names.has(name));
    return { state: missing.length === 0 ? 'ok' : 'old', apiVersion: apiVersion || 1, missing: missing };
  }

  async function testConnection(input) {
    const given = input && typeof input === 'object' ? input : {};
    const now = (await effective()).config;
    const host = given.host == null ? now.host : given.host;
    const port = given.port == null ? now.port : given.port;
    if (!checkHost(host)) return { ok: false, error: 'bad-host' };
    if (!checkPort(port)) return { ok: false, error: 'bad-port' };
    let password;
    if (given.password != null) {
      password = given.password;
      if (typeof password !== 'string' || password.length > MAX_PASSWORD) return { ok: false, error: 'bad-password' };
    } else if (host === now.host && port === now.port) {
      // 保存済みのパスワードは、同じ場所へのテストにだけ使う（別の場所へは送らない）。
      password = now.password;
    } else {
      password = '';
    }
    return probe({ host: host, port: port, password: password });
  }

  return { readStored, getConnection, setConnection, testConnection, importFromObs, SECRET_NAME };
}

module.exports = { createObsSetup, failureCode, SECRET_NAME };
