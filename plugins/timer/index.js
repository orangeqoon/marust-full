'use strict';

/**
 * タイマー（manifest v2 / inproc）。
 * 経過は開始時刻との差。モードとセット時間だけを ctx.dataDir/settings.json に残す。
 * 旧 marust_timer_settings.json は初回だけ読み、消さない。
 * legacy ではセッションを動かさない。shadow / live だけ start / end する。
 */

const fs = require('fs');
const path = require('path');

const MAX_SEC = 24 * 60 * 60;
const MAX_MS = MAX_SEC * 1000;
const DEFAULT_SEC = 5 * 60;
const DEFAULT_PRESETS = [5 * 60, 15 * 60, 30 * 60, 60 * 60, 2 * 3600, 3 * 3600];
const COUNTUP_PLANNED_SEC = 3600;
const TICK_MS = 1000;
const TITLE_MAX = 200;
const CATEGORY_MAX = 100;
const LEGACY_FILE = 'marust_timer_settings.json';
const SETTINGS_FILE = 'settings.json';
const LEGACY_NOTICE = 'legacy: 記録・題名送信はしません';

function createTimer(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const setTimer = typeof opts.setInterval === 'function' ? opts.setInterval : setInterval;
  const clearTimer = typeof opts.clearInterval === 'function' ? opts.clearInterval : clearInterval;

  let ctx = null;
  let mode = 'countdown';
  let durationSec = DEFAULT_SEC;
  let presets = DEFAULT_PRESETS.slice();
  let title = '';
  let category = '';
  let runTitle = '';
  let runCategory = '';
  let running = false;
  let originMs = 0;
  let frozenElapsedMs = 0;
  let ownsSession = false;
  let handle = null;
  let stoppedAtMs = 0;

  function bind(next) {
    if (next) ctx = next;
  }

  function log(level, message) {
    if (ctx && typeof ctx.logger === 'function') ctx.logger(level, message);
  }

  function pluginMode() {
    if (!ctx || typeof ctx.mode !== 'function') return 'legacy';
    try {
      const value = ctx.mode();
      if (value === 'legacy' || value === 'shadow' || value === 'live') return value;
    } catch (_) {
      return 'legacy';
    }
    return 'legacy';
  }

  function recording() {
    const value = pluginMode();
    return value === 'shadow' || value === 'live';
  }

  function rawElapsedMs() {
    if (!running) return frozenElapsedMs;
    const raw = now() - originMs;
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, raw);
  }

  function formatSec(total) {
    const sec = Math.max(0, Math.min(MAX_SEC, total | 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function numbers(ms) {
    const capped = Math.min(MAX_MS, Math.max(0, ms));
    const elapsedSec = Math.floor(capped / 1000);
    let remainingSec = 0;
    if (mode === 'countdown') {
      remainingSec = Math.ceil(Math.max(0, durationSec * 1000 - capped) / 1000);
    }
    const shown = mode === 'countdown' ? remainingSec : elapsedSec;
    return {
      display: formatSec(shown),
      remainingSec: remainingSec,
      elapsedSec: elapsedSec
    };
  }

  function overlayValues() {
    const view = numbers(Math.min(MAX_MS, rawElapsedMs()));
    return {
      display: view.display,
      remainingSec: view.remainingSec,
      elapsedSec: view.elapsedSec,
      mode: mode,
      state: running ? 'running' : 'stopped',
      title: running ? runTitle : title
    };
  }

  function publish() {
    if (!ctx || !ctx.overlay || typeof ctx.overlay.publish !== 'function') return;
    const values = overlayValues();
    ctx.overlay.publish('clock', values);
  }

  // 止めてからの時間（NeonTimer の「Paused: 00:12」）。動いているとき・まだ一度も始めていないときは 0。
  function pausedSeconds() {
    if (running || !stoppedAtMs) return 0;
    const diff = now() - stoppedAtMs;
    if (!Number.isFinite(diff) || diff < 0) return 0;
    return Math.min(MAX_SEC, Math.floor(diff / 1000));
  }

  function publicState() {
    const view = numbers(Math.min(MAX_MS, rawElapsedMs()));
    const current = pluginMode();
    return {
      ok: true,
      mode: mode,
      pluginMode: current,
      state: running ? 'running' : 'stopped',
      running: running,
      display: view.display,
      remainingSec: view.remainingSec,
      elapsedSec: view.elapsedSec,
      durationSec: durationSec,
      presets: presets.slice(),
      pausedSec: pausedSeconds(),
      title: title,
      category: category,
      notice: current === 'legacy' ? LEGACY_NOTICE : ''
    };
  }

  function disarm() {
    if (handle != null) {
      clearTimer(handle);
      handle = null;
    }
  }

  function arm() {
    disarm();
    handle = setTimer(onTick, TICK_MS);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  function safeView() {
    if (!ctx || !ctx.sessions || typeof ctx.sessions.view !== 'function') return null;
    try {
      const view = ctx.sessions.view();
      if (!view || view.active !== true) {
        return { active: false, title: '', state: 'none', elapsedMs: 0 };
      }
      return view;
    } catch (_) {
      return null;
    }
  }

  function beginSession(plannedSec, sessionTitle, sessionCategory) {
    if (!recording()) {
      runTitle = sessionTitle;
      runCategory = sessionCategory;
      ownsSession = false;
      return { ok: true };
    }
    const view = safeView();
    if (!view) return { ok: false, error: 'unavailable' };
    if (view.active && !ownsSession) return { ok: false, error: 'session-active' };
    if (view.active && ownsSession) {
      runTitle = sessionTitle;
      runCategory = sessionCategory;
      return { ok: true };
    }
    if (!ctx.sessions || typeof ctx.sessions.start !== 'function') {
      return { ok: false, error: 'unavailable' };
    }
    let result;
    try {
      result = ctx.sessions.start({
        title: sessionTitle,
        category: sessionCategory,
        plannedSec: plannedSec,
        source: 'timer'
      });
    } catch (_) {
      return { ok: false, error: 'unavailable' };
    }
    if (!result || result.ok === false) {
      const code = result && (result.error || result.reason) ? (result.error || result.reason) : 'unavailable';
      return { ok: false, error: String(code) };
    }
    ownsSession = true;
    runTitle = sessionTitle;
    runCategory = sessionCategory;
    return { ok: true };
  }

  function endOwned() {
    if (!ownsSession) return { ok: true };
    if (!recording()) {
      ownsSession = false;
      return { ok: true };
    }
    if (!ctx.sessions || typeof ctx.sessions.end !== 'function') {
      ownsSession = false;
      return { ok: false, error: 'unavailable' };
    }
    let result;
    try {
      result = ctx.sessions.end();
    } catch (_) {
      return { ok: false, error: 'unavailable' };
    }
    if (result && result.ok === false) {
      const code = result.error || result.reason || 'unavailable';
      return { ok: false, error: String(code) };
    }
    ownsSession = false;
    return { ok: true };
  }

  function saveSettings() {
    if (!ctx || typeof ctx.dataDir !== 'string' || !ctx.dataDir) return;
    const file = path.join(ctx.dataDir, SETTINGS_FILE);
    const data = { version: 1, mode: mode, durationSec: durationSec, presets: presets };
    try {
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (_) {
      log('warn', 'settings-not-saved');
    }
  }

  function readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      const text = String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, '');
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function legacyPath() {
    if (!ctx || typeof ctx.dataDir !== 'string' || !ctx.dataDir) return '';
    return path.resolve(ctx.dataDir, '..', '..', '..', LEGACY_FILE);
  }

  function applySettings(next) {
    mode = next.mode;
    durationSec = next.durationSec;
    presets = Array.isArray(next.presets) ? next.presets.slice() : DEFAULT_PRESETS.slice();
    frozenElapsedMs = 0;
    running = false;
  }

  function parseOurSettings(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.mode !== 'countdown' && data.mode !== 'countup') return null;
    if (!Number.isInteger(data.durationSec)) return null;
    if (data.durationSec < 1 || data.durationSec > MAX_SEC) return null;
    let nextPresets = null;
    if (Array.isArray(data.presets) && data.presets.length === DEFAULT_PRESETS.length
      && data.presets.every((v) => Number.isInteger(v) && v >= 1 && v <= MAX_SEC)) {
      nextPresets = data.presets.slice();
    }
    return { mode: data.mode, durationSec: data.durationSec, presets: nextPresets };
  }

  function readLegacy() {
    const file = legacyPath();
    if (!file || path.basename(file) !== LEGACY_FILE) return null;
    const data = readJson(file);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.mode !== 'countdown' && data.mode !== 'countup') return null;
    let nextDuration = DEFAULT_SEC;
    const ms = Number(data.durationMs);
    if (Number.isFinite(ms)) {
      const sec = Math.round(ms / 1000);
      if (sec >= 1 && sec <= MAX_SEC) nextDuration = sec;
    }
    return { mode: data.mode, durationSec: nextDuration };
  }

  function loadSettings() {
    let file = '';
    try {
      file = path.join(ctx.dataDir, SETTINGS_FILE);
    } catch (_) {
      log('warn', 'settings-not-loaded');
      applySettings({ mode: 'countdown', durationSec: DEFAULT_SEC });
      return;
    }
    if (fs.existsSync(file)) {
      const clean = parseOurSettings(readJson(file));
      applySettings(clean || { mode: 'countdown', durationSec: DEFAULT_SEC });
      if (!clean) saveSettings();
      return;
    }
    const migrated = readLegacy();
    applySettings(migrated || { mode: 'countdown', durationSec: DEFAULT_SEC });
    saveSettings();
  }

  function switchToCountup(overshootMs) {
    const keepTitle = runTitle;
    const keepCategory = runCategory;
    endOwned();
    mode = 'countup';
    const overshoot = Math.max(0, overshootMs);
    if (overshoot >= MAX_MS) {
      frozenElapsedMs = MAX_MS;
      running = false;
      disarm();
    } else {
      frozenElapsedMs = overshoot;
      originMs = now() - overshoot;
      running = true;
      arm();
      beginSession(COUNTUP_PLANNED_SEC, keepTitle, keepCategory);
    }
    saveSettings();
    publish();
  }

  function reconcile() {
    if (!running) return;
    const raw = rawElapsedMs();
    if (mode === 'countdown' && raw >= durationSec * 1000) {
      switchToCountup(raw - durationSec * 1000);
      return;
    }
    if (raw >= MAX_MS) {
      frozenElapsedMs = MAX_MS;
      running = false;
      disarm();
      endOwned();
      publish();
    }
  }

  function onTick() {
    if (!running) return;
    const modeBefore = mode;
    reconcile();
    if (running && mode === modeBefore) publish();
  }

  function assignLabels(params) {
    if (params == null) return '';
    if (typeof params !== 'object' || Array.isArray(params)) return 'bad-title';
    let nextTitle = title;
    let nextCategory = category;
    if (Object.prototype.hasOwnProperty.call(params, 'title')) {
      if (typeof params.title !== 'string' || params.title.length > TITLE_MAX) return 'bad-title';
      nextTitle = params.title;
    }
    if (Object.prototype.hasOwnProperty.call(params, 'category')) {
      if (typeof params.category !== 'string' || params.category.length > CATEGORY_MAX) return 'bad-category';
      nextCategory = params.category;
    }
    title = nextTitle;
    category = nextCategory;
    return '';
  }

  function halt(endSession) {
    if (running) stoppedAtMs = now();
    running = false;
    disarm();
    if (endSession) endOwned();
    frozenElapsedMs = Math.min(MAX_MS, frozenElapsedMs);
  }

  function onLoad(next) {
    bind(next);
    loadSettings();
    publish();
  }

  function onStart(next) {
    bind(next);
    publish();
  }

  function onStop(next) {
    bind(next);
    reconcile();
    if (running) frozenElapsedMs = Math.min(MAX_MS, rawElapsedMs());
    halt(true);
    publish();
  }

  function onDestroy(next) {
    onStop(next);
  }

  function onHealth() {
    return { ok: true, detail: 'timer' };
  }

  function actionGetState(params, next) {
    bind(next);
    reconcile();
    return publicState();
  }

  function actionSetMode(params, next) {
    bind(next);
    const nextMode = params && params.mode;
    if (nextMode !== 'countdown' && nextMode !== 'countup') return { ok: false, error: 'bad-mode' };
    reconcile();
    if (nextMode === mode) return publicState();
    if (running) frozenElapsedMs = Math.min(MAX_MS, rawElapsedMs());
    halt(true);
    frozenElapsedMs = 0;
    mode = nextMode;
    saveSettings();
    publish();
    return publicState();
  }

  function actionSetDuration(params, next) {
    bind(next);
    if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.prototype.hasOwnProperty.call(params, 'seconds')) {
      return { ok: false, error: 'bad-duration' };
    }
    if (!Number.isInteger(params.seconds) || params.seconds < 1 || params.seconds > MAX_SEC) {
      return { ok: false, error: 'bad-duration' };
    }
    if (running) return { ok: false, error: 'running' };
    durationSec = params.seconds;
    frozenElapsedMs = 0;
    saveSettings();
    publish();
    return publicState();
  }

  function actionSetPreset(params, next) {
    bind(next);
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'bad-preset' };
    const i = params.index;
    const sec = params.seconds;
    if (!Number.isInteger(i) || i < 0 || i >= presets.length) return { ok: false, error: 'bad-preset' };
    if (!Number.isInteger(sec) || sec < 1 || sec > MAX_SEC) return { ok: false, error: 'bad-preset' };
    presets[i] = sec;
    saveSettings();
    return publicState();
  }

  function actionStart(params, next) {
    bind(next);
    const labelError = assignLabels(params);
    if (labelError) return { ok: false, error: labelError };
    reconcile();
    if (running) return publicState();
    const planned = mode === 'countdown'
      ? Math.max(1, Math.ceil((durationSec * 1000 - frozenElapsedMs) / 1000))
      : COUNTUP_PLANNED_SEC;
    const begun = beginSession(planned, title, category);
    if (!begun.ok) return { ok: false, error: begun.error };
    originMs = now() - frozenElapsedMs;
    running = true;
    stoppedAtMs = 0;
    arm();
    publish();
    return publicState();
  }

  // プリセットのボタン: 動いていれば止めて（記録は閉じて）、その秒数のカウントダウンをすぐ始める（NeonTimer と同じ）。
  function actionStartPreset(params, next) {
    bind(next);
    const sec = params && params.seconds;
    if (!Number.isInteger(sec) || sec < 1 || sec > MAX_SEC) return { ok: false, error: 'bad-duration' };
    const labelError = assignLabels(params);
    if (labelError) return { ok: false, error: labelError };
    reconcile();
    if (running) {
      frozenElapsedMs = Math.min(MAX_MS, rawElapsedMs());
      halt(true);
    }
    mode = 'countdown';
    durationSec = sec;
    frozenElapsedMs = 0;
    saveSettings();
    return actionStart({ title: title, category: category }, next);
  }

  function actionStop(params, next) {
    bind(next);
    reconcile();
    if (!running) return publicState();
    frozenElapsedMs = Math.min(MAX_MS, rawElapsedMs());
    running = false;
    stoppedAtMs = now();
    disarm();
    const ended = endOwned();
    publish();
    if (ended && ended.ok === false) return { ok: false, error: ended.error };
    return publicState();
  }

  function actionReset(params, next) {
    bind(next);
    if (running) frozenElapsedMs = Math.min(MAX_MS, rawElapsedMs());
    halt(true);
    frozenElapsedMs = 0;
    stoppedAtMs = 0;
    publish();
    return publicState();
  }

  function actionSetTitle(params, next) {
    bind(next);
    const labelError = assignLabels(params);
    if (labelError) return { ok: false, error: labelError };
    publish();
    return publicState();
  }

  return {
    load: onLoad,
    start: onStart,
    stop: onStop,
    destroy: onDestroy,
    health: onHealth,
    actions: {
      getState: actionGetState,
      setMode: actionSetMode,
      setDuration: actionSetDuration,
      setPreset: actionSetPreset,
      start: actionStart,
      startPreset: actionStartPreset,
      stop: actionStop,
      reset: actionReset,
      setTitle: actionSetTitle
    }
  };
}

const plugin = createTimer();
plugin.createTimer = createTimer;
module.exports = plugin;
