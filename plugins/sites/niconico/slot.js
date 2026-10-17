'use strict';

/**
 * ニコ生の自動枠取り（stream.slot@1）。判断と通信は lib/ に置き、ここは
 * ① OBS の配信状態を 10 秒ごとに見る ② 枠の状態を持つ ③ 画面の操作、だけ。
 * - legacy: 何もしない。
 * - shadow: 読むだけ（OBS の状態・最新の番組の状態）。作らない・開始しない・延長しない・終了しない。
 * - live: OBS が配信中で枠が無ければ（動いている枠があればそれを引き継ぎ）枠を作って開始・延長。
 *   OBS が止まって N 分で終了。自然終了なら次の枠。ログインが切れたら止めて画面に出す（勝手に再ログインしない）。
 * キーは扱わない（ニコ生のキーはアカウント固定。docs/research/niconico-stream-key.md）。
 * 秘密は ctx.secrets の cookies.niconico-main だけ。値はログ・状態・イベントに出さない。
 * 金庫は 5 分に 1 回しか読まない（10 秒ごとの監視で監査が増えないように）。
 */

const fs = require('fs');
const path = require('path');
const { createNiconico } = require('./lib/niconico');
const { disconnectStep, niconicoNextAction } = require('./lib/rollover');

const SECRET = 'cookies.niconico-main';
const TICK_MS = 10000;
const AUTH_TTL_MS = 5 * 60 * 1000;
const LOGIN_RETRY_MS = 5 * 60 * 1000;
const CREATE_RETRY_MS = 60 * 1000;
const SHADOW_POLL_MS = 60 * 1000;
const MAX_SECRET = 64 * 1024;
const SESSION_RE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]{1,128}$/;

const DEFAULTS = Object.freeze({
  title: 'ライブ配信 第{part}枠',
  description: '',
  category: '一般(その他)',
  tags: '',
  autoCloseMin: 5,
  createNextOnNaturalEnd: true,
  extendToMax: true,
  nextDelaySec: 5,
  monetize: false,
  cruiseWait: false
});

function clip(value, max) {
  return Array.from(value == null ? '' : String(value)).slice(0, max).join('');
}

function int(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = typeof src.title === 'string' ? src.title.trim() : '';
  const category = typeof src.category === 'string' ? src.category.trim() : '';
  return {
    title: title ? clip(title, 100) : DEFAULTS.title,
    description: typeof src.description === 'string' ? clip(src.description, 5000) : '',
    category: category ? clip(category, 40) : DEFAULTS.category,
    tags: typeof src.tags === 'string' ? clip(src.tags.replace(/[\r\n]/g, ' '), 500) : '',
    autoCloseMin: int(src.autoCloseMin, DEFAULTS.autoCloseMin, 1, 120),
    createNextOnNaturalEnd: bool(src.createNextOnNaturalEnd, DEFAULTS.createNextOnNaturalEnd),
    extendToMax: bool(src.extendToMax, DEFAULTS.extendToMax),
    nextDelaySec: int(src.nextDelaySec, DEFAULTS.nextDelaySec, 0, 60),
    monetize: bool(src.monetize, DEFAULTS.monetize),
    cruiseWait: bool(src.cruiseWait, DEFAULTS.cruiseWait)
  };
}

/** 設定から番組作成用のテンプレートを作る（作者のものは入れない。全部画面の入力欄の値）。 */
function templateOf(config) {
  const tags = String(config.tags || '').split(',').map((t) => t.trim()).filter((t) => t).map((label) => ({ label: label, isLocked: false }));
  return {
    title: config.title,
    description: config.description,
    category: config.category,
    tags: tags,
    optionalCategories: [],
    durationMinutes: 30,
    isTimeshiftEnabled: true,
    isIchibaEnabled: true,
    isCreatorIncentiveEnabled: config.monetize === true
  };
}

