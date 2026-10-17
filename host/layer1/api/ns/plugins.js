'use strict';

/**
 * api の名前空間 plugins（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'plugins.list': {
    permission: 'read',
    windowOnly: true,
    description: '上級の「プラグインの管理」の一覧。id・版・出どころ・状態・モード・使う力（名前だけ。値は含めない）・隠せるか',
    params: {}
  },
  'plugins.reloadAll': {
    permission: 'write',
    devOnly: true,
    noApproval: true,
    description: '読み直せるプラグインを全部読み直す。開発者モードだけ。配信中は、OBS を握る自動枠取りのプラグインだけ飛ばす（skip / streaming-slot）',
    params: {}
  },
  'plugins.browse': {
    permission: 'write',
    windowOnly: true,
    description: '「機能をもっと探す」。配布ページ（GitHub）を使っているブラウザで開く。URL は引数で受けない。ウィンドウだけ',
    params: {}
  },
  'plugins.disable': {
    permission: 'write',
    windowOnly: true,
    description: '管理画面から、プラグインを無効（legacy）にする。配信中は断る。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' }
    }
  },
  'plugins.setHidden': {
    permission: 'write',
    windowOnly: true,
    description: '内蔵プラグインを隠す／戻す。隠す＝legacy にして一覧から外す（exe からは消さない）。配信中・配信先のあるサイトは隠せない。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' },
      hidden: { type: 'boolean', required: true, typeError: 'bad-value' }
    }
  }
};

function runs(S) {
  const { holdsObsId, listPlugins, publishDev, readHub, reloadRow, setHidden, setMode, src } = S;
  return {
    'plugins.reloadAll': async function () {
      const reg = src.pluginRegistry;
      if (!reg || typeof reg.reloadAll !== 'function') return { ok: false, error: 'unavailable' };
      const hub = await readHub();
      const live = !hub.known || hub.liveCount > 0;
      const rows = await reg.reloadAll(live ? { skip: function (id) { return holdsObsId(reg, id); } } : undefined);
      if (rows.length === 1 && rows[0].message === 'busy') return { ok: false, error: 'busy' };
      publishDev('plugin.reloaded', { id: '*', result: rows.every(function (row) { return row.result !== 'error'; }) ? 'ok' : 'error' });
      return { ok: true, results: rows.map(reloadRow) };
    },
    'plugins.browse': async function () {
      if (typeof src.openPluginBrowse !== 'function') return { ok: false, error: 'unavailable' };
      const done = await src.openPluginBrowse();
      return done && done.ok === true ? { ok: true } : { ok: false, error: done && done.error ? done.error : 'failed' };
    },
    'plugins.list': async function () { return listPlugins(); },
    'plugins.setHidden': async function (params, ctx) { return setHidden(params, ctx); },
    'plugins.disable': async function (params, ctx) {
      const hub = await readHub();
      if (hub.liveCount > 0) return { ok: false, error: 'streaming' };
      return setMode({ id: params.id, mode: 'legacy' }, ctx, 'plugins.disable');
    }
  };
}

module.exports = { specs, runs };
