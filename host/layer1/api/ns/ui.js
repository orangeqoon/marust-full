'use strict';

/**
 * api の名前空間 ui（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { ID_RE } = require('../../plugin-surface');
const { maxTier, UI_LEVEL_RANK } = require('../../ui-settings');

const { pickShell } = require('../../shell-pick');
const specs = {
  'ui.restart': { permission: 'write', windowOnly: true, noApproval: true, description: '画面が読めないとき本体を立ち上げ直す。ウィンドウだけ', params: {} },
  'ui.getShell': { permission: 'read', description: '画面の本体役と読み込めない理由', params: { excluded: { type: 'string', required: false, max: 400 } } },
  'ui.setShell': { permission: 'write', windowOnly: true, description: '画面の本体役を選ぶ。空ならセットの既定へ戻る', params: { id: { type: 'string', required: true, max: 32 } } },
  'ui.reload': {
    permission: 'write',
    devOnly: true,
    noApproval: true,
    description: '開いている画面を読み直させる。target は all・theme・plugin:<id> のどれか。開発者モードだけ',
    params: {
      target: { type: 'string', required: true, max: 60, emptyError: 'bad-target', typeError: 'bad-target' }
    }
  },
  // ログインの「有無」の材料（K3）。サイトごとの { id, type, oauthName, present } だけ。値は返さない。プラグイン site-login が状態を作るために読む
  // 親の窓が、プラグインの iframe の親の操作を断ったとき、そのプラグインのログに 1 行残す口（K3）。ウィンドウだけ
  'ui.logRefusal': {
    permission: 'write',
    windowOnly: true,
    description: '親の窓がプラグインの親の操作を断ったことを、そのプラグインのログ（plugin.logs）に 1 行残す。ウィンドウだけ',
    params: {
      pluginId: { type: 'string', required: true, max: 40, emptyError: 'bad-id', typeError: 'bad-id' },
      name: { type: 'string', required: true, max: 40, emptyError: 'bad-name', typeError: 'bad-name' }
    }
  },
  'ui.getSettings': {
    permission: 'read',
    description: '画面の設定（試験中のサイトも表示するか・表示の細かさ・初回の案内の進み具合）を返す',
    params: {}
  },
  'ui.setSettings': {
    permission: 'write',
    windowOnly: true,
    description: '画面の設定を保存する（試験中のサイトも表示するか・表示の細かさ・初回の案内の進み具合）。ウィンドウだけ',
    params: {
      showExperimental: { type: 'boolean', required: false, typeError: 'bad-value' },
      uiLevel: { type: 'string', required: false, enum: ['basic', 'standard', 'advanced'], error: 'bad-value', typeError: 'bad-value' },
      setupDone: { type: 'boolean', required: false, typeError: 'bad-value' },
      fanoutAck: { type: 'boolean', required: false, typeError: 'bad-value' },
      setupStep: { type: 'number', required: false, min: 0, max: 20, integer: true, typeError: 'bad-value', rangeError: 'bad-value' },
      setupSkipped: { type: 'string', required: false, max: 400, typeError: 'bad-value', lengthError: 'bad-value' },
      setupSites: { type: 'string', required: false, max: 400, typeError: 'bad-value', lengthError: 'bad-value' }
    }
  },
  'ui.getTheme': {
    permission: 'read',
    description: '画面の見た目（テーマ）。今使っているテーマの色・字の大きさと、選べるテーマの一覧を返す。テーマはデータだけのプラグイン（kind:theme）',
    params: {}
  },
  'ui.setTheme': {
    permission: 'write',
    windowOnly: true,
    description: '画面の見た目（テーマ）を選んで保存する。id を空にすると既定に戻る。ウィンドウだけ',
    params: {
      id: { type: 'string', required: true, max: 32, error: 'bad-value', typeError: 'bad-value', lengthError: 'bad-value' }
    }
  },
  'ui.layouts': {
    permission: 'read',
    description: '並べ方の見本（データだけのプラグイン kind:layout）の一覧。パネルの置き方だけで、動かすものは持たない',
    params: {}
  }
};

function runs(S) {
  const { appliedUiLevel, applyTierNow, catchUpTier, currentUiLevel, listThemes, obsHoldersSafe, packMissing, publishDev, publishModes, readHub, showExperimental, src, storedThemeId, storedUiLevel, themeView, uiSettingsView } = S;
  function shellView(excluded) {
    const settings = src.uiSettings && src.uiSettings.getView ? src.uiSettings.getView() : {};
    const reg = src.pluginRegistry;
    const records = reg && reg.snapshot ? reg.snapshot() : [];
    const rows = typeof src.dataPlugins === 'function' ? src.dataPlugins('shell') : [];
    const result = pickShell(rows, settings.shell, records, excluded);
    result.problems = records.filter(r => r.reason && r.manifest && r.manifest.kind === 'shell').map(r => ({ id: r.id, reason: /^[a-z0-9-]+$/.test(r.reason) ? r.reason : 'unavailable' }));
    return Object.assign({ ok: true }, result);
  }
  return {
    'ui.restart': function () {
      if (typeof src.restartApp !== 'function') return { ok: false, error: 'unavailable' };
      setTimeout(function () { src.restartApp(); }, 300);
      return { ok: true, restarting: true };
    },
    'ui.getShell': function (params) { return shellView((params.excluded || '').split(',').filter(id => ID_RE.test(id))); },
    'ui.setShell': function (params) {
      if (!src.uiSettings || !src.uiSettings.set) return { ok: false, error: 'unavailable' };
      if (params.id && !shellView([]).shells.some(row => row.id === params.id)) return { ok: false, error: 'unknown-shell' };
      const result = src.uiSettings.set({ shell: params.id });
      if (!result || result.ok === false) return result;
      publishDev('ui.shellChanged', {});
      return shellView([]);
    },
    'ui.reload': async function (params) {
      if (!/^(all|theme|plugin:[a-z][a-z0-9-]{0,39})$/.test(params.target)) return { ok: false, error: 'bad-target' };
      publishDev('ui.reloadRequested', { target: params.target });
      return { ok: true, sent: true };
    },
    'ui.logRefusal': function (params) {
      const reg = src.pluginRegistry;
      if (!reg || typeof reg.noteRefused !== 'function') return { ok: false, error: 'unavailable' };
      if (!ID_RE.test(params.pluginId)) return { ok: false, error: 'bad-id' };
      return reg.noteRefused(params.pluginId, params.name);
    },
    'ui.getSettings': async function () {
      const deferred = await catchUpTier(); // 先送りがあって配信が終わっていれば、ここで追いつく
      const got = src.uiSettings ? (typeof src.uiSettings.getView === 'function' ? src.uiSettings.getView() : src.uiSettings.get()) : { showExperimental: false };
      return Object.assign({ ok: true, deferred: deferred }, uiSettingsView(got));
    },
    'ui.getTheme': function () {
      return Object.assign({ ok: true }, themeView(storedThemeId()));
    },
    'ui.setTheme': function (params) {
      if (!src.uiSettings || typeof src.uiSettings.set !== 'function') return { ok: false, error: 'unavailable' };
      const id = params.id;
      if (id !== '' && !listThemes().some((t) => t.id === id)) return { ok: false, error: 'unknown-theme' };
      const wrote = src.uiSettings.set({ theme: id });
      if (!wrote || wrote.ok === false) return wrote || { ok: false, error: 'failed' };
      publishDev('ui.themeChanged', { id: id }, 'ui-theme'); // ほかの窓も見た目を取り直す（値は載せず、各窓が ui.getTheme で読む）
      return Object.assign({ ok: true }, themeView(id));
    },
    'ui.layouts': function () {
      const rows = typeof src.dataPlugins === 'function' ? src.dataPlugins('layout') : [];
      return {
        ok: true,
        layouts: rows.filter((r) => r && r.layout).map((r) => ({ id: r.id, source: r.source, label: r.layout.label, levels: r.layout.levels.slice(), placements: r.layout.placements.map((p) => ({ panel: p.panel, beside: p.beside, direction: p.direction })) }))
      };
    },
    'ui.setSettings': async function (params) {
      if (!src.uiSettings || typeof src.uiSettings.set !== 'function') return { ok: false, error: 'unavailable' };
      const patch = {};
      ['showExperimental', 'uiLevel', 'setupDone', 'fanoutAck', 'setupStep', 'setupSkipped', 'setupSites'].forEach(function (key) {
        if (params[key] !== undefined) patch[key] = params[key];
      });
      // 段階が変わるときは、書いたあとレジストリに反映させる（v3 §5）。配信中・配信中か分からないときも変えられる（V6）。
      // そのときは OBS を握る自動枠取りだけ今のままにして、ほかを入れ替える（枠取りは配信が終わったあと追いつく）。
      // 比べる相手は、レジストリが最後に反映した段階（画面に見えている値ではない。配信中に開発者モードを切った後でも、選び直せる）
      const before = appliedUiLevel();
      const rawBefore = storedUiLevel();
      const currentView = typeof src.uiSettings.getView === 'function' ? src.uiSettings.getView() : {};
      const rawMaxBefore = currentView.uiLevelMax || '';
      const levelChange = patch.uiLevel !== undefined && patch.uiLevel !== before;

      // uiLevelMax: 今までに選んだいちばん高い段階（L7e）。上げたときだけ上げ、下げても下げない
      if (patch.uiLevel !== undefined) {
        const prevEffectiveMax = rawMaxBefore || rawBefore || currentUiLevel();
        patch.uiLevelMax = maxTier(prevEffectiveMax, patch.uiLevel);
      }
      // 「本体だけ」の配り物には中級のプラグインが入っていない（Opus 2026-10-10）。束（packs/standard.json）の中身が揃うまで中級へは変えられない（K5）。
      // 返す pack は案内用（束の名前と足りない id の数。id は上限つき）
      if (patch.uiLevel === 'standard' && src.distribution === 'core') {
        const need = packMissing('standard', await readHub());
        if (need === null) return { ok: false, error: 'not-in-build', pack: 'standard', unreadable: true, missing: 0, missingIds: [] };
        if (need.length) return { ok: false, error: 'not-in-build', pack: 'standard', missing: need.length, missingIds: need.slice(0, 10) };
      }
      const keepObs = levelChange ? !(await obsHoldersSafe()) : false;
      // タイマーの自動送信の予約（K3）: 確認の「はい」で fanoutAck が true になるとき、そのとき live の送り先の id を核が控える。戻すと消す
      if (patch.fanoutAck === true) {
        let ids = [];
        try { ids = (src.orchestrator.summarizeModes({ titleTargets: true }).liveIds || []).filter(function (id) { return /^[a-z0-9-]{1,32}$/.test(id); }); } catch (_) { ids = []; }
        patch.fanoutAckLiveIds = ids.join(',');
      } else if (patch.fanoutAck === false) {
        patch.fanoutAckLiveIds = '';
      }
      const wrote = src.uiSettings.set(patch);
      if (!wrote || wrote.ok === false) return wrote || { ok: false, error: 'failed' };
      let deferred = [];
      if (levelChange) {
        const isUpgrade = patch.uiLevel !== undefined && UI_LEVEL_RANK[patch.uiLevel] > UI_LEVEL_RANK[before];
        if (isUpgrade) {
          const applied = await applyTierNow(keepObs);
          if (!applied.ok) {
            const rollback = { uiLevel: rawBefore };
            if (rawMaxBefore) rollback.uiLevelMax = rawMaxBefore;
            src.uiSettings.set(rollback); // 反映できなかった（ほかの読み直しの最中など）ので、保存されていた値（未保存なら '' ＝消す）に戻す
            return { ok: false, error: applied.error === 'busy' ? 'busy' : 'failed' };
          }
          deferred = applied.deferred;
        } else {
          // 段階を下げたときは applyTier を呼ばなくてよい（読み込むプラグインが変わらないため。L7e）
          if (typeof publishModes === 'function') publishModes('*', '');
        }
      } else {
        deferred = await catchUpTier();
      }
      return Object.assign({ ok: true, deferred: deferred }, uiSettingsView(typeof src.uiSettings.getView === 'function' ? src.uiSettings.getView() : wrote));
    }
  };
}

module.exports = { specs, runs };
