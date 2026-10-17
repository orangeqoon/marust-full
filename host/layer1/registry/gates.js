'use strict';

/**
 * 登録簿の部品: 段階・モード・開発者・サイトの有無による「読み込んでよいか」の判断（計画 X・S8b。host/core/plugin-registry.js から機械的に移した。動きは変えていない）。
 * S は host/core/plugin-registry.js の createRegistry が作る道具箱（共有の状態 st・opts・records など）。他の部品の関数は S.fn から呼ぶ。
 */

const { PLUGIN_MODES, TIER_RANK } = require('./manifest');

function createGates(S) {
  const { records, byId, modeFor, tierFor, devModeFor, recLog, setLastError, st } = S;
  const exclusive = (...args) => S.fn.exclusive(...args);
  const holdsObs = (...args) => S.fn.holdsObs(...args);
  const loadAll = (...args) => S.fn.loadAll(...args);
  const loadOne = (...args) => S.fn.loadOne(...args);
  const teardown = (...args) => S.fn.teardown(...args);

  function modeOfRec(rec) {
    let value = '';
    try {
      value = modeFor ? modeFor(rec.id) : 'legacy';
    } catch (_) {
      value = 'legacy';
    }
    return PLUGIN_MODES.has(value) ? value : 'legacy';
  }

  // そのプラグインの段階（TIER_RANK のキー）。manifest の tier が正本。
  function tierOf(rec) {
    if (rec.source === 'user') return 'advanced';
    const manifest = rec.manifest || {};
    if (typeof manifest.tier === 'string' && Object.prototype.hasOwnProperty.call(TIER_RANK, manifest.tier)) return manifest.tier;
    if (rec.siteId) return 'standard';
    return manifest.feature && manifest.feature.level === 'standard' ? 'standard' : 'advanced';
  }

  // 保存した段階を読み直す（tierFor）。分からないとき・変な値は読まない側（basic）に倒す。
  function readTier() {
    let value = 'advanced';
    try { value = tierFor ? tierFor() : 'advanced'; } catch (_) { value = 'basic'; }
    return Object.prototype.hasOwnProperty.call(TIER_RANK, value) ? value : 'basic';
  }

  // 読み込みの判断に使う段階は、最後に反映した（loadAll / applyTier の時点の）もの。毎回ファイルを読まず、保存だけ先に変わっても食い違わない。
  function currentTier() {
    if (st.appliedTier == null) st.appliedTier = readTier();
    return st.appliedTier;
  }

  // rec.tierAt: 段階を変えたとき OBS を握るもの（自動枠取り）を動かさず先送りした印。そのものが最後に合わせた段階を覚える（追いつくと消える）。
  function readDev() {
    try { return devModeFor ? devModeFor() === true : false; } catch (_) { return false; }
  }

  function currentDev() {
    if (st.appliedDev == null) st.appliedDev = readDev();
    return st.appliedDev;
  }

  // 開発者プラグイン（audience: dev。配るものの外へ移した作者・開発者の機能）は、段階とは別。開発者モードがオンのときだけ読む。
  function devGated(rec) {
    return !!devModeFor && rec.source !== 'user' && !!rec.manifest && rec.manifest.audience === 'dev';
  }

  // 機能の needs に site:<id> と書いたプラグインは、そのサイトのプラグインが入っているときだけ読み込む（計画 X・S5b。入っていなければ「○○が入っていないので使えません」と出す）
  function siteNeedsMissing(rec) {
    const feature = rec.manifest && rec.manifest.feature;
    const needs = feature && Array.isArray(feature.needs) ? feature.needs : [];
    return needs.filter((n) => /^site:/.test(n)).map((n) => n.slice(5)).filter((siteId) => !records.some((r) => byId.get(r.id) === r && r.siteId === siteId && r.status !== 'skip'));
  }

  function tierAllows(rec, now) {
    if (devGated(rec)) return currentDev();
    if (TIER_RANK[tierOf(rec)] > TIER_RANK[now || rec.tierAt || currentTier()]) return false;
    return siteNeedsMissing(rec).length === 0;
  }

  // 今の段階では読み込まない（印のプラグインを切った扱いにするために、api・画面が見る）
  function tierBlocked(id) {
    const rec = byId.get(id);
    return !!rec && !tierAllows(rec);
  }


  // 段階を変えたあとの反映（v3 §5）。上の段階のものは止め（設定と鍵は消さない）、読めるようになったものは読む。
  // 呼ぶ側が先に tierFor の答え（保存した段階）を変えておく。配信中は呼ぶ側が断る。
  // options.keepObs: true のとき、OBS の開始・停止を握るもの（自動枠取り）は動かさない（今の状態のまま。配信中か分からないときの段階の変更）。
  // 先送りしたものは deferred に入れ、次の applyTier（keepObs なし）か読み直し・起動で追いつく。
  async function applyTier(options) {
    const keepObs = !!(options && options.keepObs);
    return exclusive({ ok: false, error: 'busy' }, async () => {
      if (!st.loaded) await loadAll();
      const prev = currentTier();
      const now = readTier();
      st.appliedTier = now;
      st.appliedDev = readDev();
      const stopped = [];
      const started = [];
      const deferred = [];
      for (const rec of records) {
        if (byId.get(rec.id) !== rec) continue;
        if (keepObs && holdsObs(rec.id)) {
          if (!rec.tierAt) rec.tierAt = prev;
          if (tierAllows(rec, rec.tierAt) !== tierAllows(rec, now)) deferred.push(rec.id);
          else delete rec.tierAt;
          continue;
        }
        delete rec.tierAt;
        const allowed = tierAllows(rec, now);
        if (!allowed && (rec.status === 'running' || rec.instance)) {
          try { await teardown(rec); } catch (_) { /* 止め損ねても、読み込まない印は付ける */ }
          rec.status = 'accepted';
          rec.reason = 'tier-not-loaded';
          rec.instance = null;
          rec.ctx = null;
          stopped.push(rec.id);
        } else if (!allowed && rec.status === 'accepted') {
          rec.reason = 'tier-not-loaded';
        } else if (allowed && rec.status === 'accepted' && rec.reason === 'tier-not-loaded') {
          rec.reason = null;
          try {
            await loadOne(rec);
          } catch (err) {
            rec.status = 'load-failed';
            rec.reason = 'load-failed';
            setLastError(rec, err);
            recLog(rec, 'error', 'load-failed');
          }
          started.push(rec.id);
        }
      }
      return { ok: true, tier: now, stopped, started, deferred };
    });
  }

  // 段階の反映を先送りしているもの（自動枠取り）の id
  function pendingTier() {
    const now = currentTier();
    return records.filter((rec) => byId.get(rec.id) === rec && rec.tierAt && tierAllows(rec, rec.tierAt) !== tierAllows(rec, now)).map((rec) => rec.id);
  }

  return {
    modeOfRec,
    tierOf,
    readTier,
    currentTier,
    readDev,
    siteNeedsMissing,
    tierAllows,
    tierBlocked,
    applyTier,
    pendingTier
  };
}

module.exports = { createGates };
