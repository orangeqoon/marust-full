'use strict';

/**
 * セッション（配信の時間の記録。K3 で host/sessions.js から出した）。session.* のイベントを出せるのはこのプラグインだけ（events.js の OWNERS）。
 *  - 状態は dataDir/session.json の 1 か所だけ（L6b: 核の state.json の session は読まない）。
 *  - 核の合図: broadcast.started（配信を始めた）でセッションを始め、broadcast.stopped の all（全部止めた）で終える。核は題名を渡さない（題名は session.retitle / session.start）。
 *  - controller: 核（hub の状態・OBS エンジンの「全部止まった」知らせ）とタイマーなどの controller（ctx.sessions）が使う口。registry が provides の session.store@1 から選ぶ。
 *  - 起動時の回復（recover）と集計の知らせ（noteAggregate）は核が呼ぶ（起動の 1 回だけ。読み直しでは回復しない）。start() は進行中のセッションの鼓動を再開するだけ。
 *  - API session.view（read）・session.start / pause / resume / end / retitle（write）。名前・引数・権限は移す前と同じ。
 * 切（legacy）のあいだは controller が無い扱いで、session.* は出ない（gcal は何もせず、timer は ctx.sessions が unavailable）。
 */

const { createSessions } = require('./lib/sessions');
const { createSessionStore } = require('./lib/store');

let controller = null;

function result(value) {
  return value && typeof value === 'object' ? value : { ok: false, error: 'failed' };
}

const plugin = {
  controller: null,
  load(ctx) {
    const store = createSessionStore({ dir: ctx.dataDir });
    store.load();
    controller = createSessions({ store: store, bus: ctx.bus, events: ctx.events.NAMES, recover: false });
    plugin.controller = controller;
    ctx.api.register('session.view', () => Object.assign({ ok: true }, controller.view()), {
      access: 'read',
      description: 'セッションの状態を返す',
      params: {}
    });
    ctx.api.register('session.start', (params) => result(controller.start({
      title: params.title,
      category: params.category,
      plannedSec: params.plannedSec,
      source: 'manual'
    })), {
      access: 'write',
      description: 'セッションを始める',
      params: {
        title: { type: 'string', required: false, max: 500 },
        category: { type: 'string', required: false, max: 200 },
        plannedSec: { type: 'number', required: false }
      }
    });
    ctx.api.register('session.pause', () => result(controller.pause()), { access: 'write', description: 'セッションを一時停止する', params: {} });
    ctx.api.register('session.resume', () => result(controller.resume()), { access: 'write', description: 'セッションを再開する', params: {} });
    ctx.api.register('session.end', () => result(controller.end({})), { access: 'write', description: 'セッションを終える', params: {} });
    ctx.api.register('session.retitle', (params) => result(controller.retitle(params.title)), {
      access: 'write',
      description: 'セッションの題名を変える',
      params: { title: { type: 'string', required: true, max: 500 } }
    });
    // 配信先の集計を見て、開始のときに「もう配信中か」を知る（セッションが OBS のセッションかを決める）
    controller.attachStreamingProbe(function () {
      const row = ctx.destinations.aggregate();
      return { known: row.known === true, streaming: row.streaming === true };
    });
    plugin._ctx = ctx;
  },
  // 核の合図（L6b。manifest の subscribes）。進行中のセッションがあれば始めない（タイマーなどが先に始めていたらそれを使う）
  onEvent(name, payload) {
    if (!controller) return;
    if (name === 'broadcast.started') controller.start({ source: 'manual' });
    else if (name === 'broadcast.stopped' && payload && payload.all === true) controller.end({ reason: 'all-stopped' });
  },
  start() {
    // 起動時の回復（recover）は核が 1 回だけ呼ぶ（electron-main の recoverSessionOnce。K3 評価 Must 1）。
    // ここでは回復しない: プラグインを読み直しても、進行中のセッションを終わらせない。鼓動だけ再開する。
    if (controller) controller.rearm();
  },
  stop() { if (controller) controller.stop(); },
  destroy() {
    if (controller) controller.stop();
    controller = null;
    plugin.controller = null;
    plugin._ctx = null;
  },
  health() { return { ok: true }; }
};

module.exports = plugin;
