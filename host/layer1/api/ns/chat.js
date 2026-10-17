'use strict';

/**
 * api の名前空間 chat（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { CHAT_WRITE } = require('../rules');

const specs = {
  'chat.recent': {
    permission: 'read',
    description: '直近のコメントを新しい順に返す。limit を省くと 50 件、最大 200 件',
    params: {
      limit: { type: 'number', required: false, min: 1, max: 200, integer: true }
    }
  },
  'chat.publish': {
    permission: CHAT_WRITE,
    noApproval: true,
    description: 'コメントを 1〜50 件入れる。承認待ちにはせず、記録だけ残す',
    params: {
      messages: { type: 'array', required: true, min: 1, max: 50 },
      source: { type: 'string', required: false, max: 40 }
    }
  },
  'chat.inlets': {
    permission: 'read',
    description: 'サイトごとのコメントの入り口（丸ストが直接受け取っているプラグイン id）と、ほかの入り口から来て取り込まなかった件数',
    params: {}
  }
};

function runs(S) {
  const { src } = S;
  return {
    'chat.recent': function (params) {
      if (!src.chat || typeof src.chat.recent !== 'function') return { ok: false, error: 'unavailable' };
      return src.chat.recent(params.limit);
    },
    'chat.publish': function (params) {
      if (!src.chat || typeof src.chat.publish !== 'function') return { ok: false, error: 'unavailable' };
      const info = {};
      if (Object.prototype.hasOwnProperty.call(params, 'source')) info.source = params.source;
      return src.chat.publish(params.messages, info);
    },
    'chat.inlets': function () {
      if (!src.chat || typeof src.chat.inlets !== 'function') return { ok: false, error: 'unavailable' };
      return { ok: true, inlets: src.chat.inlets() };
    }
  };
}

module.exports = { specs, runs };