function parseCookies(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_SECRET) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed.cookies && typeof parsed.cookies === 'object' && !Array.isArray(parsed.cookies) ? parsed.cookies : parsed;
  const jar = Object.create(null);
  let session = '';
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!COOKIE_NAME_RE.test(key)) continue;
    const value = source[key];
    if (typeof value !== 'string' || !value || /[\r\n\u0000;]/.test(value)) continue;
    jar[key] = value;
    if (key === 'user_session' && SESSION_RE.test(value)) session = value;
  }
  if (!session) return null;
  return { session: session, cookie: Object.keys(jar).map((k) => k + '=' + jar[k]).join('; ') };
}

function createSlotNiconico(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function (url, init) { return globalThis.fetch(url, Object.assign({}, init, { redirect: 'manual' })); };
  const nowFn = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : function (ms) { return new Promise((r) => setTimeout(r, ms)); };
  const setTick = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
  const clearTick = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;
  const tickMs = Number.isInteger(options.tickMs) ? options.tickMs : TICK_MS;

  let ctx = null;
  let config = normalizeConfig(null);
  let timer = null;
  let busy = false;
  let nico = null;
  let authCache = { value: null, at: 0, present: null };

  const view = {
    lastOp: '',
    lastOpAt: '',
    liveId: '',
    lastLiveId: '',
    status: 'UNKNOWN',
    part: 1,
    nextReason: '',
    needsLogin: false,
    error: '',
    credentials: null,
    obs: { reachable: null, streaming: false }
  };
  const alerted = new Set(); // site.trouble は同じ原因で続けて出さない（ホームの赤い 1 行は 1 つだけ）
  let disc = { since: 0 };
  let nextCreateAt = 0;
  let nextLoginCheckAt = 0;
  let shadowPollAt = 0;

  function nowMs() {
    const n = Number(nowFn());
    return Number.isFinite(n) ? n : Date.now();
  }

  function iso() { return new Date(nowMs()).toISOString(); }

  function log(level, message) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    try { ctx.logger(level, clip(message, 200)); } catch (_) { /* ログで止めない */ }
  }

  function note(op) {
    view.lastOp = typeof op === 'string' ? op : '';
    view.lastOpAt = iso();
  }

  function modeOf(box) {
    const target = box || ctx;
    if (!target || typeof target.mode !== 'function') return 'legacy';
    try {
      const v = target.mode();
      if (v === 'legacy' || v === 'shadow' || v === 'live') return v;
    } catch (_) { /* legacy */ }
    return 'legacy';
  }

  function dataFile(name) {
    if (!ctx) return '';
    let dir = '';
    try { dir = ctx.dataDir; } catch (_) { return ''; }
    return typeof dir === 'string' && dir ? path.join(dir, name) : '';
  }

  function readJson(file) {
    try {
      if (!file || !fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > 65536) return null;
      const data = JSON.parse(text.replace(/^﻿/, ''));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (_) {
      return null;
    }
  }

  function writeFileSafe(file, text) {
    if (!file) return false;
    try { fs.writeFileSync(file, text, 'utf8'); return true; } catch (_) { return false; }
  }

  function loadConfig() {
    config = normalizeConfig(readJson(dataFile('config.json')));
  }

  /** OBS の文字ソースなどが読む番組番号のファイル（Python の current_lv.txt / watch_url.txt と同じ中身）。 */
  function writeProgramFiles(liveId) {
    writeFileSafe(dataFile('current_lv.txt'), liveId);
    writeFileSafe(dataFile('watch_url.txt'), 'https://live.nicovideo.jp/watch/' + liveId);
  }

  // ----- ログイン（金庫は 5 分に 1 回） -----

  async function getAuth() {
    const t = nowMs();
    if (authCache.value && t - authCache.at < AUTH_TTL_MS) return authCache.value;
    if (authCache.present === false && t - authCache.at < AUTH_TTL_MS) return null;
    let got;
    try {
      got = ctx && ctx.secrets && typeof ctx.secrets.get === 'function' ? await ctx.secrets.get(SECRET) : null;
    } catch (_) {
      got = null;
    }
    const parsed = got && got.ok === true ? parseCookies(got.value) : null;
    authCache = { value: parsed, at: t, present: !!parsed };
    view.credentials = !!parsed;
    return parsed;
  }

  function dropAuthCache() {
    authCache = { value: null, at: 0, present: null };
  }

  function client() {
    if (!nico) {
      nico = createNiconico({
        fetch: fetchImpl,
        getAuth: getAuth,
        now: nowMs,
        sleep: sleepFn,
        log: (level, message) => log(level, 'nico ' + message)
      });
    }
    return nico;
  }

  function publish(name, payload) {
    if (!ctx || !ctx.bus || typeof ctx.bus.publish !== 'function') return;
    try { ctx.bus.publish(name, payload, {}); } catch (_) { /* 配信は止めない */ }
  }

  /** site.trouble（job slot）を出す（live のときだけ。同じ code は直るまで 1 回）。code は [a-z0-9-]（ホームの token の形）。 */
  function alertOnce(code) {
    if (modeOf() !== 'live' || alerted.has(code)) return;
    alerted.add(code);
    publish(ctx.events.NAMES.SITE_TROUBLE, { site: 'niconico', job: 'slot', kind: code === 'login-expired' ? 'login-expired' : 'failed', code: code, at: iso() });
  }

  function fault(code) {
    if (code === 'login-expired') {
      alertOnce('login-expired');
      view.needsLogin = true;
      view.credentials = false;
      nextLoginCheckAt = nowMs() + LOGIN_RETRY_MS;
      dropAuthCache();
    }
    view.error = code;
    note(code);
    log('warn', 'niconico ' + code);
  }

  function healthy() {
    alerted.delete('login-expired');
    view.needsLogin = false;
    view.error = '';
  }

  /** 枠が変わったときだけ slot.acquired を出す。reason: created / reused / switched（自然終了のあとの次枠） */
  function adopt(liveId, status, reason) {
    if (view.liveId !== liveId) {
      const previous = view.lastLiveId;
      view.liveId = liveId;
      view.lastLiveId = liveId;
      writeProgramFiles(liveId);
      const payload = { site: 'niconico', liveId: liveId, reason: reason || 'reused', at: iso() };
      if (previous && previous !== liveId) payload.previousId = previous;
      publish(ctx.events.NAMES.SLOT_ACQUIRED, payload);
    }
    view.status = status || view.status;
  }

  function release() {
    alerted.delete('end-failed');
    view.liveId = '';
    view.status = 'UNKNOWN';
    disc = { since: 0 };
  }

  // ----- 動き -----

  /** 動いている（または準備中の）枠を探す。無ければ null。ログイン切れ・通信失敗は { error }。 */
  async function findExisting() {
    const latest = await client().getLatestProgram();
    if (!latest.ok) return { error: latest.code };
    if (!latest.data || typeof latest.data.id !== 'string') return null;
    const st = await client().checkStatus(latest.data.id);
    if (st.status === 'UNKNOWN') return { error: st.code || 'network' };
    if (st.status === 'ON_AIR' || st.status === 'TEST') return { liveId: latest.data.id, status: st.status };
    return null;
  }

  async function createOrAdopt() {
    const existing = await findExisting();
    if (existing && existing.error) return fault(existing.error);
    if (existing) {
      adopt(existing.liveId, existing.status, view.nextReason || 'reused');
      view.nextReason = '';
      if (existing.status === 'TEST') {
        const started = await client().startOnAir(existing.liveId);
        if (!started.ok) return fault(started.code);
      }
      // 動いている枠を引き継いだときも上限まで延長する（30 分で自然終了して次の枠になるのを防ぐ）。上限なら 1 回で止まる
      if (config.extendToMax) await client().extendToMax(existing.liveId);
      healthy();
      disc = { since: 0 };
      note('reused');
      return undefined;
    }
    const out = await client().createProgram({
      template: templateOf(config),
      part: view.part,
      monetize: config.monetize,
      cruise: config.cruiseWait,
      extendToMax: config.extendToMax
    });
    if (!out.ok) {
      nextCreateAt = nowMs() + CREATE_RETRY_MS;
      return fault(out.code);
    }
    healthy();
    adopt(out.liveId, 'ON_AIR', out.reused ? 'reused' : (view.nextReason || 'created'));
    view.nextReason = '';
    disc = { since: 0 };
    note(out.reused ? 'reused' : 'created');
    return undefined;
  }

  async function watchProgram(obsActive) {
    // OBS に接続できない（null）ときは、丸ストと OBS の WebSocket が切れただけで配信は続いているかもしれない。止まっている（false）の 3 倍待つ。
    const timeoutSec = config.autoCloseMin * 60 * (obsActive === null ? 3 : 1);
    const step = disconnectStep(disc, obsActive, nowMs(), timeoutSec);
    disc = step.state;
    if (step.event === 'wait-start' || step.event === 'wait-start-unreachable') log('info', 'niconico obs stopped, waiting');
    if (step.event === 'recovered') log('info', 'niconico obs recovered');
    if (step.expired) {
      const ended = await client().endProgram(view.liveId, { cpp: config.monetize });
      if (!ended.ok) {
        if (ended.code === 'login-expired') return fault(ended.code);
        disc = { since: nowMs() - timeoutSec * 1000 + 30000 }; // 30 秒後にもう一度
        view.error = ended.code;
        note('end-failed');
        alertOnce('end-failed');
        return undefined;
      }
      release();
      note('ended-disconnect');
      return undefined;
    }
    const st = await client().checkStatus(view.liveId);
    view.status = st.status;
    const action = niconicoNextAction({
      liveId: view.liveId,
      obsActive: obsActive,
      status: st.status,
      disconnectExpired: false,
      createNextOnNaturalEnd: config.createNextOnNaturalEnd
    });
    if (st.status === 'UNKNOWN' && st.code === 'login-expired') return fault('login-expired');
    if (action === 'start-on-air') {
      const started = await client().startOnAir(view.liveId);
      if (!started.ok) return fault(started.code);
      note('started');
      return undefined;
    }
    if (action === 'next-after-end' || action === 'idle-after-end') {
      if (config.monetize) await client().registerCreatorIncentive(view.liveId);
      release();
      if (action === 'idle-after-end') {
        note('ended');
        return undefined;
      }
      note('ended-natural');
      await sleepFn(config.nextDelaySec * 1000);
      view.part += 1;
      view.nextReason = 'switched';
      return createOrAdopt();
    }
    healthy();
    return undefined;
  }

  async function shadowObserve(obsActive) {
    if (obsActive !== true) return;
    if (nowMs() - shadowPollAt < SHADOW_POLL_MS) return;
    shadowPollAt = nowMs();
    const existing = await findExisting();
    if (existing && existing.error) return fault(existing.error);
    healthy();
    if (existing) {
      view.liveId = existing.liveId;
      view.status = existing.status;
      note('reused');
    } else {
      view.liveId = '';
      note('shadow-would-create');
    }
    return undefined;
  }

  async function obsState() {
    const obs = ctx && ctx.obs;
    if (!obs || typeof obs.getStreamStatus !== 'function') {
      view.obs = { reachable: false, streaming: false };
      return null;
    }
    const st = await obs.getStreamStatus();
    if (!st) {
      view.obs = { reachable: false, streaming: false };
      return null;
    }
    const active = st.outputActive === true;
    view.obs = { reachable: true, streaming: active };
    return active;
  }

  async function tick() {
    if (!ctx || busy) return;
    const mode = modeOf();
    if (mode === 'legacy') return;
    busy = true;
    try {
      const obsActive = await obsState();
      if (mode === 'shadow') {
        await shadowObserve(obsActive);
        return;
      }
      if (view.needsLogin) {
        if (nowMs() < nextLoginCheckAt) return;
        nextLoginCheckAt = nowMs() + LOGIN_RETRY_MS;
        const probe = await client().getLatestProgram();
        if (!probe.ok) return fault(probe.code);
        healthy();
      }
      const action = niconicoNextAction({ liveId: view.liveId, obsActive: obsActive });
      if (action === 'create') {
        if (nowMs() < nextCreateAt) return;
        await createOrAdopt();
        return;
      }
      if (action === 'wait') return;
      await watchProgram(obsActive);
    } catch (_) {
      view.error = 'failed';
      log('warn', 'niconico tick failed');
    } finally {
      busy = false;
    }
  }

  // ----- stream.slot@1（丸ストの「配信開始」ボタンの流れ）。キーは固定なので渡さない -----

  function resolveMode(meta) {
    return meta && meta.dryRun === true ? 'shadow' : modeOf();
  }

  function prepareBroadcast(dest, session, meta) {
    const mode = resolveMode(meta);
    if (mode === 'shadow') return { ok: true, dryRun: true };
    return { ok: true };
  }

  async function verifyLive(dest, meta) {
    const mode = resolveMode(meta);
    if (mode === 'legacy') return { ok: true };
    if (mode === 'shadow') return { ok: true, dryRun: true };
    let id = view.liveId;
    if (!id) {
      const latest = await client().getLatestProgram();
      if (!latest.ok) return { ok: false, error: latest.code };
      id = latest.data && typeof latest.data.id === 'string' ? latest.data.id : '';
    }
    if (!id) return { ok: true, live: false };
    const st = await client().checkStatus(id);
    if (st.status === 'UNKNOWN') return { ok: false, error: st.code || 'network' };
    return { ok: true, live: st.status === 'ON_AIR' };
  }

  function endBroadcast(dest, meta) {
    if (resolveMode(meta) === 'shadow') return { ok: true, dryRun: true };
    return { ok: true };
  }

  // ----- 画面の操作 -----

  async function getStatus(params, passed) {
    if (params && params.check === true) {
      dropAuthCache();
      await getAuth();
    }
    return {
      ok: true,
      mode: modeOf(passed),
      lastOp: view.lastOp,
      lastOpAt: view.lastOpAt,
      liveId: view.liveId,
      status: view.status,
      needsLogin: view.needsLogin,
      error: view.error,
      credentials: view.credentials,
      obs: Object.assign({}, view.obs),
      config: Object.assign({}, config)
    };
  }

  function setConfig(params, passed) {
    const box = passed || ctx;
    const next = normalizeConfig(Object.assign({}, config, params && typeof params === 'object' ? params : {}));
    if (!box || !box.dataDir) return { ok: false, error: 'unavailable' };
    if (!writeFileSafe(path.join(box.dataDir, 'config.json'), JSON.stringify(next))) return { ok: false, error: 'unavailable' };
    config = next;
    return { ok: true, config: Object.assign({}, config) };
  }

  /** 画面の「テスト枠を作る」: 枠を 1 つ作るだけ（開始も延長もしない。ニコ生側は準備中の状態）。押したときだけ本物に書く。 */
  async function createTestSlot(params, passed) {
    const box = passed || ctx;
    if (!params || params.confirmed !== true) return { ok: false, error: 'confirm' };
    if (modeOf(box) !== 'live') return { ok: false, error: 'not-live' };
    // OBS が配信中だと、次の見回りでこの枠をそのまま本番として開始してしまう。配信していないときだけ作る。
    if (view.obs.streaming === true) return { ok: false, error: 'obs-streaming' };
    const existing = await findExisting();
    if (existing && existing.error) return { ok: false, error: existing.error };
    if (existing) return { ok: false, error: 'already-exists', liveId: existing.liveId };
    const out = await client().createProgram({ template: templateOf(config), part: view.part, monetize: config.monetize, cruise: config.cruiseWait, testOnly: true });
    if (!out.ok) return { ok: false, error: out.code };
    note('test-slot');
    return { ok: true, liveId: out.liveId };
  }

  function load(passed) {
    ctx = passed || null;
    loadConfig();
    nico = null;
    dropAuthCache();
  }

  function start() {
    if (timer || !ctx) return;
    timer = setTick(() => { tick(); }, tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearTick(timer);
    timer = null;
  }

  function destroy() {
    stop();
    ctx = null;
    nico = null;
    dropAuthCache();
  }

  function health() {
    return { ok: true, detail: 'slot-niconico' };
  }

  return {
    load, start, stop, destroy, health,
    tick,
    prepareBroadcast, verifyLive, endBroadcast,
    actions: { getStatus: getStatus, setConfig: setConfig, createTestSlot: createTestSlot }
  };
}

const singleton = createSlotNiconico();
singleton.createSlotNiconico = createSlotNiconico;
module.exports = singleton;
