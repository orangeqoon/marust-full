'use strict';

/**
 * 中級の「機能」一覧（PLAN-plugin-core P1）。プラグインの manifest `feature` と、まだプラグインになっていない核の機能（P2 で出す）を
 * 1 つの一覧にまとめる。ここは組み立てだけ（ファイルにも OBS にも触らない）。秘密は扱わない。
 * - activation `live` / `shadow`: 入れる＝そのプラグインのモードを変える。状態＝モードが legacy 以外。
 * - activation `guide`: モードは変えない（本物のサイトへ書くので、画面の案内の中で本人が決める）。入れる＝「使う」の印を残して画面を開く。
 */

// 核の中にだけある機能（プラグインになっていないもの）。P2 で題名・コメント送信が内蔵プラグインになり、空になった。
// guide（本物のサイトへ書く機能）の印は、manifest の feature.activation が guide の行だけが対象（id は核に並べない）。
const CORE_FEATURES = Object.freeze([]);

function loginOk(loginSites, site) {
  const list = Array.isArray(loginSites) ? loginSites : [];
  const row = list.find(function (s) { return s && s.id === site; });
  return !!row && row.state === 'logged-in';
}

/** needs の 1 件を { kind, target, ok } にする。ok が null のときは「分からない」（画面は何も言わない）。 */
function resolveNeed(need, ctx) {
  if (need === 'obs') return { kind: 'obs', target: '', ok: typeof ctx.obsConnected === 'boolean' ? ctx.obsConnected : null };
  const site = /^site:(.+)$/.exec(need);
  if (site) return { kind: 'site', target: site[1], ok: Array.isArray(ctx.installedSites) ? ctx.installedSites.indexOf(site[1]) !== -1 : null };
  const m = /^login:(.+)$/.exec(need);
  if (m) return { kind: 'login', target: m[1], ok: Array.isArray(ctx.loginSites) ? loginOk(ctx.loginSites, m[1]) : null };
  return { kind: 'unknown', target: need, ok: null };
}

function describe(spec, id, source, on, mode, ctx, row) {
  return {
    id: id,
    label: spec.label,
    hint: spec.hint || '',
    level: spec.level === 'advanced' ? 'advanced' : 'standard',
    activation: spec.activation,
    group: spec.group || '',
    order: Number.isInteger(spec.order) ? spec.order : 9999,
    openPanel: spec.openPanel || '',
    tip: spec.tip || '',
    tipAliases: Array.isArray(spec.tipAliases) ? spec.tipAliases.slice() : [],
    category: row && typeof row.category === 'string' ? row.category : '',
    for: row && Array.isArray(row.for) ? row.for.slice() : [],
    tags: row && Array.isArray(row.tags) ? row.tags.slice() : [],
    needs: (Array.isArray(spec.needs) ? spec.needs : []).map(function (n) { return resolveNeed(n, ctx); }),
    source: source,
    on: on,
    mode: mode
  };
}

/**
 * ctx: { rows（modes.list の plugins。feature と mode と visible を持つ）, flags（印のついた機能の id）, loginSites, obsConnected, installedSites（入っているサイトの id） }
 * 戻り: 並んだ機能の配列。feature の無いプラグイン・見せない行（visible=false）は出ない。
 */
function buildFeatureList(ctx) {
  const c = ctx || {};
  const rows = Array.isArray(c.rows) ? c.rows : [];
  const flags = Array.isArray(c.flags) ? c.flags : [];
  const out = [];
  rows.forEach(function (row) {
    if (!row || row.visible === false || !row.feature || typeof row.feature !== 'object') return;
    const spec = row.feature;
    if (spec.activation === 'guide') {
      out.push(describe(spec, String(row.id), 'plugin', flags.indexOf(row.id) !== -1, row.mode || 'legacy', c, row));
    } else {
      out.push(describe(spec, String(row.id), 'plugin', row.mode === 'live' || row.mode === 'shadow', row.mode || 'legacy', c, row));
    }
  });
  CORE_FEATURES.forEach(function (spec) {
    out.push(describe(spec, spec.id, 'core', flags.indexOf(spec.id) !== -1, '', c));
  });
  out.sort(function (a, b) { return a.order - b.order || (a.id < b.id ? -1 : 1); });
  return out;
}

function findFeature(features, id) {
  return features.find(function (f) { return f.id === id; }) || null;
}

module.exports = { buildFeatureList, findFeature, CORE_FEATURES };
