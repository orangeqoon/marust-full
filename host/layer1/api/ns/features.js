'use strict';

/**
 * api の名前空間 features（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'features.set': {
    permission: 'write',
    windowOnly: true,
    description: '「機能」を入れる／切る。id は features.list にあるもの。入れる＝そのプラグインのモードを変える（guide の機能は「使う」の印だけ）。配信中は切れない。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 64, error: 'bad-id', typeError: 'bad-id' },
      enabled: { type: 'boolean', required: true, typeError: 'bad-value' }
    }
  },
  'features.sets': {
    permission: 'read',
    description: '「セット」（まとめて入／切・まとめて入れる。データだけのプラグイン kind: set）の一覧。中の機能のうち入っているもの・足りないもの・オンのもの。読むだけ。値（秘密）は含まない',
    params: {}
  },
  'features.setSet': {
    permission: 'write',
    windowOnly: true,
    description: '「セット」を入れる／切る。中の機能を features.set と同じ道で 1 つずつ入れる／切る（外のサイトへ書く機能は guide のまま。足りない機能は取りに行かない）。配信中は切れない。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 64, error: 'bad-id', typeError: 'bad-id' },
      enabled: { type: 'boolean', required: true, typeError: 'bad-value' }
    }
  },
  'features.list': {
    permission: 'read',
    description: '中級の「機能」一覧（名前・一言・オンか・足りないもの・開く画面）。manifest の feature と核の機能から作る。読むだけ。値（秘密）は含まない',
    params: {}
  }
};

function runs(S) {
  const { collectFeatures, listSets, setFeature, setSet } = S;
  return {
    'features.list': async function () {
      const built = await collectFeatures(false);
      if (!built.ok) return built;
      return { ok: true, features: built.features };
    },
    'features.set': function (params, ctx) { return setFeature(params, ctx); },
    'features.sets': async function () { return listSets(); },
    'features.setSet': async function (params, ctx) { return setSet(params, ctx); }
  };
}

module.exports = { specs, runs };
