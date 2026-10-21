'use strict';

/** 計画 C・C2-1: セットの置き場の決め方（D6）。env → build-info.json → exe の横 → ソース。配る版では空でもリポジトリを探さない。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createEventBus } = require('../host/core/event-bus');
const { resolveSetDirs } = require('../host/core');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const PLUGIN = "'use strict';\nmodule.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n";
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

function writePlugin(root, id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), PLUGIN);
}

// 配る版の形: <exe のフォルダ>/resources/app（appRoot）と <exe のフォルダ>/plugins
function packagedLayout() {
  const exeDir = tmp('marust-c2-exe-');
  const appRoot = path.join(exeDir, 'resources', 'app');
  fs.mkdirSync(appRoot, { recursive: true });
  return { exeDir, appRoot };
}

async function main() {
  await test('環境変数 MARUST_SET_DIR が最優先（複数はパスの区切り）。無い場所は捨てる', () => {
    const a = tmp('marust-c2-a-');
    const b = tmp('marust-c2-b-');
    try {
      const got = resolveSetDirs({ appRoot: __dirname, env: { MARUST_SET_DIR: [a, path.join(a, 'nothing'), b].join(path.delimiter) } });
      assert.strictEqual(got.from, 'env');
      assert.deepStrictEqual(got.dirs.map((d) => d.dir), [path.resolve(a), path.resolve(b)]);
      assert.ok(got.dirs.every((d) => d.source === 'set' && d.author === false && d.community === false));
    } finally { rm(a); rm(b); }
  });

  await test('build-info.json の setDirs（文字列でも { dir, author } でも）。環境変数が無いときだけ', () => {
    const { exeDir, appRoot } = packagedLayout();
    const set = tmp('marust-c2-set-');
    const author = tmp('marust-c2-author-');
    try {
      fs.writeFileSync(path.join(appRoot, 'build-info.json'), JSON.stringify({ setDirs: [set, { dir: author, author: true }, '/no/such/dir'] }));
      const got = resolveSetDirs({ appRoot, env: {} });
      assert.strictEqual(got.from, 'build-info');
      assert.deepStrictEqual(got.dirs.map((d) => [d.dir, d.author]), [[path.resolve(set), false], [path.resolve(author), true]]);
    } finally { rm(exeDir); rm(set); rm(author); }
  });

  await test('配る版: exe の横の plugins/ を使う。無ければ空（リポジトリの置き場を探さない）', () => {
    const { exeDir, appRoot } = packagedLayout();
    try {
      const none = resolveSetDirs({ appRoot, env: {} });
      assert.deepStrictEqual(none, { from: 'none', dirs: [], envMissing: false });
      fs.mkdirSync(path.join(exeDir, 'plugins'));
      const beside = resolveSetDirs({ appRoot, env: {} });
      assert.strictEqual(beside.from, 'exe');
      assert.deepStrictEqual(beside.dirs.map((d) => d.dir), [path.join(exeDir, 'plugins')]);
    } finally { rm(exeDir); }
  });

  await test('ソースから起動: リポジトリの plugins・plugins-author を今までどおり読む', () => {
    const repo = path.join(__dirname, '..');
    const got = resolveSetDirs({ appRoot: repo, env: {} });
    assert.strictEqual(got.from, 'source');
    assert.ok(got.dirs.some((d) => d.dir === path.join(repo, 'plugins') && d.source === 'set' && !d.author));
    if (fs.existsSync(path.join(repo, 'plugins-author'))) assert.ok(got.dirs.some((d) => d.dir === path.join(repo, 'plugins-author') && d.author === true));
  });

  await test('置き場の author 印はフォルダ名だけ。環境変数の置き場の名前は印になるが、版の判定には使わない', () => {
    const { exeDir: exe2, appRoot: app2 } = packagedLayout();
    try {
      const base = tmp('marust-c2-envname-');
      const named = path.join(base, 'plugins-author');
      fs.mkdirSync(named);
      const got = resolveSetDirs({ appRoot: app2, env: { MARUST_SET_DIR: named } });
      assert.ok(got.dirs[0].author === true, '名前の印は rec.author 用');
      assert.strictEqual(require('../host/core').isAuthorBuild, undefined, '作者の版かの判定は本体に無い');
      rm(base);
    } finally { rm(exe2); }
  });

  await test('registry: MARUST_SET_DIR のセットが読み込まれる／配る版でセットが空なら核だけで起動する', async () => {
    const set = tmp('marust-c2-set-');
    const { exeDir, appRoot } = packagedLayout();
    const state = tmp('marust-c2-state-');
    const mk = (root, env) => createRegistry({ core: createCore({ STATE_DIR: state }), appRoot: root, env, externalRoot: path.join(state, 'plugins'), bus: createEventBus({ logger() {} }), logger() {} });
    try {
      writePlugin(set, 'envplug');
      const withEnv = mk(appRoot, { MARUST_SET_DIR: set });
      assert.deepStrictEqual(withEnv.paths.setDirs, [path.resolve(set)]);
      const rows = await withEnv.loadAll();
      assert.strictEqual(rows.find((r) => r.id === 'envplug').status, 'running');
      const empty = mk(appRoot, {});
      assert.deepStrictEqual(empty.paths.setDirs, []);
      assert.deepStrictEqual(await empty.loadAll(), []);
    } finally { rm(set); rm(exeDir); rm(state); }
  });

  if (failed) { console.error('[marust] c2 set-dirs tests failed ' + failed); process.exit(1); }
  console.log('[marust] c2 set-dirs tests passed');
}
main().catch((err) => { console.error(err); process.exit(1); });
