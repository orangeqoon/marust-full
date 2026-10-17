'use strict';

/**
 * api の名前空間 modes（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'modes.list': {
    permission: 'read',
    description: 'プラグインごとのモード、出どころ、requires の状態を返す',
    params: {}
  },
  'modes.set': {
    permission: 'write',
    windowOnly: true,
    description: 'プラグインのモードを変える。ウィンドウだけ。live は id の確認が必要',
    params: {
      id: { type: 'string', required: true, max: 32, emptyError: 'bad-id' },
      mode: { type: 'string', required: true, enum: ['legacy', 'shadow', 'live'], error: 'bad-mode' },
      confirmName: { type: 'string', required: false, max: 80 }
    }
  },
  'modes.setMany': {
    permission: 'write',
    windowOnly: true,
    devOnly: true,
    description: '題名送信のサイト（id が site- で始まるもの）のモードを、まとめて shadow か live か legacy にする。開発者用。ウィンドウだけ',
    params: {
      mode: { type: 'string', required: true, enum: ['legacy', 'shadow', 'live'], error: 'bad-mode' },
      ids: { type: 'array', required: false, max: 64, error: 'bad-ids', typeError: 'bad-ids', item: { type: 'string', max: 32 } }
    }
  },
  'modes.setDefault': {
    permission: 'write',
    windowOnly: true,
    description: '既定のモードを変える。作者用モードのプラグインがあるときだけ。ウィンドウだけ。live は不可。無いときは unavailable',
    params: {
      mode: { type: 'string', required: true, enum: ['legacy', 'shadow', 'live'], error: 'bad-mode' }
    }
  }
};

function runs(S) {
  const { listModes, modesReady, readHub, safeToken, setDefault, setMode, visiblePlugins } = S;
  return {
    'modes.list': function () { return listModes(); },
    'modes.set': function (params, ctx) { return setMode(params, ctx); },
    'modes.setMany': async function (params, ctx) {
      if (!modesReady()) return { ok: false, error: 'unavailable' };
      const hub = await readHub();
      const rows = visiblePlugins(hub.plugins);
      const wanted = Array.isArray(params.ids) ? params.ids : null;
      const ids = [];
      for (let i = 0; i < rows.length; i += 1) {
        const id = String(rows[i].id);
        if (wanted ? wanted.indexOf(id) !== -1 : /^site-/.test(id)) ids.push(id);
      }
      const results = [];
      for (let i = 0; i < ids.length; i += 1) {
        // 1 件ずつ、既存の modes.set と同じ検査（requires など）を通す。confirmName は一括では求めない（開発者用）。
        const isExternal = rows.some(function (r) { return String(r.id) === ids[i] && r.source === 'user'; });
        const one = await setMode({ id: ids[i], mode: params.mode, confirmName: isExternal ? '' : ids[i] }, ctx);
        results.push(one && one.ok === true
          ? { id: ids[i], ok: true, mode: params.mode }
          : { id: ids[i], ok: false, error: safeToken(one && one.error) });
      }
      return { ok: true, mode: params.mode, results: results };
    },
    'modes.setDefault': function (params, ctx) { return setDefault(params, ctx); }
  };
}

module.exports = { specs, runs };
