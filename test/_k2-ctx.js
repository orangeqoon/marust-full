'use strict';

/**
 * K2: 内蔵プラグインが本体のファイルを require しなくなったので、偽の ctx にも ctx.log・ctx.events・ctx.redact が要る。
 * 本物の registry (makeCtx) と同じ部品を、偽の ctx の dataDir に向けて作る。
 */

const { appendJsonl } = require('../host/core/log-writer');
const { EVENTS } = require('../host/core/events');
const { redact } = require('../host/core/safe-runner');

function k2(dir) {
  return {
    log: { appendJsonl: (name, row, options) => appendJsonl(dir, name, row, options) },
    events: { NAMES: EVENTS },
    redact: (text) => redact(text)
  };
}

module.exports = { k2 };
