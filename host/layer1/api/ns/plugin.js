'use strict';

/**
 * api の名前空間 plugin（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { ID_RE } = require('../../plugin-surface');
const { templateFiles } = require('../../plugin-scaffold');
const { isMode } = require('../../modes');

const specs = {
  'plugin.inspect': {
    permission: 'write',
    windowOnly: true,
    description: '外から入れるプラグインの下見。zip かフォルダをメインプロセスの選択ダイアログで選ばせ、中身を調べて見せる（入れはしない）。場所は引数で受けない。ウィンドウだけ',
    params: {
      kind: { type: 'string', required: true, max: 8, error: 'bad-kind', typeError: 'bad-kind' }
    }
  },
  'plugin.install': {
    permission: 'write',
    windowOnly: true,
    description: '直前の plugin.inspect で見せたものを入れる（同じ id が外部にあれば更新）。sha256 は inspect の結果と同じものだけ通る。入れたあとも legacy。配信中は断る。ウィンドウだけ',
    params: {
      sha256: { type: 'string', required: true, max: 64, error: 'bad-sha256', typeError: 'bad-sha256' }
    }
  },
  'plugin.restore': {
    permission: 'write',
    windowOnly: true,
    description: '外から入れたプラグインを 1 つ前の版に戻す。配信中・live のあいだは断る。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' }
    }
  },
  'plugin.remove': {
    permission: 'write',
    windowOnly: true,
    description: '外から入れたプラグインを消す（plugins-backup へ移す）。配信中・live のあいだは断る。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' }
    }
  },
  'plugin.list': {
    permission: 'read',
    windowOnly: true,
    description: '外から入れたプラグインと、戻せる版（名前と版だけ）。ウィンドウだけ',
    params: {}
  },
  'plugin.create': {
    permission: 'write',
    windowOnly: true,
    description: '「作る」: 空いている id で、外から入れる形のプラグインのひな形を自分のプラグインの置き場に作る。すでにある id は何も書かずに断る（上書きしない）。作ったあとも legacy。配信中は断る。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' }
    }
  },
  'plugin.openFolder': {
    permission: 'write',
    windowOnly: true,
    description: '作った（入れた）プラグインのフォルダをエクスプローラーで開く。引数は id だけ（場所は受けない・返さない）。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' }
    }
  },
  'plugin.reload': {
    permission: 'write',
    devOnly: true,
    noApproval: true,
    description: 'プラグイン 1 つを止めて読み直す（置いたばかりの外のプラグインも拾う）。答えは result（ok / error / skip）と、失敗なら error.message と error.where（プラグインのフォルダからの相対パス:行）。開発者モードだけ。役目を単品で読み直す。配信中も可能。OBS を操作する自動枠取りだけは画面で承認してから実行する',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' }
    }
  },
  'plugin.logs': {
    permission: 'read',
    description: 'プラグインのログ（古い順。1 つのプラグインにつき最新 200 行まで）。パスは伏せてある。n は 1〜200、既定 50',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' },
      n: { type: 'number', required: false, min: 1, max: 200, integer: true, rangeError: 'bad-n', typeError: 'bad-n' }
    }
  },
  'plugin.status': {
    permission: 'read',
    description: 'プラグイン 1 つの状態（status・reason・mode・source・lastError）。lastError は message と where だけ。秘密・パスは出さない',
    params: {
      id: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' }
    }
  }
};

function runs(S) {
  const { installPublic, installerReady, pluginInspect, pluginInstall, pluginReload, src } = S;
  return {
    'plugin.inspect': async function (params) { return pluginInspect(params); },
    'plugin.install': async function (params) { return pluginInstall(params); },
    'plugin.restore': async function (params) {
      if (!installerReady()) return { ok: false, error: 'unavailable' };
      return installPublic(await src.pluginInstaller.restore(params.id));
    },
    'plugin.remove': async function (params) {
      if (!installerReady()) return { ok: false, error: 'unavailable' };
      const done = await src.pluginInstaller.remove(params.id);
      return done && done.ok === true ? { ok: true, id: done.id, version: done.version } : installPublic(done);
    },
    'plugin.create': async function (params) {
      if (!installerReady() || typeof src.pluginInstaller.scaffold !== 'function') return { ok: false, error: 'unavailable' };
      const done = await src.pluginInstaller.scaffold(params.id, templateFiles(params.id));
      return done && done.ok === true ? { ok: true, id: done.id } : { ok: false, error: done && done.error ? done.error : 'failed' };
    },
    'plugin.openFolder': async function (params) {
      if (!installerReady() || typeof src.openPluginFolder !== 'function') return { ok: false, error: 'unavailable' };
      const listed = src.pluginInstaller.list();
      const known = listed && Array.isArray(listed.installed) && listed.installed.some(function (p) { return p.id === params.id; });
      if (!known) return { ok: false, error: 'not-installed' };
      const done = await src.openPluginFolder(params.id);
      return done && done.ok === true ? { ok: true } : { ok: false, error: 'failed' };
    },
    'plugin.list': async function () {
      if (!installerReady()) return { ok: false, error: 'unavailable' };
      return src.pluginInstaller.list();
    },
    'plugin.reload': async function (params, ctx) { return pluginReload(params.id, ctx); },
    'plugin.logs': async function (params) {
      const reg = src.pluginRegistry;
      if (!reg || typeof reg.logsOf !== 'function') return { ok: false, error: 'unavailable' };
      if (!ID_RE.test(params.id)) return { ok: false, error: 'bad-id' };
      if (typeof reg.snapshot === 'function' && !reg.snapshot().some(function (r) { return r.id === params.id; })) return { ok: false, error: 'unknown-id' };
      return { ok: true, id: params.id, lines: reg.logsOf(params.id, params.n) };
    },
    'plugin.status': async function (params) {
      const reg = src.pluginRegistry;
      if (!reg || typeof reg.snapshot !== 'function') return { ok: false, error: 'unavailable' };
      if (!ID_RE.test(params.id)) return { ok: false, error: 'bad-id' };
      const hit = reg.snapshot().filter(function (r) { return r.id === params.id; })[0];
      if (!hit) return { ok: false, error: 'unknown-id' };
      let mode = 'legacy';
      try { if (src.orchestrator && typeof src.orchestrator.modeFor === 'function') mode = src.orchestrator.modeFor(hit.id); } catch (_) { mode = 'legacy'; }
      return {
        ok: true,
        id: hit.id,
        source: hit.source,
        status: hit.status,
        reason: hit.reason || '',
        mode: isMode(mode) ? mode : 'legacy',
        lastError: hit.lastError || null
      };
    }
  };
}

module.exports = { specs, runs };
