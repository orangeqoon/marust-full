'use strict';

/**
 * api の名前空間 vault（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'vault.health': {
    permission: 'read',
    description: '金庫の秘密を復号できる件数だけ返す（値は返さない）',
    params: {}
  }
};

function runs(S) {
  const { src } = S;
  return {
    'vault.health': function () {
      if (!src.secrets || typeof src.secrets.health !== 'function') return { ok: false, error: 'unavailable' };
      return src.secrets.health().catch(function () { return { ok: false, error: 'unavailable' }; });
    }
  };
}

module.exports = { specs, runs };
