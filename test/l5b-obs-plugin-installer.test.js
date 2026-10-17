'use strict';

// L5b: OBS にプラグインを入れる部品。すべて一時フォルダの偽の場所で行う（本物の ProgramData・Program Files には触らない）。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPluginInstaller } = require('../lib/obs-plugin-installer');
const { specs, runs } = require('../host/layer1/api/ns/obs');

let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l5b-'));
let seq = 0;

function world(opts) {
  const o = opts || {};
  const root = path.join(tmp, 'w' + (seq += 1));
  const bundle = path.join(root, 'bundle');
  const profile = path.join(root, 'ProgramData');
  const obsDir = path.join(root, 'obs-studio-install');
  fs.mkdirSync(path.join(bundle, 'data', 'locale'), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  if (!o.noBundle) {
    fs.writeFileSync(path.join(bundle, 'obs-multi-rtmp.dll'), 'DLL-NEW');
    fs.writeFileSync(path.join(bundle, 'obs-multi-rtmp.pdb'), 'PDB');
    fs.writeFileSync(path.join(bundle, 'obs-multi-rtmp.dll.before-x'), 'OLD');
    fs.writeFileSync(path.join(bundle, 'data', 'locale', 'ja-JP.ini'), 'ja');
    fs.writeFileSync(path.join(bundle, 'data', 'locale', 'en-US.ini'), 'en');
  }
  const placed = path.join(profile, 'obs-studio', 'plugins', 'obs-multi-rtmp', 'bin', '64bit', 'obs-multi-rtmp.dll');
  if (o.existing != null) {
    fs.mkdirSync(path.dirname(placed), { recursive: true });
    fs.writeFileSync(placed, o.existing);
  }
  const legacy = path.join(obsDir, 'obs-plugins', '64bit', 'obs-multi-rtmp.dll');
  if (o.legacy) {
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, 'legacy');
  }
  const calls = { copy: 0, elevated: [] };
  const base = {
    allUsersProfile: profile,
    bundleDirs: [path.join(root, 'nothing'), bundle],
    getObsDir: async () => obsDir,
    listProcesses: async () => (o.running ? 'obs64.exe","1234"' : 'INFO: No tasks are running'),
    elevatedCopy: async (b, t) => {
      calls.elevated.push([b, t]);
      if (o.decline) return { ok: false, declined: true };
      require('../lib/obs-plugin-installer').copyPlugin(b, t);
      return { ok: true };
    }
  };
  if (o.denyCopy) base.copy = () => { calls.copy += 1; const e = new Error('denied'); e.code = 'EACCES'; throw e; };
  const installer = createPluginInstaller(Object.assign(base, o.extra || {}));
  const target = path.join(profile, 'obs-studio', 'plugins', 'obs-multi-rtmp');
  return { installer, calls, placed, target, legacy, bundle, root, profile };
}

function written(w) { return fs.existsSync(path.join(w.profile, 'obs-studio')); }

test('missing → 入れる → same（ハッシュで確かめる。pdb と before は入らない）', async () => {
  const w = world();
  const info = await w.installer.info();
  assert.strictEqual(info.state, 'missing');
  assert.strictEqual(info.bundled, true);
  assert.strictEqual(info.target, w.target);
  assert.strictEqual(info.obsRunning, false);
  assert.strictEqual(info.legacyCopy, false);
  assert.deepStrictEqual(await w.installer.install({}), { ok: true, state: 'same' });
  assert.strictEqual(fs.readFileSync(w.placed, 'utf8'), 'DLL-NEW');
  assert.deepStrictEqual(fs.readdirSync(path.join(w.target, 'data', 'locale')).sort(), ['en-US.ini', 'ja-JP.ini']);
  assert.deepStrictEqual(fs.readdirSync(path.join(w.target, 'bin', '64bit')), ['obs-multi-rtmp.dll']);
  assert.strictEqual((await w.installer.info()).state, 'same');
  assert.strictEqual(w.calls.elevated.length, 0);
});

test('different で overwrite なし → needs-overwrite（何も書かない）。あり → same', async () => {
  const w = world({ existing: 'DLL-HONKE' });
  assert.strictEqual((await w.installer.info()).state, 'different');
  assert.deepStrictEqual(await w.installer.install({}), { ok: false, error: 'needs-overwrite' });
  assert.deepStrictEqual(await w.installer.install({ overwrite: false }), { ok: false, error: 'needs-overwrite' });
  assert.strictEqual(fs.readFileSync(w.placed, 'utf8'), 'DLL-HONKE');
  assert.strictEqual(fs.existsSync(path.join(w.target, 'data')), false);
  assert.deepStrictEqual(await w.installer.install({ overwrite: true }), { ok: true, state: 'same' });
  assert.strictEqual(fs.readFileSync(w.placed, 'utf8'), 'DLL-NEW');
});

test('OBS が動いている → obs-running（何も書かない）', async () => {
  const w = world({ running: true });
  assert.strictEqual((await w.installer.info()).obsRunning, true);
  assert.deepStrictEqual(await w.installer.install({ overwrite: true }), { ok: false, error: 'obs-running' });
  assert.strictEqual(written(w), false);
});

