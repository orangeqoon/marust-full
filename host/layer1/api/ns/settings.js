'use strict';

/**
 * api の名前空間 settings（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const fs = require('fs');
const path = require('path');

const specs = {
  'settings.export': {
    featurePlugin: 'backup',
    permission: 'read',
    windowOnly: true,
    description: '設定を JSON で返す。配信先の紐付けを含むためウィンドウだけ',
    params: {}
  },
  'settings.exportToFile': {
    featurePlugin: 'backup',
    permission: 'write',
    windowOnly: true,
    description: '設定を STATE_DIR/exports に JSON で保存し、ファイル名だけ返す。ウィンドウだけ',
    params: {}
  },
  'settings.preview': {
    featurePlugin: 'backup',
    permission: 'read',
    windowOnly: true,
    description: '書き出した設定の項目名と件数だけを返す。ウィンドウだけ',
    params: {
      document: { type: 'object', required: true, error: 'bad-document' }
    }
  },
  'settings.import': {
    featurePlugin: 'backup',
    permission: 'write',
    windowOnly: true,
    description: '選んだ項目だけ設定を反映する。反映前に控えを残す。ウィンドウだけ',
    params: {
      document: { type: 'object', required: true, error: 'bad-document' },
      sections: {
        type: 'array',
        required: true,
        min: 1,
        max: 6,
        error: 'no-sections',
        typeError: 'no-sections',
        item: { type: 'string', max: 40, error: 'no-sections' }
      }
    }
  }
};

function runs(S) {
  const { settingsTool, src } = S;
  return {
    'settings.export': function () {
      if (!src.core || !src.core.STATE_DIR) return { ok: false, error: 'unavailable' };
      const tool = settingsTool();
      const document = tool.exportAll();
      if (!document) return { ok: false, error: 'unavailable' };
      return { ok: true, filename: tool.filename(), document: document };
    },
    'settings.exportToFile': function () {
      if (!src.core || !src.core.STATE_DIR) return { ok: false, error: 'unavailable' };
      const tool = settingsTool();
      const document = tool.exportAll();
      if (!document) return { ok: false, error: 'unavailable' };
      try {
        const dir = path.join(src.core.STATE_DIR, 'exports');
        fs.mkdirSync(dir, { recursive: true });
        const name = tool.filename();
        fs.writeFileSync(path.join(dir, name), JSON.stringify(document, null, 2) + '\n', 'utf8');
        return { ok: true, filename: name, dir: dir };
      } catch (_) {
        return { ok: false, error: 'write-failed' };
      }
    },
    'settings.preview': function (params) {
      if (!src.core || !src.core.STATE_DIR) return { ok: false, error: 'unavailable' };
      return settingsTool().preview(params.document);
    },
    'settings.import': function (params) {
      if (!src.core || !src.core.STATE_DIR) return { ok: false, error: 'unavailable' };
      return settingsTool().importSelected(params.document, params.sections);
    }
  };
}

module.exports = { specs, runs };
