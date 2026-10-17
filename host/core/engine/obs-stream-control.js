'use strict';

/**
 * プラグインの ctx.obs.streamControl の裏側（electron-main が createRegistry({ obsControl }) へ渡す）。
 * 通す条件:
 * - 画面の「OBS の操作」がオン（obs-engine が live）。
 * - OBS につながっている。
 * - 'start' は、プラグイン自身の 'stop' より後に「人が止めた」ことが無いとき（非常停止・配信停止（全部））。
 *   切り替えの途中で人が止めたのを、自動で再開して上書きしない。
 * 'check' は OBS を動かさず、最初の 2 つだけ確かめる。
 */

const HUMAN_REASONS = new Set(['emergency', 'manual']);

function refuse(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

function createObsStreamControl(options) {
  const opts = options || {};
  const getOrchestrator = typeof opts.getOrchestrator === 'function' ? opts.getOrchestrator : function () { return null; };
  const getConnection = typeof opts.getConnection === 'function' ? opts.getConnection : function () { return null; };
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  let lastPluginStopAt = 0;
  let lastHumanStopAt = 0;

  /** stream.stopping の payload を渡す。人の停止（非常停止・手動の停止）だけ覚える。OBS 自身や切り替えの停止（reason 'obs'）は数えない。 */
  function onStopping(payload) {
    const reason = payload && typeof payload === 'object' ? payload.reason : '';
    if (HUMAN_REASONS.has(reason)) lastHumanStopAt = now();
  }

  function connectionOrThrow() {
    const conn = getConnection();
    let connected = false;
    try {
      connected = !!(conn && typeof conn.controlStream === 'function'
        && (typeof conn.getStatus !== 'function' || conn.getStatus().connected === true));
    } catch (_) {
      connected = false;
    }
    if (!connected) throw refuse('obs-not-connected', 'OBS_NOT_CONNECTED');
    return conn;
  }

  async function control(action) {
    const orchestrator = getOrchestrator();
    if (!orchestrator || typeof orchestrator.modeFor !== 'function' || orchestrator.modeFor('obs-engine') !== 'live') {
      throw refuse('obs-control-off');
    }
    const conn = connectionOrThrow();
    if (action === 'check') return undefined;
    if (action === 'stop') {
      lastPluginStopAt = now();
      return conn.controlStream('stop');
    }
    if (action === 'start') {
      if (lastHumanStopAt > 0 && lastHumanStopAt >= lastPluginStopAt) throw refuse('human-stopped');
      return conn.controlStream('start');
    }
    throw refuse('bad-action');
  }

  return { control, onStopping };
}

module.exports = { createObsStreamControl };
