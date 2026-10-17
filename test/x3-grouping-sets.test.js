'use strict';
require('./_ui-inline');

/**
 * 計画 X S5b（P8）: 名乗りで集めて見せる。見せ方 3 通り（種類ごと／サイトごと／段階ごと）・サイトの枠・セット（kind: set）・needs: site:<id>。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const STR = require('../plugins/ui-standard/shell/strings');
const { validateDataManifest, normalizeSet } = require('../host/layer1/data-plugins');
const { buildFeatureList } = require('../host/layer1/features');
const { createApi } = require('../host/layer1/api');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { WINDOW_ID } = require('../host/layer1/clients');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function loadUtil() {
  const ctx = { STR, SITE_ORDER: ['twitch', 'youtube', 'niconico'], window: { localStorage: { getItem: () => null, setItem() {} } }, document: {} };
  vm.createContext(ctx);
  vm.runInContext(read('plugins/ui-standard/shell/core/util.js'), ctx);
  return ctx;
}

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

(async () => {
  await test('見せ方 3 通り: 種類ごと（決まった順）・サイトごと（全部に効く→サイトの順→関係なし）・段階ごと', () => {
    const u = loadUtil();
    const J = (x) => JSON.parse(JSON.stringify(x)); // vm の中の配列は別の Array なので、比べる前に普通の値に直す
    const pick = (r) => ({ category: r.category, for: r.for, level: r.level });
    const rows = [
      { id: 'a', category: 'tool', for: [], level: 'advanced' },
      { id: 'b', category: 'title', for: ['*'], level: 'standard' },
      { id: 'c', category: 'comment', for: ['youtube', 'twitch'], level: 'standard' },
      { id: 'd', category: 'login', for: ['niconico'], level: 'standard' }
    ];
    assert.deepStrictEqual(J(u.groupRowsBy(rows, 'category', pick).map((g) => g.key)), ['cat:login', 'cat:title', 'cat:comment', 'cat:tool']);
    assert.deepStrictEqual(J(u.groupRowsBy(rows, 'site', pick).map((g) => g.key)), ['~all', 'site:twitch', 'site:youtube', 'site:niconico', '~none']);
    assert.deepStrictEqual(J(u.groupRowsBy(rows, 'site', pick).find((g) => g.key === 'site:youtube').rows.map((r) => r.id)), ['c']);
    assert.deepStrictEqual(J(u.groupRowsBy(rows, 'level', pick).map((g) => g.label)), ['中級', '上級']);
    assert.deepStrictEqual(Object.keys(STR.categoryNames).sort(), Object.keys(require('../host/layer1/manifest-claims').CATEGORY_WORDS).sort(), '画面の種類の語は manifest の決まった語と同じ');
  });

  await test('画面: 機能（中級）とプラグインの管理（上級）に見せ方の切り替え、ホームにサイトの枠', () => {
    assert.ok(/buildGroupSwitch\(mode/.test(read('plugins/ui-standard/shell/panels/features.js')) && /groupRowsBy\(rows, mode/.test(read('plugins/ui-standard/shell/panels/features.js')));
    assert.ok(/buildGroupSwitch\(mode/.test(read('plugins/ui-standard/shell/panels/plugin-manager.js')) && /groupRowsBy\(shown, mode/.test(read('plugins/ui-standard/shell/panels/plugin-manager.js')));
    const home = read('plugins/ui-standard/shell/panels/home.js');
    assert.ok(home.includes('siteFrameBlock') && home.includes('features.setSet') && home.includes("call('features.sets'"));
    assert.ok(!/プラグイン|manifest/.test(JSON.stringify(STR.groupModes) + JSON.stringify(STR.siteFrameTitle) + STR.setsTitle + STR.setsHint), '中級の言葉に専門語を出さない');
  });

  await test('セット: データだけのプラグイン（kind: set）。中身は機能の id の一覧だけ。コードや余計な欄は断る', () => {
    const ok = JSON.parse(read('plugins/set-youtube/manifest.json'));
    assert.strictEqual(validateDataManifest(ok).kind, 'set');
    assert.deepStrictEqual(validateDataManifest(ok).set.members, ['slot-youtube', 'bulk-title', 'comment-send']);
    assert.strictEqual(validateDataManifest(Object.assign({}, ok, { main: 'index.js' })).error, 'data-only-forbidden-field');
    assert.strictEqual(validateDataManifest(Object.assign({}, ok, { theme: {} })).error, 'data-only-forbidden-field');
    assert.strictEqual(validateDataManifest(Object.assign({}, ok, { set: { label: 'x', members: [] } })).error, 'bad-set');
    assert.strictEqual(validateDataManifest(Object.assign({}, ok, { set: { label: 'x', members: ['A b'] } })).error, 'bad-set');
    assert.strictEqual(validateDataManifest(Object.assign({}, ok, { for: ['Bad Id'] })).error, 'bad-manifest');
    assert.strictEqual(normalizeSet({ label: 'x', members: ['a', 'a'] }).error, 'bad-set');
  });

  await test('registry: 本物の plugins/ を読むと set-youtube が data で出て、パックにも入る', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-state-'));
    try {
      const registry = createRegistry({ core: { STATE_DIR: state }, appRoot: ROOT, builtinRoot: path.join(ROOT, 'plugins'), externalRoot: path.join(state, 'plugins'), logger: () => {} });
      await registry.loadAll();
      const sets = registry.dataPlugins('set');
      assert.deepStrictEqual(sets.map((r) => r.id), ['set-youtube']);
      assert.deepStrictEqual(sets[0].for, ['youtube']);
      assert.ok(JSON.parse(read('packs/standard.json')).plugins.indexOf('set-youtube') !== -1);
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
  });

  await test('API features.sets／features.setSet: 入っている機能だけ入れる・足りないものは出すだけ・配信中は切れない', async () => {
    const features = [
      { id: 'bulk-title', mode: 'legacy', feature: { label: '題名', activation: 'live', order: 1 } },
      { id: 'comment-send', mode: 'live', feature: { label: 'コメント', activation: 'live', order: 2 } }
    ];
    let live = 0;
    const setRows = [{ id: 'set-x', source: 'set', kind: 'set', name: 'X', set: { label: 'X セット', members: ['bulk-title', 'comment-send', 'gone'] }, for: ['youtube'] }];
    const api = createApi({
      dataPlugins: (kind) => (kind === 'set' ? setRows : []),
      audit: { write() {} },
      devMode: { get: () => ({ devMode: false, source: 'default' }) },
      core: { STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'x3-core-')) },
      getState() { return { product: 'marust', plugins: features.map((f) => ({ id: f.id, source: 'set', status: 'running', mode: f.mode, feature: f.feature, audience: 'public' })), destinations: { liveCount: live }, engineStatus: { connected: true } }; }
    });
    const listed = await api.call('features.sets', {}, win);
    assert.strictEqual(listed.ok, true, JSON.stringify(listed));
    assert.deepStrictEqual(listed.sets[0].missing, ['gone']);
    assert.strictEqual(listed.sets[0].on, false);
    assert.deepStrictEqual(listed.sets[0].members.map((m) => [m.id, m.present, m.on]), [['bulk-title', true, false], ['comment-send', true, true], ['gone', false, false]]);
    assert.strictEqual((await api.call('features.setSet', { id: 'nope', enabled: true }, win)).error, 'unknown-set');
    live = 1;
    assert.strictEqual((await api.call('features.setSet', { id: 'set-x', enabled: false }, win)).error, 'streaming');
  });

  await test('needs: site:<id>。入っていないサイトの機能は「入っていない」と出し、registry は読み込まない', async () => {
    const rows = [{ id: 'f', mode: 'live', visible: true, feature: { label: 'F', activation: 'live', needs: ['site:youtube', 'site:zzz'], order: 1 } }];
    const list = buildFeatureList({ rows, installedSites: ['youtube'] });
    assert.deepStrictEqual(list[0].needs, [{ kind: 'site', target: 'youtube', ok: true }, { kind: 'site', target: 'zzz', ok: false }]);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-reg-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-root-'));
    try {
      const mk = (id, extra) => {
        fs.mkdirSync(path.join(root, id), { recursive: true });
        fs.writeFileSync(path.join(root, id, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', provides: [], defaultMode: 'legacy' }, extra)));
        fs.writeFileSync(path.join(root, id, 'index.js'), "'use strict';\nmodule.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n");
      };
      mk('needy', { feature: { label: 'N', activation: 'live', needs: ['site:nowhere'] } });
      mk('free', { feature: { label: 'F', activation: 'live' } });
      const registry = createRegistry({ core: { STATE_DIR: state }, appRoot: root, builtinRoot: root, externalRoot: path.join(state, 'plugins'), logger: () => {} });
      await registry.loadAll();
      const snap = registry.snapshot();
      assert.strictEqual(snap.find((r) => r.id === 'needy').status, 'accepted');
      assert.strictEqual(snap.find((r) => r.id === 'needy').reason, 'needs-site');
      assert.strictEqual(snap.find((r) => r.id === 'free').status, 'running');
    } finally { fs.rmSync(state, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('ひな形（new-plugin）は category を名乗る', () => {
    const tpl = require('../cli/new-plugin');
    assert.strictEqual(JSON.parse(tpl.manifestFor('demo', false)).category, 'tool');
    assert.strictEqual(JSON.parse(tpl.manifestFor('demo', true)).category, 'destination');
  });

  if (failed) { console.error('[x3] ' + failed + ' failed'); process.exit(1); }
  console.log('[marust] x3 grouping and sets tests passed');
})();
