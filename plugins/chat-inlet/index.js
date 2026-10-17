'use strict';

/**
 * コメントの受け口（K3 で host/chat.js から出した）。丸ストはコメントを受け取らない（受信は全部わんコメ）。ここは「入ってきたコメント 1 件」の検査・重複除去・直近の控え・入り口の取り決め。
 *  - inlet: 核が使う口（registry の ctx.chat.ingest/claim/release・API chat.publish / recent / inlets）。registry が provides の chat.inlet@1 から選ぶ。
 *  - chat.message を出せるのはこのプラグインだけ（events.js の OWNERS）。API chat.publish は chat-write の権限（プラグインが出せない権限）なので、核の api.js が持ち、ここへ渡す。
 * 切（legacy）のあいだは inlet が無い扱いで、コメントは入らない。
 */

const { createChat } = require('./lib/chat');

const plugin = {
  inlet: null,
  load(ctx) {
    const states = ctx.pluginStates;
    plugin.inlet = createChat({
      bus: ctx.bus,
      events: ctx.events.NAMES,
      logger: ctx.logger,
      // 外の呼び出し元が、読み込まれたプラグインの名前を名乗るのを断る / 入り口を取っているプラグインが今も live か
      isPluginSource: (id) => !!(states && states.isRunning(id)),
      isOwnerLive: (id) => !states || states.modeOf(id) === 'live'
    });
  },
  start() {},
  stop() {},
  destroy() { plugin.inlet = null; },
  health() { return { ok: true }; }
};

module.exports = plugin;
