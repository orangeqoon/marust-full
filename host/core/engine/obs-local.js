'use strict';

/**
 * OBS エンジン（id obs-local）。役割 stream.engine@1。
 * モード判定の id は obs-engine。起動時と再接続時に開始・停止はしない。
 * drift を理由に書き戻さない。操作は 1 本の直列キュー。例外は投げない。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EVENTS } = require('../events');
const { createObsConnection, READ_VENDOR, WRITE_VENDOR } = require('./obs-connection');
const { emergencyButtonState } = require('./emergency-button');
const { redact, defaultLogger } = require('../safe-runner');
const { appendJsonl } = require('../log-writer');
const { tailOf } = require('../secret-tail');

const ENGINE_ID = 'obs-local';
const MODE_ID = 'obs-engine';
const REQUIRED = Array.from(READ_VENDOR).concat(Array.from(WRITE_VENDOR));
const ACTIVE = new Set(['live', 'connecting', 'reconnecting']);
const POLL_MS = 10000;
const VENDOR_TIMEOUT_MS = 20000;
const READ_TIMEOUT_MS = 6000;
const MAIN_ID = 'main';
const MAIN_ERROR = 'main-output';

const ERROR_TEXT = {
  '0': '',
  '-1': 'wrong-url',
  '-2': 'connect-failed',
  '-3': 'handshake-failed',
  '-4': 'server-refused'
};

function errorText(code) {
  if (code == null || code === 0 || code === '0') return '';
  const key = String(code);
  return Object.prototype.hasOwnProperty.call(ERROR_TEXT, key) ? ERROR_TEXT[key] : 'unknown';
}

function unwrapVendor(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (Object.prototype.hasOwnProperty.call(raw, 'responseData') && (raw.vendorName || raw.requestType)) {
    return raw.responseData && typeof raw.responseData === 'object' ? raw.responseData : {};
  }
  return raw;
}

function requestNames(body) {
  const rows = body && Array.isArray(body.requests) ? body.requests : [];
  const names = [];
  for (const row of rows) {
    if (typeof row === 'string') names.push(row);
    else if (row && typeof row.name === 'string') names.push(row.name);
  }
  return names;
}

function createObsLocalEngine(options) {
  const opts = options || {};
  const core = opts.core || {};
  const store = opts.store || opts.stateStore || null;
  const bus = opts.bus || null;
  const sessions = opts.sessions || null;
  let heldEmergency = false;
  const orchestrator = opts.orchestrator || null;
  const logger = typeof opts.logger === 'function' ? opts.logger : defaultLogger;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : POLL_MS;
  const vendorTimeoutMs = Number.isFinite(opts.vendorTimeoutMs) && opts.vendorTimeoutMs > 0 ? opts.vendorTimeoutMs : VENDOR_TIMEOUT_MS;
  const readTimeoutMs = Number.isFinite(opts.readTimeoutMs) && opts.readTimeoutMs > 0 ? opts.readTimeoutMs : Math.min(READ_TIMEOUT_MS, vendorTimeoutMs);
  const stopVerifyTries = Number.isInteger(opts.stopVerifyTries) && opts.stopVerifyTries > 0 ? opts.stopVerifyTries : 10;
  const stopVerifyMs = Number.isFinite(opts.stopVerifyMs) && opts.stopVerifyMs > 0 ? opts.stopVerifyMs : 500;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  const cache = new Map();
  let internal = null;
  let supported = false;
  let missing = [];
  let capsChecked = false;
  let stopReason = '';
  let suppressObsStopping = false;
  let aggregateActive = false;
  let aggregateReady = false;
  const createdKeyTails = new Map();
  let tail = Promise.resolve();
  let pollTimer = null;
  let readyDone = false;
  let readyResolve = function () {};
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  let syncRun = null;
  let syncNext = null;
  let statsRun = null;
  let apiVersion = 1;
  let versionKnown = false;
  let versionProbe = null;
  let versionGen = 0;
  // メイン出力（OBS が自分の設定で持つ配信の出力）。配信先の 1 つとして特別なターゲット 'main' で扱う。cache には入れない。
  let mainState = '';

  function iso(date) {
    const value = date instanceof Date ? date : now();
    return value.toISOString();
  }

  function mode() {
    try {
      if (orchestrator && typeof orchestrator.modeFor === 'function') {
        const value = orchestrator.modeFor(MODE_ID);
        if (value === 'live' || value === 'shadow' || value === 'legacy') return value;
      }
    } catch (_) { /* legacy */ }
    return 'legacy';
  }

  function markReady() {
    if (readyDone) return;
    readyDone = true;
    readyResolve();
  }

  function destinations() {
    if (!store || typeof store.snapshot !== 'function') return [];
    const snap = store.snapshot();
    return snap && Array.isArray(snap.destinations) ? snap.destinations : [];
  }

  function linkedTo(targetId) {
    const id = String(targetId);
    return destinations().filter((row) => {
      return row && row.engine && row.engine.id === ENGINE_ID && String(row.engine.targetId) === id;
    });
  }

  function redactRecord(record) {
    if (!record || typeof record !== 'object') return record;
    const out = {};
    const keys = Object.keys(record);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const value = record[key];
      out[key] = typeof value === 'string' ? redact(value) : value;
    }
    return out;
  }

  function appendLog(kind, record) {
    if (!core || !core.STATE_DIR) return;
    const dir = path.join(core.STATE_DIR, 'logs', 'marust');
    const ok = appendJsonl(dir, kind, redactRecord(record), { now: now() });
    if (!ok) logger('warn', kind + ' log was not written');
  }

  function record(action, detail) {
    const info = detail || {};
    appendLog('engine', {
      at: iso(),
      action: action,
      id: info.id == null ? '' : String(info.id),
      mode: mode(),
      dryRun: info.dryRun === true,
      sent: info.sent === true,
      ok: info.ok !== false,
      error: info.error ? String(info.error) : ''
    });
  }

  async function vendor(tier, requestType, requestData) {
    const call = internal && typeof internal.vendor === 'function'
      ? internal.vendor.bind(internal)
      : (connection && typeof connection.vendor === 'function' ? connection.vendor.bind(connection) : null);
    if (!call) {
      const err = new Error('obs not connected');
      err.code = 'OBS_NOT_CONNECTED';
      throw err;
    }
    // obs-websocket-js は要求に期限を持たない。答えが失われると直列キューが止まり続けるので、ここで切る。
    let timer = null;
    const limit = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error('obs request timed out');
        err.code = 'OBS_TIMEOUT';
        reject(err);
      }, tier === 'read' ? readTimeoutMs : vendorTimeoutMs);
    });
    try {
      const raw = await Promise.race([call(tier, requestType, requestData || {}), limit]);
      return unwrapVendor(raw);
    } finally {
      clearTimeout(timer);
    }
  }

  function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.then(() => {}, () => {});
    return run;
  }

  function finish(result) {
    if (result && typeof result === 'object') return result;
    return { ok: false, error: 'failed' };
  }

  function isTimeout(err) {
    return !!(err && err.code === 'OBS_TIMEOUT');
  }

  // 期限切れは「DLL 側で実行されたか不明」。失敗とは区別して返し、すぐ同期して cache を合わせる。
  async function op(task) {
    try {
      return finish(await enqueue(task));
    } catch (err) {
      if (isTimeout(err)) {
        syncNow('timeout').catch(() => {});
        return { ok: false, error: 'timeout' };
      }
      return { ok: false, error: 'failed' };
    }
  }

  function cacheView() {
    return Array.from(cache.values()).map((row) => Object.assign({}, row));
  }

  function anyOutputLive() {
    for (const row of cache.values()) {
      if (ACTIVE.has(row.state)) return true;
    }
    return false;
  }

  function publish(name, payload, extra) {
    if (!bus || typeof bus.publish !== 'function') return;
    const info = extra || {};
    bus.publish(name, payload, {
      source: 'obs-engine',
      correlationId: info.correlationId || '',
      version: info.version
    });
  }

  function destinationAggregate() {
    if (!connected() || !aggregateReady) return { known: false, streaming: false };
    return { known: true, streaming: anyOutputLive() };
  }

  function notifySession(active, emergency) {
    if (emergency === true) heldEmergency = true;
    if (!sessions || typeof sessions.noteAggregate !== "function") return;
    try {
      if (!connected() || !aggregateReady) {
        sessions.noteAggregate({ known: false });
        return;
      }
      const streaming = active === true;
      const stopEmergency = !streaming && heldEmergency === true;
      if (!streaming) heldEmergency = false;
      sessions.noteAggregate({
        known: true,
        streaming: streaming,
        emergency: stopEmergency
      });
    } catch (_) { /* session end must not break the engine */ }
  }
  function noteAggregate(reason, correlationId) {
    const active = anyOutputLive();
    const emergency = stopReason === 'emergency' || reason === 'emergency';
    if (!aggregateReady) {
      aggregateReady = true;
      aggregateActive = active;
      notifySession(active, false);
      return;
    }
    if (active === aggregateActive) {
      notifySession(active, emergency);
      return;
    }
    if (active) suppressObsStopping = false;
    aggregateActive = active;
    const why = !active && stopReason ? stopReason : (reason || 'obs');
    if (!active) stopReason = '';
    publish(active ? EVENTS.STREAM_STARTED : EVENTS.STREAM_STOPPED, { reason: why }, { correlationId: correlationId || '' });
    notifySession(active, emergency);
  }

  function remember(target, observedAt) {
    const id = target && target.id != null ? String(target.id) : '';
    if (!id) return false;
    const prev = cache.get(id) || null;
    if (prev && typeof prev.observedAt === 'string' && observedAt < prev.observedAt) return false;
    const state = target.state != null ? String(target.state) : (prev ? prev.state : 'stopped');
    let keyTail = null;
    if (createdKeyTails.has(id)) {
      keyTail = createdKeyTails.get(id);
    } else if (target && (typeof target.keyTail === 'string' || target.keyTail === null)) {
      keyTail = target.keyTail;
    } else if (target && typeof target.key === 'string') {
      keyTail = target.key.length > 0 ? tailOf(target.key) : '';
    } else if (target && target.service_settings && typeof target.service_settings.key === 'string') {
      keyTail = target.service_settings.key.length > 0 ? tailOf(target.service_settings.key) : '';
    } else if (target && target.service && typeof target.service.key === 'string') {
      keyTail = target.service.key.length > 0 ? tailOf(target.service.key) : '';
    } else if (prev && (typeof prev.keyTail === 'string' || prev.keyTail === null)) {
      keyTail = prev.keyTail;
    }
    const next = {
      id: id,
      name: target.name != null ? redact(String(target.name)) : (prev ? prev.name : id),
      protocol: target.protocol != null ? String(target.protocol) : (prev ? prev.protocol : ''),
      state: state,
      enabled: typeof target.enabled === 'boolean' ? target.enabled : (prev ? prev.enabled === true : false),
      syncStart: typeof target.sync_start === 'boolean' ? target.sync_start : (target.syncStart != null ? target.syncStart === true : (prev ? prev.syncStart === true : false)),
      syncStop: typeof target.sync_stop === 'boolean' ? target.sync_stop : (target.syncStop != null ? target.syncStop === true : (prev ? prev.syncStop === true : false)),
      lastError: pickLastError(target, prev),
      reconnects: pickReconnects(target, prev),
      observedAt: observedAt,
      keyTail: keyTail
    };
    const changed = !prev || prev.state !== next.state || prev.lastError !== next.lastError || prev.enabled !== next.enabled || prev.name !== next.name || prev.syncStart !== next.syncStart || prev.syncStop !== next.syncStop || prev.reconnects !== next.reconnects;
    cache.set(id, next);
    if (store && typeof store.updateActual === 'function') {
      const patch = { engineState: next.state, lastError: next.lastError };
      if (next.reconnects != null) patch.reconnects = next.reconnects;
      for (const row of linkedTo(id)) {
        store.updateActual(row.id, patch, { source: 'obs-engine', observedAt: observedAt });
      }
    }
    if (changed) {
      publish(EVENTS.ENGINE_TARGET_CHANGED, {
        engineId: ENGINE_ID,
        targetId: id,
        name: next.name,
        state: next.state,
        enabled: next.enabled,
        lastError: next.lastError,
        reconnects: next.reconnects,
        syncStart: next.syncStart,
        syncStop: next.syncStop
      });
    }
    return changed;
  }

  function applyList(targets, observedAt) {
    const seen = new Set();
    const rows = Array.isArray(targets) ? targets : [];
    for (const row of rows) {
      if (!row || row.id == null) continue;
      seen.add(String(row.id));
      remember(row, observedAt);
    }
    for (const id of Array.from(cache.keys())) {
      const prev = cache.get(id);
      if (seen.has(id)) continue;
      if (prev && typeof prev.observedAt === 'string' && observedAt < prev.observedAt) continue;
      cache.delete(id);
    }
    noteAggregate('sync');
  }

  function normalizeApiVersion(body) {
    const value = body && body.apiVersion;
    const parsed = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  }

  function ensureVersion() {
    if (versionKnown) return Promise.resolve(apiVersion);
    const gen = versionGen;
    if (!versionProbe) {
      versionProbe = (async () => {
        let next = 1;
        let timedOut = false;
        try {
          const body = await vendor('read', 'get_api_version', {});
          next = normalizeApiVersion(body);
        } catch (err) {
          next = 1;
          timedOut = isTimeout(err);
        }
        if (gen !== versionGen) return apiVersion;
        apiVersion = next;
        if (timedOut) {
          // 未確認のまま残す。次の同期でもう一度読む。
          versionProbe = null;
          return apiVersion;
        }
        versionKnown = true;
        return apiVersion;
      })();
    }
    return versionProbe;
  }

  function pickLastError(target, prev) {
    if (target && Object.prototype.hasOwnProperty.call(target, 'lastError')) {
      if (target.lastError == null) return '';
      return redact(String(target.lastError));
    }
    if (target && target.last_error_code != null) return errorText(target.last_error_code);
    return prev ? prev.lastError : '';
  }

  function pickReconnects(target, prev) {
    let source;
    if (target && Object.prototype.hasOwnProperty.call(target, 'reconnects')) source = target.reconnects;
    else if (target && Object.prototype.hasOwnProperty.call(target, 'reconnect_count')) source = target.reconnect_count;
    else return prev && prev.reconnects != null ? prev.reconnects : null;
    if (source == null || source === '') return prev && prev.reconnects != null ? prev.reconnects : null;
    const n = Number(source);
    if (!Number.isFinite(n)) return prev && prev.reconnects != null ? prev.reconnects : null;
    return Math.trunc(n);
  }

  function fromSnapshotTarget(row) {
    const service = row && row.service && typeof row.service === 'object' && !Array.isArray(row.service) ? row.service : null;
    const next = { id: row.id };
    if (row.name != null) next.name = row.name;
    if (row.state != null) next.state = row.state;
    if (typeof row.enabled === 'boolean') next.enabled = row.enabled;
    if (row.protocol != null) next.protocol = row.protocol;
    else if (service && service.type != null && !isSecretKey('type')) next.protocol = service.type;
    if (Object.prototype.hasOwnProperty.call(row, 'reconnects')) next.reconnects = row.reconnects;
    if (Object.prototype.hasOwnProperty.call(row, 'lastError')) next.lastError = row.lastError;
    if (typeof row.sync_start === 'boolean') next.sync_start = row.sync_start;
    if (typeof row.sync_stop === 'boolean') next.sync_stop = row.sync_stop;
    if (row.keyTail !== undefined) next.keyTail = row.keyTail;
    else if (row.key != null && typeof row.key === 'string') next.keyTail = row.key.length > 0 ? tailOf(row.key) : '';
    else if (service && service.key != null && typeof service.key === 'string') next.keyTail = service.key.length > 0 ? tailOf(service.key) : '';
    else next.keyTail = null;
    return next;
  }

  function isSecretKey(name) {
    return /key|token|password|secret/i.test(String(name || ''));
  }

  async function refreshFromList(reason) {
    const observedAt = iso();
    const listed = await vendor('read', 'list_targets', {});
    const targets = listed && Array.isArray(listed.targets) ? listed.targets : [];
    const changed = [];
    for (const row of targets) {
      const id = row && row.id != null ? String(row.id) : '';
      const prev = id ? cache.get(id) : null;
      const state = row && row.state != null ? String(row.state) : '';
      if (!prev || prev.state !== state || prev.enabled !== (row.enabled === true)) changed.push(id);
    }
    applyList(targets, observedAt);
    for (const id of changed) {
      if (!id) continue;
      try {
        const status = await vendor('read', 'get_target_status', { id: id });
        if (status && status.error) continue;
        remember(Object.assign({ id: id }, status || {}), observedAt);
      } catch (_) { /* keep the list snapshot */ }
    }
    noteAggregate(reason || 'sync');
    return { ok: true };
  }

  async function refreshFromSnapshot(reason) {
    const body = await vendor('read', 'get_snapshot', {});
    const stamp = body && typeof body.observedAt === 'string' && body.observedAt ? body.observedAt : iso();
    const rows = body && Array.isArray(body.targets) ? body.targets : [];
    const targets = [];
    for (const row of rows) {
      if (!row || row.id == null) continue;
      targets.push(fromSnapshotTarget(row));
    }
    applyList(targets, stamp);
    noteAggregate(reason || 'sync');
    return { ok: true };
  }

  function setMainState(next, observedAt) {
    if (next === mainState) return;
    mainState = next;
    if (store && typeof store.updateActual === 'function') {
      for (const row of linkedTo(MAIN_ID)) {
        store.updateActual(row.id, { engineState: next, lastError: '' }, { source: 'obs-engine', observedAt: observedAt || iso() });
      }
    }
    publish(EVENTS.ENGINE_TARGET_CHANGED, {
      engineId: ENGINE_ID,
      targetId: MAIN_ID,
      name: 'メイン出力',
      state: next,
      enabled: true,
      lastError: '',
      reconnects: null,
      syncStart: false,
      syncStop: false
    });
  }

  // メイン出力の状態を 1 回読む。読めなければ前の値のまま。
  async function readMain() {
    if (!connected() || typeof connection.call !== 'function') return;
    try {
      const status = await connection.call('GetStreamStatus');
      if (!status || typeof status !== 'object') return;
      const next = status.outputReconnecting === true ? 'reconnecting' : (status.outputActive === true ? 'live' : 'idle');
      setMainState(next, iso());
    } catch (_) { /* keep the previous value */ }
  }

  async function refresh(reason) {
    await ensureVersion();
    const result = apiVersion >= 3 ? await refreshFromSnapshot(reason) : await refreshFromList(reason);
    await readMain();
    return result;
  }

  // 走っている同期が 1 つ、その後ろに待つ同期が最大 1 つ。UI が詰まっても poll が積み重ならない。
  function runSync(reason) {
    const job = refresh(reason);
    syncRun = job.then(() => {}, () => {}).then(() => { syncRun = null; });
    return job;
  }

  function syncNow(reason) {
    if (!syncRun) return runSync(reason);
    if (!syncNext) {
      syncNext = syncRun.then(() => {
        syncNext = null;
        return runSync(reason);
      });
    }
    return syncNext;
  }

  async function verifyCapabilities() {
    const body = await vendor('read', 'list_capabilities', {});
    const names = new Set(requestNames(body));
    missing = REQUIRED.filter((name) => !names.has(name));
    supported = missing.length === 0;
    capsChecked = true;
    return { supported: supported, missing: missing.slice() };
  }

  async function onConnected() {
    versionGen += 1;
    versionKnown = false;
    versionProbe = null;
    apiVersion = 1;
    try {
      await verifyCapabilities();
    } catch (err) {
      supported = false;
      if (!missing.length) missing = ['list_capabilities'];
      // 期限切れは未確認のまま。poll がもう一度読む。
      capsChecked = !isTimeout(err);
      logger('warn', 'obs capabilities were not read');
    }
    try {
      await syncNow('connect');
    } catch (_) {
      logger('warn', 'obs target list was not read');
    } finally {
      markReady();
    }
  }

  function vendorEvent(data) {
    const type = data && (data.eventType || data.event_type);
    if (type === 'emergency_stop') {
      const body = data.eventData || data.event_data || {};
      return { kind: 'emergency', body: body && typeof body === 'object' ? body : {} };
    }
    if (type) {
      const body = data.eventData || data.event_data || data;
      return { kind: 'target', body: body && typeof body === 'object' ? body : {} };
    }
    if (data && data.id == null && (Array.isArray(data.stopped_ids) || Array.isArray(data.stoppedIds))) {
      return { kind: 'emergency', body: data };
    }
    return { kind: 'target', body: data || {} };
  }

  function onEmergency(body) {
    stopReason = 'emergency';
    const rawAt = body && typeof body.time === 'string' && body.time ? body.time : iso();
    publish(EVENTS.ENGINE_EMERGENCY_STOP, { engineId: ENGINE_ID, at: redact(rawAt) }, {});
    syncNow('emergency').catch(() => {});
  }

  function onVendor(data) {
    const event = vendorEvent(data);
    if (event.kind === 'emergency') {
      onEmergency(event.body);
      return;
    }
    const observedAt = iso();
    remember(event.body || {}, observedAt);
    noteAggregate('event');
  }

  function onOutputState(outputState) {
    if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED' || outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') readMain().catch(() => {});
    if (outputState !== 'OBS_WEBSOCKET_OUTPUT_STOPPING') return;
    if (suppressObsStopping || stopReason === 'emergency') {
      suppressObsStopping = false;
      return;
    }
    publish(EVENTS.STREAM_STOPPING, { reason: 'obs', at: iso() }, {});
  }

  const connection = opts.connection || createObsConnection({
    orchestrator: orchestrator,
    core: core,
    logger: logger,
    onOutputState: onOutputState,
    client: opts.client,
    ObsWebSocket: opts.ObsWebSocket,
    EventSubscription: opts.EventSubscription,
    reconnectMs: opts.reconnectMs,
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
    getTitle: opts.getTitle,
    getStored: opts.getStored,
    onConnected: onConnected,
    bindInternal(api) { internal = api; }
  });

  if (internal && typeof internal.onVendorEvent === 'function') internal.onVendorEvent(onVendor);
  else if (typeof connection.onVendorEvent === 'function') connection.onVendorEvent(onVendor);

  function connected() {
    const status = connection.getStatus();
    return !!(status && status.connected);
  }

  function writeGate(hasDryRun) {
    if (!connected()) return { send: false, result: { ok: false, error: 'not-connected' } };
    if (!supported) return { send: false, result: { ok: false, error: 'unsupported', missing: missing.slice() } };
    const current = mode();
    if (current === 'legacy') return { send: false, result: { ok: false, error: 'read-only' } };
    if (current === 'shadow') {
      if (hasDryRun) return { send: 'dry' };
      return { send: false, result: { ok: true, dryRun: true } };
    }
    return { send: 'live' };
  }

  async function vendorWrite(requestType, requestData, hasDryRun) {
    const gate = writeGate(hasDryRun);
    const id = requestData && requestData.id != null ? String(requestData.id) : '';
    if (!gate.send) {
      record(requestType, { id: id, sent: false, dryRun: true, ok: gate.result.ok !== false, error: gate.result.error || '' });
      return gate.result;
    }
    if (gate.send === 'dry' || (gate.send === 'live' && hasDryRun)) {
      const trial = Object.assign({}, requestData, { dry_run: true });
      const dry = await vendor('write', requestType, trial);
      if (dry && dry.success === false) {
        record(requestType, { id: id, sent: true, dryRun: true, ok: false, error: dry.error || 'rejected' });
        return { ok: false, error: dry.error || 'rejected', dryRun: true };
      }
      if (gate.send === 'dry') {
        record(requestType, { id: id, sent: true, dryRun: true, ok: true });
        return { ok: true, dryRun: true };
      }
    }
    const real = await vendor('write', requestType, requestData);
    if (real && real.success === false) {
      record(requestType, { id: id, sent: true, dryRun: false, ok: false, error: real.error || 'rejected' });
      return { ok: false, error: real.error || 'rejected' };
    }
    record(requestType, { id: id, sent: true, dryRun: false, ok: true });
    return { ok: true };
  }

  function mainRow() {
    const link = linkedTo(MAIN_ID)[0] || null;
    return {
      id: MAIN_ID,
      name: 'メイン出力',
      protocol: '',
      state: mainState || 'idle',
      enabled: true,
      main: true,
      syncStart: false,
      syncStop: false,
      lastError: '',
      reconnects: null,
      destinationId: link ? link.id : '',
      site: link ? (link.site || '') : '',
      accountId: link ? (link.accountId || link.id) : '',
      linked: !!link,
      keyTail: ''
    };
  }

  function listTargets() {
    const rows = cacheView();
    const out = connected() ? [mainRow()] : [];
    return out.concat(rows.map((row) => {
      const links = linkedTo(row.id);
      const link = links[0] || null;
      return {
        id: row.id,
        name: row.name,
        protocol: row.protocol,
        state: row.state,
        enabled: row.enabled,
        syncStart: row.syncStart,
        syncStop: row.syncStop,
        lastError: row.lastError,
        reconnects: row.reconnects == null ? null : row.reconnects,
        destinationId: link ? link.id : '',
        site: link ? (link.site || '') : '',
        accountId: link ? (link.accountId || link.id) : '',
        linked: !!link,
        keyTail: row.keyTail !== undefined ? row.keyTail : null
      };
    }));
  }

  function unlinked() {
    return listTargets().filter((row) => !row.linked);
  }

  /**
   * 各ターゲットのビットレート（kbps）を OBS から読む。読むだけ（get_target_status / get_target_config。キーは出さない）。
   * 配信中なら測った値（bitrate_bps）、止まっていれば設定の output_settings.bitrate（kbps）。どちらも無ければ null（不明）。
   */
  async function readTargetRates() {
    const rows = cacheView();
    const out = [];
    for (const row of rows) {
      let kbps = null;
      let source = '';
      try {
        const status = await vendor('read', 'get_target_status', { id: String(row.id) });
        const bps = status && Number(status.bitrate_bps);
        if (Number.isFinite(bps) && bps > 0) { kbps = Math.round(bps / 1000); source = 'live'; }
      } catch (_) { /* 不明のまま */ }
      if (kbps == null) {
        try {
          const config = await vendor('read', 'get_target_config', { id: String(row.id), reveal_secrets: false });
          const set = config && config.output_settings && typeof config.output_settings === 'object' ? config.output_settings : null;
          const rate = set ? Number(set.bitrate) : NaN;
          if (Number.isFinite(rate) && rate > 0) { kbps = Math.round(rate); source = 'config'; }
        } catch (_) { /* 不明のまま */ }
      }
      out.push({ id: String(row.id), name: String(row.name || ''), enabled: row.enabled === true, kbps: kbps, source: source });
    }
    return out;
  }

  /**
   * 動いている配信先（live / connecting / reconnecting）の通信状況を OBS から読む。読むだけ（get_target_status）。
   * 返すのは id・state・fps・kbps（測れていなければ null）・経過ミリ秒・直近のエラー番号。キーは出さない。
   * 画面が数秒おきに呼ぶので、1.5 秒だけ前の答えを使い回す。
   */
  let statsCache = { at: 0, rows: [] };
  function readTargetStats() {
    if (Date.now() - statsCache.at < 1500) return Promise.resolve(statsCache.rows.map((row) => Object.assign({}, row)));
    if (!statsRun) statsRun = readTargetStatsNow().finally(() => { statsRun = null; });
    return statsRun.then((rows) => rows.map((row) => Object.assign({}, row)));
  }

  async function readTargetStatsNow() {
    const rows = [];
    for (const row of cacheView()) {
      if (!ACTIVE.has(row.state)) continue;
      const out = { id: String(row.id), state: String(row.state), fps: null, kbps: null, durationMs: null, lastErrorCode: null };
      try {
        const status = await vendor('read', 'get_target_status', { id: out.id });
        if (status && !status.error) {
          const bps = Number(status.bitrate_bps);
          const fps = Number(status.fps);
          const ms = Number(status.duration_ms);
          const code = Number(status.last_error_code);
          if (Number.isFinite(bps) && bps > 0) out.kbps = Math.round(bps / 1000);
          if (Number.isFinite(fps) && fps > 0) out.fps = Math.round(fps * 10) / 10;
          if (Number.isFinite(ms) && ms >= 0) out.durationMs = Math.round(ms);
          if (Number.isFinite(code) && code !== 0) out.lastErrorCode = code;
        }
      } catch (_) { /* 不明のまま */ }
      rows.push(out);
    }
    statsCache = { at: Date.now(), rows: rows };
    return rows.map((row) => Object.assign({}, row));
  }

  function status() {
    const conn = connection.getStatus();
    const targets = cacheView();
    let detail = 'OBS 未接続';
    if (conn.connected && supported) detail = '接続中・エンジン対応';
    else if (conn.connected) detail = '接続中・エンジン非対応（足りない: ' + missing.join(', ') + '）';
    return {
      id: ENGINE_ID,
      connected: !!conn.connected,
      supported: supported,
      mode: mode(),
      apiVersion: apiVersion,
      missing: missing.slice(),
      detail: detail,
      unlinked: unlinked(),
      button: emergencyButtonState(targets, !!conn.connected),
      liveCount: targets.filter((row) => row && row.state === 'live').length,
      profileWarning: anyOutputLive(),
      capabilities: capabilities()
    };
  }

  function capabilities() {
    const canWrite = supported && mode() === 'live';
    return {
      createTarget: supported,
      setKey: supported,
      perTargetQuality: false,
      emergencyStop: true,
      write: canWrite,
      apiVersion: apiVersion
    };
  }

  // メイン出力の開始・停止。obs-stream-control（プラグイン用の口）は通さず、接続の細い口を直接呼ぶ。
  function controlMain(action) {
    return op(async () => {
      // 門は「未接続」と「モード」だけ（supported は見ない。obs-multi-rtmp の版が合わなくてもメイン出力は動かせる）
      let blocked = null;
      if (!connected()) blocked = { ok: false, error: 'not-connected' };
      else if (mode() === 'legacy') blocked = { ok: false, error: 'read-only' };
      else if (mode() === 'shadow') blocked = { ok: true, dryRun: true };
      if (blocked) {
        record('stream_control', { id: MAIN_ID, sent: false, dryRun: true, ok: blocked.ok, error: blocked.error || '' });
        return blocked;
      }
      try {
        await connection.controlStream(action);
      } catch (err) {
        const error = isTimeout(err) ? 'timeout' : 'failed';
        record('stream_control', { id: MAIN_ID, sent: true, dryRun: false, ok: false, error: error });
        return { ok: false, error: error };
      }
      record('stream_control', { id: MAIN_ID, sent: true, dryRun: false, ok: true });
      await readMain();
      return { ok: true };
    });
  }

  function stop(id, flags) {
    if (String(id) === MAIN_ID) {
      if (flags && flags.reason === 'manual') suppressObsStopping = true;
      return controlMain('stop');
    }
    if (flags && flags.reason === 'manual') suppressObsStopping = true;
    return op(() => vendorWrite('stop_target', { id: String(id || '') }, false));
  }

  function setEnabled(id, enabled) {
    if (String(id) === MAIN_ID) return Promise.resolve({ ok: false, error: MAIN_ERROR });
    return op(() => vendorWrite('set_target_enabled', { id: String(id || ''), enabled: enabled === true }, false));
  }

  function setKey(id, settings, flags) {
    if (String(id) === MAIN_ID) return Promise.resolve({ ok: false, error: MAIN_ERROR });
    return op(async () => {
      const body = settings || {};
      const restart = !!(flags && flags.restartIfActive === true);
      const out = {};
      if (body.server != null) {
        const server = String(body.server).trim();
        if (server) out.server = server;
      }
      if (body.key != null) {
        const key = String(body.key).trim();
        if (key) {
          out.key = key;
          const tail = tailOf(key);
          createdKeyTails.set(String(id || ''), tail);
          const target = cache.get(String(id || ''));
          if (target) target.keyTail = tail;
        }
      }
      if (!Object.keys(out).length) return { ok: false, error: 'empty-settings' };
      return vendorWrite('set_target_service_settings', {
        id: String(id || ''),
        settings: out,
        merge: true,
        restart_if_active: restart
      }, true);
    });
  }

  function create(input) {
    return op(async () => {
      const row = input || {};
      const key = row.key == null ? '' : String(row.key);
      const res = await vendorWrite('create_target', {
        name: row.name == null ? '' : String(row.name),
        protocol: row.protocol == null ? '' : String(row.protocol),
        service_settings: {
          server: row.server == null ? '' : String(row.server),
          key: key
        },
        enabled: false
      }, true);
      if (res && res.id != null) {
        createdKeyTails.set(String(res.id), key ? tailOf(key) : '');
      }
      return res;
    });
  }

  function remove(id) {
    if (String(id) === MAIN_ID) return Promise.resolve({ ok: false, error: MAIN_ERROR });
    return op(() => vendorWrite('delete_target', { id: String(id || ''), confirm: true }, false));
  }

  function linkDestination(input) {
    const row = input || {};
    const destinationId = row.destinationId != null ? String(row.destinationId) : '';
    const targetId = row.targetId != null ? String(row.targetId) : '';
    if (!destinationId || !targetId) return { ok: false, error: 'bad-id' };
    if (!store || typeof store.putDestination !== 'function') return { ok: false, error: 'no-store' };
    const accountId = row.accountId != null && String(row.accountId) !== '' ? String(row.accountId) : destinationId;
    const saved = store.putDestination({
      id: destinationId,
      site: row.site != null ? String(row.site) : '',
      accountId: accountId,
      engine: { id: ENGINE_ID, targetId: targetId }
    });
    return saved && saved.ok === false ? saved : { ok: true, destination: saved && saved.destination };
  }

  function unlinkDestination(destinationId) {
    const id = destinationId != null ? String(destinationId) : '';
    if (!id) return { ok: false, error: 'bad-id' };
    if (!store || typeof store.putDestination !== 'function') return { ok: false, error: 'no-store' };
    const saved = store.putDestination({ id: id, engine: null });
    return saved && saved.ok === false ? saved : { ok: true };
  }

  async function stopAll(ctx) {
    const info = ctx || {};
    const correlationId = info.correlationId || ('c-' + crypto.randomBytes(4).toString('hex'));
    const at = iso();
    stopReason = 'emergency';
    suppressObsStopping = true;
    publish(EVENTS.STREAM_STOPPING, { reason: 'emergency', at: at }, { correlationId: correlationId });
    if (!connected()) {
      stopReason = '';
      const result = { ok: false, error: 'not-connected', count: 0, targetsStillActive: [], mainStillActive: false, mainStopped: false };
      appendLog('emergency', { at: at, ok: false, error: result.error, correlationId: correlationId });
      return result;
    }
    let firstError = '';
    let count = 0;
    try {
      const raw = await vendor('emergency', 'stop_all_targets', {});
      count = raw && raw.count != null ? Number(raw.count) : 0;
      if (raw && raw.success === false) {
        firstError = raw.error || 'rejected';
      }
    } catch (err) {
      const timeout = isTimeout(err);
      if (!timeout) stopReason = '';
      const error = timeout ? 'timeout' : 'failed';
      firstError = error;
      if (timeout) syncNow('timeout').catch(() => {});
    }
    let mainWasActive = false;
    let mainStillActive = false;
    let mainStopped = false;
    try {
      const status = await connection.call('GetStreamStatus');
      mainWasActive = !!(status && status.outputActive === true);
      if (mainWasActive) {
        try {
          await connection.controlStream('stop');
          mainStopped = true;
        } catch (_) {
          firstError = firstError || 'main-stop-failed';
        }
      }
    } catch (_) {
      firstError = firstError || 'main-status-failed';
    }
    const tries = stopVerifyTries;
    const verifyMs = stopVerifyMs;
    let targetsStillActive = [];
    let lastMainStillActive = mainWasActive && !mainStopped;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        await syncNow('stop-all');
      } catch (_) {
        // 同期失敗でも止まったかの確認は続ける
      }
      let status2 = null;
      try {
        status2 = await connection.call('GetStreamStatus');
        mainStillActive = !!(status2 && status2.outputActive === true);
        lastMainStillActive = mainStillActive;
      } catch (_) {
        mainStillActive = lastMainStillActive;
      }
      const activeRows = cacheView().filter((row) => ACTIVE.has(row.state));
      targetsStillActive = activeRows.map((row) => row.id);
      if (!mainStillActive && targetsStillActive.length === 0) {
        break;
      }
      if (attempt < tries - 1) {
        await sleep(verifyMs);
      }
    }
    const ok = !mainStillActive && targetsStillActive.length === 0;
    const error = ok ? firstError : (firstError || 'still-active');
    const result = {
      ok: ok,
      error: error,
      count: count,
      targetsStillActive: targetsStillActive.slice(),
      mainStillActive: mainStillActive,
      mainStopped: mainStopped
    };
    appendLog('emergency', {
      at: at,
      ok: result.ok,
      error: result.error || '',
      count: result.count,
      targetsStillActive: result.targetsStillActive.length,
      mainStillActive: result.mainStillActive,
      mainStopped: result.mainStopped,
      correlationId: correlationId
    });
    if (!ok && firstError !== 'timeout') stopReason = '';
    return result;
  }

  function armPoll() {
    if (pollTimer || !(pollMs > 0)) return;
    const setTimer = opts.setIntervalFn || setInterval;
    pollTimer = setTimer(() => {
      if (!connected()) return;
      if (!capsChecked) verifyCapabilities().catch(() => {});
      syncNow('poll').catch(() => {});
    }, pollMs);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  async function start() {
    armPoll();
    try {
      const result = await connection.start();
      if (opts.connection) await onConnected();
      return result;
    } finally {
      if (!connection.getStatus().connected) markReady();
    }
  }

  /** 接続設定を変えたあと、切ってつなぎ直す。 */
  async function reconnect() {
    armPoll();
    try {
      const result = await connection.reconnect();
      if (opts.connection) await onConnected();
      return result;
    } finally {
      if (!connection.getStatus().connected) markReady();
    }
  }

  function shutdown() {
    if (pollTimer && (opts.clearIntervalFn || clearInterval)) {
      (opts.clearIntervalFn || clearInterval)(pollTimer);
    }
    pollTimer = null;
    connection.stop();
  }

  return {
    id: ENGINE_ID,
    modeId: MODE_ID,
    capabilities,
    listTargets,
    readTargetRates,
    readTargetStats,
    status,
    start(id) {
      if (String(id) === MAIN_ID) return controlMain('start');
      return op(() => vendorWrite('start_target', { id: String(id || '') }, false));
    },
    connect: start,
    reconnect,
    stop,
    setEnabled,
    setKey,
    create,
    remove,
    linkDestination,
    unlinkDestination,
    stopAll,
    emergencyStop: stopAll,
    anyOutputLive,
    destinationAggregate,
    whenReady: () => ready,
    syncNow,
    shutdown,
    connection
  };
}

module.exports = {
  createObsLocalEngine,
  ENGINE_ID,
  MODE_ID,
  errorText,
  REQUIRED
};
