'use strict';
const { k2 } = require('../../../test/_k2-ctx');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('..');
const { EVENTS } = require('../../../host/core/events');

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

function raw(extra) {
  return Object.assign({
    outputActive: true,
    outputReconnecting: false,
    outputCongestion: 0,
    outputSkippedFrames: 0,
    outputTotalFrames: 100
  }, extra || {});
}

function ctx(dir, obs, mode, events) {
  return {
    pluginDir: dir,
    dataDir: dir, ...k2(dir),
    obs: obs,
    mode() { return mode || 'shadow'; },
    bus: { publish(name, payload) { events.push({ name, payload }); } },
    logger() {}
  };
}

async function main() {
  await test('degraded/bad は設定回数の連続で遷移し、良化も連続回数を要する', async () => {
    const monitor = plugin._test.createMonitor();
    const config = path.join(os.tmpdir(), 'w49-no-config-' + Date.now());
    monitor.start({ pluginDir: config, ...k2(config), dataDir: config, mode: () => 'shadow' });
    monitor.observe(raw({ outputCongestion: 0.6 }));
    assert.strictEqual(monitor.getState(), 'ok');
    monitor.observe(raw({ outputCongestion: 0.6 }));
    assert.strictEqual(monitor.getState(), 'ok');
    monitor.observe(raw({ outputCongestion: 0.6 }));
    assert.strictEqual(monitor.getState(), 'degraded');
    monitor.observe(raw({ outputCongestion: 0.95, outputReconnecting: true }));
    monitor.observe(raw({ outputCongestion: 0.95, outputReconnecting: true }));
    monitor.observe(raw({ outputCongestion: 0.95, outputReconnecting: true }));
    assert.strictEqual(monitor.getState(), 'bad');
    monitor.observe(raw());
    monitor.observe(raw());
    assert.strictEqual(monitor.getState(), 'bad');
    monitor.observe(raw());
    assert.strictEqual(monitor.getState(), 'ok');
    monitor.stop();
  });

  await test('スキップ率は前回との差分で計算する', async () => {
    const rate = plugin._test.skippedRate(
      { outputSkippedFrames: 10, outputTotalFrames: 1000 },
      { outputSkippedFrames: 30, outputTotalFrames: 1500 }
    );
    assert.strictEqual(rate, 0.04);
    assert.strictEqual(plugin._test.skippedRate(null, raw()), 0);
  });

  await test('legacy では OBS を読まない', async () => {
    let calls = 0;
    const events = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w49-'));
    try {
      plugin.load(ctx(dir, { isStreaming: () => { calls += 1; return true; }, getStreamStatus: () => { calls += 1; return raw(); } }, 'legacy', events));
      assert.strictEqual(calls, 0);
      assert.deepStrictEqual(events, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('shadow では配信中だけ読み、状態イベントと JSONL を出す', async () => {
    let streaming = false;
    let calls = 0;
    const events = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w49-'));
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ intervalMs: 1000, consecutiveSamples: 1 }));
      const obs = {
        isStreaming() { return streaming; },
        getStreamStatus() { calls += 1; return raw({ outputCongestion: 0.6 }); }
      };
      const monitor = plugin._test.createMonitor();
      monitor.start(ctx(dir, obs, 'shadow', events));
      await monitor.tick();
      assert.strictEqual(calls, 0);
      streaming = true;
      await monitor.tick();
      assert.strictEqual(calls, 1);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].name, EVENTS.SIGNAL_STATE_CHANGED);
      assert.strictEqual(events[0].payload.state, 'degraded');
      const files = fs.readdirSync(dir).filter((name) => /^shadow-\d{8}\.jsonl$/.test(name));
      assert.strictEqual(files.length, 1);
      assert.ok(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('"state":"degraded"'));
      monitor.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (failed) process.exit(1);
  console.log('[marust] w49 tests passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
