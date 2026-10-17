'use strict';

/**
 * P4b: 外から入れるプラグインの installer（host/core/plugin-install.js）を、丸ストの部品につなぐ。
 *  - isStreaming … 配信中か（配信先が 1 つでも live）
 *  - modeOf … そのプラグインの今のモード（orchestrator.modeFor）
 *  - setLegacy … 既存のモードの書き口（host/core/modes.js の setPluginMode）で legacy を書く。モードのファイルを手で書かない
 *  - rescan … registry.rescanExternal(id)（変えた id だけ読み直す）
 * 画面や API の引数からファイルの場所を受けない。場所は選択ダイアログ（electron-main）が渡す。
 */

const { createPluginInstaller } = require('./plugin-install');
const { setPluginMode, CHANGED_EVENT } = require('./modes');

function createAppInstaller(options) {
  const opts = options || {};
  const core = opts.core;
  if (!core || !core.STATE_DIR) throw new Error('app installer requires core.STATE_DIR');
  ['isStreaming', 'modeOf'].forEach(function (k) {
    if (typeof opts[k] !== 'function') throw new Error('app installer requires ' + k);
  });
  const bus = opts.bus;
  const audit = opts.audit;
  const registry = opts.registry;
  if (!registry || typeof registry.rescanExternal !== 'function') throw new Error('app installer requires registry.rescanExternal');
  const builtinRoots = registry.paths ? (Array.isArray(registry.paths.setDirs) ? registry.paths.setDirs : [registry.paths.builtinRoot, registry.paths.authorRoot, registry.paths.communityRoot]).filter(Boolean) : [];

  return createPluginInstaller({
    stateDir: core.STATE_DIR,
    builtinRoots: builtinRoots,
    reservedIds: function () {
      return registry.snapshot().filter(function (row) { return row.source !== 'user'; }).map(function (row) { return String(row.id); });
    },
    isStreaming: opts.isStreaming,
    modeOf: opts.modeOf,
    setLegacy: function (id) {
      const wrote = setPluginMode(core, id, 'legacy');
      if (wrote && wrote.ok === true && bus && typeof bus.publish === 'function') {
        try { bus.publish(CHANGED_EVENT, { id: id, mode: 'legacy' }, { source: 'modes' }); } catch (_) { /* ファイルは書けている */ }
      }
      return wrote;
    },
    rescan: function (id) { return registry.rescanExternal(id, { wait: true }); },
    audit: function (entry) {
      if (!audit || typeof audit.write !== 'function' || !entry) return;
      const tokens = ['id:' + String(entry.id || ''), 'version:' + String(entry.version || ''), 'sha:' + String(entry.sha || '')];
      try {
        audit.write({ clientId: 'local-window', kind: 'window', method: String(entry.action || 'plugin'), paramNames: tokens, ok: true, error: '' });
      } catch (_) { /* 記録に失敗しても入れた結果は変えない */ }
    }
  });
}

module.exports = { createAppInstaller };
