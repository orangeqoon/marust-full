'use strict';

/**
 * api の名前空間 api（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { publicParams } = require('../rules');

const specs = {
  'api.describe': {
    permission: 'read',
    description: '操作の一覧を返す',
    params: {}
  }
};

function runs(S) {
  const { rowHidden, table } = S;
  return {
    'api.describe': function () {
      const memo = {};
      const methods = Object.keys(table).filter(function (method) { return !rowHidden(table[method], memo); }).map(function (method) {
        const row = table[method];
        return {
          method: method,
          permission: row.permission,
          windowOnly: row.windowOnly === true,
          noApproval: row.noApproval === true,
          owner: row.pluginId || '',
          params: publicParams(row.params),
          description: row.description || ''
        };
      });
      return { ok: true, methods: methods };
    }
  };
}

module.exports = { specs, runs };
