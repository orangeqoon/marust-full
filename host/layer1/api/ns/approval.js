'use strict';

/**
 * api の名前空間 approval（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'approval.list': {
    permission: 'read',
    description: '承認待ちの一覧を返す',
    params: {}
  },
  'approval.approve': {
    permission: 'write',
    windowOnly: true,
    description: '承認待ちを実行する',
    params: { id: { type: 'string', required: true, max: 80, emptyError: 'bad-id' } }
  },
  'approval.deny': {
    permission: 'write',
    windowOnly: true,
    description: '承認待ちを却下する',
    params: { id: { type: 'string', required: true, max: 80, emptyError: 'bad-id' } }
  }
};

function runs(S) {
  const { approvals, call } = S;
  return {
    'approval.list': function () { return approvals.list(); },
    'approval.approve': function (params) {
      return approvals.approve(params.id, function (item) {
        const next = Object.assign({}, item.ctx, { approved: true });
        return call(item.method, item.params, next);
      });
    },
    'approval.deny': function (params) { return approvals.deny(params.id); }
  };
}

module.exports = { specs, runs };
