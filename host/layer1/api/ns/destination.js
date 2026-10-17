'use strict';

/**
 * api の名前空間 destination（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { idRule } = require('../rules');

const specs = {
  'destination.list': {
    permission: 'read',
    description: '配信先の一覧を返す',
    params: {}
  },
  'destination.start': {
    permission: 'write',
    description: '配信先を開始する',
    params: { id: idRule }
  },
  'destination.stop': {
    permission: 'write',
    description: '配信先を停止する',
    params: { id: idRule }
  },
  'destination.setMain': {
    permission: 'write',
    description: 'OBS のメイン出力を配信先の 1 つ（obs-main）として使うかを決め、使うサイトを選ぶ。使うときは配信開始でメイン出力も出す。送信中は変えられない',
    params: {
      use: { type: 'boolean', required: true, label: 'use' },
      site: { type: 'string', required: false, max: 40, label: 'site', stringify: true }
    }
  },
  'destination.setKey': {
    permission: 'write',
    description: '配信先に配信キーを入れる',
    params: {
      id: idRule,
      key: { type: 'string', required: true, max: 300, trimEmpty: true, emptyError: 'key-empty' },
      server: { type: 'string', required: false, max: 300, trimEmpty: true, emptyError: 'server-empty' }
    }
  }
};

const MAIN_DESTINATION_ID = 'obs-main';
const MAIN_TARGET_ID = 'main';
const SENDING = new Set(['live', 'reconnecting', 'connecting']);

function runs(S) {
  const { destinationControl, destinationRows, publicDestination, src, engine, registry } = S;

  // メイン出力が送信中か（エンジンの一覧の main の state、無ければ配信先の行の engineState）
  function mainSending(row) {
    try {
      const impl = engine();
      if (impl && typeof impl.listTargets === 'function') {
        const found = impl.listTargets().find(function (item) { return item && String(item.id) === MAIN_TARGET_ID; });
        if (found) return SENDING.has(String(found.state));
      }
    } catch (_) { /* fall through to the row */ }
    const actual = row && row.actual && typeof row.actual === 'object' ? row.actual : {};
    return SENDING.has(String(actual.engineState || ''));
  }

  function setMain(params) {
    const rows = destinationRows();
    const store = src && src.store;
    if (!rows || !store || typeof store.putDestination !== 'function') return { ok: false, error: 'unavailable' };
    const row = rows.find(function (item) { return item && item.id === MAIN_DESTINATION_ID; }) || null;
    if (params.use !== true && !row) return { ok: true, destination: { id: MAIN_DESTINATION_ID, site: '', enabled: false } };
    if (mainSending(row)) return { ok: false, error: 'streaming' };
    const site = params.site != null ? String(params.site) : (row && row.site != null ? String(row.site) : '');
    if (params.use === true) {
      // エンジンの結び（どのエンジンかはエンジンが知っている）。まだ無効のまま作り、下で有効にする
      const impl = engine();
      if (!impl || typeof impl.linkDestination !== 'function') return { ok: false, error: 'no-engine' };
      const linked = impl.linkDestination({ destinationId: MAIN_DESTINATION_ID, targetId: MAIN_TARGET_ID, site: site, accountId: MAIN_DESTINATION_ID });
      if (!linked || linked.ok === false) return { ok: false, error: (linked && (linked.error || linked.reason)) || 'failed' };
    }
    const input = { id: MAIN_DESTINATION_ID, enabled: params.use === true };
    if (params.use !== true && params.site != null) input.site = site;
    const saved = store.putDestination(input);
    if (!saved || saved.ok === false) return { ok: false, error: (saved && saved.reason) || 'failed' };
    const dest = saved.destination || {};
    return { ok: true, destination: { id: MAIN_DESTINATION_ID, site: dest.site == null ? '' : String(dest.site), enabled: dest.enabled === true } };
  }

  function setKey(params) {
    const rows = destinationRows();
    if (!rows) return { ok: false, error: 'unavailable' };
    const row = rows.find(function (item) { return item && item.id === params.id; });
    if (!row) return { ok: false, error: 'unknown-destination' };
    if (row.id === MAIN_DESTINATION_ID || row.id === 'obs-main') return { ok: false, error: 'main-output' };
    const bound = row.engine && typeof row.engine === 'object' ? row.engine : null;
    const engineId = bound && bound.id ? String(bound.id) : '';
    const targetId = bound && bound.targetId != null ? String(bound.targetId) : '';
    if (!engineId || !targetId) return { ok: false, error: 'no-engine' };
    const impl = registry && typeof registry.get === 'function' ? registry.get(engineId) : null;
    if (!impl || typeof impl.setKey !== 'function') return { ok: false, error: 'no-engine' };

    const actual = row.actual && typeof row.actual === 'object' ? row.actual : {};
    if (SENDING.has(String(actual.engineState || ''))) {
      return { ok: false, error: 'streaming' };
    }
    if (typeof impl.listTargets === 'function') {
      try {
        const targets = impl.listTargets();
        if (Array.isArray(targets)) {
          const found = targets.find(function (t) { return t && String(t.id) === targetId; });
          if (found && SENDING.has(String(found.state || ''))) {
            return { ok: false, error: 'streaming' };
          }
        }
      } catch (_) {}
    }

    const settings = { key: String(params.key).trim() };
    if (params.server != null) settings.server = String(params.server).trim();
    const res = impl.setKey(targetId, settings, { restartIfActive: false });
    if (res && res.ok === true) return { ok: true };
    const err = (res && typeof res === 'object' && (res.error || res.reason)) || 'failed';
    return { ok: false, error: err };
  }

  return {
    'destination.list': function () {
      const rows = destinationRows();
      if (!rows) return { ok: false, error: 'unavailable' };
      return { ok: true, destinations: rows.map(publicDestination) };
    },
    'destination.start': function (params) { return destinationControl(params, 'start'); },
    'destination.stop': function (params) { return destinationControl(params, 'stop'); },
    'destination.setMain': function (params) { return setMain(params); },
    'destination.setKey': function (params) { return setKey(params); }
  };
}

module.exports = { specs, runs };