test('同梱なし → no-bundle', async () => {
  const w = world({ noBundle: true });
  assert.strictEqual((await w.installer.info()).bundled, false);
  assert.deepStrictEqual(await w.installer.install({}), { ok: false, error: 'no-bundle' });
  assert.strictEqual(written(w), false);
});

test('普通に写すと EACCES → 管理者の処理を 1 回だけ呼ぶ。成功すれば same', async () => {
  const w = world({ denyCopy: true });
  assert.deepStrictEqual(await w.installer.install({}), { ok: true, state: 'same' });
  assert.strictEqual(w.calls.copy, 1);
  assert.strictEqual(w.calls.elevated.length, 1);
});

test('管理者の確認が断られた → elevation-declined（1 回だけ呼び、何も書かない）', async () => {
  const w = world({ denyCopy: true, decline: true });
  assert.deepStrictEqual(await w.installer.install({}), { ok: false, error: 'elevation-declined' });
  assert.strictEqual(w.calls.elevated.length, 1);
  assert.strictEqual(fs.existsSync(w.placed), false);
});

test('EACCES 以外の失敗では管理者の処理を呼ばない', async () => {
  const w = world({ extra: { copy: () => { const e = new Error('x'); e.code = 'ENOSPC'; throw e; } } });
  assert.deepStrictEqual(await w.installer.install({}), { ok: false, error: 'copy-failed' });
  assert.strictEqual(w.calls.elevated.length, 0);
});

test('古い場所にある → legacyCopy true（消さない）', async () => {
  const w = world({ legacy: true });
  const info = await w.installer.info();
  assert.strictEqual(info.legacyCopy, true);
  assert.strictEqual(info.legacyPath, w.legacy);
  await w.installer.install({});
  assert.strictEqual(fs.readFileSync(w.legacy, 'utf8'), 'legacy');
});

test('管理者の処理に渡すのは、同梱の場所と入れる場所の 2 つだけ（人の入力は入らない）', async () => {
  const w = world({ denyCopy: true });
  await w.installer.install({ overwrite: true, evil: '"; calc; "', target: 'C:\\x', bundle: 'C:\\y' });
  assert.strictEqual(w.calls.elevated.length, 1);
  assert.deepStrictEqual(w.calls.elevated[0], [w.bundle, w.target]);
  assert.strictEqual(w.calls.elevated[0].length, 2);
});

test('既定の管理者の処理: 入れる場所が obs-studio\\plugins\\obs-multi-rtmp でなければ動かさない', async () => {
  const w = world({ denyCopy: true, extra: { elevatedCopy: undefined } });
  // 偽の場所（…\ProgramData\obs-studio\plugins\obs-multi-rtmp）は形が合うが、"$ を含む場所は断る
  const bad = createPluginInstaller({
    allUsersProfile: path.join(w.root, 'Prog"Data'),
    bundleDirs: [w.bundle],
    getObsDir: async () => '',
    listProcesses: async () => '',
    copy: () => { const e = new Error('d'); e.code = 'EPERM'; throw e; }
  });
  assert.deepStrictEqual(await bad.install({}), { ok: false, error: 'copy-failed' });
});

test('窓口: obs.pluginInfo は read・windowOnly、obs.installPlugin は write・windowOnly', () => {
  assert.strictEqual(specs['obs.pluginInfo'].permission, 'read');
  assert.strictEqual(specs['obs.pluginInfo'].windowOnly, true);
  assert.deepStrictEqual(specs['obs.pluginInfo'].params, {});
  assert.strictEqual(specs['obs.installPlugin'].permission, 'write');
  assert.strictEqual(specs['obs.installPlugin'].windowOnly, true);
  assert.strictEqual(specs['obs.installPlugin'].params.overwrite.type, 'boolean');
});

test('窓口の中身: 部品が無ければ unavailable。OBS が動いていてつながれば vendor を添える', async () => {
  const none = runs({ obsControlOn() {}, setObsControl() {}, src: {} });
  assert.deepStrictEqual(await none['obs.pluginInfo'](), { ok: false, error: 'unavailable' });
  assert.deepStrictEqual(await none['obs.installPlugin']({}), { ok: false, error: 'unavailable' });
  const w = world({ running: true });
  const src = { pluginInstaller: w.installer, obsSetup: { testConnection: async () => ({ ok: true, plugin: { state: 'ok', apiVersion: 3 } }) } };
  const r = runs({ obsControlOn() {}, setObsControl() {}, src });
  const info = await r['obs.pluginInfo']();
  assert.deepStrictEqual(info.vendor, { state: 'ok', apiVersion: 3 });
  const w2 = world();
  const r2 = runs({ obsControlOn() {}, setObsControl() {}, src: { pluginInstaller: w2.installer, obsSetup: { testConnection: async () => { throw new Error('x'); } } } });
  assert.strictEqual((await r2['obs.pluginInfo']()).vendor, undefined);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(failed + ' 件失敗'); process.exit(1); }
  console.log('l5b: すべて ok');
})();
