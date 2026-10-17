'use strict';
require('../../../test/_ui-inline');

/**
 * V3 C4: 内蔵プラグイン hotkeys（ホットキーの入／切の印。PLAN-V3 V3-10）。
 * manifest・中身の無い印・registry で読み込める・「機能」の一覧に advanced で出る・名前空間 hotkeys はプラグインが名乗れない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../../../host/core/core-bridge');
const { createApi, CORE_NAMESPACES } = require('../../../host/layer1/api');
const { createRegistry } = require('../../../host/layer1/plugin-registry');
const { WINDOW_ID } = require('../../../host/layer1/clients');

const DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'hotkeys');
const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

(async () => {
  await test('manifest: 決め（V3-10）のとおり。印だけ（API・秘密・OBS・サイトを持たない）', () => {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
    ['category', 'for', 'tags', 'owns'].forEach((k) => delete m[k]); (m.panels || []).forEach((panel) => { ['aliases', 'dock', 'dockOrder', 'menu'].forEach((k) => delete panel[k]); }); // 名乗り（計画 X）は、この「決め」の対象に入れない（x0 と manifest-claims の試験が見る）
    assert.deepStrictEqual(m, {
      id: 'hotkeys', name: 'ホットキー', version: '1.1.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'ui',
      feature: { label: 'ホットキー', hint: 'キーを押して、配信の開始・停止や非常停止などを呼べます（丸ストが後ろにあっても効きます）', level: 'standard', activation: 'live', group: 'hotkeys', order: 90, openPanel: 'plugin:hotkeys:main' },
      provides: ['ui.panel@1'], panels: [{ name: 'main', title: 'ホットキー', file: 'ui/panel.html' }], ui: { relay: ['hotkeys.save'] },
      defaultMode: 'legacy', audience: 'public', stability: 'stable', tier: 'standard',
      needs: ['keys', 'api.register', 'events.subscribe'], subscribes: ['modes.changed', 'plugin.reloaded'], api: { namespaces: ['hotkeys'] }, coreApi: 2
    });
    // K3: キーの検査・登録・押下の実行は核の ctx.keys。プラグインは API の名前と reload のきっかけだけ
    const inst = require(path.join(DIR, 'index.js'));
    ['stop', 'destroy'].forEach((k) => assert.strictEqual(inst[k](), undefined, k));
    assert.strictEqual(typeof inst.onEvent, 'function');
    assert.deepStrictEqual(inst.health().ok, true);
  });

  await test('registry で読み込める・既定は切・「機能」の一覧に standard で出る', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-hk-'));
    try {
      const state = path.join(root, 'state');
      const builtin = path.join(root, 'builtin');
      fs.mkdirSync(path.join(state, 'services'), { recursive: true });
      fs.mkdirSync(path.join(builtin, 'hotkeys'), { recursive: true });
      fs.copyFileSync(path.join(DIR, 'manifest.json'), path.join(builtin, 'hotkeys', 'manifest.json'));
      fs.writeFileSync(path.join(builtin, 'hotkeys', 'index.js'), 'module.exports = require(' + JSON.stringify(path.join(DIR, 'index.js')) + ');\n');
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
      assert.strictEqual(registry.snapshot().find((r) => r.id === 'hotkeys').status, 'running');
      const f = (await api.call('features.list', {}, win)).features.find((x) => x.id === 'hotkeys');
      assert.ok(f, 'features.list に出る');
      assert.deepStrictEqual([f.level, f.on], ['standard', false]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('hotkeys は内蔵プラグインの名前空間（K3）: 最初に取ったプラグインだけが hotkeys.* を出せる（CORE_NAMESPACES は 21 個）', () => {
    assert.strictEqual(CORE_NAMESPACES.length, 21);
    assert.ok(CORE_NAMESPACES.indexOf('hotkeys') === -1);
    const api = createApi({ audit: { write() {} }, getState: () => ({}) });
    assert.deepStrictEqual(api.registerPluginMethod('hotkeys', 'hotkeys.list', { access: 'read' }, () => ({ ok: true }), { audience: 'public' }), { ok: true, method: 'hotkeys.list' });
    assert.deepStrictEqual(api.registerPluginMethod('evil', 'hotkeys.evil', { access: 'read' }, () => ({ ok: true }), { audience: 'public' }), { ok: false, error: 'taken' });
  });

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('v3-hotkeys-plugin: all ok');
})();
