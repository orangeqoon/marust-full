'use strict';

/**
 * AI をつなぐ（K3 で mcp/server.js ＋ 本体のパネルから出した）。
 *  - MCP の本体は plugins/ai-connect/mcp/server.js（このプラグインの中）。本体側の互換の 1 枚は K5 で消した（作者の設定は node ./plugins/ai-connect/mcp/server.js へ）。
 *  - API ai.status（read）: このプラグインが入っている（legacy でない）か。MCP が最初に読んで、切のときは「切ってある」と答える。
 *  - ペアリングのコードを作るのは親の窓だけ（ui.parentActions の ai.pair）。このプラグインは clients.* に触れない。
 */

module.exports = {
  load(ctx) {
    ctx.api.register('ai.status', () => ({ ok: true, enabled: ctx.mode() !== 'legacy' }), {
      access: 'read',
      description: 'AI の窓口（MCP）が入っているかを返す。切のときは MCP が「切ってある」と答える',
      params: {}
    });
  },
  start() {},
  stop() {},
  destroy() {},
  health() { return { ok: true }; }
};
