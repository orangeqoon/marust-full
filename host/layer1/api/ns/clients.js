'use strict';

/**
 * api の名前空間 clients（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'clients.list': {
    permission: 'read',
    windowOnly: true,
    description: 'ペアリング済みの端末を返す',
    params: {}
  },
  'clients.revoke': {
    permission: 'write',
    windowOnly: true,
    description: '端末の接続を取り消す',
    params: {
      id: {
        type: 'string',
        required: true,
        max: 80,
        label: 'id',
        nullAsEmpty: true,
        stringify: true,
        falsyEmpty: true,
        emptyError: 'bad-id'
      }
    }
  },
  'clients.beginPairing': {
    permission: 'write',
    windowOnly: true,
    description: 'ペアリングコードを出す',
    params: {
      name: { type: 'string', required: false, max: 40 },
      permissions: { type: 'array', required: false },
      kind: { type: 'string', required: false, max: 16 },
      requiresApproval: { type: 'boolean', required: false }
    }
  }
};

function runs(S) {
  const { src } = S;
  return {
    'clients.list': function () { return src.clients ? { ok: true, clients: src.clients.list() } : { ok: false, error: 'unavailable' }; },
    'clients.revoke': function (params) { return src.clients ? src.clients.revoke(params.id) : { ok: false, error: 'unavailable' }; },
    'clients.beginPairing': function (params) { return src.clients ? src.clients.beginPairing(params) : { ok: false, error: 'unavailable' }; }
  };
}

module.exports = { specs, runs };
