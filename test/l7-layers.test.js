'use strict';

// L7a: 核と一層目の境界テスト
//   - host/ の下のフォルダは core と layer1 だけ
//   - host/core 配下の .js の相対 require は、全部 host/core/ の中を指す
//   - plugins/**・plugins-author/** の .js（各 test/ は除く）は host/ を require しない
//   - ui 配下の .js は host/core/ を require しない

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walkJs(dir, predicate) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  let out = [];
  fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
    const rel = path.join(dir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (predicate && !predicate(rel, true)) return;
      out = out.concat(walkJs(rel, predicate));
    } else if (entry.name.endsWith('.js')) {
      if (!predicate || predicate(rel, false)) {
        out.push(rel);
      }
    }
  });
  return out;
}

function extractRequires(filePath) {
  const code = fs.readFileSync(path.join(ROOT, filePath), 'utf8');
  const re = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  const requires = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    requires.push(m[2]);
  }
  return requires;
}

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name + '\n' + (err && err.stack ? err.stack : err));
  }
}

// 1. host/ の下のフォルダは core と layer1 だけ
test('host/ の下のフォルダは core と layer1 だけ', () => {
  const hostDir = path.join(ROOT, 'host');
  const entries = fs.readdirSync(hostDir, { withFileTypes: true });
  const names = entries.map((e) => e.name).sort();
  assert.deepStrictEqual(names, ['core', 'layer1']);
  assert.ok(entries.every((e) => e.isDirectory()), 'host/ の直下にファイルがあってはならない');
});

// 2. host/core 配下の .js の相対 require は全部 host/core/ の中を指す
test('host/core 配下の .js の相対 require は全部 host/core/ の中を指す', () => {
  const coreFiles = walkJs('host/core');
  const violations = [];

  for (const file of coreFiles) {
    const fromDir = path.dirname(path.join(ROOT, file));
    const reqs = extractRequires(file);
    for (const req of reqs) {
      if (!req.startsWith('.')) continue; // モジュール・組み込みは対象外
      const resolvedAbs = path.resolve(fromDir, req);
      const relToRoot = path.relative(ROOT, resolvedAbs).replace(/\\/g, '/');

      // host/core/ の外を指していたら違反
      if (!relToRoot.startsWith('host/core/') && relToRoot !== 'host/core') {
        violations.push(`${file} → ${relToRoot}`);
      }
    }
  }

  assert.deepStrictEqual(violations, [], 'host/core の外を指す相対 require があります:\n' + violations.join('\n'));
});

// 3. plugins/**・plugins-author/** の .js（各 test/ は除く）は host/ を require しない
test('plugins/**・plugins-author/** の .js（各 test/ 除く）は host/ を require しない', () => {
  const pluginFiles = [
    ...walkJs('plugins', (rel, isDir) => {
      const parts = rel.split('/');
      return !parts.includes('test');
    }),
    ...walkJs('plugins-author', (rel, isDir) => {
      const parts = rel.split('/');
      return !parts.includes('test');
    })
  ];

  const violations = [];
  for (const file of pluginFiles) {
    const fromDir = path.dirname(path.join(ROOT, file));
    const reqs = extractRequires(file);
    for (const req of reqs) {
      if (req.includes('host/')) {
        violations.push(`${file} → ${req}`);
        continue;
      }
      if (req.startsWith('.')) {
        const resolvedAbs = path.resolve(fromDir, req);
        const relToRoot = path.relative(ROOT, resolvedAbs).replace(/\\/g, '/');
        if (relToRoot.startsWith('host/')) {
          violations.push(`${file} → ${req} (${relToRoot})`);
        }
      }
    }
  }

  assert.deepStrictEqual(violations, [], 'host/ を require しているプラグインファイルがあります:\n' + violations.join('\n'));
});

// 4. ui/**/*.js は host/core/ を require しない
test('ui/**/*.js は host/core/ を require しない', () => {
  const uiFiles = walkJs('ui');
  const violations = [];

  for (const file of uiFiles) {
    const fromDir = path.dirname(path.join(ROOT, file));
    const reqs = extractRequires(file);
    for (const req of reqs) {
      if (req.includes('host/core')) {
        violations.push(`${file} → ${req}`);
        continue;
      }
      if (req.startsWith('.')) {
        const resolvedAbs = path.resolve(fromDir, req);
        const relToRoot = path.relative(ROOT, resolvedAbs).replace(/\\/g, '/');
        if (relToRoot.startsWith('host/core/') || relToRoot === 'host/core') {
          violations.push(`${file} → ${req} (${relToRoot})`);
        }
      }
    }
  }

  assert.deepStrictEqual(violations, [], 'host/core/ を require している ui ファイルがあります:\n' + violations.join('\n'));
});

