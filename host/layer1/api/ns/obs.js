'use strict';

/**
 * api の名前空間 obs（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const { tailOf } = require('../../../core');

const specs = {
  'obs.getConnection': {
    permission: 'read',
    windowOnly: true,
    description: 'OBS の接続先（host・port）とパスワードがあるかどうかを返す。パスワードの値は返さない',
    params: {}
  },
  'obs.setConnection': {
    permission: 'write',
    windowOnly: true,
    description: 'OBS の接続先を金庫に保存し、つなぎ直す。password を省くと今のまま。値は返さない',
    params: {
      host: { type: 'string', required: false, max: 253, typeError: 'bad-host', lengthError: 'bad-host' },
      port: { type: 'number', required: false, min: 1, max: 65535, integer: true, rangeError: 'bad-port', typeError: 'bad-port' },
      password: { type: 'string', required: false, max: 256, lengthError: 'bad-password', typeError: 'bad-password' }
    }
  },
  'obs.testConnection': {
    permission: 'write',
    windowOnly: true,
    description: 'OBS につないでみて、結果と改造プラグインの有無だけ返す（配信は操作しない）。値は返さない',
    params: {
      host: { type: 'string', required: false, max: 253, typeError: 'bad-host', lengthError: 'bad-host' },
      port: { type: 'number', required: false, min: 1, max: 65535, integer: true, rangeError: 'bad-port', typeError: 'bad-port' },
      password: { type: 'string', required: false, max: 256, lengthError: 'bad-password', typeError: 'bad-password' }
    }
  },
  'obs.importConfig': {
    permission: 'write',
    windowOnly: true,
    description: 'OBS 自身の obs-websocket 設定（config.json）を読んで、接続先とパスワードを金庫に保存しつなぎ直す。押されたときだけ。config.json は書き換えない。値は返さない（パスワードはあるかどうかだけ）',
    params: {}
  },
  'obs.pluginInfo': {
    permission: 'read',
    windowOnly: true,
    description: 'OBS に入れる丸スト用プラグインの状態（同梱の有無・入れる場所・missing／same／different・古い場所にもあるか・OBS が動いているか）を返す。読むだけ',
    params: {}
  },
  'obs.installPlugin': {
    permission: 'write',
    windowOnly: true,
    description: '同梱の丸スト用プラグインを OBS の場所（ProgramData の obs-studio\plugins）へ写す。OBS が動いていれば入れない。別の版があるときは overwrite:true が要る。書けなければ管理者の確認を 1 回出す。ウィンドウだけ',
    params: {
      overwrite: { type: 'boolean', required: false, typeError: 'bad-value' }
    }
  },
  'obs.setControl': {
    permission: 'write',
    windowOnly: true,
    description: '丸ストから OBS の配信開始・停止を操作できるようにするか（obs-engine と broadcast を live／legacy）。サイトの「送る」とは別。ウィンドウだけ',
    params: {
      enabled: { type: 'boolean', required: true, typeError: 'bad-value' }
    }
  }
};

function runs(S) {
  const { obsControlOn, setObsControl, src } = S;
  return {
    'obs.getConnection': function () {
      if (!src.obsSetup) return { ok: false, error: 'unavailable' };
      return Promise.resolve(src.obsSetup.getConnection()).then(async function (res) {
        if (!res || res.ok !== true) return res;
        let passwordTail = '';
        if (res.hasPassword) {
          try {
            const stored = typeof src.obsSetup.readStored === 'function' ? await src.obsSetup.readStored() : null;
            if (stored && typeof stored.password === 'string' && stored.password.length > 0) {
              passwordTail = tailOf(stored.password);
            } else {
              passwordTail = '••••';
            }
          } catch (_) {
            passwordTail = '••••';
          }
        }
        return Object.assign({}, res, {
          control: obsControlOn(),
          passwordTail: passwordTail
        });
      });
    },
    'obs.setConnection': function (params) {
      if (!src.obsSetup) return { ok: false, error: 'unavailable' };
      return src.obsSetup.setConnection(params);
    },
    'obs.testConnection': function (params) {
      if (!src.obsSetup) return { ok: false, error: 'unavailable' };
      return src.obsSetup.testConnection(params);
    },
    'obs.importConfig': function () {
      if (!src.obsSetup || typeof src.obsSetup.importFromObs !== 'function') return { ok: false, error: 'unavailable' };
      return src.obsSetup.importFromObs();
    },
    'obs.pluginInfo': async function () {
      if (!src.pluginInstaller) return { ok: false, error: 'unavailable' };
      const info = await src.pluginInstaller.info();
      // OBS が動いていてつながるときだけ、vendor API の版（checkPlugin の結果）も添える
      if (info && info.obsRunning && src.obsSetup && typeof src.obsSetup.testConnection === 'function') {
        try {
          const res = await src.obsSetup.testConnection({});
          if (res && res.ok === true && res.plugin) info.vendor = res.plugin;
        } catch (_) { /* 添えないだけ */ }
      }
      return info;
    },
    'obs.installPlugin': function (params) {
      if (!src.pluginInstaller) return { ok: false, error: 'unavailable' };
      return src.pluginInstaller.install(params);
    },
    'obs.setControl': function (params, ctx) { return setObsControl(params, ctx); }
  };
}

module.exports = { specs, runs };
