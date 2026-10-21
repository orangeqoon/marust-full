'use strict';

/**
 * OBS WebSocket への接続はこれ 1 本。読み取りと書き込みの両方を通す。
 * 外から呼べるのは読み取りだけ。書き込みと非常停止は bindInternal で渡したエンジンだけ。
 * 設定は金庫の obs.websocket、無ければ obs-config.json（読むだけ。書き換えない）。パスワードはログに出さない。
 */

const fs = require('fs');
const path = require('path');
const { defaultLogger } = require('../safe-runner');

const VENDOR_NAME = 'obs-multi-rtmp';
const VENDOR_BIT = 1 << 9;
const RECONNECT_MS = 30000;
const CONNECT_TIMEOUT_MS = 15000;
const SYNC_TIMEOUT_MS = 30000;
const DISCONNECT_TIMEOUT_MS = 5000;

const READ_REQUESTS = new Set(['GetStreamStatus', 'GetVersion']);
const READ_VENDOR = new Set([
  'list_capabilities',
  'get_api_version',
  'get_snapshot',
  'list_targets',
  'get_target_status',
  'get_target_config'
]);
const WRITE_VENDOR = new Set([
  'start_target',
  'stop_target',
  'set_target_enabled',
  'set_target_service_settings',
  'create_target',
  'delete_target'
]);
const EMERGENCY_VENDOR = new Set(['stop_all_targets']);

function normalizeConfig(data, defaults) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const port = Number(data.port);
  return {
    host: typeof data.host === 'string' && data.host ? data.host : defaults.host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaults.port,
    password: typeof data.password === 'string' ? data.password : ''
  };
}

const DEFAULT_CONFIG = Object.freeze({ host: 'localhost', port: 4455, password: '' });

/**
 * ファイルから読む。{ config, source } を返す。source は 'file'（丸スト用の場所）／'default'。
 * 旧いアプリの場所は見ない（引き継ぎは開発者プラグイン dev-legacy-import で金庫へ取り込む）。
 */
function readObsConfigFile(core) {
  const defaults = Object.assign({}, DEFAULT_CONFIG);
  const bridge = core || {};
  try {
    const servicesDir = bridge.SERVICES_DIR || '';
    const canonical = servicesDir ? path.join(servicesDir, 'obs-config.json') : '';
    if (!canonical || !fs.existsSync(canonical)) return { config: defaults, source: 'default' };
    const data = JSON.parse(fs.readFileSync(canonical, 'utf8').replace(/^﻿/, ''));
    const config = normalizeConfig(data, defaults);
    if (!config) return { config: defaults, source: 'default' };
    return { config: config, source: 'file' };
  } catch (_) {
    return { config: defaults, source: 'default' };
  }
}

function loadObsConfig(core) {
  return readObsConfigFile(core).config;
}

function subscriptionBits(EventSubscription) {
  const vendors = EventSubscription && typeof EventSubscription.Vendors === 'number'
    ? EventSubscription.Vendors
    : VENDOR_BIT;
  const all = EventSubscription && typeof EventSubscription.All === 'number' ? EventSubscription.All : 0;
  const outputs = EventSubscription && typeof EventSubscription.Outputs === 'number' ? EventSubscription.Outputs : (1 << 6);
  const general = EventSubscription && typeof EventSubscription.General === 'number' ? EventSubscription.General : 1;
  return (all || (general | outputs)) | vendors;
}

function classifyRequest(requestName, requestData) {
  const name = String(requestName || '');
  if (name === 'StartStream' || name === 'StopStream') return 'forbidden';
  if (READ_REQUESTS.has(name)) return 'read';
  if (name !== 'CallVendorRequest') return 'forbidden';
  const data = requestData && typeof requestData === 'object' ? requestData : {};
  if (data.vendorName && data.vendorName !== VENDOR_NAME) return 'forbidden';
  const type = typeof data.requestType === 'string' ? data.requestType : '';
  const inner = data.requestData && typeof data.requestData === 'object' ? data.requestData : {};
  if (inner.reveal_secrets === true || data.reveal_secrets === true) return 'forbidden';
  if (type === 'start_all_targets') return 'forbidden';
  if (READ_VENDOR.has(type)) return 'read';
  if (WRITE_VENDOR.has(type)) return 'write';
  if (EMERGENCY_VENDOR.has(type)) return 'emergency';
  return 'forbidden';
}

function forbidden() {
  const err = new Error('obs request not allowed');
  err.code = 'OBS_REQUEST_FORBIDDEN';
  return err;
}

function notConnected() {
  const err = new Error('obs not connected');
  err.code = 'OBS_NOT_CONNECTED';
  return err;
}

