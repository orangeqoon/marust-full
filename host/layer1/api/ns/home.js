'use strict';

/**
 * api の名前空間 home（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'home.getState': {
    permission: 'read',
    description: 'ホーム画面用の控え: サイトごとの「配信枠を用意した」印（reason と時刻だけ）と、消すまで残す自動枠取りの警告 1 件。読むだけ',
    params: {}
  },
  'home.dismissAlert': {
    permission: 'write',
    windowOnly: true,
    description: 'ホームの最上段に出している自動枠取りの警告を消す。ウィンドウだけ',
    params: {}
  }
};

function runs(S) {
  const { src } = S;
  return {
    'home.getState': function () {
      if (!src.homeState || typeof src.homeState.getState !== 'function') return { ok: false, error: 'unavailable' };
      return Object.assign({ ok: true }, src.homeState.getState());
    },
    'home.dismissAlert': function () {
      if (!src.homeState || typeof src.homeState.dismissAlert !== 'function') return { ok: false, error: 'unavailable' };
      src.homeState.dismissAlert();
      return { ok: true };
    }
  };
}

module.exports = { specs, runs };
