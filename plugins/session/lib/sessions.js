'use strict';

/**
 * （K3 で host/sessions.js から出した。session.* を出せるのはプラグイン session だけ。出どころは ctx.bus が rec.id で付ける）
 * 同時に 1 つだけのセッション。各操作で session.* を publish し状態を保存する。
 * 動作中は heartbeatMs（本番 30 秒）ごとに lastAliveAt を保存する。
 * 起動時に running / paused が残っていたら lastAliveAt で end し recovered: true。
 * タイマーとカレンダー、ハブの題名送信にはつながない。
 */

const crypto = require('crypto');

const DEFAULT_HEARTBEAT_MS = 30000;
const START_SOURCES = new Set(['timer', 'manual']);

function createSessions(options) {
  const opts = options || {};
  // イベント名の一覧は本体が ctx.events.NAMES で渡す（K3。本体のファイルは読まない）
  const EVENTS = opts.events;
  if (!EVENTS || typeof EVENTS.SESSION_STARTED !== 'string') throw new Error('sessions require events');
  const store = opts.store;
  const bus = opts.bus;
  if (!store || typeof store.snapshot !== 'function' || typeof store.setSession !== 'function') {
    throw new Error('sessions require a state store');
  }
  if (!bus || typeof bus.publish !== 'function') throw new Error('sessions require an event bus');
  const heartbeatMs = Number.isFinite(opts.heartbeatMs) && opts.heartbeatMs >= 1
    ? opts.heartbeatMs
    : DEFAULT_HEARTBEAT_MS;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => new Date();
  let timer = null;
  let sawStreaming = false;
  let streamingProbe = null;

  function attachStreamingProbe(fn) {
    streamingProbe = typeof fn === "function" ? fn : null;
  }

  function probedStreaming() {
    if (typeof streamingProbe !== "function") return null;
    try {
      const row = streamingProbe();
      if (!row || row.known !== true) return null;
      return row.streaming === true;
    } catch (_) {
      return null;
    }
  }

  function iso(date) {
    const value = date instanceof Date ? date : nowFn();
    return value.toISOString();
  }

  function current() {
    const snap = store.snapshot();
    return snap && snap.session ? snap.session : null;
  }

  function live(session) {
    return !!(session && (session.state === 'running' || session.state === 'paused'));
  }

  function payloadOf(session, extra) {
    return Object.assign({
      id: session.id,
      title: session.title,
      category: session.category,
      plannedSec: session.plannedSec,
      source: session.source,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt || null,
      lastAliveAt: session.lastAliveAt || null,
      segments: session.segments || [],
      recovered: false
    }, extra || {});
  }

  function publish(name, session, extra) {
    const more = extra || {};
    bus.publish(name, payloadOf(session, more), {
      correlationId: more.correlationId || ''
    });
  }

  function disarm() {
    if (timer != null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function arm() {
    disarm();
    timer = setIntervalFn(() => {
      const session = current();
      if (!session || session.state !== 'running') return;
      session.lastAliveAt = iso();
      store.setSession(session);
    }, heartbeatMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function closeOpenSegment(session, when) {
    const segments = session.segments || [];
    const last = segments[segments.length - 1];
    if (last && !last.endedAt) last.endedAt = when;
  }

  function start(input) {
    const existing = current();
    if (live(existing)) return { ok: false, reason: 'session-active' };
    const src = input && input.source;
    if (src === 'obs') return { ok: false, reason: 'source-not-enabled' };
    const now = iso();
    const session = {
      id: 's-' + now.replace(/[^0-9]/g, '') + '-' + crypto.randomBytes(3).toString('hex'),
      title: input && input.title != null ? String(input.title) : '',
      category: input && input.category != null ? String(input.category) : '',
      plannedSec: input && Number.isFinite(Number(input.plannedSec)) ? Number(input.plannedSec) : null,
      source: START_SOURCES.has(src) ? src : 'manual',
      state: 'running',
      startedAt: now,
      lastAliveAt: now,
      endedAt: null,
      segments: [{ startedAt: now }]
    };
    store.setSession(session);
    sawStreaming = probedStreaming() === true;
    publish(EVENTS.SESSION_STARTED, session);
    arm();
    return { ok: true, session: current() };
  }

  function pause() {
    const session = current();
    if (!session || session.state !== 'running') return { ok: false, reason: 'not-running' };
    const now = iso();
    session.state = 'paused';
    session.lastAliveAt = now;
    closeOpenSegment(session, now);
    store.setSession(session);
    publish(EVENTS.SESSION_PAUSED, session);
    disarm();
    return { ok: true, session: current() };
  }

  function resume() {
    const session = current();
    if (!session || session.state !== 'paused') return { ok: false, reason: 'not-paused' };
    const now = iso();
    session.state = 'running';
    session.lastAliveAt = now;
    session.segments = session.segments || [];
    session.segments.push({ startedAt: now });
    store.setSession(session);
    publish(EVENTS.SESSION_RESUMED, session);
    arm();
    return { ok: true, session: current() };
  }

  function end(input) {
    const session = current();
    if (!live(session)) return { ok: false, reason: 'no-session' };
    const when = input && typeof input.at === 'string' && input.at ? input.at : iso();
    const recovered = !!(input && input.recovered);
    session.state = 'ended';
    session.endedAt = when;
    if (!session.lastAliveAt) session.lastAliveAt = when;
    closeOpenSegment(session, when);
    disarm();
    store.setSession(session);
    sawStreaming = false;
    const extra = { recovered: recovered };
    if (input && (input.reason === 'all-stopped' || input.reason === 'emergency-stop')) extra.reason = input.reason;
    publish(EVENTS.SESSION_ENDED, session, extra);
    return { ok: true, session: current() };
  }

  function retitle(title) {
    const session = current();
    if (!live(session)) return { ok: false, reason: 'no-session' };
    session.title = title == null ? '' : String(title);
    store.setSession(session);
    publish(EVENTS.SESSION_RETITLED, session);
    return { ok: true, session: current() };
  }

  // プラグインを読み直したあと、進行中のセッションの鼓動（lastAliveAt の保存）を再開する。回復（recover）はしない（終わらせない）
  function rearm() {
    const session = current();
    if (live(session) && session.state === 'running') arm();
    return { ok: true };
  }

  function recover(input) {
    const session = current();
    if (!live(session)) return { ok: true, recovered: false };
    const anyOutputLive = !!(input && input.anyOutputLive);
    if (session.source === 'obs' && anyOutputLive) {
      bus.publish(EVENTS.SESSION_RESUMED, payloadOf(session, { recovered: true }), {});
      if (session.state === 'running') arm();
      return { ok: true, recovered: true, continued: true, session: current() };
    }
    const at = session.lastAliveAt || session.startedAt;
    const result = end({ at, recovered: true });
    return { ok: result.ok, recovered: true, continued: false, session: result.session };
  }

  function elapsedMs(session, nowMs) {
    let total = 0;
    for (const seg of session.segments || []) {
      const start = Date.parse(seg.startedAt);
      const endAt = seg.endedAt ? Date.parse(seg.endedAt) : nowMs;
      if (Number.isFinite(start) && Number.isFinite(endAt)) total += Math.max(0, endAt - start);
    }
    return total;
  }

  function view() {
    const session = current();
    if (!live(session)) return { active: false, title: '', state: 'none', elapsedMs: 0 };
    return {
      active: true,
      title: session.title,
      state: session.state,
      elapsedMs: elapsedMs(session, nowFn().getTime())
    };
  }

  if (opts.recover !== false) recover();


  function noteAggregate(info) {
    const row = info || {};
    const session = current();
    if (!live(session)) {
      sawStreaming = false;
      return { ok: true, ended: false };
    }
    if (row.known !== true) return { ok: true, ended: false };
    if (row.streaming === true) {
      sawStreaming = true;
      return { ok: true, ended: false };
    }
    if (row.streaming !== false || !sawStreaming) return { ok: true, ended: false };
    const reason = row.emergency === true ? 'emergency-stop' : 'all-stopped';
    const result = end({ reason: reason });
    return {
      ok: result.ok === true,
      ended: result.ok === true,
      reason: reason,
      session: result.session
    };
  }
  return {
    start,
    pause,
    resume,
    end,
    retitle,
    recover,
    rearm,
    view,
    noteAggregate,
    attachStreamingProbe,
    stop: disarm,
    heartbeatMs
  };
}

module.exports = { createSessions, DEFAULT_HEARTBEAT_MS };
