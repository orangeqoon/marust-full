'use strict';

/**
 * 計画 C・C1-1: つなぎ口の版（coreApi）。無ければ 1・核より新しいものと壊れた値は読み込まない（理由つき）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createEventBus } = require('../host/core/event-bus');
const { PLUGIN_API_VERSION, coreApiProblem } = require('../host/layer1/registry/manifest');
const { validateDataManifest } = require('../host/layer1/data-plugins');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const PLUGIN = "'use strict';\nmodule.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n";

function writePlugin(root, id, extra) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js' }, extra)));
  fs.writeFileSync(path.join(dir, 'index.js'), PLUGIN);
}

async function main() {
  await test('つなぎ口の版は 2・coreApiProblem の判定', () => {
    assert.strictEqual(PLUGIN_API_VERSION, 2);
    assert.strictEqual(coreApiProblem({}), '');
    assert.strictEqual(coreApiProblem({ coreApi: 1 }), '');
    assert.strictEqual(coreApiProblem({ coreApi: null }), '');
    assert.strictEqual(coreApiProblem({ coreApi: 2 }), '');
    assert.strictEqual(coreApiProblem({ coreApi: 3 }), 'core-api-too-new');
    ['1', 0, -1, 1.5, true, {}].forEach((v) => assert.strictEqual(coreApiProblem({ coreApi: v }), 'bad-core-api'));
  });

  await test('registry: 書いてない・1 は読み込む／新しい・壊れたものは skip して理由とログを残す', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-state-'));
    const logs = [];
    try {
      writePlugin(root, 'noapi', {});
      writePlugin(root, 'api1', { coreApi: 1 });
      writePlugin(root, 'future', { coreApi: 3 });
      writePlugin(root, 'broken', { coreApi: 'x' });
      const registry = createRegistry({
        core: createCore({ STATE_DIR: state }),
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(state, 'plugins'),
        bus: createEventBus({ logger() {} }),
        logger: (level, message) => logs.push(level + ':' + message)
      });
      const rows = await registry.loadAll();
      const by = (id) => rows.find((r) => r.id === id);
      assert.strictEqual(by('noapi').status, 'running');
      assert.strictEqual(by('api1').status, 'running');
      assert.strictEqual(by('future').status, 'skip');
      assert.strictEqual(by('future').reason, 'core-api-too-new');
      assert.strictEqual(by('broken').reason, 'bad-core-api');
      assert.ok(logs.join('\n').includes('skip set/future core-api-too-new coreApi=3'));
      assert.ok(logs.join('\n').includes('skip set/broken bad-core-api coreApi=invalid'));
      assert.ok(!registry.getRunning().some((r) => r.id === 'future'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });


  await test('データだけのプラグイン（テーマ）も coreApi を書ける。新しすぎるものは registry が断る', async () => {
    const theme = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'theme-default', 'manifest.json'), 'utf8'));
    assert.ok(!validateDataManifest(Object.assign({}, theme, { coreApi: 1 })).error);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-data-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-state-'));
    try {
      fs.mkdirSync(path.join(root, 'th-ok'));
      fs.mkdirSync(path.join(root, 'th-new'));
      fs.writeFileSync(path.join(root, 'th-ok', 'manifest.json'), JSON.stringify(Object.assign({}, theme, { id: 'th-ok', coreApi: 1, isDefault: false })));
      fs.writeFileSync(path.join(root, 'th-new', 'manifest.json'), JSON.stringify(Object.assign({}, theme, { id: 'th-new', coreApi: 3, isDefault: false })));
      const registry = createRegistry({ core: createCore({ STATE_DIR: state }), appRoot: root, builtinRoot: root, authorRoot: path.join(root, 'none'), communityRoot: '', externalRoot: path.join(state, 'plugins'), bus: createEventBus({ logger() {} }), logger() {} });
      const rows = await registry.loadAll();
      assert.strictEqual(rows.find((r) => r.id === 'th-ok').status, 'data');
      assert.strictEqual(rows.find((r) => r.id === 'th-new').reason, 'core-api-too-new');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  await test('サイトの形（roles）でも coreApi を見る。新しいものは丸ごと skip・合うものは各役目へ写る', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-site-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-state-'));
    try {
      ['sitenew', 'siteold'].forEach((name) => {
        const dir = path.join(root, 'sites', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: name, name: name, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', coreApi: name === 'sitenew' ? 3 : 1, roles: { site: { main: 'index.js' } } }));
        fs.writeFileSync(path.join(dir, 'index.js'), PLUGIN);
      });
      const registry = createRegistry({ core: createCore({ STATE_DIR: state }), appRoot: root, builtinRoot: root, authorRoot: path.join(root, 'none'), communityRoot: '', externalRoot: path.join(state, 'plugins'), bus: createEventBus({ logger() {} }), logger() {} });
      const rows = await registry.loadAll();
      const bad = rows.find((r) => r.id === 'sitenew');
      assert.ok(bad && bad.status === 'skip' && bad.reason === 'core-api-too-new', JSON.stringify(rows.map((r) => [r.id, r.status, r.reason])));
      assert.ok(!rows.some((r) => r.id === 'site-sitenew' && r.status !== 'skip'));
      const good = rows.find((r) => r.id === 'site-siteold');
      assert.ok(good && good.manifest.coreApi === 1, JSON.stringify(rows.map((r) => [r.id, r.status, r.reason])));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  if (failed) { console.error('[marust] c1 core-api tests failed ' + failed); process.exit(1); }
  console.log('[marust] c1 core-api tests passed');
}
main().catch((err) => { console.error(err); process.exit(1); });
