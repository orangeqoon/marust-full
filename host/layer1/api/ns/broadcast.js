'use strict';

/**
 * api の名前空間 broadcast（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { destinationIdsRule, preflightIdsRule } = require('../rules');

const specs = {
  'broadcast.preflight': {
    permission: 'read',
    description: '配信前チェックの結果を返す。destinationIds を空にすると有効な配信先を見る',
    params: { destinationIds: preflightIdsRule }
  },
  'broadcast.start': {
    permission: 'write',
    description: '配信を開始する。destinationIds は 1〜20 個まで（題名・カテゴリは受け取らない）',
    params: {
      destinationIds: destinationIdsRule,
      confirmed: { type: 'boolean', required: false, typeError: 'confirmed-type' }
    }
  },
  'broadcast.stop': {
    permission: 'write',
    description: '配信を停止する。destinationIds は 1〜20 個',
    params: { destinationIds: destinationIdsRule }
  },
  'broadcast.stopAll': {
    permission: 'write',
    description: '全部止める。配信先もメイン出力も止め、止まったかを確かめて返す',
    params: {}
  },
  'broadcast.status': {
    permission: 'read',
    description: '配信開始が実行中かと、直近の結果を返す',
    params: {}
  }
};

function runs(S) {
  const { cleanIds, enabledDestinationIds, runPreflight, src } = S;
  return {
    'broadcast.preflight': function (params) {
      const ids = cleanIds(params.destinationIds);
      return runPreflight(ids.length ? ids : enabledDestinationIds());
    },
    'broadcast.start': function (params) {
      if (!src.broadcast || typeof src.broadcast.start !== 'function') return { ok: false, error: 'unavailable' };
      return src.broadcast.start({
        destinationIds: params.destinationIds,
        confirmed: params.confirmed === true
      });
    },
    'broadcast.stop': function (params) {
      if (!src.broadcast || typeof src.broadcast.stop !== 'function') return { ok: false, error: 'unavailable' };
      return src.broadcast.stop({ destinationIds: params.destinationIds });
    },
    'broadcast.stopAll': function () {
      if (!src.broadcast || typeof src.broadcast.stopAll !== 'function') return { ok: false, error: 'unavailable' };
      return src.broadcast.stopAll({});
    },
    'broadcast.status': function () {
      if (!src.broadcast || typeof src.broadcast.status !== 'function') return { ok: false, error: 'unavailable' };
      return src.broadcast.status();
    }
  };
}

module.exports = { specs, runs };
