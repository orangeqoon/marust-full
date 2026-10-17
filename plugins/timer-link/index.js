'use strict';

/**
 * タイマーの連携（V3 は印だけ。K3 で送る係をここへ出した）。
 * タイマーを始めたとき（session.started の source が timer）、題名とカテゴリの自動送信を核に頼む。
 *  - 頼むのは hub.fanoutReserved だけ（title と category だけ渡す。confirmed も allowedLiveIds も渡せない）。
 *    本番の送り先があるときの確認は、核が一度確認した予約の範囲だけ送る（host/layer1/fanout-gate.js）。このプラグインに確認の門は無い。
 *  - session.started を出せるのはプラグイン session だけ（events.js の OWNERS）。切（legacy）のあいだは頼まない。
 */

let last = { sent: false, reason: 'none', at: '' };
let ctxRef = null;

function note(sent, reason) {
  last = { sent: sent, reason: reason, at: new Date().toISOString() };
  return last;
}

async function onStarted(payload) {
  const ctx = ctxRef;
  if (!ctx) return note(false, 'off');
  if (!payload || payload.source !== 'timer') return note(false, 'not-timer');
  if (ctx.mode() === 'legacy') return note(false, 'off');
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const category = typeof payload.category === 'string' ? payload.category.trim() : '';
  if (!title && !category) return note(false, 'empty');
  let done;
  try {
    done = await ctx.api.call('hub.fanoutReserved', { title: title, category: category });
  } catch (_) {
    return note(false, 'failed');
  }
  if (done && done.ok === true) return note(true, 'sent');
  return note(false, done && typeof done.error === 'string' ? done.error : 'failed');
}

module.exports = {
  load(ctx) {
    ctxRef = ctx;
    ctx.bus.subscribe(ctx.events.NAMES.SESSION_STARTED, (_name, payload, meta) => {
      if (!meta || meta.source !== 'session') return undefined;
      return onStarted(payload);
    });
  },
  onEvent() {},
  start() {},
  stop() {},
  destroy() { ctxRef = null; },
  health() { return { ok: true }; },
  _last: function () { return Object.assign({}, last); }
};
