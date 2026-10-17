'use strict';

/**
 * 「更新を確かめる」（K3 で host/update-check.js から出した）。押したときにだけ配布ページを 1 回読む。API update.check（ウィンドウだけ・読むだけ）。
 * 版と配布ページは ctx.app（本体が凍結して渡す）。自動ではつながない。
 */

const { createUpdateCheck } = require('./lib/check');

let checker = null;

module.exports = {
  load(ctx) {
    const app = ctx.app || {};
    checker = createUpdateCheck({ repo: app.releasesRepo, version: app.version });
    ctx.api.register('update.check', () => checker.check(), {
      access: 'read',
      windowOnly: true,
      description: '最新の版を、配布ページ（GitHub Releases）から 1 回読む。押したときだけ。自動ではつながない。ウィンドウだけ',
      params: {}
    });
  },
  start() {},
  stop() { checker = null; },
  destroy() { checker = null; },
  health() { return { ok: true }; }
};
