'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCAN = ['host', 'lib', 'plugins', 'ui', 'cli', 'mcp'];

let failed = 0;
const skipped = [];

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

function skip(name, reason) {
  skipped.push(name);
  console.log('skip ' + name);
  console.log('  ' + reason);
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

function sourceFiles() {
  const files = [];
  for (let i = 0; i < SCAN.length; i += 1) walk(path.join(ROOT, SCAN[i]), files);
  return files;
}

function usesFetch(text) {
  return /\bfetch\s*\(/.test(text) || /\.fetch\s*\(/.test(text);
}

function setsRedirect(text) {
  return /redirect\s*[:=]\s*['"](?:manual|error)['"]/.test(text);
}

function pluginsMissingRedirect() {
  const root = path.join(ROOT, 'plugins');
  const ids = fs.readdirSync(root);
  const missing = [];
  for (let i = 0; i < ids.length; i += 1) {
    const dir = path.join(root, ids[i]);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = [];
    walk(dir, files);
    let fetches = false;
    let redirect = false;
    for (let j = 0; j < files.length; j += 1) {
      const text = fs.readFileSync(files[j], 'utf8');
      if (usesFetch(text)) fetches = true;
      if (setsRedirect(text)) redirect = true;
    }
    if (fetches && !redirect) missing.push(ids[i]);
  }
  return missing;
}

async function main() {
  await test('source does not disable TLS verification', async function () {
    const files = sourceFiles();
    const hits = [];
    for (let i = 0; i < files.length; i += 1) {
      const lines = fs.readFileSync(files[i], 'utf8').split(/\n/);
      for (let n = 0; n < lines.length; n += 1) {
        if (/rejectUnauthorized\s*:\s*false/.test(lines[n]) || lines[n].indexOf('NODE_TLS_REJECT_UNAUTHORIZED') !== -1) {
          hits.push(path.relative(ROOT, files[i]) + ':' + (n + 1));
        }
      }
    }
    assert.deepStrictEqual(hits, []);
  });

  const holes = pluginsMissingRedirect();
  await test('fetch plugins refuse redirects', async function () {
    assert.deepStrictEqual(holes, []);
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w36 transport ok (' + skipped.length + ' skipped)');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});