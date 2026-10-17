'use strict';

/**
 * api の名前空間 engine（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */

const { destinationIdRule, idRule } = require('../rules');

const specs = {
  'engine.status': {
    permission: 'read',
    description: '配信エンジンの接続状態を返す',
    params: {}
  },
  'engine.listTargets': {
    permission: 'read',
    description: 'エンジン上のターゲット一覧を返す',
    params: {}
  },
  'engine.start': {
    permission: 'write',
    description: 'エンジンのターゲットを開始する',
    params: { id: idRule }
  },
  'engine.stop': {
    permission: 'write',
    description: 'エンジンのターゲットを停止する',
    params: { id: idRule }
  },
  'engine.setEnabled': {
    permission: 'write',
    description: 'エンジンのターゲットの有効・無効を切り替える',
    params: {
      id: idRule,
      enabled: { type: 'boolean', required: true }
    }
  },
  'engine.setKey': {
    permission: 'write',
    description: '配信キーを入れる（restartIfActive は受け付けるが常に false で呼ぶ）',
    params: {
      id: idRule,
      key: { type: 'string', required: true, max: 300, trimEmpty: true, emptyError: 'key-empty' },
      server: { type: 'string', required: false, max: 300, trimEmpty: true, emptyError: 'server-empty' },
      restartIfActive: { type: 'boolean', required: false, typeError: 'restart-type' }
    }
  },
  'engine.create': {
    permission: 'write',
    description: 'エンジンにターゲットを作る',
    params: {
      protocol: { type: 'string', required: true, enum: ['RTMP', 'SRT_RIST', 'WHIP'], error: 'protocol' },
      name: { type: 'string', required: true, max: 100, nullAsEmpty: true },
      server: { type: 'string', required: true, max: 300, nullAsEmpty: true },
      key: { type: 'string', required: true, max: 300, nullAsEmpty: true }
    }
  },
  'engine.remove': {
    permission: 'write',
    description: 'エンジンのターゲットを削除する',
    params: { id: idRule }
  },
  'engine.link': {
    permission: 'write',
    description: '配信先とエンジンのターゲットを結ぶ',
    params: {
      destinationId: destinationIdRule,
      targetId: { type: 'string', required: true, max: 80, label: 'target', nullAsEmpty: true, emptyError: 'bad-id' },
      site: { type: 'string', required: false, max: 40, label: 'site', stringify: true },
      accountId: { type: 'string', required: false, max: 80, label: 'account', stringify: true }
    }
  },
  'engine.unlink': {
    permission: 'write',
    description: '配信先とエンジンのターゲットの結びを外す',
    params: { destinationId: destinationIdRule }
  },
  'engine.emergencyStop': {
    permission: 'emergency',
    description: 'すべての配信を止める',
    params: {}
  },
  'engine.targetStats': {
    permission: 'read',
    description: '動いている配信先の通信状況（fps・kbps・経過）を返す。読むだけ',
    params: {}
  },
  'engine.targetRates': {
    permission: 'read',
    description: '使う予定の配信先ごとのビットレート（kbps）を返す。配信中は OBS の実測、そうでなければ OBS の設定の値。読めなければ null。キー・URL は返さない。読むだけ',
    params: {}
  }
};

function runs(S) {
  const { engine, registry, src } = S;
  return {
    'engine.status': function () { return engine().status(); },
    'engine.listTargets': function () { return engine().listTargets(); },
    'engine.start': function (params) { return engine().start(params.id); },
    'engine.stop': function (params) { return engine().stop(params.id); },
    'engine.setEnabled': function (params) { return engine().setEnabled(params.id, params.enabled); },
    'engine.setKey': function (params) {
      // L8g: プラグインにも開けたので、送信中（接続中・再接続中を含む）の配信先のキーは書き換えない。メイン出力は核が main-output で断る
      const cur = engine();
      const rows = cur && typeof cur.listTargets === 'function' ? cur.listTargets() : null;
      const row = Array.isArray(rows) ? rows.find((r) => r && String(r.id) === String(params.id)) : null;
      if (row && !row.main && (row.state === 'live' || row.state === 'connecting' || row.state === 'reconnecting')) {
        return { ok: false, error: 'streaming' };
      }
      const settings = { key: String(params.key).trim() };
      if (params.server != null) settings.server = String(params.server).trim();
      return engine().setKey(params.id, settings, { restartIfActive: false });
    },
    'engine.create': function (params) { return engine().create(params); },
    'engine.remove': function (params) { return engine().remove(params.id); },
    'engine.link': function (params) { return engine().linkDestination(params); },
    'engine.unlink': function (params) { return engine().unlinkDestination(params.destinationId); },
    'engine.emergencyStop': function (params) {
      if (src && src.broadcast && typeof src.broadcast.stopAll === 'function') {
        return src.broadcast.stopAll({});
      }
      if (registry && typeof registry.emergencyStop === 'function') return registry.emergencyStop(params || {});
      const current = engine();
      if (!current || typeof current.stopAll !== 'function') return { ok: false, error: 'no-engine' };
      return current.stopAll(params || {});
    },
    'engine.targetStats': async function () {
      try {
        const eng = engine();
        if (!eng || typeof eng.readTargetStats !== 'function') return { ok: false, error: 'unavailable' };
        return { ok: true, targets: await eng.readTargetStats() };
      } catch (_) {
        return { ok: false, error: 'not-connected' };
      }
    },
    'engine.targetRates': async function () {
      try {
        const eng = engine();
        if (!eng || typeof eng.readTargetRates !== 'function') return { ok: false, error: 'unavailable' };
        const rows = await eng.readTargetRates();
        return { ok: true, targets: rows.map(function (r) { return { id: r.id, name: r.name, enabled: r.enabled, kbps: r.kbps, source: r.source }; }) };
      } catch (_) {
        return { ok: false, error: 'not-connected' };
      }
    }
  };
}

module.exports = { specs, runs };