function createObsConnection(options) {
  const opts = options || {};
  const orchestrator = opts.orchestrator;
  const core = opts.core || {};
  const logger = opts.logger || defaultLogger;
  const reconnectMs = Number.isFinite(opts.reconnectMs) ? opts.reconnectMs : RECONNECT_MS;
  // 金庫の obs.websocket（{host,port,password}）を返す口。無ければ null。読む順番は 金庫 → ファイル。
  const connectTimeoutMs = Number.isFinite(opts.connectTimeoutMs) ? opts.connectTimeoutMs : CONNECT_TIMEOUT_MS;
  const syncTimeoutMs = Number.isFinite(opts.syncTimeoutMs) ? opts.syncTimeoutMs : SYNC_TIMEOUT_MS;
  const getStored = typeof opts.getStored === 'function' ? opts.getStored : null;
  const setTimer = opts.setTimeoutFn || setTimeout;
  const clearTimer = opts.clearTimeoutFn || clearTimeout;
  let client = opts.client || null;
  let connected = false;
  let stopped = false;
  let timer = null;
  const status = { connected: false, detail: '未接続' };
  const vendorHandlers = [];

  function warn(detail) {
    status.detail = detail;
    status.connected = false;
    logger('warn', detail);
  }

  function emitVendor(data) {
    const vendorName = data && (data.vendorName || data.vendor_name);
    const eventType = data && (data.eventType || data.event_type);
    if (vendorName !== VENDOR_NAME) return;
    if (eventType !== 'target_state_changed' && eventType !== 'emergency_stop') return;
    const eventData = data && (data.eventData || data.event_data) ? (data.eventData || data.event_data) : {};
    // target_state_changed は従来どおり中身だけ。emergency_stop は種類が分かる形で渡す。
    const payload = eventType === 'emergency_stop' ? { eventType: eventType, eventData: eventData } : eventData;
    for (const handler of vendorHandlers.slice()) {
      try { handler(payload); } catch (_) { warn('OBS の配信先イベントを配れませんでした'); }
    }
  }

  function bind(obs) {
    if (!obs || obs.__marustBound) return;
    obs.__marustBound = true;
    if (typeof obs.on !== 'function') return;
    obs.on('StreamStateChanged', (data) => {
      const outputState = data && data.outputState != null ? String(data.outputState) : '';
      if (typeof opts.onOutputState === 'function') {
        try { opts.onOutputState(outputState); } catch (_) { /* 配信停止の通知失敗で配りを止めない */ }
      }
      let title = '';
      try {
        if (typeof opts.getTitle === 'function') title = String(opts.getTitle() || '');
      } catch (_) {
        title = '';
      }
      if (!orchestrator || typeof orchestrator.dispatchObs !== 'function') return;
      Promise.resolve()
        .then(() => orchestrator.dispatchObs({ outputState, title }))
        .catch(() => warn('OBS イベントを配れませんでした'));
    });
    obs.on('VendorEvent', (data) => emitVendor(data));
    obs.on('ConnectionClosed', () => {
      connected = false;
      warn('OBS 切断。30秒後に再接続します');
      schedule();
    });
  }

  function schedule() {
    if (stopped || timer) return;
    timer = setTimer(() => {
      timer = null;
      if (!stopped && !connected) connect();
    }, reconnectMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function resolveConfig() {
    if (getStored) {
      try {
        const stored = normalizeConfig(await getStored(), DEFAULT_CONFIG);
        if (stored) return { config: stored, source: 'vault' };
      } catch (_) { /* 金庫が読めないときはファイルへ */ }
    }
    return readObsConfigFile(core);
  }

  /** 決着しないかもしれない待ちに期限をつける。期限が来たら code つきのエラーで落とす。 */
  function withTimeout(promise, ms, code) {
    let handle = null;
    const limit = new Promise((_, reject) => {
      handle = setTimeout(() => {
        const err = new Error('timeout');
        err.code = code;
        reject(err);
      }, ms);
    });
    return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(handle));
  }

  function dropClient() {
    if (client && typeof client.disconnect === 'function') {
      Promise.resolve().then(() => client.disconnect()).catch(() => {});
    }
  }

  let inflight = null;
  // 世代番号。reconnect / stop で進め、古い試みの結果は捨てる。
  let generation = 0;

  /** 設定を変えたあとに、今の接続を切ってつなぎ直す。つなぎ中で止まった試みは待たずに捨てる。 */
  async function reconnect() {
    if (stopped) return getStatus();
    generation += 1;
    inflight = null;
    if (timer) clearTimer(timer);
    timer = null;
    connected = false;
    status.connected = false;
    if (client && typeof client.disconnect === 'function') {
      try { await withTimeout(client.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch (_) { /* 切れていてもよい */ }
      if (timer) clearTimer(timer);
      timer = null;
    }
    return connect();
  }

  async function connect() {
    if (stopped || connected) return getStatus();
    if (inflight) return inflight;
    const mine = connectOnce(generation).finally(() => {
      if (inflight === mine) inflight = null;
    });
    inflight = mine;
    return mine;
  }

  async function connectOnce(gen) {
    if (stopped || connected) return getStatus();
    const stale = () => stopped || gen !== generation;
    try {
      let EventSubscription = opts.EventSubscription || null;
      if (!client) {
        const loaded = require('obs-websocket-js');
        const Ctor = opts.ObsWebSocket || loaded.default || loaded.OBSWebSocket || loaded;
        EventSubscription = EventSubscription || loaded.EventSubscription || null;
        client = new Ctor();
      }
      bind(client);
      const cfg = (await resolveConfig()).config;
      if (stale()) return getStatus();
      if (typeof client.connect !== 'function') throw new Error('no-connect');
      await withTimeout(client.connect('ws://' + cfg.host + ':' + cfg.port, cfg.password, {
        eventSubscriptions: subscriptionBits(EventSubscription)
      }), connectTimeoutMs, 'CONNECT_TIMEOUT');
      if (stale()) return getStatus();
      connected = true;
      status.connected = true;
      status.detail = '接続中';
      if (typeof opts.onConnected === 'function') {
        try { await withTimeout(opts.onConnected(), syncTimeoutMs, 'SYNC_TIMEOUT'); }
        catch (_) { logger('warn', 'OBS 接続後の同期に失敗しました'); /* 接続は生きている。状態は変えず、同期は poll がやり直す */ }
      }
      return getStatus();
    } catch (err) {
      if (stale()) return getStatus();
      connected = false;
      // 期限切れで放った接続が、あとから成功して居座らないよう切っておく。
      if (err && err.code === 'CONNECT_TIMEOUT') dropClient();
      // 原因の切り分け用に、エラーの番号と種類だけ残す（メッセージ本文は出さない。パスワードを含みうるため）。
      const code = err && err.code != null ? String(err.code).replace(/[^\w.-]/g, '').slice(0, 40) : '';
      warn('OBS 接続失敗' + (code ? '(' + code + ')' : '') + '。30秒後に再接続します');
      schedule();
      return getStatus();
    }
  }

  function rawCall(requestName, requestData) {
    if (!client || typeof client.call !== 'function' || !connected) return Promise.reject(notConnected());
    return client.call(requestName, requestData);
  }

  function call(requestName, requestData) {
    if (classifyRequest(requestName, requestData) !== 'read') return Promise.reject(forbidden());
    const name = String(requestName || '');
    if (name === 'CallVendorRequest') {
      const data = requestData && typeof requestData === 'object' ? requestData : {};
      const wrapped = Object.assign({}, data, { vendorName: VENDOR_NAME });
      return rawCall('CallVendorRequest', wrapped);
    }
    return rawCall(name, requestData);
  }

  /**
   * 配信全体の開始・停止だけ（プラグイン ctx.obs.streamControl 専用の細い口）。
   * call() は StartStream / StopStream を拒否したまま。呼ぶ側（electron-main の obsControl）が
   * obs-engine が live のときだけ通す。
   */
  function controlStream(action) {
    if (action !== 'start' && action !== 'stop') return Promise.reject(forbidden());
    return rawCall(action === 'start' ? 'StartStream' : 'StopStream');
  }

  function vendor(tier, requestType, requestData) {
    const wrapped = {
      vendorName: VENDOR_NAME,
      requestType: String(requestType || ''),
      requestData: requestData && typeof requestData === 'object' ? requestData : {}
    };
    if (classifyRequest('CallVendorRequest', wrapped) !== tier) return Promise.reject(forbidden());
    return rawCall('CallVendorRequest', wrapped);
  }

  function getStatus() {
    return { connected: status.connected, detail: status.detail };
  }

  function onVendorEvent(handler) {
    if (typeof handler !== 'function') return function unsubscribe() {};
    vendorHandlers.push(handler);
    return function unsubscribe() {
      const index = vendorHandlers.indexOf(handler);
      if (index >= 0) vendorHandlers.splice(index, 1);
    };
  }

  function stop() {
    stopped = true;
    generation += 1;
    inflight = null;
    if (timer) clearTimer(timer);
    timer = null;
    connected = false;
    status.connected = false;
    status.detail = '停止';
    if (client && typeof client.disconnect === 'function') {
      Promise.resolve().then(() => client.disconnect()).catch(() => {});
    }
  }

  async function disconnect() {
    stop();
    if (client && typeof client.disconnect === 'function') {
      try {
        await client.disconnect();
      } catch (_) {
        // 切断エラーは握りつぶす
      }
    }
  }

  if (typeof opts.bindInternal === 'function') {
    opts.bindInternal({ vendor, onVendorEvent, getStatus });
  }

  return {
    start: connect,
    reconnect,
    resolveConfig,
    stop,
    disconnect,
    call,
    controlStream,
    getStatus,
    onVendorEvent,
    loadObsConfig: () => loadObsConfig(core)
  };
}

module.exports = {
  createObsConnection,
  loadObsConfig,
  readObsConfigFile,
  normalizeConfig,
  DEFAULT_CONFIG,
  classifyRequest,
  subscriptionBits,
  VENDOR_NAME,
  VENDOR_BIT,
  RECONNECT_MS,
  READ_REQUESTS,
  READ_VENDOR,
  WRITE_VENDOR,
  EMERGENCY_VENDOR
};
