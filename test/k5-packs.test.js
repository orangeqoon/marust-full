'use strict';
require('./_ui-inline');

/**
 * K5: 束（packs）。packs/<段階>.json は plugins/ の manifest.tier から作る正本（npm run pack:plugins が書く）。
 * ① 食い違わない ② 積み上げ（basic ⊂ standard ⊂ advanced）③ 束の zip の中身 ④ 「本体だけ」に束を展開すると中級へ上げられる
 * ⑤ mcp/server.js の互換の 1 枚は消えた
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');

const { packAll, packLists, writePacks, PACK_ORDER } = require('../cli/pack-plugins');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');

const root = path.join(__dirname, '..');
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function zipEntries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, z) => {
      if (err) return reject(err);
      const out = {};
      z.on('entry', (e) => {
        z.openReadStream(e, (err2, s) => {
          if (err2) return reject(err2);
          const chunks = [];
          s.on('data', (c) => chunks.push(c));
          s.on('end', () => { out[e.fileName] = Buffer.concat(chunks); z.readEntry(); });
        });
      });
      z.on('end', () => resolve(out));
      z.on('error', reject);
      z.readEntry();
    });
  });
}

test('packs/*.json は plugins/ の manifest.tier から作った一覧と同じ（pack:plugins をやり直し忘れていない）', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-packs-'));
  try {
    const lists = packLists(packAll(out));
    PACK_ORDER.forEach((name) => assert.deepStrictEqual(readJson(path.join(root, 'packs', name + '.json')), lists[name], name + ' が古い。npm run pack:plugins'));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('束は積み上がる: basic ⊂ standard ⊂ advanced。basic には update-check が入る', () => {
  const [b, s, a] = PACK_ORDER.map((n) => readJson(path.join(root, 'packs', n + '.json')).plugins);
  assert.ok(b.includes('update-check') && b.length > 0);
  b.forEach((id) => assert.ok(s.includes(id), id));
  s.forEach((id) => assert.ok(a.includes(id), id));
  assert.ok(s.length > b.length && a.length > s.length);
  assert.ok(!a.some((id) => /^dev-legacy|author/.test(id)), '作者専用は束に入れない');
});

test('L9a: 中級の束には三層目が無く、chat-* は公開版の束に無く、中級は一層目＋二層目の公開版と一致する', () => {
  const std = readJson(path.join(root, 'packs', 'standard.json')).plugins;
  const adv = readJson(path.join(root, 'packs', 'advanced.json')).plugins;
  const layers = readJson(path.join(root, 'host', 'layer1', 'plugin-layers.json'));

  // chat-* はどの束にも入らない
  assert.ok(!adv.some((id) => /^chat-(fc2|kukulu|picarto|rumble|soop|twitch)$/.test(id)), 'chat-* は公開版の束に入れない');
  assert.ok(!std.some((id) => /^chat-(fc2|kukulu|picarto|rumble|soop|twitch)$/.test(id)), 'chat-* は中級の束に入れない');

  // 三層目（ai-connect, session, diagnostics, notify-discord, signal-monitor, dev-shadow）は中級の束に入らない
  const layer3Ids = ['ai-connect', 'session', 'diagnostics', 'notify-discord', 'signal-monitor', 'dev-shadow'];
  layer3Ids.forEach((id) => {
    assert.ok(!std.includes(id), id + ' は中級の束に入れない（三層目）');
  });

  // 中級の束の各プラグインは、一層目または二層目に載っている
  const l1AndL2 = new Set([...layers.layer1, ...layers.layer2]);
  std.forEach((id) => {
    assert.ok(id === 'ui-standard' || l1AndL2.has(id), id + ' は plugin-layers.json の layer1 または layer2 にあること');
  });

  // kukulu-port は中級と上級の束に入る
  assert.ok(std.includes('kukulu-port'), 'kukulu-port は中級の束に入る');
  assert.ok(adv.includes('kukulu-port'), 'kukulu-port は上級の束に入る');

  // hotkeys, uplink-estimate は中級に入る
  assert.ok(std.includes('hotkeys'), 'hotkeys は中級の束に入る');
  assert.ok(std.includes('uplink-estimate'), 'uplink-estimate は中級の束に入る');
});

/** 束の zip を dir に展開する（案内どおり。resources/app/ にそのまま）。書く先は dir の中だけ */
async function extractTo(zipFile, dir) {
  const entries = await zipEntries(zipFile);
  for (const name of Object.keys(entries)) {
    assert.ok(!name.startsWith('/') && !name.includes('..'), name);
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entries[name]);
  }
  return entries;
}

test('束の zip: pack.json と、plugins/<id>/…・plugins/sites/<id>/… の木（そのまま展開できる形）', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-zip-'));
  const packsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-lists-'));
  try {
    const index = packAll(out);
    const bundles = writePacks(index, out, packsDir);
    assert.deepStrictEqual(bundles.map((b) => b.pack), PACK_ORDER.slice());
    for (const b of bundles) {
      const buf = fs.readFileSync(path.join(out, b.file));
      assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), b.sha256);
      const entries = await zipEntries(path.join(out, b.file));
      const meta = JSON.parse(entries['pack.json'].toString('utf8'));
      assert.strictEqual(meta.plugins.length, b.plugins);
      meta.plugins.forEach((p) => assert.ok(entries[p.installPath + '/manifest.json'], p.id + ' の manifest.json が木の位置に無い'));
      assert.ok(!Object.keys(entries).some((n) => /.zip$/.test(n)), '入れ子の zip は無い');
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(packsDir, { recursive: true, force: true }); }
});

