'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCAN = ['host', 'lib', 'plugins', 'ui', 'cli', 'mcp'];
const NEEDLES = ['C:\\scripts', 'C:\\\\scripts', 'C:\\Users', 'C:\\\\Users'];

let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test') continue; // プラグイン自身の試験は配らないので見ない
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|mjs|cjs|html|css|json)$/.test(entry.name)) acc.push(full);
  }
}

async function main() {
  await test('source does not hardcode C:\\scripts or C:\\Users', async function () {
    const files = [];
    for (let i = 0; i < SCAN.length; i += 1) walk(path.join(ROOT, SCAN[i]), files);
    const hits = [];
    for (let i = 0; i < files.length; i += 1) {
      const lines = fs.readFileSync(files[i], 'utf8').split(/\n/);
      for (let n = 0; n < lines.length; n += 1) {
        const line = lines[n];
        if (line.indexOf('allow-hardcode') !== -1) continue;
        for (let k = 0; k < NEEDLES.length; k += 1) {
          if (line.indexOf(NEEDLES[k]) !== -1) {
            hits.push(path.relative(ROOT, files[i]) + ':' + (n + 1));
            break;
          }
        }
      }
    }
    assert.deepStrictEqual(hits, []);
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w36 paths ok');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});