'use strict';
require('../../../test/_ui-inline');

/**
 * V4 C2: 内蔵プラグイン backup（バックアップの入／切の印。V3-result「V4 への答え」V4-2）。
 * manifest・中身の無い印・registry で読み込める・settings.* の 4 行は legacy で隠れる・migration.* は切れない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../../../host/core/core-bridge');
const { createApi } = require('../../../host/layer1/api');
const { createRegistry } = require('../../../host/layer1/plugin-registry');
const { WINDOW_ID } = require('../../../host/layer1/clients');

const DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'backup');
const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
const BACKUP_ROWS = ['settings.export', 'settings.exportToFile', 'settings.preview', 'settings.import'];

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function apiWith(mode, extra) {
  const orchestrator = Object.assign({
    modeSetting(id) { return id === 'backup' ? mode.value : 'legacy'; },
    modeFor() { return 'legacy'; }
  }, extra || {});
  return createApi({
    orchestrator,
    audit: { write() {} },
    devMode: { get: () => ({ devMode: true, source: 'default' }) },
    getState() { return { product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
  });
}
const names = async (api) => (await api.call('api.describe', {}, win)).methods.map((m) => m.method);

(async () => {
  await test('manifest: 決め（V4-2）のとおり。印だけ（API・秘密・OBS・サイトを持たない）', () => {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
    ['category', 'for', 'tags', 'owns'].forEach((k) => delete m[k]); (m.panels || []).forEach((panel) => { ['aliases', 'dock', 'dockOrder', 'menu'].forEach((k) => delete panel[k]); }); // 名乗り（計画 X）は、この「決め」の対象に入れない（x0 と manifest-claims の試験が見る）
    assert.deepStrictEqual(m, {
      id: 'backup', name: 'バックアップ', version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'ui',
      feature: { label: 'バックアップ', hint: '設定（レイアウト・モード・ホットキー・配信先・プラグインの設定）をファイルに書き出し、あとで選んで戻せます（秘密は入りません）', level: 'advanced', activation: 'live', group: 'backup', order: 95, openPanel: 'plugin:backup:main' },
      provides: ['ui.panel@1'], panels: [{ name: 'main', title: 'バックアップ', file: 'ui/panel.html' }], ui: { relay: ['settings.exportToFile', 'settings.import'] },
      defaultMode: 'legacy', audience: 'public', stability: 'stable', tier: 'basic', coreApi: 2
    });
    const inst = require(path.join(DIR, 'index.js'));
    ['load', 'start', 'stop', 'destroy'].forEach((k) => assert.strictEqual(inst[k](), undefined, k));
    assert.deepStrictEqual(inst.health(), { ok: true });
  });

  await test('registry で読み込める・既定は切・「機能」の一覧に advanced で出る', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-bk-'));
    try {
      const state = path.join(root, 'state');
      const builtin = path.join(root, 'builtin');
      fs.mkdirSync(path.join(state, 'services'), { recursive: true });
      fs.mkdirSync(path.join(builtin, 'backup'), { recursive: true });
      fs.copyFileSync(path.join(DIR, 'manifest.json'), path.join(builtin, 'backup', 'manifest.json'));
      fs.writeFileSync(path.join(builtin, 'backup', 'index.js'), 'module.exports = require(' + JSON.stringify(path.join(DIR, 'index.js')) + ');\n');
      const real = createCore();
      const core = { STATE_DIR: state, SERVICES_DIR: path.join(state, 'services'), COOKIES_DIR: path.join(state, 'cookies'), DATA_DIR: path.join(state, 'data'), ROOT_DIR: root, atomicWriteJsonSync: real.atomicWriteJsonSync };
      const registry = createRegistry({ core, appRoot: root, builtinRoot: builtin, authorRoot: path.join(root, 'no-author'), externalRoot: path.join(state, 'plugins'), logger() {}, modeFor: () => 'legacy' });
      const api = createApi({
        core,
        devMode: { get: () => ({ devMode: true, source: 'default' }) },
        audit: { write() {} },
        getState: () => ({ product: 'marust', plugins: registry.snapshot().map((r) => Object.assign({}, r, { feature: r.manifest && r.manifest.feature ? r.manifest.feature : null })), destinations: { liveCount: 0 }, engineStatus: { connected: true } })
      });
      registry.attachApi(api);
      await registry.loadAll();
      assert.strictEqual(registry.snapshot().find((r) => r.id === 'backup').status, 'running');
      const f = (await api.call('features.list', {}, win)).features.find((x) => x.id === 'backup');
      assert.ok(f, 'features.list に出る');
      assert.deepStrictEqual([f.level, f.on], ['advanced', false]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('legacy: settings.* の 4 行は describe に無く call は unknown-method。引っ越し（migration.*）は出る', async () => {
    const mode = { value: 'legacy' };
    const api = apiWith(mode);
    const list = await names(api);
    BACKUP_ROWS.forEach((m) => assert.ok(!list.includes(m), m + ' が出ている'));
    ['migration.export', 'migration.import'].forEach((m) => assert.ok(list.includes(m), m + ' が消えた'));
    for (const m of BACKUP_ROWS) {
      assert.deepStrictEqual(await api.call(m, { document: {}, sections: ['layout'] }, win), { ok: false, error: 'unknown-method' }, m);
    }
  });

  await test('live（と shadow）: 4 行が出て、呼べる（unknown-method ではない）', async () => {
    for (const value of ['live', 'shadow']) {
      const api = apiWith({ value });
      const list = await names(api);
      BACKUP_ROWS.forEach((m) => assert.ok(list.includes(m), value + ' で ' + m + ' が無い'));
      for (const m of BACKUP_ROWS) {
        const res = await api.call(m, { document: {}, sections: ['layout'] }, win);
        assert.notStrictEqual(res && res.error, 'unknown-method', m);
      }
    }
  });

  await test('forceLegacy（全部 legacy に固定）でも backup の行は隠れない（設定上のモードを見る）', async () => {
    const api = apiWith({ value: 'live' }, { modeFor() { return 'legacy'; } });
    const list = await names(api);
    BACKUP_ROWS.forEach((m) => assert.ok(list.includes(m), m));
  });

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('v4-backup: all ok');
})();
