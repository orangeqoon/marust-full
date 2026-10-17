'use strict';

/**
 * 計画 C・C2-2: 出どころは「セット（source: 'set'）」と「自分で足したもの（source: 'user'）」の 2 つ。
 * 同じ id はセットが勝つ。ひとつしか持てない役（口）はセットの中から選ぶ（自分で足したものは名乗れない・使われない）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createEventBus } = require('../host/core/event-bus');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function writePlugin(root, id, extra, tag) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', defaultMode: 'live', tier: 'basic' }, extra)));
  fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { load() {}, start() {}, stop() {}, destroy() {}, inlet: { tag: " + JSON.stringify(tag || id) + " } };\n");
}

function world(setDir, userRoot, state) {
  return createRegistry({
    core: createCore({ STATE_DIR: state }),
    appRoot: setDir,
    setDirs: setDir ? [{ dir: setDir }] : [],
    externalRoot: userRoot,
    modeFor: () => 'live',
    bus: createEventBus({ logger() {} }),
    logger() {}
  });
}

async function main() {
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c2o-set-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c2o-state-'));
  const user = path.join(state, 'plugins');
  try {
    await test('同じ id はセットが勝つ。自分で足したほうは id-collision-skipped。出どころは set と user だけ', async () => {
      writePlugin(set, 'dup', {});
      writePlugin(user, 'dup', {});
      writePlugin(user, 'mine', {});
      const registry = world(set, user, state);
      const rows = await registry.loadAll();
      const dups = rows.filter((r) => r.id === 'dup');
      assert.deepStrictEqual(dups.map((r) => [r.source, r.status, r.reason]), [['set', 'running', null], ['user', 'skip', 'id-collision-skipped']]);
      assert.strictEqual(registry.sourceOf('dup'), 'set');
      assert.strictEqual(registry.sourceOf('mine'), 'user');
      rows.forEach((r) => assert.ok(r.source === 'set' || r.source === 'user', r.id + ' ' + r.source));
    });

    await test('セットの同じ id が版（coreApi）で読み込まれなくても、自分で足したものは席を奪わない', async () => {
      writePlugin(set, 'future-dup', { coreApi: 3 });
      writePlugin(user, 'future-dup', {});
      const registry = world(set, user, state);
      const rows = await registry.loadAll();
      assert.deepStrictEqual(rows.filter((r) => r.id === 'future-dup').map((r) => [r.source, r.status, r.reason]), [['set', 'skip', 'core-api-too-new'], ['user', 'skip', 'id-collision-skipped']]);
    });

    await test('ひとつしか持てない役（口）: セットが持つ。自分で足したものが同じ役を名乗っても選ばれない', async () => {
      writePlugin(set, 'inlet-set', { provides: ['chat.inlet@1'] }, 'set');
      writePlugin(user, 'inlet-user', { provides: ['chat.inlet@1'] }, 'user');
      const registry = world(set, user, state);
      await registry.loadAll();
      assert.strictEqual(registry.port('chat.inlet@1', 'inlet').tag, 'set');
      const mine = registry.snapshot().find((r) => r.id === 'inlet-user');
      assert.ok(mine.manifest.provides.indexOf('chat.inlet@1') === -1, '名乗りは捨てられる');
    });

    await test('セットに役の持ち主が居なければ、自分で足したものがあっても口は空（核だけ・ほかの役が奪わない）', async () => {
      const emptySet = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c2o-empty-'));
      try {
        const registry = world(emptySet, user, state);
        await registry.loadAll();
        assert.strictEqual(registry.port('chat.inlet@1', 'inlet'), null);
      } finally { fs.rmSync(emptySet, { recursive: true, force: true }); }
    });
  } finally {
    fs.rmSync(set, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
  if (failed) { console.error('[marust] c2 origin tests failed ' + failed); process.exit(1); }
  console.log('[marust] c2 origin tests passed');
}
main().catch((err) => { console.error(err); process.exit(1); });
