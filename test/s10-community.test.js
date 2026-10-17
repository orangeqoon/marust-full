'use strict';

/**
 * 計画 X・S10: みんなのプラグイン（隣の marust-plugins の plugins フォルダ）の置き場。
 * 出どころはセット（source: set）で、community の印が付く。配る exe には入らず、作者の build は build-info.json の setDirs で隣のフォルダを指す。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../host/layer1/plugin-registry');
const C = require('./_community');

const ROOT = path.join(__dirname, '..');
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const manifest = (id) => JSON.stringify({ id, name: id, version: '1.0.0', manifestVersion: 2, kind: 'ui', runtime: 'inproc', main: 'index.js', provides: ['ui.panel@1'] });
function put(root, id) {
  fs.mkdirSync(path.join(root, id, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'manifest.json'), manifest(id));
  fs.writeFileSync(path.join(root, id, 'index.js'), 'module.exports = { load() {}, start() {}, stop() {}, destroy() {}, health() { return { ok: true }; } };\n');
  fs.writeFileSync(path.join(root, id, 'test', 'a.test.js'), '');
}
const make = (extra) => createRegistry(Object.assign({ core: { STATE_DIR: tmp('s10-state-') }, appRoot: ROOT, authorRoot: path.join(ROOT, 'no-author'), externalRoot: path.join(os.tmpdir(), 's10-none-' + process.pid), logger() {} }, extra));

test('communityRoot のプラグインは source builtin で、community の印が付く（内蔵と同じ id は内蔵が勝つ）', () => {
  const builtin = tmp('s10-b-'); const community = tmp('s10-c-');
  put(builtin, 'aaa'); put(community, 'bbb'); put(community, 'aaa');
  const rows = make({ builtinRoot: builtin, communityRoot: community }).discover();
  const b = rows.find((r) => r.id === 'bbb');
  assert.ok(b && b.source === 'set' && b.community === true && b.status !== 'skip');
  assert.strictEqual(rows.find((r) => r.id === 'aaa' && r.community !== true).status !== 'skip', true);
  const dup = rows.find((r) => r.id === 'aaa' && r.community === true);
  assert.strictEqual(dup.status, 'skip');
  assert.strictEqual(dup.reason, 'id-collision-skipped');
});

test('試験が builtinRoot を差し替えているときは、既定では一覧を足さない・既定の木では隣の一覧を読む', () => {
  const builtin = tmp('s10-b2-');
  assert.strictEqual(make({ builtinRoot: builtin }).paths.communityRoot, '');
  if (C.exists()) {
    const reg = make({});
    assert.strictEqual(path.resolve(reg.paths.communityRoot), path.resolve(C.ROOT));
    const rows = reg.discover();
    fs.readdirSync(C.ROOT).forEach((id) => {
      const row = rows.find((r) => r.id === id);
      assert.ok(row && row.community === true && row.source === 'set', id);
    });
  }
});

test('Q14: 配る exe（resources/app）では隣の marust-plugins に切り替えない', () => {
  const root = tmp('q14-exe-');
  const app = path.join(root, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(root, 'resources', 'marust-plugins', 'plugins'), { recursive: true });
  assert.strictEqual(createRegistry({ core: { STATE_DIR: tmp('q14-st-') }, appRoot: app, authorRoot: path.join(root, 'na'), externalRoot: path.join(root, 'ne') }).paths.communityRoot, '');
});

test('L8d: みんなのプラグインにも宣言した口（keys・external・pluginStates）が渡る（出どころ制限解除）', async () => {
  const state = tmp('q14-a-');
  const communityRoot = path.join(state, 'community');
  fs.mkdirSync(path.join(communityRoot, 'cprobe'), { recursive: true });
  fs.writeFileSync(path.join(communityRoot, 'cprobe', 'manifest.json'), JSON.stringify({
    id: 'cprobe', name: 'cprobe', version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', needs: ['keys', 'external.open'], provides: ['chat.inlet@1'], external: { hosts: ['accounts.google.com'] }
  }));
  fs.writeFileSync(path.join(communityRoot, 'cprobe', 'index.js'), 'module.exports = { load(ctx) { globalThis.__q14probe = ctx; }, start() {}, stop() {}, destroy() {}, health() { return { ok: true }; } };\n');
  const stateDir = path.join(state, 'st');
  fs.mkdirSync(stateDir, { recursive: true });
  const registry = createRegistry({
    core: { STATE_DIR: stateDir },
    appRoot: path.join(state, 'app'),
    builtinRoot: path.join(state, 'nope'),
    communityRoot,
    authorRoot: path.join(state, 'no-author'),
    externalRoot: path.join(state, 'ext'),
    logger() {},
    modeFor: () => 'live',
    app: { version: '1', releasesRepo: 'a/b' },
    keys: () => ({ reload() {}, save() {}, list() {}, release() {} }),
    openExternal: async () => {}
  });
  try {
    await registry.loadAll();
    assert.ok(globalThis.__q14probe, 'ctx captured');
    const ctx = globalThis.__q14probe;
    assert.ok(ctx.keys, 'keys が渡る');
    assert.ok(ctx.external, 'external が渡る');
    assert.ok(ctx.pluginStates, 'pluginStates が渡る');
  } finally {
    delete globalThis.__q14probe;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('Q14: title.reserved はみんなのプラグインでも持ち主になれる（timer-link）', async () => {
  const state = tmp('q14-b-');
  const communityRoot = path.join(state, 'community');
  fs.mkdirSync(path.join(communityRoot, 'cres'), { recursive: true });
  fs.writeFileSync(path.join(communityRoot, 'cres', 'manifest.json'), JSON.stringify({
    id: 'cres', name: 'cres', version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', needs: ['title.reserved'], api: { calls: ['hub.fanoutReserved'] }
  }));
  fs.writeFileSync(path.join(communityRoot, 'cres', 'index.js'), 'module.exports = { load(ctx) { globalThis.__q14res = ctx; }, start() {}, stop() {}, destroy() {}, health() { return { ok: true }; } };\n');
  const stateDir = path.join(state, 'st');
  fs.mkdirSync(stateDir, { recursive: true });
  const registry = createRegistry({
    core: { STATE_DIR: stateDir },
    appRoot: path.join(state, 'app'),
    builtinRoot: path.join(state, 'nope'),
    communityRoot,
    authorRoot: path.join(state, 'no-author'),
    externalRoot: path.join(state, 'ext'),
    logger() {},
    modeFor: () => 'live',
    app: { version: '1', releasesRepo: 'a/b' },
    keys: () => ({ reload() {}, save() {}, list() {}, release() {} }),
    openExternal: async () => {}
  });
  const grants = [];
  const fake = {
    callAs(id, method, params, g) { grants.push(g); return { ok: true }; },
    registerPluginAction() {},
    registerPluginMethod() { return { ok: true }; }
  };
  try {
    await registry.loadAll();
    registry.attachApi(fake);
    await globalThis.__q14res.api.call('hub.fanoutReserved', { title: 't' });
    assert.strictEqual(grants.length, 1);
    assert.strictEqual(grants[0].titleReserved, true);
  } finally {
    delete globalThis.__q14res;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of queue) {
    try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name + '\n' + (err && err.stack || err)); }
  }
  if (failed) { console.error('[s10] ' + failed + ' failed'); process.exit(1); }
  console.log('[s10] ' + queue.length + ' passed');
})();
