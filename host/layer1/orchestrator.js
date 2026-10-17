'use strict';

/**
 * 題名／カテゴリのファンアウトと OBS イベントの分配。
 * モードは state/services/marust-fanout.json。無ければ legacy（副作用なし）。
 * この別プロセス骨格は NeonTimer の startStreamingApis を呼ばない。
 * legacy = 送らない。shadow = dryRun で記録。orchestrator = プラグインを呼び、同じ形で記録。
 * プラグインごとのモードは marust-modes.json の plugins[id]、次に default。読み込みは host/core/modes.js。
 * それも無いとき、manifest v1 で fanout を持つものだけ marust-fanout.json を引き継ぐ（orchestrator は live）。
 * manifest v2 は自分の defaultMode、無ければ legacy。fanout が orchestrator でも v2 は live にしない。
 * モードファイルも fanout ファイルも legacy でも、起動中の v2 の defaultMode が live / shadow なら送る。
 * 1 回の fanout / dispatchObs ではモードファイルを 1 回だけ読む。
 * summarizeModes は起動中プラグインの live / shadow / legacy を数える。
 * forceLegacy はプロセスが終わるまで全部 legacy。ファイルは書かない。
 * fanout の中身（v1 より v2 のサイトを優先する判断を含む）は 役目 title.fanout@1 を持つプラグインの lib/fanout.js。ここは役目 title.fanout@1 のプラグインへ渡すだけ。
 * 失敗の符号は記録の message に出す。値や応答本文は出さない。
 * キューはプラグイン id と用途（fanout / obs）ごと。タイムアウト後も本体が終わるまでそのキーは busy。
 * 本体が max(timeout*3, 60秒) を過ぎても終わらなければ stuck。isConfigured のタイムアウトは待たない。
 * obs-start は配信セッションにつき 1 回。状態はメモリ上だけ。
 */

const path = require('path');
const { run, defaultLogger, redact, defaultTimeoutMs } = require('../core');
const { readModesDocument, lookupPluginMode } = require('./modes');
const { appendJsonl } = require('../core');
const { localIso, clipField, summarizeSites } = require('./audit-fields');
const { PEER_METHODS } = require('./plugin-api-check');

const MAX_MANIFEST_TIMEOUT_MS = 120000;
const STUCK_FLOOR_MS = 60000;
const SEND_COMMENT_TIMEOUT_MS = 12000;
const PEER_VALUE = new Set(['updateMetadata', 'sendComment', 'isConfigured', 'suggestCategories']); // 答えの value をプラグインへ返すメソッド
const PEER_WRITES = new Set(['updateMetadata', 'updateStream', 'updateTitle', 'updateCategory', 'sendComment']);
const OBS_STARTING = 'OBS_WEBSOCKET_OUTPUT_STARTING';
const OBS_STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED';
const OBS_STOPPING = 'OBS_WEBSOCKET_OUTPUT_STOPPING';
const OBS_STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED';

function manifestTimeoutMs(rec, method) {
  const timeouts = rec && rec.manifest && rec.manifest.timeouts;
  if (!timeouts || typeof timeouts !== 'object' || Array.isArray(timeouts)) return undefined;
  const raw = timeouts[method];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  if (raw < 1 || raw > MAX_MANIFEST_TIMEOUT_MS) return undefined;
  return raw;
}


function formatModeSummary(summary) {
  const row = summary || {};
  return 'live ' + (row.live || 0) + ' / shadow ' + (row.shadow || 0) + ' / legacy ' + (row.legacy || 0);
}

function allowedLiveIdsForHub(payload, liveIds) {
  const confirmed = !!(payload && payload.confirmed === true);
  if (confirmed) {
    if (!Array.isArray(payload.allowedLiveIds)) return [];
    return payload.allowedLiveIds.filter((id) => typeof id === 'string');
  }
  return Array.isArray(liveIds) ? liveIds.slice() : [];
}

