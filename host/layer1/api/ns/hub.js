'use strict';

/**
 * api の名前空間 hub（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { withoutSecrets } = require('../rules');

const specs = {
  'hub.getState': {
    permission: 'read',
    description: 'ハブの状態を返す',
    params: {}
  },
  'hub.fanout': {
    permission: 'write',
    description: '題名とカテゴリを各サイトへ送る',
    params: {
      title: { type: 'string', required: false, max: 500, loose: true },
      category: { type: 'string', required: false, max: 200, loose: true },
      confirmed: { type: 'boolean', required: false, loose: true },
      allowedLiveIds: { type: 'array', required: false, loose: true }
    }
  },
  'hub.forceLegacy': {
    permission: 'write',
    description: '作者用モードのプラグインがあるとき、すべてのプラグインを legacy に戻す。無いときは unavailable',
    params: {}
  },
  // タイマーの自動送信（K3）。プラグイン timer-link だけが呼べる（宣言した内蔵。出どころは核が付ける）。確認の門は核の予約（host/core/fanout-gate.js）
  'hub.fanoutReserved': {
    permission: 'write',
    description: 'タイマーを始めたときの題名・カテゴリの自動送信。核が確認した予約の範囲だけ送る。プラグイン timer-link だけが呼べる',
    params: {
      title: { type: 'string', required: false, max: 500 },
      category: { type: 'string', required: false, max: 200 }
    }
  }
};

function runs(S) {
  const { devModeOn, showExperimental, src, withVisible } = S;
  return {
    'hub.getState': function (_params, ctx) {
      const state = src.getState();
      const permissions = ctx && Array.isArray(ctx.permissions) ? ctx.permissions.slice() : [];
      const clientId = ctx && typeof ctx.clientId === 'string' ? ctx.clientId : '';
      function withCaller(body) {
        const clean = withoutSecrets(body && typeof body === 'object' ? body : {});
        const out = Object.assign({}, clean, { permissions: permissions, clientId: clientId, confirmLive: src.confirmLive !== false, devMode: devModeOn(), aiAutoPair: typeof src.aiAutoPair === 'function' ? !!src.aiAutoPair() : false, showExperimental: showExperimental() });
        if (Array.isArray(out.plugins)) out.plugins = withVisible(out.plugins);
        return out;
      }
      if (state && typeof state.then === 'function') return state.then(withCaller);
      return withCaller(state);
    },
    'hub.fanout': function (params) { return src.fanout(params); },
    'hub.forceLegacy': function () { return src.forceLegacy(); },
    'hub.fanoutReserved': function (params, ctx) {
      if (!ctx || ctx.kind !== 'plugin' || ctx.titleReserved !== true) return { ok: false, error: 'forbidden' }; // manifest needs の title.reserved を持つ内蔵 1 つだけ（登録簿が認める）
      if (!src.fanoutReserved || typeof src.fanoutReserved.send !== 'function') return { ok: false, error: 'unavailable' };
      return src.fanoutReserved.send({ title: params.title, category: params.category }); // confirmed などは受け取らない
    }
  };
}

module.exports = { specs, runs };
