'use strict';

/**
 * 回線の余裕（R7）。「配信先の数 × 各配信先のビットレート」の足し算と、上りの速さに対する判定。
 * 通信しない・外の測定サーバーにつながない。上りの速さは使う人が入れる。
 * ビットレートは OBS から読む（読めない配信先は「不明」として足し算から外し、0 とは数えない）。
 */

const DEFAULT_TIGHT_PERCENT = 70;
const DEFAULT_SHORT_PERCENT = 90;

function number(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * targets: [{ id, name, enabled, kbps(null なら不明), source }]（使う予定のもの＝enabled だけを足す）
 * 戻り: { plannedKbps, knownCount, unknownCount, unknownNames[], uplinkMbps, ratioPercent|null,
 *         verdict: 'ok'|'tight'|'short'|'unknown'|'no-uplink'|'no-targets', thresholds }
 */
function assess(input) {
  const src = input || {};
  const tight = Math.min(100, Math.max(1, number(src.tightPercent) || DEFAULT_TIGHT_PERCENT));
  const short = Math.min(100, Math.max(tight, number(src.shortPercent) || DEFAULT_SHORT_PERCENT));
  const uplinkMbps = Math.max(0, number(src.uplinkMbps) || 0);
  const rows = Array.isArray(src.targets) ? src.targets : [];
  let plannedKbps = 0;
  let known = 0;
  const unknownNames = [];
  let enabledCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.enabled !== true) continue;
    enabledCount += 1;
    const kbps = number(row.kbps);
    if (Number.isFinite(kbps) && kbps > 0) {
      plannedKbps += kbps;
      known += 1;
    } else if (unknownNames.length < 20) {
      unknownNames.push(String(row.name || row.id || '').slice(0, 60));
    }
  }
  const unknownCount = enabledCount - known;
  const out = {
    plannedKbps: Math.round(plannedKbps),
    knownCount: known,
    unknownCount: unknownCount,
    unknownNames: unknownNames,
    uplinkMbps: uplinkMbps,
    ratioPercent: null,
    verdict: 'unknown',
    thresholds: { tightPercent: tight, shortPercent: short }
  };
  if (enabledCount === 0) {
    out.verdict = 'no-targets';
    return out;
  }
  if (known === 0) {
    out.verdict = 'unknown';
    return out;
  }
  if (!(uplinkMbps > 0)) {
    out.verdict = 'no-uplink';
    return out;
  }
  const ratio = (plannedKbps / (uplinkMbps * 1000)) * 100;
  out.ratioPercent = Math.round(ratio * 10) / 10;
  out.verdict = ratio <= tight ? 'ok' : (ratio <= short ? 'tight' : 'short');
  return out;
}

module.exports = { assess, DEFAULT_TIGHT_PERCENT, DEFAULT_SHORT_PERCENT };
