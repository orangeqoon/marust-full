'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  intervalMs: 2000,
  consecutiveSamples: 3,
  degradedCongestion: 0.5,
  badCongestion: 0.9,
  degradedSkippedRate: 0.02
});

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function loadConfig(pluginDir) {
  let raw = {};
  try {
    const file = path.join(pluginDir, 'config.json');
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    raw = {};
  }
  const config = {
    intervalMs: Math.max(1, Math.trunc(finite(raw.intervalMs, DEFAULTS.intervalMs))),
    consecutiveSamples: Math.max(1, Math.trunc(finite(raw.consecutiveSamples, DEFAULTS.consecutiveSamples))),
    degradedCongestion: Math.max(0, Math.min(1, finite(raw.degradedCongestion, DEFAULTS.degradedCongestion))),
    badCongestion: Math.max(0, Math.min(1, finite(raw.badCongestion, DEFAULTS.badCongestion))),
    degradedSkippedRate: Math.max(0, Math.min(1, finite(raw.degradedSkippedRate, DEFAULTS.degradedSkippedRate)))
  };
  if (config.badCongestion < config.degradedCongestion) config.badCongestion = config.degradedCongestion;
  return config;
}

function modeOf(ctx) {
  try {
    const mode = ctx && typeof ctx.mode === 'function' ? ctx.mode() : 'legacy';
    return mode === 'shadow' || mode === 'live' ? mode : 'legacy';
  } catch (_) {
    return 'legacy';
  }
}

function statusReader(ctx) {
  const obs = ctx && (ctx.obs || ctx.obsConnection);
  if (!obs) return null;
  if (typeof obs.getStreamStatus === 'function') return obs;
  if (typeof obs.call === 'function') return { call: obs.call.bind(obs) };
  return null;
}

async function isStreaming(obs) {
  if (!obs) return false;
  if (typeof obs.isStreaming === 'function') return (await obs.isStreaming()) === true;
  if (typeof obs.outputActive === 'boolean') return obs.outputActive;
  return true;
}

async function readStatus(obs) {
  if (typeof obs.getStreamStatus === 'function') return obs.getStreamStatus();
  return obs.call('GetStreamStatus');
}

function skippedRate(previous, current) {
  if (!previous) return 0;
  const skippedDelta = Number(current.outputSkippedFrames) - Number(previous.outputSkippedFrames);
  const totalDelta = Number(current.outputTotalFrames) - Number(previous.outputTotalFrames);
  if (!Number.isFinite(skippedDelta) || !Number.isFinite(totalDelta) || totalDelta <= 0) return 0;
  return Math.max(0, skippedDelta) / totalDelta;
}

function metricsOf(previous, raw) {
  const current = raw && typeof raw === 'object' ? raw : {};
  return {
    outputActive: current.outputActive === true,
    outputReconnecting: current.outputReconnecting === true,
    outputCongestion: finite(current.outputCongestion, 0),
    outputSkippedFrames: Math.max(0, finite(current.outputSkippedFrames, 0)),
    outputTotalFrames: Math.max(0, finite(current.outputTotalFrames, 0)),
    skippedRate: skippedRate(previous, current)
  };
}

function severity(metrics, config) {
  if (metrics.outputReconnecting || metrics.outputCongestion >= config.badCongestion) return 'bad';
  if (metrics.outputCongestion >= config.degradedCongestion || metrics.skippedRate >= config.degradedSkippedRate) return 'degraded';
  return 'ok';
}

// パネルに出す文言。DOM を使わない（test/w51-signal-panel.test.js が直接呼ぶ）。
const STATE_TEXT = Object.freeze({ ok: '良好', degraded: 'やや悪い', bad: '悪い' });

function stateText(state) {
  return Object.prototype.hasOwnProperty.call(STATE_TEXT, state) ? STATE_TEXT[state] : '不明';
}

function modeText(mode) {
  if (mode === 'shadow') return 'shadow（見張り中）';
  if (mode === 'live') return 'live（見張り中）';
  // legacy と未知のモードは安全な方（見張りが止まっていると出す）。
  return '見張りは止まっています（legacy）';
}

function formatRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return (Math.round(n * 100) / 100).toFixed(2);
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return (Math.round(n * 10000) / 100).toFixed(2) + '%';
}

function panelText(view) {
  const box = view && typeof view === 'object' ? view : {};
  const metrics = box.metrics && typeof box.metrics === 'object' ? box.metrics : null;
  return {
    state: stateText(box.state),
    at: typeof box.at === 'string' && box.at ? box.at : 'まだ一度も変わっていません',
    congestion: metrics ? formatRatio(metrics.outputCongestion) : '-',
    skippedRate: metrics ? formatPercent(metrics.skippedRate) : '-',
    reconnecting: metrics ? (metrics.outputReconnecting === true ? '再接続中' : '再接続していない') : '-',
    mode: modeText(box.mode)
  };
}

