'use strict';

/**
 * 計画 C・C6-1: ひとつしか持てない口の持ち主はセット（source: 'set'）だけ。
 * キー割り当て（needs: keys → ctx.keys）と予約の自動送信（needs: title.reserved）は、
 * 自分で足したもの（source: 'user'）が書いても持てない。
 * コメントの受け口（chat-port.js → port('chat.inlet@1')）は test/c2-origin.test.js で同じ決まりを見ている。
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

const seen = {};
function writePlugin(root, id, extra) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({
    id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', tier: 'basic'
  }, extra)));
  fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { load(ctx) { global.__c6hold[ctx.id] = ctx; }, start() {}, stop() {}, destroy() {} };\n");
}

function world(setDir, userRoot, state) {
  return createRegistry({
    core: createCore({ STATE_DIR: state }),
    appRoot: setDir,
    setDirs: [{ dir: setDir }],
    externalRoot: userRoot,
    modeFor: () => 'live',
    bus: createEventBus({ logger() {} }),
    logger() {},
    app: { version: '1', releasesRepo: 'a/b' },
    keys: () => ({ reload() {}, save() {}, list() { return { ok: true }; }, release() {} })
  });
}

function pair() {
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c6h-set-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c6h-state-'));
  return { set, user: path.join(state, 'plugins'), state };
}

async function main() {
  global.__c6hold = seen;
  const a = pair();
  const b = pair();
  try {
    await test('キー割り当て: セットだけが ctx.keys を持つ。自分で足したものは needs に書いても持てない', async () => {
      writePlugin(a.set, 'key-set', { needs: ['keys'] });
      writePlugin(a.user, 'key-user', { needs: ['keys'] });
      const registry = world(a.set, a.user, a.state);
      await registry.loadAll();
      assert.ok(seen['key-set'] && seen['key-set'].keys, 'セットがキーの口を持つ');
      assert.ok(seen['key-user'], '自分で足したものは読み込める');
      assert.strictEqual(seen['key-user'].keys, undefined, 'user はキーの持ち主にならない');
    });

    await test('キー割り当て: セットに持ち主が居なくても、自分で足したものは口を持たない', async () => {
      writePlugin(b.user, 'key-only-user', { needs: ['keys'] });
      const registry = world(b.set, b.user, b.state);
      await registry.loadAll();
      assert.ok(seen['key-only-user'], '読み込めた');
      assert.strictEqual(seen['key-only-user'].keys, undefined);
    });

    await test('予約の自動送信: セットだけが titleReserved を得る。自分で足したものは得ない', async () => {
      const c = pair();
      try {
        const extra = { needs: ['title.reserved'], api: { calls: ['hub.fanoutReserved'] } };
        writePlugin(c.set, 'rsv-set', extra);
        writePlugin(c.user, 'rsv-user', extra);
        const registry = world(c.set, c.user, c.state);
        const grants = [];
        const fake = {
          callAs(id, method, params, g) { grants.push({ id, titleReserved: !!(g && g.titleReserved) }); return { ok: true }; },
          registerPluginAction() {},
          registerPluginMethod() { return { ok: true }; }
        };
        await registry.loadAll();
        registry.attachApi(fake);
        await seen['rsv-set'].api.call('hub.fanoutReserved', { title: 't' });
        await seen['rsv-user'].api.call('hub.fanoutReserved', { title: 't' });
        assert.deepStrictEqual(grants, [
          { id: 'rsv-set', titleReserved: true },
          { id: 'rsv-user', titleReserved: false }
        ]);
      } finally { fs.rmSync(c.set, { recursive: true, force: true }); fs.rmSync(c.state, { recursive: true, force: true }); }
    });

    await test('予約の自動送信: セットに持ち主が居なくても、自分で足したものは得ない', async () => {
      const d = pair();
      try {
        writePlugin(d.user, 'rsv-only-user', { needs: ['title.reserved'], api: { calls: ['hub.fanoutReserved'] } });
        const registry = world(d.set, d.user, d.state);
        const grants = [];
        await registry.loadAll();
        registry.attachApi({
          callAs(id, method, params, g) { grants.push(!!(g && g.titleReserved)); return { ok: true }; },
          registerPluginAction() {},
          registerPluginMethod() { return { ok: true }; }
        });
        await seen['rsv-only-user'].api.call('hub.fanoutReserved', { title: 't' });
        assert.deepStrictEqual(grants, [false]);
      } finally { fs.rmSync(d.set, { recursive: true, force: true }); fs.rmSync(d.state, { recursive: true, force: true }); }
    });
  } finally {
    delete global.__c6hold;
    fs.rmSync(a.set, { recursive: true, force: true });
    fs.rmSync(a.state, { recursive: true, force: true });
    fs.rmSync(b.set, { recursive: true, force: true });
    fs.rmSync(b.state, { recursive: true, force: true });
  }
  if (failed) { console.error('[marust] c6 holder tests failed ' + failed); process.exit(1); }
  console.log('[marust] c6 holder tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
