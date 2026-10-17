'use strict';

/**
 * api の名前空間 app（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'app.restart': {
    permission: 'write',
    devOnly: true,
    description: '丸ストを再起動する（host/ を直したとき用）。承認が要る。開発者モードだけ。配信中でも承認すればできる（配信は止まらない。自動枠取りは再起動のあと引き継ぎから戻る）',
    params: {}
  },
  'app.settings.get': {
    permission: 'read',
    description: 'Windows の起動時に marust を開くかを返す',
    params: {}
  },
  'app.settings.set': {
    permission: 'write',
    windowOnly: true,
    description: 'Windows の起動時に marust を開くかを保存する。ウィンドウだけ',
    params: {
      openAtLogin: { type: 'boolean', required: true, typeError: 'open-at-login-type' }
    }
  }
};

function runs(S) {
  const { readHub, src } = S;
  return {
    'app.restart': async function () {
      if (typeof src.restartApp !== 'function') return { ok: false, error: 'unavailable' };
      const live = (await readHub()).liveCount > 0;
      setTimeout(function () { try { src.restartApp(); } catch (_) { /* 再起動できなかった */ } }, 300);
      return live ? { ok: true, restarting: true, whileStreaming: true } : { ok: true, restarting: true };
    },
    'app.settings.get': function () {
      const settings = src.appSettings;
      if (!settings || typeof settings.get !== 'function') return { ok: false, error: 'unavailable' };
      try {
        const row = settings.get();
        return { ok: true, openAtLogin: !!(row && row.openAtLogin === true) };
      } catch (_) {
        return { ok: false, error: 'unavailable' };
      }
    },
    'app.settings.set': function (params) {
      const settings = src.appSettings;
      if (!settings || typeof settings.set !== 'function') return { ok: false, error: 'unavailable' };
      try {
        const row = settings.set(params.openAtLogin === true);
        if (row && row.ok === false) {
          return { ok: false, error: typeof row.error === 'string' && row.error ? row.error : 'failed' };
        }
        return { ok: true, openAtLogin: !!(row && row.openAtLogin === true) };
      } catch (_) {
        return { ok: false, error: 'unavailable' };
      }
    }
  };
}

module.exports = { specs, runs };
