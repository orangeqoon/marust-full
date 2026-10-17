'use strict';

/**
 * api の名前空間 diagnostics（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { createSecretApi } = require('../../../core');
const { collectFacts } = require('../../diagnostics-facts');

const specs = {
  // 診断の材料（K3）。診断の文はプラグイン diagnostics が作る。名前と有無だけの平らな表。値・秘密・絶対パスは返さない
  'diagnostics.facts': {
    permission: 'read',
    description: '診断の材料（稼働時間・窓口・プラグインの状態・エンジン・金庫・ログの容量・状態ファイル・モード設定）を名前と有無だけで返す。値や秘密は含めない',
    params: {}
  },
  // サイトの準備の「事実」だけ（V6。本番切り替えの案内 golive は開発者プラグイン dev-shadow。判定の文面はそちら）。値・一覧は返さない。
  'diagnostics.siteFacts': {
    permission: 'read',
    devOnly: true,
    description: 'サイトの準備の事実だけ返す: 渡した秘密の名前の有無・渡したプラグインのモード・そのサイトの配信先の紐付き。値や一覧は返さない',
    params: {
      site: { type: 'string', required: true, max: 32, error: 'bad-id', typeError: 'bad-id', lengthError: 'bad-id' },
      secretNames: { type: 'array', required: false, max: 16, error: 'bad-names', typeError: 'bad-names', item: { type: 'string', max: 80 } },
      pluginIds: { type: 'array', required: false, max: 16, error: 'bad-ids', typeError: 'bad-ids', item: { type: 'string', max: 64 } }
    }
  }
};

function runs(S) {
  const { destinationRows, diagnosticsInput, engine, listModes, src } = S;
  return {
    'diagnostics.facts': function () {
      return collectFacts(diagnosticsInput());
    },
    'diagnostics.siteFacts': async function (params) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(params.site))) return { ok: false, error: 'bad-id' };
      const site = String(params.site);
      const out = { ok: true, site: site, secrets: null, plugins: null, destinations: [] };
      const names = Array.isArray(params.secretNames) ? params.secretNames.filter(function (n) { return typeof n === 'string'; }) : [];
      if (names.length) {
        try {
          const listed = await createSecretApi(src.secrets).list();
          if (listed && listed.ok === true && Array.isArray(listed.secrets)) {
            const have = new Set();
            listed.secrets.forEach(function (row) { if (row && typeof row.name === 'string') have.add(row.name); });
            out.secrets = {};
            names.forEach(function (n) { out.secrets[n] = have.has(n); });
          }
        } catch (_) { out.secrets = null; }
      }
      const ids = Array.isArray(params.pluginIds) ? params.pluginIds.filter(function (n) { return typeof n === 'string'; }) : [];
      if (ids.length) {
        const modes = await listModes();
        if (modes && modes.ok === true && Array.isArray(modes.plugins)) {
          const byId = new Map();
          modes.plugins.forEach(function (row) { if (row && typeof row.id === 'string') byId.set(row.id, row); });
          out.plugins = {};
          ids.forEach(function (id) {
            const row = byId.get(id);
            out.plugins[id] = !row ? 'missing' : (row.mode === 'legacy' || row.mode === 'shadow' || row.mode === 'live' ? row.mode : 'unknown');
          });
        }
      }
      const rows = destinationRows();
      if (rows) {
        rows.forEach(function (row) {
          if (!row || typeof row !== 'object' || String(row.site == null ? '' : row.site) !== site) return;
          const bound = row.engine && typeof row.engine === 'object' && !Array.isArray(row.engine) ? row.engine : null;
          const engineId = bound && typeof bound.id === 'string' && bound.targetId != null && String(bound.targetId).trim() ? (/^[a-z0-9-]{1,40}$/.test(bound.id) ? bound.id : 'engine') : '';
          out.destinations.push({
            id: String(row.id == null ? '' : row.id),
            enabled: row.enabled === true,
            engineId: engineId
          });
        });
      }
      return out;
    }
  };
}

module.exports = { specs, runs };
