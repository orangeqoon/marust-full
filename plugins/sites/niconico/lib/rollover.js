'use strict';

/**
 * 自動枠取りの「判断だけ」の純粋な関数（通信も時計も持たない。時刻は引数）。
 * 丸スト本体（host/・plugins/）は読まない。
 */

const DEFAULT_THRESHOLD_SEC = 42600; // 11 時間 50 分（auto_switch_final.py の ROLLOVER_THRESHOLD_SEC）

const DEFAULT_LIMITS = Object.freeze({
  createsPerDay: 20,
  switchesPerDay: 4,
  minCreateGapMs: 5 * 60 * 1000,
  unitsPerDay: 7000
});

function finiteNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** YouTube: 経過秒が閾値に達したら切り替える。経過秒の出どころ（OBS か枠の開始時刻）は問わない。 */
function shouldRollover(input) {
  const src = input || {};
  const elapsed = finiteNumber(src.elapsedSec, 0);
  const threshold = finiteNumber(src.thresholdSec, DEFAULT_THRESHOLD_SEC);
  if (!(threshold > 0)) return false;
  return elapsed >= threshold;
}

/**
 * YouTube: 枠を作る・切り替える前の安全弁（クォータと再接続の繰り返し対策）。
 * usage = { units, creates, switches, lastCreateAt(ms|0) }。kind は 'create' か 'switch'。
 * 戻り: { ok: true } か { ok: false, reason: 'quota-guard'|'create-limit'|'switch-limit'|'too-soon' }
 */
function writeGuard(input) {
  const src = input || {};
  const usage = src.usage || {};
  const limits = Object.assign({}, DEFAULT_LIMITS, src.limits || {});
  const now = finiteNumber(src.now, 0);
  if (finiteNumber(usage.units, 0) >= limits.unitsPerDay) return { ok: false, reason: 'quota-guard' };
  if (src.kind === 'switch') {
    if (finiteNumber(usage.switches, 0) >= limits.switchesPerDay) return { ok: false, reason: 'switch-limit' };
    return { ok: true };
  }
  if (finiteNumber(usage.creates, 0) >= limits.createsPerDay) return { ok: false, reason: 'create-limit' };
  const last = finiteNumber(usage.lastCreateAt, 0);
  if (last > 0 && now - last < limits.minCreateGapMs) return { ok: false, reason: 'too-soon' };
  return { ok: true };
}

/**
 * ニコ生: 番組 data から ON_AIR / TEST / ENDED を決める（check_program_status の移植）。
 * テスト中は beginTime が未来の onAirSchedule を先出しするので、begin <= now < end を必ず見る。
 */
function classifyProgram(data, nowMs) {
  if (!data || typeof data !== 'object') return 'ENDED';
  const onAir = data.onAirSchedule;
  if (onAir && onAir.beginTime && onAir.endTime) {
    const begin = Date.parse(onAir.beginTime);
    const end = Date.parse(onAir.endTime);
    if (!Number.isFinite(begin) || !Number.isFinite(end)) return 'ON_AIR';
    if (begin <= nowMs && nowMs < end) return 'ON_AIR';
    if (nowMs >= end) return 'ENDED';
  }
  if (data.testSchedule) return 'TEST';
  return 'ENDED';
}

/**
 * ニコ生: OBS が止まって（または接続不可で）から timeoutSec 経ったか（ObsDisconnectMonitor.update の移植）。
 * obsActive: true=配信中 / false=停止 / null=接続不可。state = { since: ms|0 }（呼ぶ側が持つ）。
 * 戻り: { state, expired, event }  event は 'wait-start' | 'wait-start-unreachable' | 'timeout' | 'recovered' | ''
 */
function disconnectStep(state, obsActive, nowMs, timeoutSec) {
  const since = state && finiteNumber(state.since, 0) > 0 ? state.since : 0;
  if (obsActive === true) {
    return { state: { since: 0 }, expired: false, event: since ? 'recovered' : '' };
  }
  if (!since) {
    return { state: { since: nowMs }, expired: false, event: obsActive === null ? 'wait-start-unreachable' : 'wait-start' };
  }
  if (nowMs - since >= timeoutSec * 1000) {
    return { state: { since: 0 }, expired: true, event: 'timeout' };
  }
  return { state: { since: since }, expired: false, event: '' };
}

/**
 * ニコ生: 1 周ぶんの次の動作（auto_caster.py run() の分岐の移植）。
 * input: { liveId, obsActive(true|false|null), status('ON_AIR'|'TEST'|'ENDED'|'UNKNOWN'), forceEnd, disconnectExpired, createNextOnNaturalEnd }
 * 戻り: 'wait' | 'create' | 'end-forced' | 'end-disconnect' | 'start-on-air' | 'next-after-end' | 'idle-after-end' | 'keep'
 */
function niconicoNextAction(input) {
  const src = input || {};
  if (!src.liveId) return src.obsActive === true ? 'create' : 'wait';
  if (src.forceEnd === true) return 'end-forced';
  if (src.disconnectExpired === true) return 'end-disconnect';
  if (src.status === 'TEST') return 'start-on-air';
  if (src.status === 'ENDED') {
    if (src.obsActive === true && src.createNextOnNaturalEnd !== false) return 'next-after-end';
    return 'idle-after-end';
  }
  return 'keep';
}

module.exports = {
  DEFAULT_THRESHOLD_SEC,
  DEFAULT_LIMITS,
  shouldRollover,
  writeGuard,
  classifyProgram,
  disconnectStep,
  niconicoNextAction
};
