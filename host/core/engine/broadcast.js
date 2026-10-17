'use strict';

/**
 * 配信開始の流れ（ARCHITECTURE §6.4、WAVE3 約束 C・D）。
 * モード id は broadcast。legacy は何もしない。shadow は dryRun で記録し、エンジンには書かない。
 * live は実行する。エンジン側の書き込み可否はエンジン自身のモードが決める。
 * 配信キーは setKey に渡す間だけ handKey の中にあり、結果・イベント・ログ・状態には残さない。
 */

const crypto = require('crypto');
const { EVENTS } = require('../events');
const { run } = require('../safe-runner');

const MODE_ID = 'broadcast';
const SLOT_ROLE = 'stream.slot@1';
const LIVE_WAIT_MS = 30000;
const VERIFY_WAIT_MS = 60000;
const VERIFY_INTERVAL_MS = 5000;
const LIVE_POLL_MS = 1000;

function defaultSleep(ms) {
  const delay = ms > 0 ? ms : 0;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function sanitizePreflight(result) {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      globalOk: false,
      blocked: [],
      items: [{
        id: '',
        destinationId: '',
        level: 'error',
        code: 'preflight-failed',
        message: 'preflight failed',
        scope: 'global'
      }]
    };
  }
  const source = Array.isArray(result.items) ? result.items : [];
  const items = [];
  for (let i = 0; i < source.length; i += 1) {
    const row = source[i] && typeof source[i] === 'object' ? source[i] : {};
    const level = row.level === 'error' || row.level === 'warn' || row.level === 'ok' ? row.level : 'warn';
    const destinationId = row.destinationId == null ? '' : String(row.destinationId).slice(0, 80);
    const scope = row.scope === 'global' || row.scope === 'destination'
      ? row.scope
      : (destinationId ? 'destination' : 'global');
    items.push({
      id: row.id == null ? '' : String(row.id).slice(0, 80),
      destinationId: destinationId,
      level: level,
      code: row.code == null ? '' : String(row.code).slice(0, 80),
      message: row.message == null ? '' : String(row.message).slice(0, 300),
      scope: scope
    });
  }
  // globalOk と blocked は受け取った値を信じず、items から作り直す。
  const blocked = [];
  let globalOk = true;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].level !== 'error') continue;
    if (items[i].scope === 'destination' && items[i].destinationId) {
      if (blocked.indexOf(items[i].destinationId) === -1) blocked.push(items[i].destinationId);
    } else {
      globalOk = false;
    }
  }
  return {
    ok: items.every((row) => row.level !== 'error'),
    globalOk: globalOk,
    blocked: blocked,
    items: items
  };
}

function firstErrorCode(report, destinationId) {
  const rows = report && Array.isArray(report.items) ? report.items : [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].level === 'error' && rows[i].scope === 'destination' && rows[i].destinationId === destinationId) {
      return rows[i].code || 'failed';
    }
  }
  return 'failed';
}

