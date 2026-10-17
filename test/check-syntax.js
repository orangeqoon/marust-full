'use strict';

/**
 * npm run check の本体。main.js・electron-main.js と、cli・host・mcp・plugins・test・ui の下の .js を
 * 1 つずつ `node --check` する。package.json に並べると Windows の 1 行の長さ（約 8191 文字）を超えるため。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['cli', 'lib', 'host', 'mcp', 'plugins', 'plugins-author', 'test', 'ui'];
const SKIP = new Set(['node_modules', 'dist', 'fixtures']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
}

const files = [path.join(ROOT, 'main.js'), path.join(ROOT, 'electron-main.js')];
for (const dir of DIRS) walk(path.join(ROOT, dir), files);
walk(path.join(ROOT, '..', 'marust-plugins'), files); // みんなのプラグイン（隣のフォルダ。無ければ何もしない）

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed += 1;
    process.stderr.write('[check] ' + path.relative(ROOT, file) + '\n' + (res.stderr || '') + '\n');
  }
}
console.log('[check] ' + files.length + ' files, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
