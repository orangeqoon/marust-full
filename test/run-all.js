'use strict';

/**
 * npm test の本体。次の *.test.js を名前順に 1 本ずつ別プロセスで流す。
 *   - test/ 直下（本体と、全体にまたがる試験）
 *   - plugins/<id>/test/・plugins/sites/<id>/test/・plugins-author/<id>/test/（1 機能 1 フォルダ。計画 X・P4。プラグインの試験はそのフォルダの中）
 * 1 本でも失敗したら終了コード 1。新しいテストは名前を *.test.js にして置くだけで自動で入る。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function testsIn(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((n) => n.endsWith('.test.js')).sort().map((n) => path.join(dir, n));
}

function pluginTests(base) {
  const abs = path.join(ROOT, base);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
    if (entry.isDirectory()) testsIn(path.join(base, entry.name, 'test')).forEach((f) => out.push(f));
  });
  return out;
}

// みんなのプラグイン（隣の streaming/marust-plugins/plugins/<id>/test/。計画 X・S10）。無ければ飛ばす。
function communityTests() {
  const abs = path.join(ROOT, '..', 'marust-plugins', 'plugins');
  if (!fs.existsSync(abs)) return [];
  const out = [];
  fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
    if (entry.isDirectory()) testsIn(path.relative(ROOT, path.join(abs, entry.name, 'test'))).forEach((f) => out.push(f));
  });
  return out;
}

const files = testsIn('test')
  .concat(pluginTests('plugins'), pluginTests(path.join('plugins', 'sites')), pluginTests('plugins-author'), communityTests());

let passed = 0;
const failed = [];
for (const rel of files) {
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], { stdio: 'inherit' });
  if (r.status === 0) passed += 1;
  else failed.push(rel);
}

console.log(`\n[run-all] ${passed}/${files.length} passed`);
if (failed.length) {
  console.error(`[run-all] FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