function hubFanoutDecision(summary, confirmed) {
  const live = summary && summary.live ? summary.live : 0;
  const shadow = summary && summary.shadow ? summary.shadow : 0;
  const liveIds = summary && Array.isArray(summary.liveIds) ? summary.liveIds.slice() : [];
  if (live + shadow === 0) return { send: false, legacy: true, liveIds: liveIds };
  if (live > 0 && confirmed !== true) return { send: false, needsConfirm: true, liveIds: liveIds };
  return { send: true, liveIds: liveIds };
}

function cliFanoutDecision(summary, confirmEnv) {
  const live = summary && summary.live ? summary.live : 0;
  const shadow = summary && summary.shadow ? summary.shadow : 0;
  if (live + shadow === 0) return { send: false, reason: 'legacy' };
  if (live > 0 && String(confirmEnv == null ? '' : confirmEnv) !== '1') {
    return { send: false, reason: 'needs-confirm' };
  }
  return { send: true, reason: '' };
}

function createOrchestrator(options) {
  const opts = options || {};
  const registry = opts.registry;
  const core = opts.core;
  const logger = opts.logger || defaultLogger;
  const runner = opts.run || run;
  const queues = new Map();
  let obsStarted = false;

  function resolverNow() {
    return (opts.modeSource && typeof opts.modeSource.get === 'function') ? opts.modeSource.get() : null;
  }

  function readModesFile() {
    const read = readModesDocument(core);
    if (!read || read.missing || !read.ok) {
      if (read && read.reason === 'parse') logger('warn', 'invalid marust-modes.json count=1');
      return null;
    }
    return read.data;
  }

  function validPluginMode(value) {
    return value === 'legacy' || value === 'shadow' || value === 'live';
  }

  function findManifest(rows, id) {
    if (!Array.isArray(rows)) return undefined;
    for (let i = 0; i < rows.length; i += 1) {
      const rec = rows[i];
      if (rec && String(rec.id) === id) return rec.manifest || null;
    }
    return undefined;
  }

  function manifestOf(pluginId) {
    const id = pluginId == null ? '' : String(pluginId);
    if (registry && typeof registry.getRunning === 'function') {
      try {
        const found = findManifest(registry.getRunning() || [], id);
        if (found !== undefined) return found;
      } catch (_) { /* 一覧が取れなければ fanout は引き継がない */ }
    }
    if (registry && typeof registry.snapshot === 'function') {
      try {
        const found = findManifest(registry.snapshot() || [], id);
        if (found !== undefined) return found;
      } catch (_) { /* 未起動の定義が取れなくても続ける */ }
    }
    return null;
  }

  function modeFromSnapshot(pluginId, snap, ignoreForced) {
    const resolver = resolverNow();
    if (resolver) {
      try {
        const modes = snap && snap.modes;
        const info = {
          modes: modes,
          specific: modes ? lookupPluginMode(modes.plugins, pluginId) : '',
          manifest: manifestOf(pluginId),
          external: !!(registry && typeof registry.sourceOf === 'function' && registry.sourceOf(String(pluginId)) === 'user'),
          ignoreForced: ignoreForced === true,
          runningDefaultNonLegacy: runningDefaultNonLegacy()
        };
        const mode = resolver.modeFor(pluginId, info);
        if (validPluginMode(mode)) return mode;
        return 'legacy';
      } catch (_) {
        return 'legacy';
      }
    }
    // 公開版（resolver 無し）
    const id = String(pluginId);
    if (id === 'broadcast' || id === 'obs-engine') return 'live';
    const modes = snap && snap.modes;
    const specific = modes ? lookupPluginMode(modes.plugins, pluginId) : '';
    if (specific === 'live') return 'live';
    if (specific) return 'legacy';
    if (registry && typeof registry.sourceOf === 'function' && registry.sourceOf(id) === 'user') return 'legacy';
    const manifest = manifestOf(pluginId);
    if (manifest && manifest.defaultMode === 'live') return 'live';
    return 'legacy';
  }

  function runningHasNonLegacy(snap) {
    const running = typeof registry.getRunning === 'function' ? (registry.getRunning() || []) : [];
    for (let i = 0; i < running.length; i += 1) {
      const rec = running[i];
      const id = rec && rec.id != null ? String(rec.id) : '';
      const pluginMode = modeFromSnapshot(id, snap);
      if (pluginMode === 'live' || pluginMode === 'shadow') return true;
    }
    return false;
  }

  function takeSnapshot() {
    return { modes: readModesFile() };
  }

  function modeFor(pluginId, snap) {
    return modeFromSnapshot(pluginId, snap || takeSnapshot());
  }

  // 全部 legacy に固定していても変わらない、そのプラグインの設定上のモード（機能の API を出す・隠すの判断に使う）
  function modeSetting(pluginId) {
    return modeFromSnapshot(pluginId, takeSnapshot(), true);
  }

  function runningDefaultNonLegacy(includeShadow) {
    let running = [];
    try {
      running = registry && typeof registry.getRunning === 'function' ? (registry.getRunning() || []) : [];
    } catch (_) {
      return false;
    }
    const countShadow = includeShadow !== false; // 既定は true。resolver 無しの道では false で live だけ数える
    for (let i = 0; i < running.length; i += 1) {
      const manifest = running[i] && running[i].manifest;
      if (manifest && manifest.manifestVersion === 2 && (manifest.defaultMode === 'live' || (countShadow && manifest.defaultMode === 'shadow'))) {
        return true;
      }
    }
    return false;
  }

  function anyNonLegacySnapshot(snap) {
    const resolver = resolverNow();
    if (resolver) {
      return resolver.anyNonLegacy({
        modes: snap && snap.modes,
        runningDefaultNonLegacy: runningDefaultNonLegacy()
      });
    }
    const modes = snap && snap.modes;
    if (modes && modes.plugins && typeof modes.plugins === 'object' && !Array.isArray(modes.plugins)) {
      for (const value of Object.values(modes.plugins)) {
        if (value === 'live') return true;
      }
    }
    return runningDefaultNonLegacy(false);
  }

  // 題名の送り先になるもの（v2 のサイト stream.site@1 と、fanout を宣言した v1 のサイト）。機能の印のプラグインなどは含めない
  function isTitleTarget(rec) {
    const manifest = rec && rec.manifest;
    if (!manifest) return false;
    if (manifest.fanout && typeof manifest.fanout === 'object') return true;
    return Array.isArray(manifest.provides) && manifest.provides.indexOf('stream.site@1') !== -1;
  }

  // opts.titleTargets: 題名の送り先だけ数える（タイマーの確認の門が使う。timer-link などの印を「本番」と数えない）
  function summarizeModes(opts, snapshot) {
    const snap = snapshot || takeSnapshot();
    const onlyTargets = !!(opts && opts.titleTargets === true);
    const resolver = resolverNow();
    const summary = { live: 0, shadow: 0, legacy: 0, forced: resolver ? resolver.forced() : false, liveIds: [] };
    const running = typeof registry.getRunning === 'function' ? registry.getRunning() : [];
    for (const rec of running) {
      if (onlyTargets && !isTitleTarget(rec)) continue;
      const id = rec && rec.id != null ? String(rec.id) : '';
      const pluginMode = modeFromSnapshot(id, snap);
      if (pluginMode === 'live') {
        summary.live += 1;
        summary.liveIds.push(id);
      } else if (pluginMode === 'shadow') {
        summary.shadow += 1;
      } else {
        summary.legacy += 1;
      }
    }
    return summary;
  }

  function obsCapable(rec, cap) {
    const caps = (rec && rec.manifest && rec.manifest.capabilities) || [];
    if (caps.includes(cap)) return true;
    if (cap !== 'obs-start' && cap !== 'obs-stop') return false;
    const provides = (rec && rec.manifest && rec.manifest.provides) || [];
    return provides.indexOf('stream.lifecycle@1') !== -1;
  }

  function forceLegacy(reason) {
    const resolver = resolverNow();
    if (resolver) {
      return resolver.forceLegacy(reason);
    }
    return { ok: false, error: 'unavailable' };
  }

  function withMode(row, pluginMode) {
    if (!row || typeof row !== 'object') return row;
    return Object.assign({}, row, { mode: pluginMode });
  }


  function stuckLimitMs(timeoutMs) {
    if (Number.isFinite(opts.stuckAfterMs) && opts.stuckAfterMs >= 0) return opts.stuckAfterMs;
    const base = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeoutMs();
    return Math.max(base * 3, STUCK_FLOOR_MS);
  }

  function queueOf(key) {
    let q = queues.get(key);
    if (!q) {
      q = { running: false, pending: null, stuck: false, pluginId: null };
      queues.set(key, q);
    }
    return q;
  }

  function queueKeyStuck(key) {
    const q = queues.get(key);
    return !!(q && q.stuck);
  }

  function pluginIsStuck(pluginId) {
    for (const q of queues.values()) {
      if (q.stuck && q.pluginId === pluginId) return true;
    }
    return false;
  }

  function markStuck(key) {
    const q = queues.get(key);
    if (!q || q.stuck) return;
    q.stuck = true;
    if (q.pending) {
      const waiting = q.pending;
      q.pending = null;
      waiting.resolve(skip(waiting.pluginId, 'plugin-stuck'));
    }
  }

  if (!registry) throw new Error('orchestrator requires registry');
  if (!core) throw new Error('orchestrator requires core');

  function currentMode() {
    const resolver = resolverNow();
    if (resolver) return resolver.fanoutMode();
    return 'orchestrator';
  }

  function skip(id, message) {
    return { id, result: 'skip', elapsedMs: 0, message };
  }

  function enqueue(key, pluginId, task) {
    return new Promise((resolve) => {
      const q = queueOf(key);
      q.pluginId = pluginId;
      if (q.stuck) {
        resolve(skip(pluginId, 'plugin-stuck'));
        return;
      }
      const entry = { task, resolve, pluginId };
      if (!q.running) {
        q.running = true;
        pump(key, entry);
        return;
      }
      if (q.pending) q.pending.resolve(skip(q.pending.pluginId, 'superseded'));
      q.pending = entry;
    });
  }

  async function pump(key, entry) {
    const q = queues.get(key);
    let settled = null;
    let timedOut = false;
    let callTimeoutMs = null;
    try {
      const out = await entry.task();
      if (out && out.settled && typeof out.settled.then === 'function') settled = out.settled;
      timedOut = !!(out && out.result === 'timeout');
      if (out && Number.isFinite(out.timeoutMs)) callTimeoutMs = out.timeoutMs;
      entry.resolve({
        id: out && out.id != null ? out.id : entry.pluginId,
        result: out && out.result != null ? out.result : 'error',
        elapsedMs: out && out.elapsedMs != null ? out.elapsedMs : 0,
        message: out && out.message != null ? out.message : '',
        value: out && out.value !== undefined ? out.value : undefined
      });
    } catch (err) {
      entry.resolve({
        id: entry.pluginId,
        result: 'error',
        elapsedMs: 0,
        message: redact(err && err.message)
      });
    }
    if (settled && timedOut) {
      const timer = setTimeout(() => markStuck(key), stuckLimitMs(callTimeoutMs));
      try {
        await settled;
      } catch (_) {
        /* settled is not supposed to reject */
      }
      clearTimeout(timer);
      if (q) q.stuck = false;
    } else if (settled) {
      try {
        await settled;
      } catch (_) {
        /* settled is not supposed to reject */
      }
    }
    if (q && q.pending) {
      const next = q.pending;
      q.pending = null;
      await pump(key, next);
      return;
    }
    if (q) q.running = false;
  }

  async function ensureLoaded() {
    if (!registry.isLoaded()) await registry.loadAll();
  }

  function runOpts(rec, method, loggerFor) {
    const timeoutMs = manifestTimeoutMs(rec, method);
    const callOpts = { logger: loggerFor };
    if (timeoutMs != null) callOpts.timeoutMs = timeoutMs;
    return callOpts;
  }

  async function consider(rec, gate) {
    if (!gate.ok) return skip(rec.id, gate.message);
    const loggerFor = (level, message) => logger(level, `${rec.id} ${message}`);
    const checked = await runner(rec.instance, 'isConfigured', [], runOpts(rec, 'isConfigured', loggerFor));
    if (checked && checked.result === 'timeout') return skip(rec.id, 'not-configured-timeout');
    if (!checked || checked.result !== 'ok' || !checked.value) return skip(rec.id, 'not-configured');
    return null;
  }

  function shouldAudit(mode) {
    return mode === 'shadow' || mode === 'orchestrator';
  }

  async function writeAudit(record) {
    if (!core || !core.STATE_DIR) return;
    const dir = path.join(core.STATE_DIR, 'logs', 'marust');
    const ok = appendJsonl(dir, 'shadow', record);
    if (!ok) logger('warn', 'shadow log was not written');
  }

  function publicCall(id, ran) {
    return {
      id,
      result: ran.result,
      elapsedMs: ran.elapsedMs,
      message: ran.message || '',
      settled: ran.settled || null,
      timeoutMs: ran && Number.isFinite(ran.timeoutMs) ? ran.timeoutMs : undefined
    };
  }

  // 題名の一斉変更は内蔵プラグイン（役目 title.fanout@1。plugins/bulk-title）が行う。ここは渡すだけの薄い口（V2-8）。
  // 全部 legacy のときは今までどおり legacy-mode の 1 行、渡す先が無ければ no-plugin の 1 行。
  async function fanout(intent) {
    const snap = takeSnapshot();
    if (!anyNonLegacySnapshot(snap)) return [skip('*', 'legacy-mode')];
    await ensureLoaded();
    if (!runningHasNonLegacy(snap)) return [skip('*', 'legacy-mode')];
    if (typeof opts.fanoutImpl === 'function') return opts.fanoutImpl(intent); // 試験・組み込み用の差し替え
    const rec = fanoutProvider();
    if (!rec) return [skip('*', 'no-plugin')];
    const loggerFor = (level, message) => logger(level, rec.id + ' ' + message);
    const ran = await runner(rec.instance, 'fanout', [intent], { logger: loggerFor, timeoutMs: manifestTimeoutMs(rec, 'fanout') || 120000 });
    if (ran.result === 'timeout') return [{ id: '*', result: 'error', elapsedMs: 0, message: 'timeout' }];
    if (ran.result !== 'ok' || !Array.isArray(ran.value)) return [{ id: '*', result: 'error', elapsedMs: 0, message: 'bad-result' }];
    return ran.value;
  }

  function noteObsState(outputState) {
    if (outputState === OBS_STARTING || outputState === OBS_STARTED) {
      if (obsStarted) return { cap: null };
      obsStarted = true;
      return { cap: 'obs-start' };
    }
    if (outputState === OBS_STOPPING) {
      obsStarted = false;
      return { cap: 'obs-stop' };
    }
    if (outputState === OBS_STOPPED) {
      obsStarted = false;
      return { cap: null };
    }
    return { cap: null };
  }

  async function dispatchObs(input) {
    const snap = takeSnapshot();
    if (!anyNonLegacySnapshot(snap)) return [skip('*', 'legacy-mode')];
    await ensureLoaded();
    if (!runningHasNonLegacy(snap)) return [skip('*', 'legacy-mode')];
    const outputState = input && input.outputState;
    const decision = noteObsState(outputState);
    const title = input && input.title != null ? String(input.title) : '';
    const category = input && input.category != null ? String(input.category) : '';
    let rows = [];
    if (decision.cap) {
      const jobs = [];
      for (const rec of registry.getRunning()) {
        if (!obsCapable(rec, decision.cap)) continue;
        const pluginMode = modeFor(rec.id, snap);
        if (pluginMode === 'legacy') {
          jobs.push(Promise.resolve(withMode(skip(rec.id, 'legacy-mode'), pluginMode)));
          continue;
        }
        const dryRun = pluginMode === 'shadow' ? true : !!(input && input.dryRun);
        const meta = {
          source: 'obs',
          dryRun,
          mode: pluginMode
        };
        jobs.push((async () => {
          const queueKey = rec.id + ':obs';
          if (queueKeyStuck(queueKey)) return withMode(skip(rec.id, 'plugin-stuck'), pluginMode);
          const denied = await consider(rec, { ok: true });
          if (denied) return withMode(denied, pluginMode);
          const ran = await enqueue(queueKey, rec.id, async () => {
            const loggerFor = (level, message) => logger(level, rec.id + ' ' + message);
            const result = await runner(
              rec.instance,
              'onObsEvent',
              [{ outputState }, { title }, meta],
              runOpts(rec, 'onObsEvent', loggerFor)
            );
            return publicCall(rec.id, result);
          });
          return withMode(ran, pluginMode);
        })());
      }
      rows = await Promise.all(jobs);
    }
    await writeAudit({
      ts: localIso(),
      kind: 'obs',
      source: 'obs',
      outputState: outputState == null ? '' : String(outputState),
      title: clipField(title),
      category: clipField(category),
      sites: summarizeSites(rows)
    });
    return rows;
  }

  // ---- ctx.peers（V2-10〜V2-12）。内蔵プラグインが、サイトの決まったメソッドだけを呼ぶ口 ----
  function runningRec(id) {
    let rows = [];
    try { rows = registry.getRunning() || []; } catch (_) { return null; }
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] && String(rows[i].id) === id) return rows[i];
    }
    return null;
  }

  function isBuiltin(id) {
    return !(registry && typeof registry.sourceOf === 'function' && registry.sourceOf(String(id)) === 'user');
  }

  // 1 回のスナップショットで、動いている全プラグイン（呼んだ本人を除く）。インスタンス・パス・秘密は渡さない
  function peerList(callerId) {
    const snap = takeSnapshot();
    let rows = [];
    try { rows = registry.getRunning() || []; } catch (_) { return []; }
    const out = [];
    for (const rec of rows) {
      if (!rec || String(rec.id) === callerId) continue;
      const id = String(rec.id);
      const m = rec.manifest || {};
      const fan = m.fanout;
      out.push({
        id,
        mode: modeFor(id, snap),
        manifestVersion: m.manifestVersion === 2 ? 2 : 1,
        provides: Array.isArray(m.provides) ? m.provides.map(String) : [],
        fanout: fan && typeof fan === 'object' ? { method: String(fan.method || ''), requires: fan.requires == null ? '' : String(fan.requires) } : null
      });
    }
    return out;
  }

  function peerRoleOk(rec, method) {
    const m = rec.manifest || {};
    const provides = Array.isArray(m.provides) ? m.provides : [];
    const v2site = m.manifestVersion === 2 && provides.indexOf('stream.site@1') !== -1;
    const fan = m.fanout && typeof m.fanout === 'object' ? m.fanout : null;
    if (method === 'updateMetadata' || method === 'suggestCategories') return v2site;
    if (method === 'updateStream' || method === 'updateTitle' || method === 'updateCategory') return !!fan && fan.method === method;
    if (method === 'isConfigured') return v2site || !!fan;
    if (method === 'sendComment') return provides.indexOf('chat.sink@1') !== -1;
    return false;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // 答え: { id, result: 'ok'|'error'|'timeout'|'skip', elapsedMs, message, value? }。value は ok のときだけ、JSON で複製できるものだけ
  async function peerRun(callerId, id, method, args, popts) {
    const target = typeof id === 'string' ? id : '';
    const row = (result, message) => ({ id: target, result, elapsedMs: 0, message });
    const denied = () => row('error', 'peer-denied');
    if (!target || target === callerId || PEER_METHODS.indexOf(method) === -1) return denied();
    const call = popts && typeof popts === 'object' && !Array.isArray(popts) ? popts : {};
    if (call.queue !== undefined && call.queue !== 'fanout') return denied();
    const rec = runningRec(target);
    if (!rec || !rec.instance || !peerRoleOk(rec, method)) return denied();
    let callArgs;
    try { callArgs = cloneJson(Array.isArray(args) ? args : []); } catch (_) { return row('error', 'bad-args'); }
    if (PEER_WRITES.has(method)) {
      const pluginMode = modeFor(target, takeSnapshot());
      if (pluginMode === 'legacy') return row('skip', 'legacy-mode');
      if (pluginMode === 'shadow') {
        const last = callArgs[callArgs.length - 1];
        if (!last || typeof last !== 'object' || Array.isArray(last)) return row('error', 'bad-args');
        last.dryRun = true;
        if (method !== 'sendComment') last.mode = 'shadow';
      }
    }
    const loggerFor = (level, message) => logger(level, target + ' ' + message);
    const callOpts = { logger: loggerFor };
    const timeoutMs = manifestTimeoutMs(rec, method) != null ? manifestTimeoutMs(rec, method) : (method === 'sendComment' ? SEND_COMMENT_TIMEOUT_MS : undefined);
    if (timeoutMs != null) callOpts.timeoutMs = timeoutMs;
    const exec = async () => {
      const ran = await runner(rec.instance, method, callArgs, callOpts);
      return {
        id: target,
        result: ran.result,
        elapsedMs: ran.elapsedMs,
        message: redact(ran.message || ''),
        settled: ran.settled || null,
        timeoutMs: Number.isFinite(ran.timeoutMs) ? ran.timeoutMs : undefined,
        value: ran.result === 'ok' && PEER_VALUE.has(method) ? ran.value : undefined
      };
    };
    let out;
    if (call.queue === 'fanout') {
      const key = target + ':fanout';
      if (queueKeyStuck(key)) return row('skip', 'plugin-stuck');
      out = await enqueue(key, target, exec);
    } else {
      out = await exec();
    }
    const result = { id: out.id != null ? String(out.id) : target, result: out.result, elapsedMs: out.elapsedMs, message: redact(out.message || '') };
    if (out.result === 'ok' && out.value !== undefined) {
      try { result.value = cloneJson(out.value); } catch (_) { return { id: target, result: 'error', elapsedMs: out.elapsedMs, message: 'bad-result' }; }
    }
    return result;
  }

  // 題名の一斉変更を引き受ける内蔵プラグイン（役目 title.fanout@1・legacy でない・全部 legacy に固定していない）。無ければ null
  function fanoutProvider() {
    const resolver = resolverNow();
    if (resolver && resolver.forced()) return null;
    const snap = takeSnapshot();
    let rows = [];
    try { rows = registry.getRunning() || []; } catch (_) { return null; }
    for (const rec of rows) {
      const provides = rec && rec.manifest && Array.isArray(rec.manifest.provides) ? rec.manifest.provides : [];
      if (provides.indexOf('title.fanout@1') === -1 || !isBuiltin(rec.id)) continue;
      if (modeFor(String(rec.id), snap) === 'legacy') continue;
      if (rec.instance && typeof rec.instance.fanout === 'function') return rec;
    }
    return null;
  }

  async function health() {
    await ensureLoaded();
    const rows = [];
    for (const rec of registry.getRunning()) {
      const loggerFor = (level, message) => logger(level, `${rec.id} ${message}`);
      const ran = await runner(rec.instance, 'health', [], runOpts(rec, 'health', loggerFor));
      rows.push({
        id: rec.id,
        result: ran.result,
        elapsedMs: ran.elapsedMs,
        message: ran.message || '',
        health: ran.result === 'ok' ? ran.value : null,
        stuck: pluginIsStuck(rec.id)
      });
    }
    return rows;
  }

  return {
    fanout,
    dispatchObs,
    health,
    readMode: currentMode,
    modeFor, takeSnapshot, // 表示の1要求内だけ共有。操作は従来どおり新しく読む。
    modeSetting,
    modesPluginOn: function () { return !!resolverNow(); },
    summarizeModes,
    forceLegacy,
    peerList,
    peerRun,
    fanoutProvider
  };
}

// registry の opts.peers に渡す口。orchestrator は registry より後に作られるので、呼ばれたときに見る
function createPeersBridge(getOrchestrator) {
  return {
    list(callerId) {
      const o = getOrchestrator();
      return o ? o.peerList(callerId) : [];
    },
    run(callerId, id, method, args, popts) {
      const o = getOrchestrator();
      return o ? o.peerRun(callerId, id, method, args, popts) : Promise.resolve({ id: String(id), result: 'error', elapsedMs: 0, message: 'unavailable' });
    }
  };
}

module.exports = {
  createOrchestrator,
  createPeersBridge,
  manifestTimeoutMs,
  MAX_MANIFEST_TIMEOUT_MS,
  formatModeSummary,
  hubFanoutDecision,
  allowedLiveIdsForHub,
  cliFanoutDecision
};
