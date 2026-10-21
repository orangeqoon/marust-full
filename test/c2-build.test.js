'use strict';

/** 計画 C・C2-3: ビルドは核だけ。配る版は exe の横にセット（writeSetDir）、作者の版は build-info.json にセットの置き場（authorBuildInfo）。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSetDir, bareRequires } = require('../cli/pack-plugins');
const { resolveSetDirs } = require('../host/core');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');

test('writeSetDir: plugins/ を試験（test/）なしで写す。plugins-author は入らない。もう一度作ると作り直し', () => {
  const out = tmp('marust-c2b-set-');
  try {
    const dest = path.join(out, 'plugins');
    const count = writeSetDir(dest);
    assert.ok(count >= 20, 'プラグインの数 ' + count);
    assert.ok(fs.existsSync(path.join(dest, 'bulk-title', 'manifest.json')));
    assert.ok(!fs.existsSync(path.join(dest, 'bulk-title', 'test')), 'プラグインの試験は配らない');
    assert.ok(!fs.existsSync(path.join(dest, 'dev-legacy-import')) && !fs.existsSync(path.join(dest, 'chat-twitch')), '作者専用は入らない');
    fs.writeFileSync(path.join(dest, 'STALE'), 'x');
    writeSetDir(dest);
    assert.ok(!fs.existsSync(path.join(dest, 'STALE')), '古い中身は消える（差し替え）');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('セットが使う npm の部品（ws など）は、exe の横のセットの node_modules から見つかる（アプリの node_modules は見えない場所）', () => {
  const out = tmp('marust-c2b-npm-');
  try {
    const dest = path.join(out, 'plugins');
    writeSetDir(dest);
    const used = bareRequires(dest);
    assert.ok(used.includes('ws'), '今の使い先: ' + used.join(','));
    // セット内の、npm の部品を require するファイルごとに、そのファイルの場所から名前が解決できる
    const files = [];
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(dir, e.name)); } else if (/\.js$/.test(e.name)) files.push(path.join(dir, e.name));
      });
    }(dest));
    const builtin = new Set(require('module').builtinModules);
    let checked = 0;
    files.forEach((file) => {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'".\/][^'"]*)['"]\s*\)/g)) {
        const name = m[1].charAt(0) === '@' ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
        if (builtin.has(name) || m[1].indexOf('node:') === 0) continue;
        const found = require.resolve(m[1], { paths: [path.dirname(file)] });
        assert.ok(found.startsWith(path.join(dest, 'node_modules')), file + ' → ' + found);
        checked += 1;
      }
    });
    assert.ok(checked >= 2, '確かめた数 ' + checked);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('配る版の置き場: 作った plugins/ を exe の横に置くと、resolveSetDirs が見つける（exe の中にはコピーしない）', () => {
  const exeDir = tmp('marust-c2b-exe-');
  try {
    const appRoot = path.join(exeDir, 'resources', 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    writeSetDir(path.join(exeDir, 'plugins'));
    const got = resolveSetDirs({ appRoot, env: {} });
    assert.strictEqual(got.from, 'exe');
    assert.deepStrictEqual(got.dirs.map((d) => d.dir), [path.join(exeDir, 'plugins')]);
    assert.ok(!fs.existsSync(path.join(appRoot, 'plugins')));
  } finally { fs.rmSync(exeDir, { recursive: true, force: true }); }
});

if (failed) { console.error('[marust] c2 build tests failed ' + failed); process.exit(1); }
console.log('[marust] c2 build tests passed');
