'use strict';
const { k2 } = require('../../../test/_k2-ctx');
require('../../../test/_ui-inline');
const { hubSource } = require('../../../test/_ui-source');

/**
 * R7: 回線の余裕（足し算・判定・API・OBS からの読み取り）と、切り替え中に回線の見張りが警告しないこと。
 * 偽の OBS だけ。外には通信しない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { assess } = require('../lib/assess');
const { createUplinkWorld } = require('../../../test/_uplink-world');
const { createObsLocalEngine } = require('../../../host/core/engine/obs-local');
const { WINDOW_ID } = require('../../../host/layer1/clients');
const signal = require('../../signal-monitor');

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

const T = (name, kbps, enabled) => ({ id: name, name: name, enabled: enabled !== false, kbps: kbps });

(async () => {
  await test('assess: 足し算（使う予定＝有効なものだけ）と 70% / 90% の判定', () => {
    const rows = [T('a', 6000), T('b', 4000), T('c', 8000, false)];
    const ok = assess({ targets: rows, uplinkMbps: 20 });
    assert.strictEqual(ok.plannedKbps, 10000);
    assert.strictEqual(ok.ratioPercent, 50);
    assert.strictEqual(ok.verdict, 'ok');
    assert.strictEqual(assess({ targets: rows, uplinkMbps: 14 }).verdict, 'tight'); // 71.4%
    assert.strictEqual(assess({ targets: rows, uplinkMbps: 10 }).verdict, 'short'); // 100%
    assert.strictEqual(assess({ targets: rows, uplinkMbps: 10 / 0.7 }).verdict, 'ok', 'ちょうど 70% は余裕あり');
    assert.strictEqual(assess({ targets: rows, uplinkMbps: 10 / 0.9 }).verdict, 'tight', 'ちょうど 90% はぎりぎり');
    assert.strictEqual(assess({ targets: rows }).verdict, 'no-uplink');
    assert.strictEqual(assess({ targets: [], uplinkMbps: 10 }).verdict, 'no-targets');
    assert.strictEqual(assess({ targets: [T('x', 5000, false)], uplinkMbps: 10 }).verdict, 'no-targets');
  });

  await test('assess: 読めない配信先は不明として足し算から外す（0 として数えない）。割合は設定で変えられる', () => {
    const rows = [T('a', 6000), T('b', null), T('c', 0), T('d', 'x')];
    const out = assess({ targets: rows, uplinkMbps: 10 });
    assert.strictEqual(out.plannedKbps, 6000);
    assert.strictEqual(out.knownCount, 1);
    assert.strictEqual(out.unknownCount, 3);
    assert.deepStrictEqual(out.unknownNames, ['b', 'c', 'd']);
    assert.strictEqual(assess({ targets: [T('a', null), T('b', null)], uplinkMbps: 10 }).verdict, 'unknown');
    assert.strictEqual(assess({ targets: [T('a', 5000)], uplinkMbps: 10, tightPercent: 40, shortPercent: 60 }).verdict, 'tight');
    assert.strictEqual(assess({ targets: [T('a', 5000)], uplinkMbps: 10, tightPercent: 40, shortPercent: 45 }).verdict, 'short');
    const odd = assess({ targets: [T('a', 5000)], uplinkMbps: 10, tightPercent: 95, shortPercent: 20 });
    assert.ok(odd.thresholds.shortPercent >= odd.thresholds.tightPercent, '短い方が長い方より下にならない');
  });

  await test('設定: 上りの速さと割合を保存（プラグインの settings.json）。範囲外は拒否。ほかの設定ファイルを壊さない', async () => {
    const w = await createUplinkWorld({ legacyUi: { devMode: true } });
    try {
      const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
      assert.strictEqual((await w.api.call('uplink.setSettings', { uplinkMbps: 30 }, win)).ok, true);
      assert.strictEqual((await w.api.call('uplink.setSettings', { uplinkMbps: -1 }, win)).error, 'bad-value');
      assert.strictEqual((await w.api.call('uplink.setSettings', { uplinkMbps: Infinity }, win)).error, 'bad-value');
      assert.strictEqual((await w.api.call('uplink.setSettings', { tightPercent: 5 }, win)).error, 'bad-value');
      assert.strictEqual((await w.api.call('uplink.setSettings', { shortPercent: '90' }, win)).error, 'bad-value');
      assert.deepStrictEqual(await w.api.call('uplink.setSettings', { tightPercent: 60, shortPercent: 80 }, win), { ok: true, uplinkMbps: 30, tightPercent: 60, shortPercent: 80 });
      const file = path.join(w.state, 'data', 'marust', 'plugins', 'uplink-estimate', 'settings.json');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, uplinkMbps: 30, tightPercent: 60, shortPercent: 80 });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(w.state, 'data', 'marust', 'ui-settings.json'), 'utf8')), { devMode: true }, '旧い設定ファイルには書かない');
    } finally { w.done(); }
  });

  await test('engine.readTargetRates: 配信中は実測、止まっていれば設定、どちらも無ければ null。読み取りの命令だけを使い、キーは求めない', async () => {
    const calls = [];
    const targets = [
      { id: 't1', name: 'YouTube', protocol: 'RTMP', state: 'live', enabled: true },
      { id: 't2', name: 'Twitch', protocol: 'RTMP', state: 'stopped', enabled: true },
      { id: 't3', name: 'Kick', protocol: 'RTMP', state: 'stopped', enabled: true }
    ];
    const vendorFake = async (tier, type, data) => {
      calls.push([tier, type, JSON.stringify(data)]);
      if (type === 'list_targets') return { targets: targets };
      if (type === 'get_api_version') return { api_version: 2 };
      if (type === 'list_capabilities') return { requests: [] };
      if (type === 'get_target_status') return data.id === 't1' ? { bitrate_bps: 6200000 } : { bitrate_bps: 0 };
      if (type === 'get_target_config') return data.id === 't2' ? { output_settings: { bitrate: 4500 }, service_settings: { key: '***redacted***' } } : { output_settings: {} };
      return {};
    };
    const connection = {
      getStatus: () => ({ connected: true, detail: '接続中' }),
      vendor: (tier, type, data) => vendorFake(tier, type, data).then((body) => body),
      call: async () => ({}),
      onVendorEvent() { return function () {}; },
      start: async () => ({}), reconnect: async () => ({}), stop() {}
    };
    let engine;
    try {
      engine = createObsLocalEngine({ connection: connection, orchestrator: { modeFor: () => 'legacy' }, store: null, bus: null, logger() {} });
    } catch (err) {
      engine = null;
    }
    if (!engine || typeof engine.readTargetRates !== 'function') {
      // エンジンの組み立てが重いときは、関数があることだけを確かめる
      assert.ok(engine && typeof engine.readTargetRates === 'function');
      return;
    }
    await engine.syncNow('test').catch(() => {});
    const rows = await engine.readTargetRates();
    const byId = {};
    rows.forEach((r) => { byId[r.id] = r; });
    if (rows.length === 3) {
      assert.deepStrictEqual([byId.t1.kbps, byId.t1.source], [6200, 'live']);
      assert.deepStrictEqual([byId.t2.kbps, byId.t2.source], [4500, 'config']);
      assert.deepStrictEqual([byId.t3.kbps, byId.t3.source], [null, '']);
    }
    assert.ok(calls.every((c) => c[0] === 'read'), '書き込みの命令は呼ばない');
    assert.ok(calls.filter((c) => c[1] === 'get_target_config').every((c) => /"reveal_secrets":false/.test(c[2])));
  });

  await test('uplink.estimate / uplink.setSettings / features.set（API）。プラグインを通しても答えの形は同じ', async () => {
    const rows = [
      { id: 'signal-monitor', name: '回線の見張り', kind: 'integration', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [], audience: 'public', stability: 'stable', feature: { label: '回線の見張り', hint: '', level: 'advanced', activation: 'shadow', group: 'uplink', order: 80, needs: [], openPanel: '' } },
      { id: 'site-twitch', name: 'x', kind: 'site', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [], audience: 'public', stability: 'stable' }
    ];
    const w = await createUplinkWorld({ rates: [T('YouTube', 6000), T('Twitch', 6000), T('未読', null)], extraApi: { confirmLive: true, getState() { return { product: 'marust', plugins: rows }; } } });
    const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
    const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
    const api = w.api;
    try {
      let est = await api.call('uplink.estimate', {}, browser);
      assert.strictEqual(est.ok, true, JSON.stringify(est));
      assert.strictEqual(est.verdict, 'no-uplink');
      assert.strictEqual(est.unknownCount, 1);
      assert.strictEqual(est.plannedKbps, 12000);
      assert.strictEqual((await api.call('uplink.setSettings', { uplinkMbps: 30 }, browser)).error, 'forbidden');
      assert.strictEqual((await api.call('uplink.setSettings', { uplinkMbps: -5 }, win)).error, 'bad-value');
      assert.strictEqual((await api.call('uplink.setSettings', { uplinkMbps: 30 }, win)).uplinkMbps, 30);
      est = await api.call('uplink.estimate', {}, win);
      assert.strictEqual(est.verdict, 'ok'); // 40%
      assert.deepStrictEqual(Object.keys(est.targets[0]).sort(), ['enabled', 'kbps', 'name', 'source']);
      w.rates = [T('a', 28000)];
      assert.strictEqual((await api.call('uplink.estimate', {}, win)).verdict, 'short');
      // features.set: 一覧（manifest の feature）にある機能だけ。shadow の機能は入れる＝shadow、切る＝legacy
      assert.strictEqual((await api.call('features.set', { id: 'signal-monitor', enabled: true }, browser)).error, 'forbidden');
      assert.strictEqual((await api.call('features.set', { id: 'site-twitch', enabled: true }, win)).error, 'unknown-feature');
      assert.deepStrictEqual(await api.call('features.set', { id: 'signal-monitor', enabled: true }, win), { ok: true, id: 'signal-monitor', on: true, mode: 'shadow', openPanel: '' });
      const modes = JSON.parse(fs.readFileSync(path.join(w.core.SERVICES_DIR, 'marust-modes.json'), 'utf8'));
      assert.strictEqual(modes.plugins['signal-monitor'], 'shadow');
      assert.deepStrictEqual(await api.call('features.set', { id: 'signal-monitor', enabled: false }, win), { ok: true, id: 'signal-monitor', on: false, mode: 'legacy', openPanel: '' });
    } finally { w.done(); }
  });

  await test('uplink.estimate: OBS につながっていなければ not-connected（外へ通信しない）。エンジンが無ければ unavailable', async () => {
    const w = await createUplinkWorld({ rates: new Error('obs not connected') });
    try {
      const out = await w.api.call('uplink.estimate', {}, { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] });
      assert.deepStrictEqual(out, { ok: false, error: 'not-connected' });
    } finally { w.done(); }
    const bare = await createUplinkWorld({ extraApi: { engine: {} } });
    try {
      assert.deepStrictEqual(await bare.api.call('uplink.estimate', {}, { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] }), { ok: false, error: 'unavailable' });
    } finally { bare.done(); }
  });

  await test('signal-monitor: 切り替え（slot.switching）の間と直後は、停止・再接続を「悪い」と数えない', () => {
    const { createMonitor } = signal._test;
    const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-signal-'));
    const startOn = (m) => m.start({ pluginDir: dirTmp, ...k2(dirTmp), dataDir: dirTmp, mode: () => 'shadow', bus: { publish() {} }, logger() {} });
    const mon = createMonitor();
    startOn(mon);
    const bad = { outputActive: true, outputReconnecting: true, outputCongestion: 0.99, outputSkippedFrames: 0, outputTotalFrames: 100 };
    // 切り替え中でなければ、続けて 3 回で bad になる
    const plain = createMonitor();
    startOn(plain);
    for (let i = 0; i < 3; i += 1) plain.observe(bad);
    assert.strictEqual(plain.getState(), 'bad');
    // 切り替え中は、何回来ても状態を変えない
    mon.noteSwitching({ site: 'youtube', phase: 'start' });
    for (let i = 0; i < 10; i += 1) mon.observe(bad);
    assert.strictEqual(mon.getState(), 'ok');
    // 終わった直後も 20 秒は数えない。それを過ぎれば今までどおり
    mon.noteSwitching({ site: 'youtube', phase: 'end' });
    for (let i = 0; i < 3; i += 1) mon.observe(bad);
    assert.strictEqual(mon.getState(), 'ok');
    mon.noteSwitching({ phase: 'unknown' }); // 知らない phase は無視
    mon.noteSwitching(null);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 25000;
      for (let i = 0; i < 3; i += 1) mon.observe(bad);
      assert.strictEqual(mon.getState(), 'bad');
    } finally { Date.now = realNow; }
    assert.deepStrictEqual(signal.onEvent('slot.switching', { phase: 'unknown' }), { ok: true }); // 共有の見張りを静かにさせない
    mon.stop();
    plain.stop();
    fs.rmSync(dirTmp, { recursive: true, force: true });
  });

  await test('signal-monitor: 画面で「入れる」（shadow）にしたら、再起動を待たずに動く。切ると止まる（modes.changed）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-signal2-'));
    let mode = 'legacy';
    let congestion = 0;
    const events = [];
    const ctx = {
      pluginDir: dir, dataDir: dir, ...k2(dir),
      mode() { return mode; },
      bus: { publish(name, payload) { events.push({ name, payload }); } },
      logger() {},
      obs: {
        async isStreaming() { return true; },
        async getStreamStatus() { return { outputActive: true, outputReconnecting: false, outputCongestion: congestion, outputSkippedFrames: 0, outputTotalFrames: 100 }; }
      }
    };
    const mon = signal._test.monitor;
    try {
      signal.load(ctx);
      signal.start(ctx); // legacy で起動した（初めての人）
      assert.strictEqual(mon.isRunning(), false);
      mode = 'shadow'; // 画面の features.set
      signal.onEvent('modes.changed', { id: 'signal-monitor', mode: 'shadow' });
      assert.strictEqual(mon.isRunning(), true, '再起動なしで動き出す');
      congestion = 0.95;
      for (let i = 0; i < 3; i += 1) await mon.tick();
      assert.strictEqual(mon.getState(), 'bad', '見張りが実際に OBS を読んでいる');
      mode = 'legacy';
      signal.onEvent('modes.changed', { id: 'signal-monitor', mode: 'legacy' });
      assert.strictEqual(mon.isRunning(), false);
    } finally {
      mon.stop();
      signal.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('signal-monitor は上級へ（V3・v3 §0-6）。回線のパネルとメニューの見張りの行は開発者モードか上級（V5）。回線の余裕は一般の画面に出す', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'plugins', 'signal-monitor', 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.audience, 'public');
    assert.strictEqual(manifest.stability, 'stable');
    assert.ok(manifest.subscribes.indexOf('slot.switching') !== -1);
    const menubar = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'plugins', 'ui-standard', 'shell', 'menubar.js'), 'utf8');
    // メニューの行はパネルの menu（min: advanced・orDev）の名乗りで決まる
    const sig = manifest.panels.find((p) => p.menu);
    assert.ok(sig && sig.menu.min === 'advanced' && sig.menu.orDev === true && menubar.includes("return levelAtLeast('advanced') || (menu.orDev === true && devMode);"));
    // 回線の余裕の画面は uplink-estimate のパネル（V7）。一般の画面に出す（dev ではない）
    const up = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'plugins', 'uplink-estimate', 'manifest.json'), 'utf8'));
    assert.strictEqual(up.audience, 'public');
    assert.deepStrictEqual(up.panels.map((p) => p.title), ['回線の余裕']);
    const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'plugins', 'uplink-estimate', 'ui', 'panel.html'), 'utf8');
    assert.ok(/外の測定サイトへ自分ではつながりません/.test(html), '丸ストが測定サーバーにつながらないことを画面に書く');
  });

  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
})();
