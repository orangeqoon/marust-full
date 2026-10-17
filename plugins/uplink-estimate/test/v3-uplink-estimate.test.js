'use strict';
require('../../../test/_ui-inline');

/**
 * V3 C3: 内蔵プラグイン uplink-estimate（回線の余裕。PLAN-V3 V3-5〜V3-8）。
 * 切ると uplink.* は unknown-method・旧 ui-settings.json の 3 欄は初回だけ写す・engine.targetRates はキー/URL を返さない・
 * ctx.api.call は engine.targetRates しか呼べない・uplink.setSettings は窓だけ。偽のエンジンだけ。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUplinkWorld } = require('../../../test/_uplink-world');
const { WINDOW_ID } = require('../../../host/layer1/clients');
const { loadSettings } = require('../lib/settings');

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
const T = (name, kbps, enabled) => ({ id: name, name, enabled: enabled !== false, kbps, source: 'config' });
const ownFile = (w) => path.join(w.state, 'data', 'marust', 'plugins', 'uplink-estimate', 'settings.json');
const oldFile = (w) => path.join(w.state, 'data', 'marust', 'ui-settings.json');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

(async () => {
  await test('manifest: 決め（V3-6）のとおり', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'plugins', 'uplink-estimate', 'manifest.json'), 'utf8'));
    ['category', 'for', 'tags', 'owns'].forEach((k) => delete m[k]); (m.panels || []).forEach((panel) => { ['aliases', 'dock', 'dockOrder', 'menu'].forEach((k) => delete panel[k]); }); // 名乗り（計画 X）は、この「決め」の対象に入れない（x0 と manifest-claims の試験が見る）
    assert.deepStrictEqual(m, {
      id: 'uplink-estimate', name: '回線の余裕', version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'ui',
      feature: { label: '回線の余裕', hint: '使う配信先のビットレートを足して、上りの速さと比べます（外へは通信しません）', level: 'standard', activation: 'live', group: 'uplink', order: 79, openPanel: 'plugin:uplink-estimate:main' },
      provides: ['ui.panel@1'], panels: [{ name: 'main', title: '回線の余裕', file: 'ui/panel.html' }], ui: { relay: ['uplink.setSettings'] },
      defaultMode: 'legacy', audience: 'public', stability: 'stable', tier: 'standard',
      api: { namespaces: ['uplink'], calls: ['engine.targetRates'] },
      coreApi: 2, needs: ['api.call', 'api.register', 'storage']
    });
  });

  await test('切る（legacy）と uplink.* は unknown-method・describe に無い。入れると今までどおり', async () => {
    const w = await createUplinkWorld({ rates: [T('a', 5000)], modes: { 'uplink-estimate': 'legacy' } });
    try {
      const names = async () => (await w.api.call('api.describe', {}, win)).methods.map((m) => m.method);
      assert.ok(!(await names()).some((n) => n.startsWith('uplink.')));
      for (const m of ['uplink.estimate', 'uplink.last']) assert.deepStrictEqual(await w.api.call(m, {}, win), { ok: false, error: 'unknown-method' });
      assert.deepStrictEqual(await w.api.call('uplink.setSettings', { uplinkMbps: 1 }, win), { ok: false, error: 'unknown-method' });
      assert.strictEqual(w.calls, 0, '切っているあいだは OBS も読まない');
      w.modes['uplink-estimate'] = 'live';
      assert.deepStrictEqual((await names()).filter((n) => n.startsWith('uplink.')).sort(), ['uplink.estimate', 'uplink.last', 'uplink.setSettings']);
      assert.strictEqual((await w.api.call('uplink.estimate', {}, win)).ok, true);
    } finally { w.done(); }
  });

  await test('describe の行は移す前と同じ（権限・windowOnly・引数の規則・説明）。持ち主だけが uplink-estimate', async () => {
    const w = await createUplinkWorld({});
    try {
      const rows = {};
      (await w.api.call('api.describe', {}, win)).methods.forEach((m) => { rows[m.method] = m; });
      const est = rows['uplink.estimate'];
      const set = rows['uplink.setSettings'];
      const last = rows['uplink.last'];
      assert.deepStrictEqual([est.permission, est.windowOnly, est.noApproval, est.owner], ['read', false, false, 'uplink-estimate']);
      assert.deepStrictEqual([set.permission, set.windowOnly, set.noApproval], ['write', true, false]);
      assert.deepStrictEqual([last.permission, last.windowOnly], ['read', false]);
      assert.deepStrictEqual(Object.keys(set.params).sort(), ['shortPercent', 'tightPercent', 'uplinkMbps']);
      assert.deepStrictEqual(est.params, {});
      assert.deepStrictEqual(last.params, {});
      assert.strictEqual(est.description, '回線の余裕（R7）: 使う予定の配信先のビットレートを OBS から読んで足し、使う人が入れた上りの速さと比べる。読めない配信先は「不明」。外へは通信しない');
      assert.strictEqual(set.description, '上りの速さ（Mbps）と、「ぎりぎり」「足りない」の割合（%）を保存する。ウィンドウだけ');
      assert.strictEqual(last.description, '回線の余裕の「最後の判定」と計算した時刻を返す（読むだけ。OBS は読まない。ホームの 1 行用。まだ計算していなければ last は null）');
      // 本体の読むだけの口
      const tr = rows['engine.targetRates'];
      assert.deepStrictEqual([tr.permission, tr.windowOnly, tr.owner, tr.params], ['read', false, '', {}]);
    } finally { w.done(); }
  });

  await test('uplink.setSettings は窓以外 forbidden（ブラウザ）', async () => {
    const w = await createUplinkWorld({});
    try {
      assert.strictEqual((await w.api.call('uplink.setSettings', { uplinkMbps: 30 }, browser)).error, 'forbidden');
      assert.ok(!fs.existsSync(ownFile(w)), '書かれない');
      assert.strictEqual((await w.api.call('uplink.setSettings', { uplinkMbps: 30 }, win)).ok, true);
    } finally { w.done(); }
  });

  await test('設定の移しかえ: 旧 ui-settings.json の 3 欄を初回だけ写す・範囲外は既定・旧ファイルは変わらない', async () => {
    const legacy = { devMode: true, uplinkMbps: 30, uplinkTightPercent: 5, uplinkShortPercent: 80, other: 'x' };
    const w = await createUplinkWorld({ legacyUi: legacy });
    try {
      const before = fs.readFileSync(oldFile(w), 'utf8');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(ownFile(w), 'utf8')), { version: 1, uplinkMbps: 30, tightPercent: 70, shortPercent: 80 }, '範囲外（5）は既定の 70');
      assert.strictEqual(fs.readFileSync(oldFile(w), 'utf8'), before, '旧ファイルは書き換えない');
      // 旧い値が変わっても、2 回目の load は settings.json だけを見る
      fs.writeFileSync(oldFile(w), JSON.stringify({ uplinkMbps: 99, uplinkTightPercent: 50, uplinkShortPercent: 60 }));
      const ctx = globalThis.__uplinkCtx;
      assert.deepStrictEqual(loadSettings(ctx), { uplinkMbps: 30, tightPercent: 70, shortPercent: 80 });
      // 型違い（文字列）・範囲外の上限・下限ちょうど
      fs.rmSync(ownFile(w));
      fs.writeFileSync(oldFile(w), JSON.stringify({ uplinkMbps: '20', uplinkTightPercent: 101, uplinkShortPercent: 10 }));
      assert.deepStrictEqual(loadSettings(ctx), { uplinkMbps: 0, tightPercent: 70, shortPercent: 10 });
      assert.strictEqual(JSON.parse(fs.readFileSync(ownFile(w), 'utf8')).version, 1);
      // 画面の設定の保存は settings.json へ。旧ファイルには書かない
      const oldBefore = fs.readFileSync(oldFile(w), 'utf8');
      assert.strictEqual((await w.api.call('uplink.setSettings', { uplinkMbps: 12 }, win)).uplinkMbps, 12);
      assert.strictEqual(fs.readFileSync(oldFile(w), 'utf8'), oldBefore);
      assert.strictEqual(JSON.parse(fs.readFileSync(ownFile(w), 'utf8')).uplinkMbps, 12);
    } finally { w.done(); }
  });

  await test('設定の移しかえ: 旧ファイルが無い・壊れているときは既定で続く。書けなくても写した値でメモリだけで続く', async () => {
    const none = await createUplinkWorld({});
    try {
      assert.ok(!fs.existsSync(ownFile(none)), '旧ファイルが無ければ何も書かない');
      const est = await none.api.call('uplink.estimate', {}, win);
      assert.strictEqual(est.uplinkMbps, 0);
      assert.deepStrictEqual(est.thresholds, { tightPercent: 70, shortPercent: 90 });
    } finally { none.done(); }
    const broken = await createUplinkWorld({ legacyUi: {} });
    try {
      fs.rmSync(ownFile(broken), { force: true });
      fs.writeFileSync(oldFile(broken), '{');
      assert.deepStrictEqual(loadSettings(globalThis.__uplinkCtx), { uplinkMbps: 0, tightPercent: 70, shortPercent: 90 });
    } finally { broken.done(); }
    const ro = await createUplinkWorld({ legacyUi: { uplinkMbps: 40 } });
    try {
      fs.rmSync(ownFile(ro));
      // dataDir の下を作れない形（ふつうのファイルの下）にして、書き込みを失敗させる
      // K3: 旧い置き場は dataDir の 2 つ上。<data>/marust/ にふつうのファイルを置き、その下を dataDir にする
      const blocker = path.join(ro.state, 'data', 'marust', 'blocker-file');
      fs.writeFileSync(blocker, 'not a dir');
      const ctx = { dataDir: path.join(blocker, 'x') };
      assert.strictEqual(loadSettings(ctx).uplinkMbps, 40, '書けなくても写した値でメモリだけで続く');
    } finally { ro.done(); }
  });

  await test('engine.targetRates: 行は id・name・enabled・kbps・source だけ。偽のエンジンが key・url を返しても出ない', async () => {
    const w = await createUplinkWorld({
      rates: [{ id: 't1', name: 'YouTube', enabled: true, kbps: 6000, source: 'live', key: 'SECRET-KEY-1234', url: 'rtmp://x.example/live/SECRET', streamKey: 'S2', service_settings: { key: 'S3' } }]
    });
    try {
      const got = await w.api.call('engine.targetRates', {}, browser);
      assert.deepStrictEqual(got, { ok: true, targets: [{ id: 't1', name: 'YouTube', enabled: true, kbps: 6000, source: 'live' }] });
      assert.ok(!/SECRET|rtmp|S2|S3/.test(JSON.stringify(got)));
      const est = await w.api.call('uplink.estimate', {}, win);
      assert.ok(!/SECRET|rtmp|S2|S3/.test(JSON.stringify(est)), 'uplink.estimate の答えにも出ない');
      w.rates = new Error('x');
      assert.deepStrictEqual(await w.api.call('engine.targetRates', {}, browser), { ok: false, error: 'not-connected' });
      w.rates = null;
      assert.deepStrictEqual(await w.api.call('engine.targetRates', {}, browser), { ok: false, error: 'not-connected' }, '配列でなければ読めなかったとして扱う');
    } finally { w.done(); }
    const bare = await createUplinkWorld({ extraApi: { engine: {} } });
    try {
      assert.deepStrictEqual(await bare.api.call('engine.targetRates', {}, browser), { ok: false, error: 'unavailable' });
    } finally { bare.done(); }
  });

  await test('ctx.api.call は engine.targetRates しか呼べない（manifest の api.calls）', async () => {
    const w = await createUplinkWorld({ rates: [T('a', 5000)] });
    try {
      const ctx = globalThis.__uplinkCtx;
      assert.strictEqual((await ctx.api.call('engine.targetRates', {})).ok, true);
      for (const m of ['hub.getState', 'engine.targetStats', 'engine.status', 'api.describe', 'hub.fanout', 'engine.setKey']) {
        assert.deepStrictEqual(await ctx.api.call(m, {}), { ok: false, error: 'not-declared' }, m);
      }
    } finally { w.done(); }
  });

  await test('uplink.last: 計算前は null・計算後は 6 欄だけ・失敗では更新しない', async () => {
    const w = await createUplinkWorld({ rates: [T('a', 5000), T('b', null)] });
    try {
      assert.deepStrictEqual(await w.api.call('uplink.last', {}, browser), { ok: true, last: null });
      await w.api.call('uplink.setSettings', { uplinkMbps: 10 }, win);
      await w.api.call('uplink.estimate', {}, win);
      const last = (await w.api.call('uplink.last', {}, browser)).last;
      assert.deepStrictEqual(Object.keys(last).sort(), ['at', 'plannedKbps', 'ratioPercent', 'unknownCount', 'uplinkMbps', 'verdict']);
      assert.deepStrictEqual([last.verdict, last.plannedKbps, last.uplinkMbps, last.ratioPercent, last.unknownCount], ['ok', 5000, 10, 50, 1]);
      assert.ok(!Number.isNaN(Date.parse(last.at)));
      const keep = JSON.stringify(last);
      w.rates = new Error('x');
      await w.api.call('uplink.estimate', {}, win);
      assert.strictEqual(JSON.stringify((await w.api.call('uplink.last', {}, browser)).last), keep);
    } finally { w.done(); }
  });

  await test('本体から uplink が消えている: host/uplink.js・home-state の控え・ui-settings の 3 欄・api.js の assess', () => {
    const root = path.join(__dirname, '..', '..', '..');
    assert.ok(!fs.existsSync(path.join(root, 'host', 'uplink.js')));
    assert.ok(fs.existsSync(path.join(root, 'plugins', 'uplink-estimate', 'lib', 'assess.js')));
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/uplink/i.test(read('host/layer1/home-state.js')));
    assert.ok(!/uplink/i.test(read('host/layer1/ui-settings.js')));
    assert.ok(!/assessUplink|noteUplink|uplinkLast|getUplink|'uplink\./.test(require('../../../test/_api-source').read()));
    const { createUiSettings } = require('../../../host/layer1/ui-settings');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-ui-'));
    try {
      const ui = createUiSettings({ stateDir: dir });
      assert.strictEqual(ui.getUplink, undefined);
      assert.strictEqual(ui.set({ uplinkMbps: 30 }).error, 'bad-key', '本体はもう uplink の欄を知らない');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('v3-uplink-estimate: all ok');
})();
