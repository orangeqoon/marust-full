'use strict';

/**
 * api の名前空間 secrets（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { createSecretApi } = require('../../../core');

const specs = {
  'secrets.list': {
    permission: 'read',
    windowOnly: true,
    description: '金庫の名前と更新時刻と大きさを返す',
    params: {}
  },
  'secrets.set': {
    permission: 'write',
    windowOnly: true,
    description: '金庫に値を入れる',
    params: {}
  },
  'secrets.remove': {
    permission: 'write',
    windowOnly: true,
    description: '金庫から名前を消す',
    params: {}
  }
};

function runs(S) {
  const { src } = S;
  return {
    'secrets.list': function () {
      return createSecretApi(src.secrets).list();
    },
    'secrets.set': function (params, ctx) {
      return createSecretApi(src.secrets).set(params, ctx);
    },
    'secrets.remove': function (params, ctx) {
      return createSecretApi(src.secrets).remove(params, ctx);
    }
  };
}

module.exports = { specs, runs };
