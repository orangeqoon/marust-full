'use strict';
const { k2 } = require('../../../test/_k2-ctx');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('..');

const ROOT = path.join(__dirname, '..', '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'signal-monitor');

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

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function main() {
  await test('「今の状態を返す」関数は初期値を ok・時刻なしだけ返す', () => {
    const status = plugin.getStatus();
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.state, 'ok');
    assert.strictEqual(status.previous, 'ok');
    assert.strictEqual(status.at, null);
    assert.strictEqual(status.metrics, null);
    assert.strictEqual(status.mode, 'legacy');
    assert.strictEqual(status.text.state, '良好');
  });

  await test('「今の状態を返す」関数は状態変化のあとに値・時刻・直近の値を返す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w51-'));
    const monitor = plugin._test.monitor;
    try {
      plugin.load({
        pluginDir: dir,
        dataDir: dir, ...k2(dir),
        mode() { return 'shadow'; },
        bus: { publish() {} },
        logger() {}
      });
      monitor.start({
        pluginDir: dir,
        dataDir: dir, ...k2(dir),
        mode() { return 'shadow'; },
        bus: { publish() {} },
        logger() {}
      });
      monitor.observe(raw({ outputCongestion: 0.6 }));
      monitor.observe(raw({ outputCongestion: 0.6 }));
      monitor.observe(raw({ outputCongestion: 0.6 }));

      const first = plugin.getStatus();
      assert.strictEqual(first.state, 'degraded');
      assert.strictEqual(first.previous, 'ok');
      assert.strictEqual(first.mode, 'shadow');
      assert.ok(ISO_RE.test(first.at), 'at=' + first.at);
      assert.strictEqual(first.metrics.outputCongestion, 0.6);
      assert.strictEqual(first.text.state, 'やや悪い');
      assert.strictEqual(first.text.congestion, '0.60');
      const firstAt = first.at;

      monitor.observe(raw({ outputCongestion: 0.95, outputReconnecting: true }));
      monitor.observe(raw({ outputCongestion: 0.95, outputReconnecting: true }));
      monitor.observe(raw({ outputCongestion: 0.95, outputReconnecting: true }));

      const second = plugin.getStatus();
      assert.strictEqual(second.state, 'bad');
      assert.strictEqual(second.previous, 'degraded');
      assert.strictEqual(second.mode, 'shadow');
      assert.ok(ISO_RE.test(second.at), 'at=' + second.at);
      assert.notStrictEqual(second.at, firstAt);
      assert.strictEqual(second.metrics.outputReconnecting, true);
      assert.strictEqual(second.text.state, '悪い');
      assert.strictEqual(second.text.reconnecting, '再接続中');
      assert.strictEqual(second.text.mode, 'shadow（見張り中）');
    } finally {
      monitor.stop();
      plugin.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('表示用の文言は 3 つの状態に正しい日本語を返す', () => {
    assert.strictEqual(plugin.panelText({ state: 'ok' }).state, '良好');
    assert.strictEqual(plugin.panelText({ state: 'degraded' }).state, 'やや悪い');
    assert.strictEqual(plugin.panelText({ state: 'bad' }).state, '悪い');
    assert.strictEqual(plugin.panelText({}).state, '不明');
  });

  await test('表示用の文言は legacy のモードに「見張りは止まっています（legacy）」を返す', () => {
    assert.strictEqual(plugin.panelText({ mode: 'legacy' }).mode, '見張りは止まっています（legacy）');
    assert.strictEqual(plugin.panelText({}).mode, '見張りは止まっています（legacy）');
    assert.strictEqual(plugin.panelText({ mode: 'unknown' }).mode, '見張りは止まっています（legacy）');
    assert.strictEqual(plugin.panelText({ mode: 'shadow' }).mode, 'shadow（見張り中）');
    assert.strictEqual(plugin.panelText({ mode: 'live' }).mode, 'live（見張り中）');
  });

  await test('表示用の文言は時刻なしと値なしなら安全な文字を返す', () => {
    const text = plugin.panelText({ state: 'ok', at: null, metrics: null, mode: 'legacy' });
    assert.strictEqual(text.at, 'まだ一度も変わっていません');
    assert.strictEqual(text.congestion, '-');
    assert.strictEqual(text.skippedRate, '-');
    assert.strictEqual(text.reconnecting, '-');
    const withMetrics = plugin.panelText({ metrics: { outputCongestion: 0.123, skippedRate: 0.0456, outputReconnecting: false } });
    assert.strictEqual(withMetrics.congestion, '0.12');
    assert.strictEqual(withMetrics.skippedRate, '4.56%');
    assert.strictEqual(withMetrics.reconnecting, '再接続していない');
  });

  await test('manifest.json に ui.panel@1 がある', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
    assert.ok(Array.isArray(manifest.provides));
    assert.ok(manifest.provides.indexOf('ui.panel@1') !== -1);
    assert.deepStrictEqual(manifest.subscribes, ['signal.stateChanged', 'slot.switching', 'modes.changed']);
    assert.strictEqual(manifest.actions.getStatus, 'read');
    assert.strictEqual(typeof plugin.actions.getStatus, 'function');
    assert.strictEqual(manifest.panels.length, 1);
    assert.strictEqual(manifest.panels[0].file, 'ui/panel.html');
    const html = fs.readFileSync(path.join(PLUGIN_DIR, 'ui', 'panel.html'), 'utf8');
    assert.ok(html.indexOf('src="panel.js"') !== -1);
    assert.ok(html.indexOf('href="panel.css"') !== -1);
    assert.strictEqual(/<script(?![^>]*\bsrc=)/.test(html), false);
    assert.strictEqual(html.indexOf('onclick='), -1);
    const panelJs = fs.readFileSync(path.join(PLUGIN_DIR, 'ui', 'panel.js'), 'utf8');
    assert.ok(panelJs.indexOf('plugin.signal-monitor.getStatus') !== -1);
    assert.strictEqual(panelJs.indexOf('innerHTML'), -1);
    assert.strictEqual(panelJs.indexOf('fetch('), -1);
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('[marust] w51 tests passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