// 5. 核の外（host/layer1/**・electron-main.js・main.js・cli/**・ui/**）が host/core/ を require するときは入口（host/core）だけ
test('核の外が host/core/ を require するときは入口（host/core）だけ', () => {
  const outerFiles = [
    ...walkJs('host/layer1'),
    'electron-main.js',
    'main.js',
    ...walkJs('cli'),
    ...walkJs('ui')
  ];

  const allowedRel = new Set(['host/core', 'host/core/index', 'host/core/index.js']);
  const violations = [];

  for (const file of outerFiles) {
    const absPath = path.join(ROOT, file);
    if (!fs.existsSync(absPath)) continue;
    const fromDir = path.dirname(absPath);
    const reqs = extractRequires(file);
    for (const req of reqs) {
      if (!req.startsWith('.')) continue;
      const resolvedAbs = path.resolve(fromDir, req);
      const relToRoot = path.relative(ROOT, resolvedAbs).replace(/\\/g, '/');
      if (relToRoot.startsWith('host/core/') || relToRoot === 'host/core') {
        if (!allowedRel.has(relToRoot)) {
          violations.push(`${file} → ${req}`);
        }
      }
    }
  }

  assert.deepStrictEqual(violations, [], '核の入口以外を直接 require しているファイルがあります:\n' + violations.join('\n'));
});

// 6. cli/**/*.js は plugins/・plugins-author/ の中を require しない
test('cli/**/*.js は plugins/・plugins-author/ の中を require しない', () => {
  // cli/autocast.js は丸スト非依存の枠取り部品（sites プラグインの lib）を単体実行する検証ツールの例外
  const cliFiles = walkJs('cli').filter((f) => f !== 'cli/autocast.js');
  const violations = [];

  for (const file of cliFiles) {
    const fromDir = path.dirname(path.join(ROOT, file));
    const reqs = extractRequires(file);
    for (const req of reqs) {
      if (req.includes('plugins/') || req.includes('plugins-author/')) {
        violations.push(`${file} → ${req}`);
        continue;
      }
      if (req.startsWith('.')) {
        const resolvedAbs = path.resolve(fromDir, req);
        const relToRoot = path.relative(ROOT, resolvedAbs).replace(/\\/g, '/');
        if (relToRoot.startsWith('plugins/') || relToRoot.startsWith('plugins-author/')) {
          violations.push(`${file} → ${req} (${relToRoot})`);
        }
      }
    }
  }

  assert.deepStrictEqual(violations, [], 'plugins/ または plugins-author/ を require している cli ファイルがあります:\n' + violations.join('\n'));
});

// 7. cli/**/*.js が host/ を require するときは核の入口（host/core）か host/layer1/ の中だけ
test('cli/**/*.js が host/ を require するときは核の入口（host/core）か host/layer1/ の中だけ', () => {
  const cliFiles = walkJs('cli');
  const allowedCore = new Set(['host/core', 'host/core/index', 'host/core/index.js']);
  const violations = [];

  for (const file of cliFiles) {
    const fromDir = path.dirname(path.join(ROOT, file));
    const reqs = extractRequires(file);
    for (const req of reqs) {
      if (!req.startsWith('.')) continue;
      const resolvedAbs = path.resolve(fromDir, req);
      const relToRoot = path.relative(ROOT, resolvedAbs).replace(/\\/g, '/');
      if (relToRoot.startsWith('host/')) {
        const isCoreEntry = allowedCore.has(relToRoot);
        const isLayer1 = relToRoot.startsWith('host/layer1/') || relToRoot === 'host/layer1';
        if (!isCoreEntry && !isLayer1) {
          violations.push(`${file} → ${req} (${relToRoot})`);
        }
      }
    }
  }

  assert.deepStrictEqual(violations, [], 'host/ の許可された場所以外を require している cli ファイルがあります:\n' + violations.join('\n'));
});

if (failed) {
  console.error(`[l7-layers] ${failed} failed`);
  process.exit(1);
}
console.log('[l7-layers] all passed');
