'use strict';

/**
 * api の名前空間 migration（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { MAX_BUNDLE } = require('../../migration-bundle');

const specs = {
  'migration.export': {
    permission: 'write',
    windowOnly: true,
    description: '設定と金庫の秘密を、合言葉で暗号化した 1 ファイルに書き出す。値は返さない。ウィンドウだけ',
    params: {
      passphrase: { type: 'string', required: true, max: 200, error: 'bad-passphrase', typeError: 'bad-passphrase' }
    }
  },
  'migration.import': {
    permission: 'write',
    windowOnly: true,
    description: '引っ越しファイルを合言葉で開き、設定（モード以外）と金庫の秘密を取り込む。配信中は拒否。値は返さない。ウィンドウだけ',
    params: {
      passphrase: { type: 'string', required: true, max: 200, error: 'bad-passphrase', typeError: 'bad-passphrase' },
      bundle: { type: 'string', required: true, max: MAX_BUNDLE, error: 'bad-bundle', typeError: 'bad-bundle' }
    }
  }
};

function runs(S) {
  const { migrationTool } = S;
  return {
    'migration.export': function (params) {
      return migrationTool().exportBundle({ passphrase: params.passphrase });
    },
    'migration.import': function (params) {
      return migrationTool().importBundle({ passphrase: params.passphrase, bundle: params.bundle });
    }
  };
}

module.exports = { specs, runs };
