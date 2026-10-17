'use strict';

/**
 * api の名前空間 devmode（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'devmode.get': {
    permission: 'read',
    description: '開発者モードがオンかを返す',
    params: {}
  },
  'devmode.set': {
    permission: 'write',
    windowOnly: true,
    description: '開発者モードのオン・オフを設定ファイルに保存する。環境変数 MARUST_DEV で固定されているときは env-locked。ウィンドウだけ',
    params: {
      value: { type: 'boolean', required: true, typeError: 'bad-value', error: 'bad-value' }
    }
  }
};

function runs(S) {
  const { appliedUiLevel, applyTierNow, currentUiLevel, devModeOn, obsHoldersSafe, src } = S;
  return {
    'devmode.get': function () {
      const dm = src.devMode && typeof src.devMode.get === 'function' ? src.devMode.get() : { devMode: true, source: 'default' };
      return { ok: true, devMode: dm.devMode === true, source: dm.source, locked: dm.source === 'env' };
    },
    'devmode.set': async function (params) {
      if (!src.devMode || typeof src.devMode.set !== 'function') return { ok: false, error: 'unavailable' };
      // 段階を保存していないとき、段階は開発者モードで決まる（上級／初級）。開発者プラグイン（audience: dev）も開発者モードの切り替えで読む／止める。
      // 変わるならプラグインの読み込みを合わせる（配信中でも。自動枠取りだけ今のまま。deferred で返す）。合わせられなければ元に戻して busy。
      const before = appliedUiLevel();
      const devBefore = devModeOn();
      const out = src.devMode.set(params.value);
      if (out && out.ok !== false && (currentUiLevel() !== before || devModeOn() !== devBefore)) {
        const applied = await applyTierNow(!(await obsHoldersSafe()));
        if (!applied.ok) {
          src.devMode.set(devBefore);
          return { ok: false, error: applied.error === 'busy' ? 'busy' : 'failed' };
        }
        return Object.assign({}, out, { deferred: applied.deferred });
      }
      return out;
    }
  };
}

module.exports = { specs, runs };
