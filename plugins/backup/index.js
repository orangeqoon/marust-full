'use strict';

/**
 * バックアップ（V4）。中身の無い「入／切の印」のプラグイン。
 * 設定を集める・反映するのは本体（host/core/settings-export.js。引っ越しと共有）が持つ。
 * 本体は、このプラグインが legacy（切）のあいだ、settings.export / exportToFile / preview / import を無いものとして扱う。
 * 引っ越し（migration.*）は本体の機能で、切れない。
 */

module.exports = {
  load() {},
  start() {},
  stop() {},
  destroy() {},
  health() { return { ok: true }; }
};