function createBroadcast(options) {
  const opts = options || {};
  const preflight = opts.preflight;
  const registry = opts.registry;
  const engines = opts.engines;
  const store = opts.store;
  const bus = opts.bus;
  const orchestrator = opts.orchestrator;
  const logger = typeof opts.logger === 'function' ? opts.logger : function () {};
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const runner = typeof opts.run === 'function' ? opts.run : run;

  let running = false;
  let stopping = false;
  let stopRequestedForStart = false;
  let last = null;

  function log(level, message) {
    try { logger(level, message); } catch (_) { /* a logger must not stop the flow */ }
  }

  function mode() {
    try {
      if (orchestrator && typeof orchestrator.modeFor === 'function') {
        const value = orchestrator.modeFor(MODE_ID);
        if (value === 'live' || value === 'shadow' || value === 'legacy') return value;
      }
    } catch (_) { /* fall through */ }
    return 'legacy';
  }

  function newCorrelation() {
    return 'b-' + crypto.randomBytes(8).toString('hex');
  }

  function publish(name, payload, correlationId) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish(name, payload, { source: 'broadcast', correlationId: correlationId || '' });
    } catch (_) { /* the bus already isolates handlers */ }
  }

  function readDestinations() {
    if (!store || typeof store.snapshot !== 'function') return [];
    try {
      const snap = store.snapshot();
      return snap && Array.isArray(snap.destinations) ? snap.destinations : [];
    } catch (_) {
      return [];
    }
  }

  function findDestination(id) {
    const rows = readDestinations();
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === id) return rows[i];
    }
    return null;
  }

  function enabledDestinations() {
    const rows = readDestinations();
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.enabled !== true || typeof row.id !== 'string' || !row.id) continue;
      out.push({ id: row.id, site: row.site == null ? '' : String(row.site) });
    }
    return out;
  }

  function normalizeIds(value) {
    if (!Array.isArray(value)) return { error: 'destination-ids' };
    const ids = [];
    const seen = new Set();
    for (let i = 0; i < value.length; i += 1) {
      if (typeof value[i] !== 'string') return { error: 'destination-ids' };
      const id = value[i].trim();
      if (!id || id.length > 80) return { error: 'destination-ids' };
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length < 1 || ids.length > 20) return { error: 'destination-ids' };
    return { ids: ids };
  }

  function destView(row) {
    const engine = row.engine && typeof row.engine === 'object' ? row.engine : null;
    return {
      id: row.id,
      site: row.site == null ? '' : String(row.site),
      accountId: row.accountId == null ? '' : String(row.accountId),
      engine: engine ? {
        id: engine.id == null ? '' : String(engine.id),
        targetId: engine.targetId == null ? '' : String(engine.targetId)
      } : null
    };
  }

  function slotRecords() {
    if (!registry || typeof registry.getRunning !== 'function') return [];
    try {
      const rows = registry.getRunning();
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }

  function slotForSite(site) {
    const want = String(site || '');
    const rows = slotRecords();
    for (let i = 0; i < rows.length; i += 1) {
      const rec = rows[i];
      const manifest = rec && rec.manifest;
      const provides = manifest && Array.isArray(manifest.provides) ? manifest.provides : [];
      if (provides.indexOf(SLOT_ROLE) === -1) continue;
      const sites = manifest && Array.isArray(manifest.slotFor) ? manifest.slotFor : [];
      if (sites.indexOf(want) !== -1 && rec.instance) return rec;
    }
    return null;
  }

  function engineOf(row) {
    const bound = row && row.engine && typeof row.engine === 'object' ? row.engine : null;
    const engineId = bound && bound.id ? String(bound.id) : '';
    const targetId = bound && bound.targetId != null ? String(bound.targetId) : '';
    if (!engineId || !targetId) return null;
    let impl = null;
    try {
      impl = engines && typeof engines.get === 'function' ? engines.get(engineId) : null;
    } catch (_) {
      impl = null;
    }
    if (!impl) return null;
    return { impl: impl, engineId: engineId, targetId: targetId };
  }

  function publicItem(row) {
    const ok = !!(row && row.ok === true);
    return {
      destinationId: row && row.destinationId != null ? String(row.destinationId) : '',
      ok: ok,
      step: ok ? 'done' : (row && row.step ? String(row.step).slice(0, 40) : ''),
      error: ok ? '' : (row && row.error ? String(row.error).slice(0, 80) : 'failed')
    };
  }

  function copyItems(items) {
    const source = Array.isArray(items) ? items : [];
    const out = [];
    for (let i = 0; i < source.length; i += 1) out.push(publicItem(source[i]));
    return out;
  }

  function remember(correlationId, modeName, items, extra) {
    const clean = copyItems(items);
    const info = extra || {};
    last = {
      correlationId: correlationId,
      mode: modeName,
      ok: clean.length > 0 && clean.every((row) => row.ok),
      error: info.error ? String(info.error) : '',
      items: clean,
      preflight: info.preflight || null,
      skipped: Array.isArray(info.skipped) ? info.skipped.map((id) => String(id)) : [],
      at: new Date(now()).toISOString()
    };
    return last;
  }

  function fail(destinationId, step, error) {
    return {
      destinationId: destinationId,
      ok: false,
      step: step,
      error: error ? String(error).slice(0, 80) : 'failed'
    };
  }

  async function callSlot(rec, method, args) {
    const timeouts = rec && rec.manifest && rec.manifest.timeouts;
    const timeoutMs = timeouts && Number.isInteger(timeouts[method]) ? timeouts[method] : undefined;
    const callOpts = { logger: logger };
    if (timeoutMs != null) callOpts.timeoutMs = timeoutMs;
    let ran;
    try {
      ran = await runner(rec.instance, method, args, callOpts);
    } catch (_) {
      return { ok: false, error: 'failed' };
    }
    if (!ran || ran.result === 'timeout') return { ok: false, error: 'timeout' };
    if (ran.result === 'skip') return { ok: false, error: 'no-method' };
    if (ran.result !== 'ok' || !ran.value || typeof ran.value !== 'object') return { ok: false, error: 'failed' };
    return ran.value;
  }

  function readTargetState(engine, targetId) {
    if (!engine || typeof engine.listTargets !== 'function') return '';
    try {
      const rows = engine.listTargets();
      if (!Array.isArray(rows)) return '';
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row && String(row.id) === targetId) return row.state == null ? '' : String(row.state);
      }
    } catch (_) { /* keep waiting */ }
    return '';
  }

  async function waitLive(engine, targetId, engineId) {
    if (readTargetState(engine, targetId) === 'live') return { ok: true };
    let saw = false;
    let unsub = function () {};
    if (bus && typeof bus.subscribe === 'function') {
      try {
        unsub = bus.subscribe(EVENTS.ENGINE_TARGET_CHANGED, function (_name, payload) {
          try {
            if (!payload || typeof payload !== 'object') return;
            const id = payload.targetId != null ? String(payload.targetId) : (payload.id != null ? String(payload.id) : '');
            if (id !== targetId) return;
            if (payload.engineId != null && engineId && String(payload.engineId) !== String(engineId)) return;
            if (payload.state === 'live') saw = true;
          } catch (_) { /* one bad event does not end the wait */ }
        });
      } catch (_) {
        unsub = function () {};
      }
    }
    const deadline = now() + LIVE_WAIT_MS;
    try {
      while (!saw && now() < deadline) {
        if (readTargetState(engine, targetId) === 'live') return { ok: true };
        const remain = deadline - now();
        if (remain <= 0) break;
        const before = now();
        await sleep(Math.min(remain, LIVE_POLL_MS));
        if (saw || readTargetState(engine, targetId) === 'live') return { ok: true };
        if (now() <= before) return { ok: false, error: 'timeout' };
      }
    } finally {
      try { unsub(); } catch (_) { /* already gone */ }
    }
    if (saw || readTargetState(engine, targetId) === 'live') return { ok: true };
    return { ok: false, error: 'timeout' };
  }

  function dropSecretFields(prepared) {
    if (prepared && typeof prepared === 'object') {
      prepared.server = undefined;
      prepared.key = undefined;
    }
  }

  async function callEngine(fn) {
    try {
      const result = await fn();
      if (!result || result.ok === false) return { ok: false, error: (result && result.error) || 'failed' };
      return { ok: true };
    } catch (_) {
      return { ok: false, error: 'failed' };
    }
  }

  async function verifyLoop(slot, view, meta, modeName) {
    if (modeName !== 'live') {
      const once = await callSlot(slot, 'verifyLive', [view, meta]);
      dropSecretFields(once);
      if (once && once.ok === true) return { ok: true };
      return { ok: false, error: (once && once.error) || 'not-live' };
    }
    const started = now();
    let hard = '';
    while (true) {
      const result = await callSlot(slot, 'verifyLive', [view, meta]);
      dropSecretFields(result);
      if (result && result.ok === true && (result.live === true || result.dryRun === true)) return { ok: true };
      if (result && result.ok === false && result.error && result.error !== 'not-live') {
        hard = String(result.error);
        return { ok: false, error: hard };
      }
      if (now() - started >= VERIFY_WAIT_MS) return { ok: false, error: 'timeout' };
      const remain = VERIFY_WAIT_MS - (now() - started);
      const before = now();
      await sleep(Math.min(VERIFY_INTERVAL_MS, remain));
      if (now() - started >= VERIFY_WAIT_MS) return { ok: false, error: 'timeout' };
      if (now() <= before) return { ok: false, error: 'timeout' };
    }
  }

  async function attemptDestination(row, ctx) {
    if (!row) return fail(ctx.id, 'lookup', 'unknown-destination');
    if (row.enabled !== true) return fail(row.id, 'lookup', 'destination-disabled');
    const view = destView(row);
    const bound = engineOf(row);
    if (!bound) return fail(view.id, 'lookup', 'no-engine');
    const slot = slotForSite(view.site);
    if (ctx.mode === 'live') {
      const started = await callEngine(() => bound.impl.start(bound.targetId));
      if (!started.ok) return fail(view.id, 'start', started.error || 'failed');
      const live = await waitLive(bound.impl, bound.targetId, bound.engineId);
      if (!live.ok) return fail(view.id, 'confirm', live.error || 'timeout');
    }
    if (slot) {
      const verified = await verifyLoop(slot, view, ctx.meta, ctx.mode);
      if (!verified.ok) return fail(view.id, 'verify', verified.error || 'timeout');
    }
    return { destinationId: view.id, ok: true, step: 'done', error: '' };
  }

  async function runDestination(id, ctx) {
    const row = findDestination(id);
    const first = await attemptDestination(row, Object.assign({ id: id }, ctx));
    if (first.ok) return first;
    log('info', 'broadcast retry destination=' + id + ' step=' + first.step + ' error=' + first.error);
    return attemptDestination(row, Object.assign({ id: id }, ctx));
  }

  function finish(correlationId, modeName, items, extra) {
    const saved = remember(correlationId, modeName, items, extra);
    const payload = {
      ok: saved.ok,
      error: saved.error,
      mode: modeName,
      items: copyItems(saved.items),
      preflight: saved.preflight,
      skipped: saved.skipped.slice()
    };
    publish(EVENTS.BROADCAST_RESULT, payload, correlationId);
    return {
      ok: saved.ok,
      error: saved.error,
      correlationId: correlationId,
      mode: modeName,
      items: copyItems(saved.items),
      preflight: saved.preflight,
      skipped: saved.skipped.slice()
    };
  }

  async function start(input) {
    if (stopping) return { ok: false, error: 'stopping', mode: mode(), correlationId: '', items: [] };
    if (running) return { ok: false, error: 'busy', mode: mode(), correlationId: '', items: [] };
    const current = mode();
    if (current === 'legacy') {
      return { ok: false, error: 'legacy', mode: 'legacy', correlationId: '', items: [] };
    }
    const parsed = normalizeIds(input && input.destinationIds);
    if (parsed.error) return { ok: false, error: parsed.error, mode: current, correlationId: '', items: [] };
    if (!input || input.confirmed !== true) {
      return { ok: false, error: 'confirm', mode: current, correlationId: '', items: [] };
    }
    if (!preflight || typeof preflight.run !== 'function') {
      return { ok: false, error: 'unavailable', mode: current, correlationId: '', items: [] };
    }
    running = true;
    const correlationId = newCorrelation();
    try {
      log('info', 'broadcast start correlation=' + correlationId + ' mode=' + current + ' count=' + parsed.ids.length);
      let report;
      try {
        report = sanitizePreflight(await preflight.run(parsed.ids.slice()));
      } catch (_) {
        report = sanitizePreflight(null);
      }
      if (report.globalOk !== true) {
        log('info', 'broadcast preflight stop correlation=' + correlationId + ' count=' + report.items.length);
        return finish(correlationId, current, [], { error: 'preflight', preflight: report });
      }
      const ctx = {
        mode: current,
        meta: { correlationId: correlationId, dryRun: current !== 'live' }
      };
      const blockedIds = report.blocked;
      const runIds = parsed.ids.filter((id) => blockedIds.indexOf(id) === -1);
      const skipped = parsed.ids.filter((id) => blockedIds.indexOf(id) !== -1);
      if (runIds.length === 0) {
        log('info', 'broadcast preflight stop correlation=' + correlationId + ' all-blocked');
        const blockedItems = parsed.ids.map((id) => fail(id, 'preflight', firstErrorCode(report, id)));
        return finish(correlationId, current, blockedItems, {
          error: 'preflight', preflight: report, skipped: skipped
        });
      }
      const items = [];
      let startedEmitted = false;
      for (let i = 0; i < parsed.ids.length; i += 1) {
        if (stopRequestedForStart) {
          for (let j = i; j < parsed.ids.length; j += 1) {
            items.push(fail(parsed.ids[j], 'start', 'stopped'));
          }
          break;
        }
        if (blockedIds.indexOf(parsed.ids[i]) !== -1) {
          items.push(fail(parsed.ids[i], 'preflight', firstErrorCode(report, parsed.ids[i])));
          continue;
        }
        let item;
        try {
          item = await runDestination(parsed.ids[i], ctx);
        } catch (_) {
          item = fail(parsed.ids[i], 'start', 'failed');
        }
        items.push(item);
        if (item.ok && !startedEmitted) {
          startedEmitted = true;
          publish(EVENTS.BROADCAST_STARTED, {
            destinationIds: runIds.slice(),
            mode: current
          }, correlationId);
        }
      }
      return finish(correlationId, current, items, {
        error: '',
        preflight: report,
        skipped: skipped
      });
    } finally {
      running = false;
      stopRequestedForStart = false;
    }
  }

  async function stopOne(id, current, correlationId) {
    const row = findDestination(id);
    if (!row) return fail(id, 'lookup', 'unknown-destination');
    const view = destView(row);
    const bound = engineOf(row);
    const slot = slotForSite(view.site);
    const meta = { correlationId: correlationId, dryRun: current !== 'live' };
    let step = 'done';
    let error = '';
    if (current === 'live') {
      if (!bound) {
        step = 'stop';
        error = 'no-engine';
      } else {
        const stopped = await callEngine(() => bound.impl.stop(bound.targetId, { reason: 'manual' }));
        if (!stopped.ok) {
          step = 'stop';
          error = stopped.error || 'failed';
        }
      }
    }
    if (slot) {
      const ended = await callSlot(slot, 'endBroadcast', [view, meta]);
      dropSecretFields(ended);
      if (!(ended && ended.ok === true) && !error) {
        step = 'end';
        error = (ended && ended.error) || 'failed';
      }
    }
    if (error) return fail(view.id, step, error);
    return { destinationId: view.id, ok: true, step: 'done', error: '' };
  }

  async function stop(input) {
    if (running) return { ok: false, error: 'busy', mode: mode(), correlationId: '', items: [] };
    const current = mode();
    if (current === 'legacy') {
      return { ok: false, error: 'legacy', mode: 'legacy', correlationId: '', items: [] };
    }
    const parsed = normalizeIds(input && input.destinationIds);
    if (parsed.error) return { ok: false, error: parsed.error, mode: current, correlationId: '', items: [] };
    running = true;
    const correlationId = newCorrelation();
    try {
      publish(EVENTS.STREAM_STOPPING, {
        reason: 'manual',
        at: new Date(now()).toISOString()
      }, correlationId);
      const items = [];
      for (let i = 0; i < parsed.ids.length; i += 1) {
        try {
          items.push(await stopOne(parsed.ids[i], current, correlationId));
        } catch (_) {
          items.push(fail(parsed.ids[i], 'stop', 'failed'));
        }
      }
      const clean = copyItems(items);
      const ok = clean.length > 0 && clean.every((row) => row.ok);
      remember(correlationId, current, clean, { error: '' });
      publish(EVENTS.BROADCAST_STOPPED, {
        ok: ok,
        mode: current,
        destinationIds: parsed.ids.slice(),
        items: copyItems(clean)
      }, correlationId);
      log('info', 'broadcast stop correlation=' + correlationId + ' mode=' + current + ' count=' + clean.length);
      return { ok: ok, error: '', correlationId: correlationId, mode: current, items: copyItems(clean) };
    } finally {
      running = false;
    }
  }

  async function stopAll(input) {
    stopping = true;
    try {
      const current = mode();
      const correlationId = newCorrelation();
      if (running) stopRequestedForStart = true;
      publish(EVENTS.STREAM_STOPPING, {
        reason: 'manual',
        at: new Date(now()).toISOString()
      }, correlationId);

      let enginesResult = { ok: false, error: 'no-engine', results: [] };
      if (engines && typeof engines.emergencyStop === 'function') {
        try {
          enginesResult = await engines.emergencyStop({ correlationId: correlationId });
        } catch (_) {
          enginesResult = { ok: false, error: 'failed', results: [] };
        }
      }

      const items = [];
      if (current !== 'legacy') {
        const dests = enabledDestinations();
        for (let i = 0; i < dests.length; i += 1) {
          const row = findDestination(dests[i].id);
          if (!row) continue;
          const slot = slotForSite(row.site);
          if (!slot) continue;
          const view = destView(row);
          const meta = { correlationId: correlationId, dryRun: current !== 'live' };
          try {
            const ended = await callSlot(slot, 'endBroadcast', [view, meta]);
            dropSecretFields(ended);
            if (ended && ended.ok === true) {
              items.push({ destinationId: view.id, ok: true, step: 'done', error: '' });
            } else {
              items.push(fail(view.id, 'end', (ended && ended.error) || 'failed'));
            }
          } catch (_) {
            items.push(fail(view.id, 'end', 'failed'));
          }
        }
      }

      const clean = copyItems(items);
      const engineOk = enginesResult.ok === true;
      const ok = engineOk;
      let error = '';
      if (!ok) {
        const results = Array.isArray(enginesResult.results) ? enginesResult.results : [];
        const firstBad = results.find((row) => row && row.ok === false);
        if (firstBad && firstBad.error) error = firstBad.error;
        else if (enginesResult.error) error = enginesResult.error;
        else error = 'failed';
      }
      remember(correlationId, current, clean, { error: error });
      publish(EVENTS.BROADCAST_STOPPED, {
        ok: ok,
        mode: current,
        items: copyItems(clean),
        engines: enginesResult,
        all: true
      }, correlationId);
      log('info', 'broadcast stopAll correlation=' + correlationId + ' mode=' + current + ' ok=' + ok);
      return {
        ok: ok,
        error: error,
        correlationId: correlationId,
        mode: current,
        engines: enginesResult,
        items: copyItems(clean)
      };
    } finally {
      stopping = false;
    }
  }

  function status() {
    const current = mode();
    if (!last) {
      return { ok: true, running: running, stopping: stopping, mode: current, last: null, destinations: enabledDestinations() };
    }
    return {
      ok: true,
      running: running,
      stopping: stopping,
      mode: current,
      last: {
        correlationId: last.correlationId,
        mode: last.mode,
        ok: last.ok === true,
        error: last.error || '',
        items: copyItems(last.items),
        preflight: last.preflight,
        skipped: Array.isArray(last.skipped) ? last.skipped.slice() : [],
        at: last.at
      },
      destinations: enabledDestinations()
    };
  }

  return { start: start, stop: stop, stopAll: stopAll, status: status, isStopping: function () { return stopping; } };
}

module.exports = {
  createBroadcast,
  sanitizePreflight,
  MODE_ID,
  LIVE_WAIT_MS,
  VERIFY_WAIT_MS,
  VERIFY_INTERVAL_MS
};
