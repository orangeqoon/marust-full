'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../host/layer1/plugin-registry');

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

const PLUGIN_SOURCE = [
  "'use strict';",
  'module.exports = {',
  '  load() {},',
  '  start() {},',
  '  stop() {},',
  '  destroy() {}',
  '};',
  ''
].join('\n');

function writePlugin(root, id, needs) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    manifestVersion: 2,
    id: id,
    name: id,
    version: '0.1.0',
    kind: 'integration',
    runtime: 'inproc',
    defaultMode: 'legacy'
  };
  if (needs) manifest.needs = needs;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), PLUGIN_SOURCE);
}

async function withRegistry(options, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w50-'));
  const plugins = path.join(root, 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  writePlugin(plugins, 'needs-obs', ['obs.read']);
  writePlugin(plugins, 'no-obs', null);
  const registry = createRegistry(Object.assign({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: plugins,
    logger: function () {}
  }, options || {}));
  try {
    await registry.loadAll();
    await fn(registry);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ctxOf(registry, id) {
  const rec = registry.getRunning().find((row) => row.id === id);
  assert.ok(rec, id + ' が起動していない');
  return rec.ctx;
}

async function main() {
  await test('宣言（needs: [obs.read]）のあるプラグインだけ ctx.obs を持つ', async () => {
    await withRegistry({ obsRead: () => Promise.resolve({ outputActive: true }) }, async (registry) => {
      const obs = ctxOf(registry, 'needs-obs').obs;
      assert.ok(obs, '宣言ありの ctx.obs が無い');
      assert.strictEqual(typeof obs.getStreamStatus, 'function');
      assert.strictEqual(typeof obs.isStreaming, 'function');
    });
  });

  await test('宣言の無いプラグインの ctx.obs は undefined', async () => {
    await withRegistry({ obsRead: () => Promise.resolve({ outputActive: true }) }, async (registry) => {
      assert.strictEqual(ctxOf(registry, 'no-obs').obs, undefined);
    });
  });

  await test('getStreamStatus が obsRead(GetStreamStatus) の結果を返す', async () => {
    const seen = [];
    const status = { outputActive: true, outputCongestion: 0.25, outputSkippedFrames: 1 };
    await withRegistry({
      obsRead: (requestName) => {
        seen.push(requestName);
        return Promise.resolve(status);
      }
    }, async (registry) => {
      const obs = ctxOf(registry, 'needs-obs').obs;
      assert.deepStrictEqual(await obs.getStreamStatus(), status);
      assert.deepStrictEqual(seen, ['GetStreamStatus']);
    });
  });

  await test('getStreamStatus は未接続（失敗）のとき null', async () => {
    await withRegistry({
      obsRead: () => Promise.reject(Object.assign(new Error('obs not connected'), { code: 'OBS_NOT_CONNECTED' }))
    }, async (registry) => {
      const obs = ctxOf(registry, 'needs-obs').obs;
      assert.strictEqual(await obs.getStreamStatus(), null);
    });
  });

  await test('isStreaming は outputActive の true / false / 失敗で返る値が違う', async () => {
    let next = { outputActive: true };
    await withRegistry({
      obsRead: () => {
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      }
    }, async (registry) => {
      const obs = ctxOf(registry, 'needs-obs').obs;
      assert.strictEqual(await obs.isStreaming(), true);
      next = { outputActive: false };
      assert.strictEqual(await obs.isStreaming(), false);
      next = { outputCongestion: 0.1 };
      assert.strictEqual(await obs.isStreaming(), false);
      next = new Error('obs not connected');
      assert.strictEqual(await obs.isStreaming(), false);
    });
  });

  await test('obsRead が無いと宣言があっても ctx.obs が無い', async () => {
    await withRegistry({}, async (registry) => {
      assert.strictEqual(ctxOf(registry, 'needs-obs').obs, undefined);
    });
  });

  await test('ctx.obs に書き込みの関数は無い', async () => {
    await withRegistry({ obsRead: () => Promise.resolve({ outputActive: true }) }, async (registry) => {
      const obs = ctxOf(registry, 'needs-obs').obs;
      assert.deepStrictEqual(Object.keys(obs).sort(), ['getStreamStatus', 'isStreaming']);
      const forbidden = ['call', 'callVendor', 'vendor', 'startStream', 'stopStream', 'StartStream', 'StopStream', 'start', 'stop', 'stopAll', 'setCurrentProgramScene'];
      for (const name of forbidden) {
        assert.strictEqual(obs[name], undefined, 'ctx.obs.' + name + ' が在ってはいけない');
      }
    });
  });

  await test('呼ぶのは GetStreamStatus だけ', async () => {
    const seen = [];
    await withRegistry({
      obsRead: (requestName) => {
        seen.push(requestName);
        return Promise.resolve({ outputActive: true });
      }
    }, async (registry) => {
      const obs = ctxOf(registry, 'needs-obs').obs;
      await obs.getStreamStatus();
      await obs.isStreaming();
      await obs.getStreamStatus();
      assert.ok(seen.length > 0);
      assert.ok(seen.every((name) => name === 'GetStreamStatus'), 'GetStreamStatus 以外を呼んだ: ' + seen.join(','));
    });
  });

  await test('signal-monitor の manifest は obs.read を宣言している', async () => {
    const file = path.join(__dirname, '..', 'plugins', 'signal-monitor', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(manifest.needs));
    assert.ok(manifest.needs.indexOf('obs.read') !== -1);
  });

  if (failed) process.exit(1);
  console.log('[marust] w50 tests passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
