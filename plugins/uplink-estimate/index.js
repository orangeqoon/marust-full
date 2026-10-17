'use strict';

/**
 * 回線の余裕（V3）。「使う配信先のビットレートの足し算」と、上りの速さに対する判定。API uplink.estimate・uplink.setSettings・uplink.last。
 * 配信先ごとのビットレートは本体の読むだけの API engine.targetRates（ctx.api.call）から。外へは通信しない・秘密には触れない。
 * 設定（上りの速さ・割合）は ctx.dataDir/settings.json。最後の判定はメモリだけ。
 */

const { assess } = require('./lib/assess');
const { loadSettings, save } = require('./lib/settings');

const VERDICTS = new Set(['ok', 'tight', 'short', 'unknown', 'no-uplink', 'no-targets']);

let settings = null;
let last = null;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 画面に出す要点だけ控える（対象の名前などは持たない）
function note(result) {
  if (!result || result.ok !== true || !VERDICTS.has(result.verdict)) return;
  last = {
    at: new Date().toISOString(),
    verdict: result.verdict,
    plannedKbps: num(result.plannedKbps),
    uplinkMbps: num(result.uplinkMbps),
    ratioPercent: num(result.ratioPercent),
    unknownCount: num(result.unknownCount)
  };
}

module.exports = {
  load(ctx) {
    settings = loadSettings(ctx);
    last = null;

    ctx.api.register('uplink.estimate', async () => {
      const got = await ctx.api.call('engine.targetRates', {});
      if (!got || got.ok !== true || !Array.isArray(got.targets)) return { ok: false, error: got && typeof got.error === 'string' ? got.error : 'failed' };
      const rows = got.targets;
      const assessed = Object.assign({ ok: true }, assess({
        targets: rows,
        uplinkMbps: settings.uplinkMbps,
        tightPercent: settings.tightPercent,
        shortPercent: settings.shortPercent
      }), { targets: rows.map((r) => ({ name: r.name, enabled: r.enabled, kbps: r.kbps, source: r.source })) });
      note(assessed);
      return assessed;
    }, {
      access: 'read',
      description: '回線の余裕（R7）: 使う予定の配信先のビットレートを OBS から読んで足し、使う人が入れた上りの速さと比べる。読めない配信先は「不明」。外へは通信しない',
      params: {}
    });

    ctx.api.register('uplink.setSettings', (params) => {
      const next = Object.assign({}, settings);
      if (typeof params.uplinkMbps === 'number') next.uplinkMbps = params.uplinkMbps;
      if (typeof params.tightPercent === 'number') next.tightPercent = params.tightPercent;
      if (typeof params.shortPercent === 'number') next.shortPercent = params.shortPercent;
      if (!save(ctx, next)) return { ok: false, error: 'write-failed' };
      settings = next;
      return { ok: true, uplinkMbps: settings.uplinkMbps, tightPercent: settings.tightPercent, shortPercent: settings.shortPercent };
    }, {
      access: 'write',
      windowOnly: true,
      description: '上りの速さ（Mbps）と、「ぎりぎり」「足りない」の割合（%）を保存する。ウィンドウだけ',
      params: {
        uplinkMbps: { type: 'number', required: false, min: 0, max: 100000, typeError: 'bad-value', rangeError: 'bad-value' },
        tightPercent: { type: 'number', required: false, min: 10, max: 100, typeError: 'bad-value', rangeError: 'bad-value' },
        shortPercent: { type: 'number', required: false, min: 10, max: 100, typeError: 'bad-value', rangeError: 'bad-value' }
      }
    });

    ctx.api.register('uplink.last', () => ({ ok: true, last: last ? Object.assign({}, last) : null }), {
      access: 'read',
      description: '回線の余裕の「最後の判定」と計算した時刻を返す（読むだけ。OBS は読まない。ホームの 1 行用。まだ計算していなければ last は null）',
      params: {}
    });
  },
  start() {},
  stop() {},
  destroy() { settings = null; last = null; },
  health() { return { ok: true }; }
};
