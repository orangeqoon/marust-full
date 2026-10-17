'use strict';
require('./_ui-inline');

/**
 * P4b: 外から入れる機能の配線（plugin.inspect / install / restore / remove / list・plugins.browse）。
 * 偽のもの（一時フォルダ・手で作った zip・偽の選択ダイアログ・偽の状態）だけ。本物のダイアログ・サイト・OBS・Google には触らない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const { createApi } = require('../host/layer1/api');
const { createCore } = require('../host/core/core-bridge');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createAppInstaller } = require('../host/layer1/plugin-install-wire');
const { WINDOW_ID } = require('../host/layer1/clients');
const { buildZip } = require('./_zip-fixture');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const real = createCore();
const MAIN_SRC = 'module.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n';
function manifestOf(id, extra) {
  return Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'], secrets: ['ext.' + id + '.token'], needs: ['obs.read'] }, extra || {});
}
function zipEntries(id, version, extra) {
  return [
    { name: 'manifest.json', data: JSON.stringify(manifestOf(id, Object.assign({ version: version || '1.0.0' }, extra || {}))) },
    { name: 'index.js', data: MAIN_SRC + '// ' + (version || '1.0.0') + '\n' }
  ];
}

/** 本物の registry・installer（wire）・api を、一時フォルダの上でつなぐ。選択ダイアログと配信中かだけ偽物。 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4b-'));
  const stateDir = path.join(root, 'state');
  const builtin = path.join(root, 'builtin');
  fs.mkdirSync(path.join(stateDir, 'services'), { recursive: true });
  fs.mkdirSync(builtin, { recursive: true });
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const core = { STATE_DIR: stateDir, SERVICES_DIR: path.join(stateDir, 'services'), COOKIES_DIR: path.join(stateDir, 'cookies'), DATA_DIR: path.join(stateDir, 'data'), atomicWriteJsonSync: real.atomicWriteJsonSync };
  const modesFile = path.join(core.SERVICES_DIR, 'marust-modes.json');
  const modeOf = (id) => { try { return JSON.parse(fs.readFileSync(modesFile, 'utf8')).plugins[id] || 'legacy'; } catch (_) { return 'legacy'; } };
  const events = [];
  const audits = [];
  const registry = createRegistry({ core, appRoot: root, builtinRoot: builtin, authorRoot: path.join(root, 'no-author'), externalRoot: path.join(stateDir, 'plugins'), logger() {}, modeFor: modeOf });
  const st = { streaming: false, picks: [], pickResult: null, rescans: [], browses: [] };
  const rescanOrig = registry.rescanExternal;
  registry.rescanExternal = (id, opt) => { st.rescans.push(id); return rescanOrig(id, opt); };
  const installer = createAppInstaller({
    core, registry, bus: { publish: (n, p) => events.push([n, p]) },
    audit: { write: (r) => audits.push(r) },
    isStreaming: async () => st.streaming,
    modeOf
  });
  const api = createApi({
    core, confirmLive: true,
    bus: { publish: (n, p) => events.push([n, p]) },
    audit: { write: (r) => audits.push(r) },
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    getState: () => ({ product: 'marust', plugins: [], destinations: { liveCount: st.streaming ? 1 : 0 }, engineStatus: { connected: true } }),
    pluginInstaller: installer,
    pickPluginSource: async (kind) => { st.picks.push(kind); return st.pickResult; },
    openPluginBrowse: async () => { st.browses.push(1); return { ok: true }; }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
  const zip = (name, entries) => { const f = path.join(src, name); fs.writeFileSync(f, buildZip(entries)); return f; };
  return { root, stateDir, modesFile, modeOf, events, audits, registry, installer, api, win, browser, st, zip, plugins: path.join(stateDir, 'plugins'), done() { fs.rmSync(root, { recursive: true, force: true }); } };
}

(async () => {
  await test('権限: plugin.inspect/install/restore/remove・plugins.browse は write・ウィンドウだけ。plugin.list は read・ウィンドウだけ', async () => {
    const t = setup();
    try {
      const want = { 'plugin.inspect': 'write', 'plugin.install': 'write', 'plugin.restore': 'write', 'plugin.remove': 'write', 'plugin.list': 'read', 'plugins.browse': 'write' };
      Object.keys(want).forEach((m) => assert.strictEqual(t.api.permissionFor(m), want[m], m));
      for (const m of Object.keys(want)) {
        const r = await t.api.call(m, { kind: 'zip', sha256: 'a'.repeat(64), id: 'foo' }, t.browser);
        assert.strictEqual(r.error, 'forbidden', m + ' がブラウザから呼べる');
      }
      assert.deepStrictEqual(t.st.picks, [], 'ブラウザからはダイアログを開かない');
    } finally { t.done(); }
  });

  await test('inspect: 場所は選択ダイアログからだけ（引数の path・source は無視）・キャンセルは何もしない・結果に PC の場所を含めない', async () => {
    const t = setup();
    try {
      const z = t.zip('alpha.zip', zipEntries('alpha'));
      t.st.pickResult = null;
      const c = await t.api.call('plugin.inspect', { kind: 'zip', path: z, source: z }, t.win);
      assert.deepStrictEqual(c, { ok: true, canceled: true });
      assert.deepStrictEqual(t.st.picks, ['zip']);
      assert.ok(!fs.existsSync(path.join(t.plugins, 'alpha')), 'キャンセルで何も置かない');
      t.st.pickResult = z;
      const r = await t.api.call('plugin.inspect', { kind: 'zip', path: '/etc/evil' }, t.win);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.id, 'alpha');
      assert.strictEqual(r.name, 'alpha');
      assert.strictEqual(r.version, '1.0.0');
      assert.deepStrictEqual(r.uses.secrets, ['ext.alpha.token']);
      assert.deepStrictEqual(r.uses.needs, ['obs.read']);
      assert.deepStrictEqual(r.uses.provides, ['ui.panel@1']);
      assert.ok(/^[0-9a-f]{64}$/.test(r.sha256));
      assert.ok(r.fileCount === 2 && r.bytes > 0);
      assert.strictEqual(r.updates, false);
      assert.ok(!JSON.stringify(r).includes(t.root.replace(/\\/g, '\\\\')) && !JSON.stringify(r).includes(t.root), '場所を返さない');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'alpha')), '下見では置かない');
      assert.deepStrictEqual((await t.api.call('plugin.inspect', { kind: 'url' }, t.win)).error, 'bad-kind');
    } finally { t.done(); }
  });

  await test('install: 下見の無いまま・違う sha256・使い回しは断る。下見どおりなら入れ、入れたあとも legacy（モードは modes の書き口で書く）', async () => {
    const t = setup();
    try {
      const z = t.zip('alpha.zip', zipEntries('alpha'));
      t.st.pickResult = z;
      assert.strictEqual((await t.api.call('plugin.install', { sha256: 'a'.repeat(64) }, t.win)).error, 'not-inspected');
      const seen = await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
      assert.strictEqual((await t.api.call('plugin.install', { sha256: 'b'.repeat(64) }, t.win)).error, 'not-inspected');
      // 失敗した試しで下見は消える。もう一度見せ直す
      await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
      const done = await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win);
      assert.strictEqual(done.ok, true, JSON.stringify(done));
      assert.strictEqual(done.id, 'alpha');
      assert.strictEqual(done.updated, false);
      assert.ok(fs.existsSync(path.join(t.plugins, 'alpha', 'manifest.json')));
      assert.strictEqual(t.modeOf('alpha'), 'legacy');
      assert.strictEqual(JSON.parse(fs.readFileSync(t.modesFile, 'utf8')).plugins.alpha, 'legacy', '明示で legacy を書く');
      assert.ok(t.events.some(([n, p]) => n === 'modes.changed' && p.id === 'alpha' && p.mode === 'legacy'));
      assert.deepStrictEqual(t.st.rescans, ['alpha'], '入れた id だけ読み直す');
      assert.ok(!JSON.stringify(done).includes(t.root), '場所を返さない');
      // 同じ下見で 2 回は入れられない
      assert.strictEqual((await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win)).error, 'not-inspected');
      // 動いてはいない（legacy のあいだは読み込まない）
      assert.notStrictEqual(t.registry.snapshot().filter((r) => r.id === 'alpha')[0].status, 'running');
      assert.ok(t.audits.some((a) => a.method === 'plugin.install' && a.paramNames.indexOf('id:alpha') !== -1), '監査に 1 行');
      assert.ok(t.audits.every((a) => !JSON.stringify(a).includes('token')), '秘密の値は書かない');
    } finally { t.done(); }
  });

  await test('install: 下見のあとで中身が変わったら changed-since-inspect（承認したものと同じ中身だけ入る）', async () => {
    const t = setup();
    try {
      const z = t.zip('alpha.zip', zipEntries('alpha', '1.0.0'));
      t.st.pickResult = z;
      const seen = await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
      t.zip('alpha.zip', zipEntries('alpha', '1.0.1')); // 同じ場所のファイルを差し替える
      const r = await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'changed-since-inspect');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'alpha')));
      assert.strictEqual(t.modeOf('alpha'), 'legacy');
    } finally { t.done(); }
  });

  await test('install: 下見から 10 分たったら断る', async () => {
    const t = setup();
    const realNow = Date.now;
    try {
      t.st.pickResult = t.zip('alpha.zip', zipEntries('alpha'));
      const seen = await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
      Date.now = () => realNow() + 11 * 60 * 1000;
      assert.strictEqual((await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win)).error, 'not-inspected');
    } finally { Date.now = realNow; t.done(); }
  });

  await test('配信中: 入れる・更新・戻す・消すは断る（サーバー側）。何も動かさず、legacy も書かない', async () => {
    const t = setup();
    try {
      t.st.pickResult = t.zip('alpha.zip', zipEntries('alpha'));
      const seen = await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
      t.st.streaming = true;
      const r = await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win);
      assert.strictEqual(r.error, 'streaming');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'alpha')));
      assert.ok(!fs.existsSync(t.modesFile), 'モードのファイルに触らない');
      assert.strictEqual((await t.api.call('plugin.remove', { id: 'alpha' }, t.win)).error, 'not-installed');
      t.st.streaming = false;
      await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
      assert.strictEqual((await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win)).ok, true);
      t.st.streaming = true;
      assert.strictEqual((await t.api.call('plugin.remove', { id: 'alpha' }, t.win)).error, 'streaming');
      assert.strictEqual((await t.api.call('plugin.restore', { id: 'alpha' }, t.win)).error, 'no-backup');
      assert.ok(fs.existsSync(path.join(t.plugins, 'alpha')));
    } finally { t.done(); }
  });

  await test('更新・戻す・消す・一覧: 更新は 1 つ前を残し、戻すと入れ替わり、消すと plugins-backup へ。list は名前と版だけ', async () => {
    const t = setup();
    try {
      const put = async (version) => {
        t.st.pickResult = t.zip('alpha-' + version + '.zip', zipEntries('alpha', version));
        const seen = await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
        return { seen, done: await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win) };
      };
      const first = await put('1.0.0');
      assert.strictEqual(first.done.ok, true);
      const second = await put('1.1.0');
      assert.strictEqual(second.seen.updates, true);
      assert.strictEqual(second.seen.previousVersion, '1.0.0');
      assert.strictEqual(second.done.updated, true);
      let list = await t.api.call('plugin.list', {}, t.win);
      assert.strictEqual(list.ok, true);
      assert.deepStrictEqual(list.installed.map((x) => [x.id, x.version, x.backupVersion]), [['alpha', '1.1.0', '1.0.0']]);
      assert.ok(!JSON.stringify(list).includes(t.root), '場所を返さない');
      const back = await t.api.call('plugin.restore', { id: 'alpha' }, t.win);
      assert.strictEqual(back.ok, true, JSON.stringify(back));
      list = await t.api.call('plugin.list', {}, t.win);
      assert.strictEqual(list.installed[0].version, '1.0.0');
      assert.strictEqual(t.modeOf('alpha'), 'legacy');
      const gone = await t.api.call('plugin.remove', { id: 'alpha' }, t.win);
      assert.deepStrictEqual(gone, { ok: true, id: 'alpha', version: '1.0.0' });
      assert.ok(!fs.existsSync(path.join(t.plugins, 'alpha')));
      assert.ok(fs.existsSync(path.join(t.stateDir, 'plugins-backup')));
      assert.strictEqual((await t.api.call('plugin.remove', { id: '../x' }, t.win)).error, 'bad-id');
      assert.ok(t.st.rescans.every((id) => id === 'alpha'), '変えた id だけ');
    } finally { t.done(); }
  });

  await test('live のものは更新・戻す・消すを断る（先に無効にする）', async () => {
    const t = setup();
    try {
      t.st.pickResult = t.zip('alpha.zip', zipEntries('alpha'));
      const seen = await t.api.call('plugin.inspect', { kind: 'zip' }, t.win);
      await t.api.call('plugin.install', { sha256: seen.sha256 }, t.win);
      fs.writeFileSync(t.modesFile, JSON.stringify({ plugins: { alpha: 'live' } })); // 試験の準備だけ（本物の modes.set は別の試験）
      assert.strictEqual((await t.api.call('plugin.remove', { id: 'alpha' }, t.win)).error, 'live');
      assert.ok(fs.existsSync(path.join(t.plugins, 'alpha')));
    } finally { t.done(); }
  });

  await test('installer も picker も無い構成では unavailable（落ちない）。plugins.browse は固定の口を呼ぶだけ', async () => {
    const t = setup();
    try {
      const bare = createApi({ core: { STATE_DIR: t.stateDir, SERVICES_DIR: path.join(t.stateDir, 'services'), atomicWriteJsonSync: real.atomicWriteJsonSync }, devMode: { get: () => ({ devMode: false }) } });
      for (const [m, p] of [['plugin.inspect', { kind: 'zip' }], ['plugin.install', { sha256: 'a'.repeat(64) }], ['plugin.restore', { id: 'x' }], ['plugin.remove', { id: 'x' }], ['plugin.list', {}], ['plugins.browse', {}]]) {
        assert.strictEqual((await bare.call(m, p, t.win)).error, 'unavailable', m);
      }
      assert.deepStrictEqual(await t.api.call('plugins.browse', { url: 'https://evil.example/' }, t.win), { ok: true });
      assert.strictEqual(t.st.browses.length, 1);
    } finally { t.done(); }
  });

  await test('createAppInstaller: 必須の部品が無ければ作るときに throw', () => {
    const t = setup();
    try {
      assert.throws(() => createAppInstaller({ core: { STATE_DIR: t.stateDir }, registry: t.registry, isStreaming: async () => false }), /modeOf/);
      assert.throws(() => createAppInstaller({ core: { STATE_DIR: t.stateDir }, registry: t.registry, modeOf: () => 'legacy' }), /isStreaming/);
      assert.throws(() => createAppInstaller({ core: { STATE_DIR: t.stateDir }, registry: {}, isStreaming: async () => false, modeOf: () => 'legacy' }), /rescanExternal/);
    } finally { t.done(); }
  });

  await test('画面: 管理パネルは inspect の結果・自己責任の文・sha256 の先頭・使う力を出し、場所を扱わない。配信中はボタンを止める。もっと探すは上級のパネルだけ', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const STR = require('../plugins/ui-standard/shell/strings');
    const panel = read('plugins/ui-standard/shell/panels/plugin-manager.js');
    ['plugin.inspect', 'plugin.install', 'plugin.restore', 'plugin.remove', 'plugin.list', 'plugins.browse', 'STR.pluginInstallWarning', 'sha256'].forEach((s) => assert.ok(panel.includes(s), s));
    const keys = [...panel.matchAll(/STR\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    keys.forEach((k) => assert.ok(k in STR, '未定義の文字: ' + k));
    assert.ok(!/\bpath\b|file\.path|webkitRelativePath|type="file"|<input/i.test(panel), '画面は場所を扱わない・ファイル入力を使わない');
    assert.ok(/同じ力/.test(STR.pluginInstallWarning) && /申告/.test(STR.pluginInstallWarning) && /閉じ込め|サンドボックス/.test(STR.pluginInstallWarning), '自己責任・申告であって閉じ込めではない、をはっきり書く');
    assert.ok(/streaming/.test(panel), '配信中はボタンを止める');
    ['pluginInstallErr'].forEach((k) => assert.strictEqual(typeof STR[k], 'function'));
    ['streaming', 'live', 'changed-since-inspect', 'mode-write-failed', 'not-inspected', 'provides-not-allowed', 'secret-namespace', 'id-reserved', 'bad-id', 'no-backup'].forEach((code) => assert.ok(STR.pluginInstallErr(code).length > 0, code));
    // 中級の「機能を足す」には入れる・探すを置かない
    assert.ok(!read('plugins/ui-standard/shell/panels/features.js').includes('plugin.inspect') && !read('plugins/ui-standard/shell/panels/features.js').includes('plugins.browse'));
    assert.ok(read('plugins/ui-standard/shell/menubar.js').includes("['plugin-manager', STR.pluginManagerMenu, { min: 'advanced' }]"), '上級だけ');
  });

  if (failed) { console.error('\n[p4b] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] p4b plugin install wiring tests passed');
})();
