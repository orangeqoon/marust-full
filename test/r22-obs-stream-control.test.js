'use strict';

/**
 * R22: ctx.obs.streamControl（配信全体の開始・停止だけの口）。
 * obs.streamControl と obsControl があり、そのプラグイン自身が live のときだけ通す。obs.read は要らない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createObsConnection } = require('../host/core/engine/obs-connection');

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

const SOURCE = "'use strict';\nmodule.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n";

function writePlugin(root, id, needs) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { manifestVersion: 2, id: id, name: id, version: '0.1.0', kind: 'integration', runtime: 'inproc', defaultMode: 'legacy' };
  if (needs) manifest.needs = needs;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), SOURCE);
}

async function withRegistry(options, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-r22-'));
  const plugins = path.join(root, 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  writePlugin(plugins, 'reader', ['obs.read']);
  writePlugin(plugins, 'controller', ['obs.read', 'obs.streamControl']);
  writePlugin(plugins, 'bulk-title', ['obs.read', 'obs.streamControl']);
  writePlugin(plugins, 'control-only', ['obs.streamControl']);
  const modes = { controller: 'legacy', 'bulk-title': 'legacy' };
  const registry = createRegistry(Object.assign({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: plugins,
    logger() {},
    modeFor: (id) => modes[id] || 'legacy'
  }, options || {}));
  try {
    await registry.loadAll();
    await fn(registry, modes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ctxOf(registry, id) {
  const rec = registry.getRunning().find((row) => row.id === id);
  assert.ok(rec, id + ' not running');
  return rec.ctx;
}

(async () => {
  await test('streamControl は obs.streamControl を宣言したプラグインにだけ渡る（obs.read だけなら関数は無い）', async () => {
    await withRegistry({ obsRead: async () => ({}), obsControl: async () => {} }, async (registry) => {
      assert.strictEqual(typeof ctxOf(registry, 'controller').obs.streamControl, 'function');
      assert.strictEqual(ctxOf(registry, 'reader').obs.streamControl, undefined);
      assert.strictEqual(typeof ctxOf(registry, 'control-only').obs.streamControl, 'function');
    });
  });

  await test('obsControl が渡っていなければ宣言があっても streamControl は無い', async () => {
    await withRegistry({ obsRead: async () => ({}) }, async (registry) => {
      assert.strictEqual(ctxOf(registry, 'controller').obs.streamControl, undefined);
    });
  });

  await test('legacy / shadow では OBS を動かさない。live のときだけ obsControl を呼ぶ（三層目は layer3-no-start・二層目は start 可）', async () => {
    const calls = [];
    await withRegistry({ obsRead: async () => ({}), obsControl: async (action) => { calls.push(action); } }, async (registry, modes) => {
      const obs = ctxOf(registry, 'controller').obs;
      const obsL2 = ctxOf(registry, 'bulk-title').obs;
      assert.deepStrictEqual(await obs.streamControl({ action: 'stop' }), { ok: false, error: 'not-live' });
      modes.controller = 'shadow';
      modes['bulk-title'] = 'shadow';
      assert.deepStrictEqual(await obs.streamControl({ action: 'start' }), { ok: false, error: 'not-live' });
      assert.deepStrictEqual(calls, []);
      modes.controller = 'live';
      modes['bulk-title'] = 'live';
      // 三層目: stop は呼べるが start は layer3-no-start
      assert.deepStrictEqual(await obs.streamControl({ action: 'stop' }), { ok: true });
      assert.deepStrictEqual(await obs.streamControl({ action: 'start' }), { ok: false, error: 'layer3-no-start' });
      assert.deepStrictEqual(calls, ['stop']);
      // 二層目: start も呼べる
      assert.deepStrictEqual(await obsL2.streamControl({ action: 'start' }), { ok: true });
      assert.deepStrictEqual(calls, ['stop', 'start']);
      assert.deepStrictEqual(await obs.streamControl({ action: 'check' }), { ok: true });
      assert.deepStrictEqual(await obs.streamControl({ action: 'restart' }), { ok: false, error: 'bad-action' });
      assert.deepStrictEqual(await obs.streamControl({}), { ok: false, error: 'bad-action' });
      assert.deepStrictEqual(await obs.streamControl(null), { ok: false, error: 'bad-action' });
      assert.deepStrictEqual(calls, ['stop', 'start', 'check']);
    });
  });

  await test('OBS 操作がオフ・未接続・失敗は理由の符号だけ返す（メッセージは出さない）', async () => {
    let boom = null;
    await withRegistry({ obsRead: async () => ({}), obsControl: async () => { throw boom; } }, async (registry, modes) => {
      modes['bulk-title'] = 'live';
      const obs = ctxOf(registry, 'bulk-title').obs;
      boom = new Error('obs-control-off');
      assert.deepStrictEqual(await obs.streamControl({ action: 'stop' }), { ok: false, error: 'obs-control-off' });
      boom = new Error('human-stopped');
      assert.deepStrictEqual(await obs.streamControl({ action: 'start' }), { ok: false, error: 'human-stopped' });
      boom = Object.assign(new Error('secret-host.local refused'), { code: 'OBS_NOT_CONNECTED' });
      assert.deepStrictEqual(await obs.streamControl({ action: 'stop' }), { ok: false, error: 'obs-not-connected' });
      boom = new Error('secret-host.local refused');
      const other = await obs.streamControl({ action: 'start' });
      assert.deepStrictEqual(other, { ok: false, error: 'failed' });
      assert.ok(JSON.stringify(other).indexOf('secret-host') === -1);
    });
  });

  await test('読む口は今まで通り（getStreamStatus / isStreaming）', async () => {
    await withRegistry({ obsRead: async () => ({ outputActive: true, outputDuration: 5 }), obsControl: async () => {} }, async (registry) => {
      const obs = ctxOf(registry, 'controller').obs;
      assert.strictEqual(await obs.isStreaming(), true);
      assert.deepStrictEqual(await obs.getStreamStatus(), { outputActive: true, outputDuration: 5 });
      assert.ok(Object.isFrozen(obs));
    });
  });

  await test('obs-connection: call は StartStream / StopStream を拒否したまま。controlStream だけが通す', async () => {
    const sent = [];
    class Fake {
      on() {}
      async connect() {}
      async disconnect() {}
      async call(name) { sent.push(name); return {}; }
    }
    const conn = createObsConnection({
      core: { STATE_DIR: path.join(os.tmpdir(), 'marust-r22-none'), ROOT_DIR: path.join(os.tmpdir(), 'marust-r22-none') },
      client: new Fake(),
      getStored: async () => ({ host: 'localhost', port: 4455, password: 'x' }),
      logger() {}
    });
    await assert.rejects(conn.controlStream('stop'), (e) => e && e.code === 'OBS_NOT_CONNECTED');
    await conn.start();
    await assert.rejects(conn.call('StartStream'), (e) => e && e.code === 'OBS_REQUEST_FORBIDDEN');
    await assert.rejects(conn.call('StopStream'), (e) => e && e.code === 'OBS_REQUEST_FORBIDDEN');
    await assert.rejects(conn.controlStream('delete'), (e) => e && e.code === 'OBS_REQUEST_FORBIDDEN');
    assert.deepStrictEqual(sent, []);
    await conn.controlStream('stop');
    await conn.controlStream('start');
    assert.deepStrictEqual(sent, ['StopStream', 'StartStream']);
    conn.stop();
  });

  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
})();
