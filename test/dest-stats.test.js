'use strict';
require('./_ui-inline');

const assert = require('assert');
const buttons = require('../plugins/ui-standard/shell/panels/destinations');

global.siteLabel = (s) => s;
const targets = [
  { id: 'a', name: 'yt1', site: 'youtube', destinationId: 'd1', state: 'live', enabled: true },
  { id: 'b', name: 'yt2', site: 'youtube', destinationId: 'd2', state: 'live', enabled: true },
  { id: 'c', name: 'tw', site: 'twitch', destinationId: 'd3', state: 'live', enabled: true },
  { id: 'd', name: 'kk', site: 'kick', destinationId: 'd4', state: 'stopped', enabled: true }
];
const groups = buttons.streamGroups(targets, {});
const yt = groups.find((g) => g.site === 'youtube');
const tw = groups.find((g) => g.site === 'twitch');
const kick = groups.find((g) => g.site === 'kick');

// 1 つの配信先: fps・kbps・経過
assert.strictEqual(buttons.streamStatsText(tw, { c: { fps: 30, kbps: 6200, durationMs: 4994000 } }), '30fps · 6200kbps · 1:23:14');
// 複数: fps は低い方・kbps は合計・経過は長い方
assert.strictEqual(buttons.streamStatsText(yt, { a: { fps: 30, kbps: 3000, durationMs: 60000 }, b: { fps: 29.5, kbps: 2500, durationMs: 90000 } }), '29.5fps · 5500kbps · 0:01:30');
// 一部だけ取れている
assert.strictEqual(buttons.streamStatsText(tw, { c: { fps: null, kbps: 4500, durationMs: null } }), '4500kbps');
// 何も取れない・統計が無い・止まっているサイトは空（呼ぶ側は「配信中」に戻す）
assert.strictEqual(buttons.streamStatsText(tw, { c: { fps: null, kbps: null, durationMs: 1000 } }), '');
assert.strictEqual(buttons.streamStatsText(tw, {}), '');
assert.strictEqual(buttons.streamStatsText(tw, null), '');
assert.strictEqual(buttons.streamStatsText(kick, { d: { fps: 30, kbps: 1000, durationMs: 1 } }), '');
assert.strictEqual(buttons.streamStatsText(null, {}), '');
console.log('[marust] dest stats tests passed');

(async () => {
  const { createObsLocalEngine } = require('../host/core/engine/obs-local');
  const calls = [];
  const list = [
    { id: 't1', name: 'YouTube', protocol: 'RTMP', state: 'live', enabled: true },
    { id: 't2', name: 'Twitch', protocol: 'RTMP', state: 'stopped', enabled: true },
    { id: 't3', name: 'Kick', protocol: 'RTMP', state: 'live', enabled: true }
  ];
  const vendorFake = async (tier, type, data) => {
    calls.push([tier, type]);
    if (type === 'list_targets') return { targets: list };
    if (type === 'get_api_version') return { api_version: 2 };
    if (type === 'list_capabilities') return { requests: [] };
    if (type === 'get_target_status') {
      if (data.id === 't1') return { bitrate_bps: 6200000, fps: 29.97, duration_ms: 12000, last_error_code: 0 };
      return { error: 'target_not_found' };
    }
    return {};
  };
  const connection = {
    getStatus: () => ({ connected: true, detail: '接続中' }),
    vendor: (tier, type, data) => vendorFake(tier, type, data),
    call: async () => ({}),
    onVendorEvent() { return function () {}; },
    start: async () => ({}), reconnect: async () => ({}), stop() {}
  };
  const engine = createObsLocalEngine({ connection: connection, orchestrator: { modeFor: () => 'legacy' }, store: null, bus: null, logger() {} });
  await engine.syncNow('test').catch(() => {});
  const rows = await engine.readTargetStats();
  const byId = {};
  rows.forEach((r) => { byId[r.id] = r; });
  assert.deepStrictEqual(Object.keys(byId).sort(), ['t1', 't3'], '止まっている配信先は読まない');
  assert.deepStrictEqual([byId.t1.kbps, byId.t1.fps, byId.t1.durationMs, byId.t1.lastErrorCode], [6200, 30, 12000, null]);
  assert.deepStrictEqual([byId.t3.kbps, byId.t3.fps], [null, null], '読めなければ null');
  assert.ok(calls.every((c) => c[0] === 'read'), '読む命令だけ');
  const before = calls.length;
  await engine.readTargetStats();
  assert.strictEqual(calls.length, before, '1.5 秒は前の答えを使い回す');
  console.log('[marust] dest stats engine tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
