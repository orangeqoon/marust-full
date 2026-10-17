'use strict';
require('./_ui-inline');

/**
 * V5: 配り物 2 種類（v3 §5.1・Q-2026-10-10-v5-distribution.md）。
 * ① build / build:author / build:core の除外（plugins-author は配る exe に入らない・core は plugins も入らない）
 * ② pack:plugins の zip と plugins-index.json ③「本体だけ」（distribution: core）の段階の扱い
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');

const { CORE_IGNORE, buildInfo } = require('../cli/build-core');
const { packAll, appRequires } = require('../cli/pack-plugins');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function ignoreArgs(script) {
  return (script.match(/--ignore=("[^"]*"|\S+)/g) || []).map((s) => s.slice(9).replace(/^"|"$/g, '').replace(/\\"/g, '"'));
}
const matchesAny = (patterns, p) => patterns.some((r) => new RegExp(r.charAt(0) === '^' ? r : '^' + r + '(/|$)').test(p));

test('build（配る用）: exe は核だけ（plugins・plugins-author・dist 系を入れない）。セットは exe の横へ置く（計画 C・C2-3）', () => {
  const ig = ignoreArgs(pkg.scripts.build);
  for (const p of ['/plugins-author/x/manifest.json', '/dist-author/a', '/dist-core/a', '/dist-plugins/a', '/plugins/bulk-title/manifest.json', '/plugins/sites/twitch/site.js']) assert.ok(matchesAny(ig, p), p);
  for (const p of ['/host/core/api.js', '/ui/hub.html', '/node_modules/ws/index.js', '/electron-main.js']) assert.ok(!matchesAny(ig, p), p);
  assert.ok(pkg.scripts.build.includes('node cli/pack-plugins.js --set dist/marust-win32-x64/plugins'), 'build の最後にセットを exe の横へ置く');
});

test('build:author: exe は核だけ（plugins・plugins-author・みんなのも入れない。置き場は build-info.json が指す）・dist 系も入れない', () => {
  const ig = ignoreArgs(pkg.scripts['build:author:pack']);
  for (const p of ['/plugins/bulk-title/manifest.json', '/plugins-author/x/manifest.json', '/dist', '/dist-core/a', '/dist-plugins/a']) assert.ok(matchesAny(ig, p), p);
  for (const p of ['/host/core/api.js', '/ui/hub.html', '/electron-main.js']) assert.ok(!matchesAny(ig, p), p);
  assert.ok(!pkg.scripts['build:author:pack'].includes('pack-plugins.js --set'), '作者の版は横に plugins/ を置かない');
});

test('build:core: plugins・plugins-author を入れない。host・ui・node_modules は入る', () => {
  const list = CORE_IGNORE.slice();
  for (const p of ['/plugins/bulk-title/manifest.json', '/plugins/sites/twitch/site.js', '/plugins-author/x/index.js', '/dist', '/dist-author/a', '/docs/x.md', '/test/a.js']) assert.ok(matchesAny(list, p), p);
  for (const p of ['/host/core/api.js', '/ui/hub.html', '/node_modules/ws/index.js', '/electron-main.js', '/package.json', '/assets/icon.ico']) assert.ok(!matchesAny(list, p), p);
  assert.strictEqual(buildInfo().distribution, 'core');
  assert.ok(pkg.scripts['build:core'] && pkg.scripts['pack:plugins']);
});

function readZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, z) => {
      if (err) return reject(err);
      const names = [];
      z.on('entry', (e) => { names.push(e.fileName); z.readEntry(); });
      z.on('end', () => resolve(names));
      z.on('error', reject);
      z.readEntry();
    });
  });
}

test('pack:plugins: 内蔵 29 個が 1 つずつ zip になり（直下に manifest.json）、index の SHA-256 と tier が合う', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-pack-'));
  try {
    const index = packAll(out);
    assert.strictEqual(index.length, 29); // L9a で chat-* 6本が plugins-author へ移り、kukulu-port が plugins へ移った（33 - 6 + 1 = 28）
    const doc = JSON.parse(fs.readFileSync(path.join(out, 'plugins-index.json'), 'utf8'));
    assert.strictEqual(doc.plugins.length, 29);
    for (const row of index) {
      const buf = fs.readFileSync(path.join(out, row.file));
      assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), row.sha256, row.id);
      assert.ok(['basic', 'standard', 'advanced'].includes(row.tier), row.id + ' tier');
      const names = await readZip(path.join(out, row.file));
      assert.ok(names.includes('manifest.json'), row.id);
      assert.ok(names.every((n) => !n.startsWith('.') && !n.includes('..') && !n.includes('\\')), row.id);
    }
    assert.ok(index.every((r) => !/plugins-author/.test(r.installPath)));
    assert.strictEqual(index.find((r) => r.id === 'backup').tier, 'basic');
    assert.deepStrictEqual(index.find((r) => r.id === 'session').appRequires, [], '本体の部品を直接 require していない（K2）');
    // 2 回作っても同じ zip（時刻を固定している）
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-pack2-'));
    try {
      assert.deepStrictEqual(packAll(again).map((r) => r.sha256), index.map((r) => r.sha256));
    } finally { fs.rmSync(again, { recursive: true, force: true }); }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('appRequires: フォルダの外へ出る相対 require だけ拾う', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-req-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'index.js'), "require('./lib/a'); require('../../host/core/events'); require('fs');");
    fs.writeFileSync(path.join(dir, 'lib', 'a.js'), "require('../b'); require('../../../host/core/safe-runner');");
    fs.writeFileSync(path.join(dir, 'b.js'), '');
    assert.deepStrictEqual(appRequires(dir, ['index.js', 'lib/a.js', 'b.js']), ['host/core/events', 'host/core/safe-runner']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 内蔵プラグインが本体の host/・lib/ を直接 require している数（Opus 2026-10-10: 入れる道の前に ctx 経由へ直して 0 にする）。増えたら失敗、減ったら上限を下げさせる。
const APP_REQUIRE_CEILING = { plugins: 0, links: 0 };
test('内蔵プラグインの本体への直 require の数が上限どおり（増やさない・直したら上限を下げる）', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-req2-'));
  try {
    const index = packAll(out);
    const withReq = index.filter((r) => r.appRequires.length);
    const links = withReq.reduce((n, r) => n + r.appRequires.length, 0);
    assert.ok(withReq.length <= APP_REQUIRE_CEILING.plugins && links <= APP_REQUIRE_CEILING.links, '増えた: ' + withReq.length + ' 個・' + links + ' 件 ' + withReq.map((r) => r.id).join(','));
    assert.ok(withReq.length === APP_REQUIRE_CEILING.plugins && links === APP_REQUIRE_CEILING.links, '減った。APP_REQUIRE_CEILING を ' + withReq.length + '・' + links + ' に下げる');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('plugins-author も本体への直 require 0。plugins・plugins-author に process.cwd() と require(path.join( が無い（K2 評価 Should 3）', () => {
  const walk = (dir, acc) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test') walk(p, acc); } else if (e.name.endsWith('.js')) acc.push(p);
    });
    return acc;
  };
  ['plugins', 'plugins-author'].forEach((top) => {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) return;
    walk(base, []).filter((f) => !/dev-storage-locator/.test(f)).forEach((f) => {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!/require\(['"](\.\.\/)+(host|lib)\//.test(src), f + ' が本体を直接 require している');
      assert.ok(!/process\.cwd\(\)/.test(src), f + ' が process.cwd() を使っている');
      assert.ok(!/require\(path\.join\(/.test(src), f + ' が動的な require を使っている');
    });
  });
});

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
function apiFor(distribution) {
  const stored = { uiLevel: 'basic' };
  return createApi({
    distribution,
    uiSettings: {
      set(p) { if (p.uiLevel) stored.uiLevel = p.uiLevel; return { ok: true }; },
      get() { return { showExperimental: false }; },
      getView() { return { readable: true, uiLevel: stored.uiLevel, setupStep: 0, setupSkipped: [], setupSites: [] }; }
    },
    audit: { write() {} },
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    getState() { return { product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
  });
}

test('「本体だけ」: ui.getSettings に distribution: core・中級へは変えられない（not-in-build）・上級は選べる。内蔵つきは full', async () => {
  const core = apiFor('core');
  assert.strictEqual((await core.call('ui.getSettings', {}, win)).distribution, 'core');
  assert.deepStrictEqual(await core.call('ui.setSettings', { uiLevel: 'standard' }, win), { ok: false, error: 'not-in-build', pack: 'standard', missing: JSON.parse(fs.readFileSync(path.join(root, 'packs', 'standard.json'), 'utf8')).plugins.length, missingIds: JSON.parse(fs.readFileSync(path.join(root, 'packs', 'standard.json'), 'utf8')).plugins.slice(0, 10) });
  assert.strictEqual((await core.call('ui.setSettings', { uiLevel: 'advanced' }, win)).uiLevel, 'advanced');
  const full = apiFor(undefined);
  assert.strictEqual((await full.call('ui.getSettings', {}, win)).distribution, 'full');
  assert.strictEqual((await full.call('ui.setSettings', { uiLevel: 'standard' }, win)).uiLevel, 'standard');
});

test('electron-main: build-info.json の distribution を読んで api に渡す（無ければ full）', () => {
  const src = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');
  assert.ok(src.includes("path.join(__dirname, 'build-info.json')") && src.includes('distribution: readDistribution()'));
  assert.ok(!fs.existsSync(path.join(root, 'build-info.json')), 'ソースには build-info.json を置かない（ビルドが入れる）');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of queue) {
    try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
  }
  if (failed) { console.error('[v5-dist] ' + failed + ' failed'); process.exit(1); }
  console.log('[v5-dist] all passed');
})();
