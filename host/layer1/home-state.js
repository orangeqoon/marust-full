'use strict';

/**
 * ホーム画面（R8）が読む「控え」。画面の定期更新のたびに OBS や金庫を読まないよう、ホスト側で最後の値だけ持つ。
 * - slot.acquired: サイトごとの「配信枠: 用意できました」の表示だけに使う（reason と時刻だけ。枠 ID・チャット ID は持たない）。
 * - site.trouble（サイトの困りごと）: 画面の最上段の赤い 1 行。消す（dismissAlert）まで残す。メモリだけ（再起動で消える）。
 * 外へは何も書かない。
 */

const TOKEN_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const JOBS = new Set(['slot', 'title', 'comment']);
const KINDS = new Set(['login-expired', 'rate-limited', 'unreachable', 'failed']);
const REASONS = new Set(['created', 'reused', 'switched']);

function token(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TOKEN_RE.test(text) ? text : '';
}

function createHomeState(deps) {
  const d = deps || {};
  const nowFn = typeof d.now === 'function' ? d.now : function defaultNow() { return new Date(); };
  const slots = new Map();
  let alert = null;
  const unsubs = [];

  function iso() { return nowFn().toISOString(); }

  function onSlotAcquired(payload) {
    const site = token(payload && payload.site);
    if (!site) return;
    const reason = REASONS.has(payload.reason) ? payload.reason : 'reused';
    const at = typeof payload.at === 'string' && payload.at.length <= 40 && !Number.isNaN(Date.parse(payload.at)) ? payload.at : iso();
    slots.set(site, { reason: reason, at: at });
  }

  function onSlotAlert(payload) {
    const kind = payload && KINDS.has(payload.kind) ? payload.kind : 'failed';
    const job = payload && JOBS.has(payload.job) ? payload.job : 'slot';
    alert = { site: token(payload && payload.site) || 'unknown', job: job, kind: kind, code: token(payload && payload.code) || kind, at: iso() };
  }

  if (d.bus && typeof d.bus.subscribe === 'function') {
    unsubs.push(d.bus.subscribe('slot.acquired', function (_name, payload) { onSlotAcquired(payload); }));
    unsubs.push(d.bus.subscribe('site.trouble', function (_name, payload) { onSlotAlert(payload); }));
  }

  return {
    onSlotAcquired: onSlotAcquired,
    onSlotAlert: onSlotAlert,
    getState: function () {
      const out = {};
      for (const [site, row] of slots) out[site] = Object.assign({}, row);
      return { slots: out, alert: alert ? Object.assign({}, alert) : null };
    },
    dismissAlert: function () { alert = null; },
    stop: function () { while (unsubs.length) { try { unsubs.pop()(); } catch (_) { /* 無視 */ } } }
  };
}

module.exports = { createHomeState };
