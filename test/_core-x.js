'use strict';

/**
 * 計画 X（PLAN-X-run-all.md）の見張りの数え方。test/x0-core-numbers.test.js と cli/ の測定から使う。
 * P1 本体の中のプラグイン id・P4 1 機能 1 フォルダ・P7 host/ の大きさ・P8 名乗りの欠け。
 * 上限は test/fixtures/core-boundary.json の "x"。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walkJs(dir, acc) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return acc;
  fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walkJs(rel, acc); } else if (entry.name.endsWith('.js')) acc.push(rel);
  });
  return acc;
}

function walkAssets(dir, acc) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return acc;
  fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walkAssets(rel, acc); } else if (entry.name.endsWith('.json') || entry.name.endsWith('.html') || entry.name.endsWith('.css')) acc.push(rel);
  });
  return acc;
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** プラグインの置き場（内蔵・サイト・作者用）。キーは置き場のパス（サイトと作者用に同じ id がある）→ { id, dir, base, manifest } */
function pluginDirs() {
  const out = {};
  ['plugins', 'plugins/sites', 'plugins-author', '../marust-plugins/plugins'].forEach((base) => {
    const abs = path.join(ROOT, base);
    if (!fs.existsSync(abs)) return;
    fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
      if (!entry.isDirectory()) return;
      const file = path.join(abs, entry.name, 'manifest.json');
      if (!fs.existsSync(file)) return;
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { manifest = null; }
      out[base + '/' + entry.name] = { id: entry.name, dir: base + '/' + entry.name, base, manifest };
    });
  });
  return out;
}

function pluginIds() { const dirs = pluginDirs(); return Array.from(new Set(Object.keys(dirs).map((k) => dirs[k].id))); }

/** P1: 本体（host/・ui/・electron-main.js・main.js）の中でプラグイン id を文字列として書いている (ファイル, id) の組 */
function pluginIdRefs() {
  const ids = pluginIds();
  const files = walkJs('host', []).concat(walkJs('ui', []), ['electron-main.js', 'main.js']);
  const out = [];
  files.forEach((file) => {
    // require('./x') の相対パスは、プラグイン id に見えても id ではない
    // A3: 案内コメントだけを除く（c4-ui-standard と同じ完全一致）。実行コードは除外しない。
    const documentedComments = {
      'host/core/owners.js': " * - parentActions: ['ai.pair']（親の窓だけが実行する操作。plugins/ui-standard/shell/core/parent-actions.js）",
      'host/layer1/plugin-surface.js': '// 実行（確認の窓・権限の判断）は親の画面（plugins/ui-standard/shell/core/parent-actions.js）。iframe は名前と値を渡すだけ。'
    };
    const text = read(file).split(/\r?\n/).filter((line) => line !== documentedComments[file] && !/require\('\.{1,2}\//.test(line)).join('\n');
    ids.forEach((id) => {
      const re = new RegExp('([\'"`/:])' + id.replace(/-/g, '\\-') + '([\'"`/:])');
      if (re.test(text)) out.push(file + ' → ' + id);
    });
  });
  return out.sort();
}

/** P1b: 本体（host/・ui/）の json/html/css の中でプラグイン id を文字列として書いている (ファイル, id) の組 */
function pluginIdRefsAssets() {
  const ids = pluginIds();
  const files = walkAssets('host', []).concat(walkAssets('ui', []));
  const out = [];
  files.forEach((file) => {
    const text = read(file);
    ids.forEach((id) => {
      const re = new RegExp('([\'"`/:])' + id.replace(/-/g, '\\-') + '([\'"`/:])');
      if (re.test(text)) out.push(file + ' → ' + id);
    });
  });
  return out.sort();
}

/** P7: host/ の大きさ（子フォルダも含む） */
function hostSize() {
  const files = walkJs('host', []);
  let lines = 0;
  files.forEach((file) => { lines += read(file).split('\n').length; });
  return { files: files.length, lines };
}

/** P4: test/ 直下にあって特定のプラグインのフォルダを使う試験（Q15: _community と marust-plugins も数える） */
function rootPluginTests() {
  return fs.readdirSync(path.join(ROOT, 'test')).filter((n) => n.endsWith('.test.js') && !/^x[0-9]/.test(n)) // x0・x1…は計画 X の見張り自身
    .filter((n) => {
      const text = read('test/' + n).replaceAll('plugins/ui-standard/shell/', 'shell/');
      return /plugins(-author)?\/(sites\/)?[a-z]/.test(text) || text.indexOf("require('./_community')") !== -1 || text.indexOf('marust-plugins') !== -1;
    }).sort();
}

/** P8: 内蔵（plugins/・plugins/sites/）で category（種類）の名乗りが無いもの */
function noCategory() {
  const dirs = pluginDirs();
  return Object.keys(dirs).filter((k) => dirs[k].base !== 'plugins-author' && dirs[k].manifest && !dirs[k].manifest.category && ['theme', 'layout', 'set', 'shell'].indexOf(dirs[k].manifest.kind) === -1).sort();
}

module.exports = { ROOT, walkJs, read, pluginDirs, pluginIds, pluginIdRefs, pluginIdRefsAssets, hostSize, rootPluginTests, noCategory };