test('build:core の除外に packs/ は入っていない（束の一覧が exe に同梱される）', () => {
  const src = fs.readFileSync(path.join(root, 'cli', 'build-core.js'), 'utf8');
  const list = eval(src.match(/CORE_IGNORE = Object\.freeze\((\[[\s\S]*?\])\)/)[1]); // eslint-disable-line no-eval
  const res = list.map((p) => new RegExp(p.charAt(0) === '^' ? p : '^' + p.replace(/[.]/g, '\.') + '(/|$)'));
  ['/packs', '/packs/standard.json', '/host/core/api.js'].forEach((f) => assert.ok(!res.some((r) => r.test(f)), f + ' が除外される'));
  assert.ok(res.some((r) => r.test('/plugins/timer/index.js')), '本体だけの除外は plugins/ を落とす');
});

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
function coreApi(pluginIds) {
  const stored = { uiLevel: 'basic' };
  return createApi({
    distribution: 'core',
    uiSettings: {
      set(p) { if (p.uiLevel) stored.uiLevel = p.uiLevel; return { ok: true }; },
      get() { return { showExperimental: false }; },
      getView() { return { readable: true, uiLevel: stored.uiLevel, setupStep: 0, setupSkipped: [], setupSites: [] }; }
    },
    audit: { write() {} },
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    getState() { return { product: 'marust', plugins: pluginIds.map((id) => (typeof id === 'string' ? { id, source: 'set', status: 'running' } : id)), destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
  });
}

test('「本体だけ」: 中級の束が揃うまで中級へ上げられず、足りない数を返す。揃うと上げられる', async () => {
  const std = readJson(path.join(root, 'packs', 'standard.json')).plugins;
  const none = await coreApi([]).call('ui.setSettings', { uiLevel: 'standard' }, win);
  assert.strictEqual(none.error, 'not-in-build');
  assert.strictEqual(none.pack, 'standard');
  assert.strictEqual(none.missing, std.length);
  const part = await coreApi(std.slice(1)).call('ui.setSettings', { uiLevel: 'standard' }, win);
  assert.strictEqual(part.missing, 1);
  assert.deepStrictEqual(part.missingIds, [std[0]]);
  const full = await coreApi(std).call('ui.setSettings', { uiLevel: 'standard' }, win);
  assert.strictEqual(full.uiLevel, 'standard');
});

test('実際に展開: 本体だけの木に pack-standard.zip を展開すると、束の id が内蔵として見つかり、中級へ上がる', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-exp-out-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-exp-app-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-exp-state-'));
  try {
    const index = packAll(out);
    writePacks(index, out, fs.mkdtempSync(path.join(os.tmpdir(), 'k5-exp-lists-')));
    const std = readJson(path.join(root, 'packs', 'standard.json')).plugins;
    // 展開前: 本体だけ（plugins/ 無し）→ 何も見つからない
    fs.mkdirSync(appDir, { recursive: true });
    const { createRegistry } = require('../host/layer1/plugin-registry');
    const before = createRegistry({ appRoot: appDir, core: { STATE_DIR: stateDir }, logger() {} }).discover();
    assert.strictEqual(before.filter((r) => r.source === 'set').length, 0);
    await extractTo(path.join(out, 'packs', 'pack-standard.zip'), appDir);
    const rows = createRegistry({ appRoot: appDir, core: { STATE_DIR: stateDir }, logger() {} }).discover();
    const found = new Set(); // サイトは site-<id>・sink-<id> の役目に展開される（束の id は manifest の id＝siteId）
    rows.filter((r) => r.source === 'set').forEach((r) => { found.add(r.id); if (r.siteId) found.add(r.siteId); });
    std.forEach((id) => assert.ok(found.has(id), id + ' が内蔵として見つからない'));
    const hubRows = rows.map((r) => ({ id: r.id, source: r.source, siteId: r.siteId || '', status: r.status }));
    const api = coreApi(hubRows);
    const res = await api.call('ui.setSettings', { uiLevel: 'standard' }, win);
    assert.strictEqual(res.uiLevel, 'standard', JSON.stringify(res));
  } finally { [out, appDir, stateDir].forEach((d) => fs.rmSync(d, { recursive: true, force: true })); }
});

test('束の一覧が読めない・外から入れたもの・読み込みに失敗したものは「ある」と数えない', async () => {
  const std = readJson(path.join(root, 'packs', 'standard.json')).plugins;
  const ext = await coreApi(std.map((id) => ({ id, source: 'user', status: 'running' }))).call('ui.setSettings', { uiLevel: 'standard' }, win);
  assert.strictEqual(ext.error, 'not-in-build');
  assert.strictEqual(ext.missing, std.length);
  const failed = await coreApi(std.map((id, i) => ({ id, source: 'set', status: i === 0 ? 'load-failed' : 'running' }))).call('ui.setSettings', { uiLevel: 'standard' }, win);
  assert.strictEqual(failed.missing, 1);
});

test('互換の mcp/server.js は無い。MCP の本体は plugins/ai-connect/mcp/server.js だけ', () => {
  assert.ok(!fs.existsSync(path.join(root, 'mcp', 'server.js')));
  assert.ok(fs.existsSync(path.join(root, 'plugins', 'ai-connect', 'mcp', 'server.js')));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of queue) {
    try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
  }
  if (failed) { console.error('[k5-packs] ' + failed + ' failed'); process.exit(1); }
  console.log('[k5-packs] all passed');
})();
