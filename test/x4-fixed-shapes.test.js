'use strict';
require('./_ui-inline');

/**
 * 計画 X S3.5: 固定の試験。後の段（api.js・plugin-registry.js を割る）で「外から見える形が変わっていない」ことを確かめる安全網。
 *   1. api.describe の全行（メソッド名・権限・windowOnly・params の形）を fixtures/api-describe.json に固定
 *   2. createRegistry の戻り値のキー（24 個）を固定
 *   3. だれにどの ctx の口が渡るか（内蔵・作者用・外から × needs／provides）を fixtures/ctx-doors.json に固定
 * 意図して変えたときは UPDATE_FIXTURES=1 node test/x4-fixed-shapes.test.js で書き直し、差分を見てコミットする。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApi } = require('../host/layer1/api');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { WINDOW_ID } = require('../host/layer1/clients');

const FIX = path.join(__dirname, 'fixtures');
const UPDATE = process.env.UPDATE_FIXTURES === '1';
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function fixture(name, actual) {
  const file = path.join(FIX, name);
  if (UPDATE || !fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n'); return; }
  const want = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), want, name + ' が変わった。意図した変更なら UPDATE_FIXTURES=1 で書き直して差分を確かめる');
}

(async () => {
  await test('api.describe: 本体のメソッド全部の名前・権限・windowOnly・params の形が固定されている', async () => {
    const described = await createApi({}).call('api.describe', {}, { clientId: WINDOW_ID, kind: 'window', permissions: ['read'] });
    assert.strictEqual(described.ok, true);
    const rows = described.methods.map((m) => ({ method: m.method, permission: m.permission, windowOnly: m.windowOnly, noApproval: m.noApproval, owner: m.owner, params: m.params }));
    rows.sort((a, b) => (a.method < b.method ? -1 : 1));
    fixture('api-describe.json', rows);
  });

  await test('createRegistry: 戻り値のキーが固定されている（割っても外の形は変えない）', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'x4-state-'));
    try {
      const registry = createRegistry({ core: { STATE_DIR: state }, appRoot: state, builtinRoot: state, externalRoot: path.join(state, 'plugins'), logger: () => {} });
      assert.deepStrictEqual(Object.keys(registry).sort(), [
        'appliedTier', 'applyTier', 'attachApi', 'bootResults', 'dataPlugins', 'discover', 'events', 'getRunning', 'holdsObs', 'isLoaded', 'loadAll', 'logsOf', 'noteRefused',
        'overlayHub', 'paths', 'pendingTier', 'port', 'portHit', 'reload', 'reloadAll', 'rescanExternal', 'snapshot', 'sourceOf', 'tierBlocked'
      ].sort());
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
  });

  await test('ctx の口: だれにどの口が渡るか（内蔵・作者用・外から入れたもの × needs／provides）が固定されている', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'x4-state-'));
    const roots = { builtin: path.join(state, 'b'), author: path.join(state, 'a'), external: path.join(state, 'plugins') };
    global.__x4ctx = {};
    try {
      const mk = (source, id, extra) => {
        const dir = path.join(roots[source], id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', provides: [], defaultMode: 'live', tier: 'basic' }, extra)));
        fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { load(ctx) { global.__x4ctx[ctx.id] = ctx; }, start() {}, stop() {}, destroy() {} };\n");
      };
      const cases = {
        'b-plain': ['builtin', {}],
        'b-keys': ['builtin', { needs: ['keys'] }],
        'b-open': ['builtin', { needs: ['external.open'], external: { hosts: ['example.com'] } }],
        'b-session': ['builtin', { provides: ['session.store@1'] }],
        'b-inlet': ['builtin', { provides: ['chat.inlet@1'] }],
        'b-obs': ['builtin', { needs: ['obs.read'] }],
        'b-api': ['builtin', { api: { namespaces: ['xdemo'] } }],
        'a-plain': ['author', {}],
        'a-keys': ['author', { needs: ['keys'] }],
        'e-plain': ['external', {}],
        'e-keys': ['external', { needs: ['keys'] }],
        'e-api': ['external', { api: { namespaces: ['xext'] } }]
      };
      Object.keys(cases).forEach((id) => mk(cases[id][0], id, cases[id][1]));
      const registry = createRegistry({
        core: { STATE_DIR: state }, appRoot: state, builtinRoot: roots.builtin, authorRoot: roots.author, externalRoot: roots.external,
        modeFor: () => 'live', store: { snapshot: () => ({ session: { title: 't' } }) }, keys: () => ({}), openExternal: () => Promise.resolve(), obsRead: () => ({}),
        logger: () => {}
      });
      await registry.loadAll();
      const table = {};
      Object.keys(cases).forEach((id) => {
        const ctx = global.__x4ctx[id];
        table[id] = ctx ? { keys: Object.keys(ctx).sort(), doors: ['keys', 'external', 'pluginStates', 'obs', 'core', 'app', 'api'].filter((k) => ctx[k] != null), legacySession: !!(ctx.destinations && typeof ctx.destinations.legacySession === 'function' && ctx.destinations.legacySession()) } : null;
      });
      fixture('ctx-doors.json', table);
      // L8d: 外から入れたものにも core・app は渡り、宣言した口が渡る。宣言のない口は渡らない
      ['e-plain', 'e-keys', 'e-api'].forEach((id) => {
        if (!table[id]) return;
        assert.ok(table[id].doors.indexOf('core') !== -1, id + ' に core が渡る');
        assert.ok(table[id].doors.indexOf('app') !== -1, id + ' に app が渡る');
        ['pluginStates', 'external'].forEach((k) => assert.ok(table[id].doors.indexOf(k) === -1, id + ' に ' + k + ' は渡らない'));
      });
      assert.ok(table['e-api'].doors.indexOf('api') !== -1, 'e-api に api が渡る');
    } finally { delete global.__x4ctx; fs.rmSync(state, { recursive: true, force: true }); }
  });


  await test('窓口: 道を見る順番が固定されている（Host → プラグインの画面 → /pair/* → 拡張 → 旧い経路 → /health → 画面 → /ui/ → /vendor/）', () => {
    const src = require('./_gateway-source').read();
    const marks = ['if (!hostOk(req))', 'if (servePluginSurface(req, res, pathname)) return;', "pathname === '/pair/native'", "pathname === '/pair/extension'", "pathname === '/pair'", 'extReceiver.handle(req, res)', 'receiver.handle(req, res)', "pathname === '/health'", "pathname === '/index.html'", "pathname.startsWith('/ui/')", "pathname.startsWith('/vendor/dockview/')"];
    let at = -1;
    marks.forEach((m) => {
      const i = src.indexOf(m, at + 1);
      assert.ok(i > at, m + ' の位置（順番が変わった）');
      at = i;
    });
  });

  await test('起動の順番: electron-main は 登録簿 → 窓口 → listen → attachApi の順（api は窓口に渡し、登録簿へは窓口のあとにつなぐ）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
    const marks = ['registry = createRegistry(', 'gateway = createGateway(', 'gateway.listen(', 'registry.attachApi('];
    let at = -1;
    marks.forEach((m) => {
      const i = src.indexOf(m, at + 1);
      assert.ok(i > at, m + ' の位置（作る順番が変わった）');
      at = i;
    });
  });

  if (failed) { console.error('[x4] ' + failed + ' failed'); process.exit(1); }
  console.log('[marust] x4 fixed shapes tests passed');
})();