function createMonitor() {
  let ctx = null;
  let config = DEFAULTS;
  let timer = null;
  let previousRaw = null;
  let state = 'ok';
  let previousState = 'ok';
  let lastMetrics = null;
  let changedAt = null;
  let candidate = '';
  let candidateCount = 0;
  let running = false;
  let chain = Promise.resolve();

  function logRecord(next, metrics, at) {
    const ok = ctx.log.appendJsonl('shadow', {
      kind: 'signal.state',
      state: next,
      previous: state,
      metrics: metrics,
      at: at
    });
    if (!ok && ctx && typeof ctx.logger === 'function') ctx.logger('warn', 'signal-monitor record failed');
  }

  function publish(next, metrics, at) {
    const previous = state;
    previousState = previous;
    state = next;
    changedAt = at;
    lastMetrics = metrics;
    const payload = { state: next, previous: previous, metrics: metrics, at: at };
    if (ctx && ctx.bus && typeof ctx.bus.publish === 'function') ctx.bus.publish(ctx.events.NAMES.SIGNAL_STATE_CHANGED, payload);
    logRecord(next, metrics, at);
  }

  // 自動枠取りの切り替え（OBS を止めて再開する暗転）の間と、その直後は、停止・再接続を「悪い」と数えない（R7）。
  let quietUntil = 0;
  const QUIET_AFTER_MS = 20000;
  const QUIET_MAX_MS = 120000;

  function noteSwitching(payload) {
    const phase = payload && payload.phase;
    if (phase === 'start') quietUntil = Date.now() + QUIET_MAX_MS;
    else if (phase === 'end') quietUntil = Date.now() + QUIET_AFTER_MS;
  }

  function observe(raw) {
    const metrics = metricsOf(previousRaw, raw);
    previousRaw = raw && typeof raw === 'object' ? raw : {};
    lastMetrics = metrics;
    if (Date.now() < quietUntil) {
      candidate = '';
      candidateCount = 0;
      return;
    }
    const next = severity(metrics, config);
    if (next === state) {
      candidate = '';
      candidateCount = 0;
      return;
    }
    if (candidate === next) candidateCount += 1;
    else {
      candidate = next;
      candidateCount = 1;
    }
    if (candidateCount >= config.consecutiveSamples) publish(next, metrics, new Date().toISOString());
  }

  async function tick() {
    if (!running || modeOf(ctx) === 'legacy') return;
    const obs = statusReader(ctx);
    if (!obs || !(await isStreaming(obs))) return;
    try {
      const raw = await readStatus(obs);
      if (raw && raw.outputActive === true) observe(raw);
    } catch (_) {
      // OBS の一時的な読み取り失敗は、誤判定を避けるため状態にしない。
    }
  }

  function start(nextCtx) {
    ctx = nextCtx;
    config = loadConfig(ctx && ctx.pluginDir);
    if (modeOf(ctx) === 'legacy') return;
    running = true;
    timer = setInterval(() => {
      chain = chain.then(tick, tick);
    }, config.intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // 今の状態を返す（パネル用の読み取り）。初期値は ok・時刻なし。
  function snapshot() {
    return { state: state, previous: previousState, metrics: lastMetrics, at: changedAt };
  }

  return { start, stop, destroy: stop, tick, observe, noteSwitching, isRunning: () => running, getState: () => state, snapshot };
}

const monitor = createMonitor();
let loadedContext = null;

// 「今の状態を返す」読み取り。パネルは開いた直後と signal.stateChanged のたびにこれを呼ぶ。
function getStatus(params, ctx) {
  void params;
  const snap = monitor.snapshot();
  const mode = modeOf(ctx || loadedContext);
  const view = { state: snap.state, at: snap.at, metrics: snap.metrics, mode: mode };
  return {
    ok: true,
    state: snap.state,
    previous: snap.previous,
    metrics: snap.metrics,
    at: snap.at,
    mode: mode,
    text: panelText(view)
  };
}

module.exports = {
  load(ctx) {
    // ctx.dataDir は記録時に初めて参照する。legacy ではディレクトリも作らない。
    loadedContext = ctx;
  },
  start() { if (loadedContext && modeOf(loadedContext) !== 'legacy') monitor.start(loadedContext); },
  stop() { monitor.stop(); loadedContext = null; },
  destroy() { monitor.stop(); },
  // 画面への配信は manifest の subscribes 経由。ここでは何も操作しない。
  onEvent(name, payload) {
    if (name === 'slot.switching') monitor.noteSwitching(payload);
    // 画面の「回線の見張りを使う」（features.set）でモードが変わったら、再起動を待たずに動かす・止める。
    if (name === 'modes.changed' && loadedContext) {
      const now = modeOf(loadedContext);
      if (now !== 'legacy' && !monitor.isRunning()) monitor.start(loadedContext);
      else if (now === 'legacy' && monitor.isRunning()) monitor.stop();
    }
    return { ok: true };
  },
  getStatus,
  panelText,
  actions: { getStatus },
  _test: { createMonitor, loadConfig, metricsOf, severity, skippedRate, panelText, monitor }
};
