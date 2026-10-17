'use strict';

/**
 * 開発者用:
 *  - shadow.report … shadow の記録を日数とサイトでまとめる（V1 で host/core/api.js から移した）
 *  - golive.check … 本番切り替えの 6 項目の案内（V6 で host/golive.js から移した）。事実は本体の diagnostics.siteFacts・destinations は
 *    broadcast.preflight を ctx.api.call で読み、判定の文面はここ
 *  - 画面 ui/shadow-report.html・ui/golive.html（V6 で本体の画面から移した）
 * 名前・引数・権限（read・開発者モードだけ）は移す前と同じ。本体のファイルは require しない（出す文字列の伏せは ctx.redact）。
 */

const { report, setRedact } = require('./lib/report');
const { check, SITES } = require('./lib/golive');

module.exports = {
  load(ctx) {
    setRedact(ctx.redact);
    const shadowReport = (query) => {
      const stateDir = ctx.core && ctx.core.STATE_DIR;
      if (!stateDir) return { ok: false, error: 'unavailable' };
      const bag = query && typeof query === 'object' ? query : {};
      return report({
        days: Object.prototype.hasOwnProperty.call(bag, 'days') ? bag.days : undefined,
        site: Object.prototype.hasOwnProperty.call(bag, 'site') ? bag.site : undefined,
        stateDir
      });
    };
    ctx.api.register('shadow.report', (params) => shadowReport(params), {
      access: 'read',
      description: 'shadow の記録を日数とサイトでまとめる。値や秘密は含めない',
      params: {
        days: { type: 'number', required: false, min: 1, max: 30, integer: true, rangeError: 'bad-days', typeError: 'bad-days' },
        site: { type: 'string', required: false, max: 64 }
      }
    });
    ctx.api.register('golive.check', (params) => check(params.site, {
      facts: (site, secretNames, pluginIds) => ctx.api.call('diagnostics.siteFacts', { site, secretNames, pluginIds }),
      preflight: (ids) => ctx.api.call('broadcast.preflight', { destinationIds: ids }),
      shadowReport
    }), {
      access: 'read',
      description: '本番切り替えの 6 項目を返す。秘密の値は含めない',
      params: {
        site: { type: 'string', required: true, max: 32, enum: SITES.slice(), error: 'unknown-site' }
      }
    });
  },
  start() {},
  stop() {},
  destroy() {}
};
