'use strict';

/**
 * 画面の本体役（kind: shell）の選び方（計画 C・C3-1）。ひとつしか持てない役。
 * - 設定（ui-settings の shell）で選んだ id が、読み込めている shell なら（出どころがセットでも自分で足したものでも）それを使う。
 * - 選んだものが無い・読み込めない・消えたときは、セットの shell に戻る（既定の印 isDefault があればそれ、無ければ id が若いもの）。戻った理由は reason に出す。
 * - 何も選んでいないときも、セットの shell だけから選ぶ（自分で足したものは明示で選んだときだけ）。
 * - セットの shell も無ければ null（枠のページは最低限の表示を出す。C3-2）。
 * 純粋な関数。rows は registry.dataPlugins('shell') の行、records は registry.snapshot()（読み込めなかった理由を引くため。無くてもよい）。
 */

function baseOf(id) {
  return '/plugins/' + id + '/shell/';
}

function view(row) {
  return {
    id: row.id,
    source: row.source,
    label: row.shell.label,
    scripts: row.shell.scripts.slice(),
    styles: row.shell.styles.slice(),
    layout: row.shell.layout,
    template: row.shell.template || '',
    base: baseOf(row.id)
  };
}

function pickShell(rows, wanted, records, excluded) {
  const all = (Array.isArray(rows) ? rows : []).filter((r) => r && r.shell && !(excluded || []).includes(r.id));
  const want = typeof wanted === 'string' ? wanted : '';
  const list = all.map((r) => ({ id: r.id, source: r.source, label: r.shell.label }));
  const chosen = want ? all.find((r) => r.id === want) : null;
  let reason = '';
  if (want && !chosen) {
    const rec = (Array.isArray(records) ? records : []).find((r) => r && r.id === want);
    reason = rec && rec.reason ? String(rec.reason) : 'unknown-shell';
  }
  let hit = chosen;
  if (!hit) {
    const sets = all.filter((r) => r.source === 'set').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    hit = sets.find((r) => r.isDefault === true) || sets[0] || null;
  }
  return {
    active: hit ? view(hit) : null,
    wanted: want,
    fellBack: !!want && !chosen,
    reason: reason,
    shells: list
  };
}

module.exports = { pickShell, baseOf };
