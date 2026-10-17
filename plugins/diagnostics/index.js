'use strict';

/**
 * 診断（K3 で host/diagnostics.js ＋ 本体の診断パネルから出した）。読むだけ。
 *  - 材料は核の read の API diagnostics.facts（host/core/diagnostics-facts.js。名前と有無だけの平らな表）。ここは表から診断の文（findings）を作る。
 *  - API diagnostics.run（read。名前・権限は移す前と同じ）。値・秘密・トークン・絶対パスは返さない。
 */

const { analyze } = require('./lib/diagnose');

module.exports = {
  load(ctx) {
    ctx.api.register('diagnostics.run', async () => {
      const facts = await ctx.api.call('diagnostics.facts', {});
      return analyze(facts);
    }, {
      access: 'read',
      description: '診断結果を返す。値や秘密は含めない',
      params: {}
    });
  },
  start() {},
  stop() {},
  destroy() {},
  health() { return { ok: true }; }
};
