'use strict';
require('./_ui-inline');

/**
 * P4a の ★2（Opus の安全レビュー）で決まった直し M1〜M9 の試験。
 * 偽のもの（一時フォルダ・手で作った zip・偽の状態）だけ。本物のサイト・OBS・Google には触らない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const { createRegistry, externalSecretOk, externalIdProblem } = require('../host/layer1/plugin-registry');
const { createPluginInstaller } = require('../host/layer1/plugin-install');
const { createApi } = require('../host/layer1/api');
const { createCore } = require('../host/core/core-bridge');
const { createUiSettings } = require('../host/layer1/ui-settings');
const { WINDOW_ID } = require('../host/layer1/clients');
const { buildZip } = require('./_zip-fixture');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function pluginSrc(mark) {
  return [
    'const fs = require("fs");',
    'const M = ' + JSON.stringify(mark) + ';',
    'let ctxSeen = null;',
    'module.exports = {',
    '  load(ctx) { ctxSeen = ctx; fs.appendFileSync(M, "load\\n"); },',
    '  start() { fs.appendFileSync(M, "start\\n"); },',
    '  stop() { fs.appendFileSync(M, "stop\\n"); },',
    '  destroy() { fs.appendFileSync(M, "destroy\\n"); },',
    '  get ctxSeen() { return ctxSeen; }',
    '};'
  ].join('\n');
}
const marks = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

function manifestOf(id, extra) {
  return Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'] }, extra || {});
}

function mkRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4a2-reg-'));
  const builtin = path.join(root, 'builtin');
  const external = path.join(root, 'state', 'plugins');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  const modes = {};
  const registry = createRegistry({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: builtin,
    authorRoot: path.join(root, 'no-author'),
    externalRoot: external,
    logger() {},
    modeFor: (id) => modes[id] || 'legacy'
  });
  const mark = (id) => path.join(root, id + '.marks');
  const put = (where, id, manifest) => {
    const dir = path.join(where, id);
    writeJson(path.join(dir, 'manifest.json'), manifest || manifestOf(id));
    fs.writeFileSync(path.join(dir, 'index.js'), pluginSrc(mark(id)));
    return dir;
  };
  return { root, builtin, external, modes, registry, mark, put, done() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const rowOf = (t, id) => t.registry.snapshot().find((r) => r.id === id);
const ctxOf = (t, id) => t.registry.getRunning().find((r) => r.id === id).instance.ctxSeen;

const MAIN_SRC = 'module.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n';
function zipEntries(id, version, extra) {
  return [
    { name: 'manifest.json', data: JSON.stringify(manifestOf(id, Object.assign({ version: version || '1.0.0' }, extra || {}))) },
    { name: 'index.js', data: MAIN_SRC + '// ' + (version || '1.0.0') + '\n' }
  ];
}
const shaOfFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function mkInstaller(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4a2-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const st = { streaming: false, mode: 'legacy', legacyOk: true, events: [], rescans: [] };
  const plugins = path.join(stateDir, 'plugins');
  const base = {
    stateDir,
    builtinRoots: [],
    isStreaming: async () => st.streaming,
    modeOf: () => st.mode,
    setLegacy: (id) => {
      // ファイルを動かす前に呼ばれたかを見るため、その時点の置き場を控える
      st.events.push({ legacy: id, present: fs.existsSync(path.join(plugins, id)) ? fs.readdirSync(path.join(plugins, id)).sort().join(',') : '' });
      return { ok: st.legacyOk };
    },
    rescan: async (id) => { st.rescans.push(id); },
    random: (() => { let n = 0; return () => 'r' + (n += 1); })()
  };
  const opts = Object.assign(base, over || {});
  Object.keys(opts).forEach((k) => { if (opts[k] === undefined) delete opts[k]; });
  const make = () => createPluginInstaller(opts);
  const zip = (name, entries) => { const f = path.join(src, name); fs.writeFileSync(f, buildZip(entries)); return f; };
  return { root, stateDir, plugins, st, make, zip, done() { fs.rmSync(root, { recursive: true, force: true }); } };
}

(async () => {
  // ---------------------------------------------------------------- M1
  await test('M1: 秘密の名前の正規表現は点を文字どおりに見る（fo が ext.foo.x を取れない・extXfooYbar は通らない）', async () => {
    assert.strictEqual(externalSecretOk('foo', 'ext.foo.x'), true);
    assert.strictEqual(externalSecretOk('fo', 'ext.foo.x'), true, 'L8g: 名前空間の縛りは外した（以前は false）');
    assert.strictEqual(externalSecretOk('foo', 'extXfooYbar'), false);
    assert.strictEqual(externalSecretOk('a-b', 'ext.a-b.x'), true);
    const t = mkRegistry();
    try {
      t.put(t.external, 'fo', manifestOf('fo', { secrets: ['ext.foo.x'] }));
      t.put(t.external, 'foo', manifestOf('foo', { secrets: ['extXfooYbar'] }));
      t.modes.fo = 'live';
      t.modes.foo = 'live';
      await t.registry.loadAll();
      assert.strictEqual(rowOf(t, 'fo').status, 'running', 'L8g: ext.foo.x を fo が宣言できる');
      assert.strictEqual(rowOf(t, 'foo').reason, 'secret-namespace', 'extXfooYbar は名前の形が違う（大文字）');
    } finally { t.done(); }
  });

  // ---------------------------------------------------------------- M2
  await test('M2: 外部の dataDirId は消す（ctx.dataDir は必ず自分の id）。内蔵は今までどおり', async () => {
    const t = mkRegistry();
    try {
      t.put(t.external, 'ext-dd', manifestOf('ext-dd', { dataDirId: 'timer' }));
      t.put(t.builtin, 'bi-dd', manifestOf('bi-dd', { dataDirId: 'timer' }));
      t.modes['ext-dd'] = 'live';
      t.modes['bi-dd'] = 'live';
      await t.registry.loadAll();
      assert.strictEqual(rowOf(t, 'ext-dd').manifest.dataDirId, undefined);
      assert.strictEqual(path.basename(ctxOf(t, 'ext-dd').dataDir), 'ext-dd');
      assert.strictEqual(path.basename(ctxOf(t, 'bi-dd').dataDir), 'timer');
    } finally { t.done(); }
  });

  // ---------------------------------------------------------------- M3
  await test('M3: 外部の provides から session.controller@1・chat.source@1 を落とす（registry）。stream.lifecycle@1 は残す', async () => {
    const t = mkRegistry();
    try {
      t.put(t.external, 'ext-pv', manifestOf('ext-pv', { provides: ['ui.panel@1', 'session.controller@1', 'chat.source@1', 'stream.lifecycle@1'] }));
      t.modes['ext-pv'] = 'live';
      await t.registry.loadAll();
      assert.deepStrictEqual(rowOf(t, 'ext-pv').manifest.provides, ['ui.panel@1', 'stream.lifecycle@1']);
      const ctx = ctxOf(t, 'ext-pv');
      assert.deepStrictEqual(ctx.chat.ingest({ text: 'x' }), { ok: false, error: 'not-chat-source' }, 'コメントの入り口を持たない');
    } finally { t.done(); }
  });

  await test('M3: installer は session.controller@1・chat.source@1 を申告した外部を provides-not-allowed で断る', async () => {
    const t = mkInstaller();
    try {
      const inst = t.make();
      for (const p of ['session.controller@1', 'chat.source@1']) {
        const f = t.zip(p + '.zip', zipEntries('pv-ext', '1.0.0', { provides: ['ui.panel@1', p] }));
        assert.strictEqual((await inst.inspect(f)).error, 'provides-not-allowed', p);
        assert.strictEqual((await inst.install(f, { expectSha256: shaOfFile(f) })).error, 'provides-not-allowed', p);
      }
      const ok = t.zip('ok.zip', zipEntries('pv-ext', '1.0.0', { provides: ['ui.panel@1', 'stream.lifecycle@1'] }));
      assert.strictEqual((await inst.inspect(ok)).ok, true);
    } finally { t.done(); }
  });

  await test('計画 C: installer は coreApi が今の核より新しい・壊れた外部を断る（版が合えば通る）', async () => {
    const t = mkInstaller();
    try {
      const inst = t.make();
      const newer = t.zip('newer.zip', zipEntries('api-ext', '1.0.0', { coreApi: 3 }));
      assert.strictEqual((await inst.inspect(newer)).error, 'core-api-too-new');
      const broken = t.zip('broken.zip', zipEntries('api-ext', '1.0.0', { coreApi: 'x' }));
      assert.strictEqual((await inst.inspect(broken)).error, 'bad-core-api');
      const same = t.zip('same.zip', zipEntries('api-ext', '1.0.0', { coreApi: 1 }));
      assert.strictEqual((await inst.inspect(same)).ok, true);
    } finally { t.done(); }
  });

  // ---------------------------------------------------------------- M4
  await test('M4: id の規則は 1 か所（installer と registry で同じ）。registry は破る外部を reserved-id で skip', async () => {
    assert.strictEqual(typeof externalIdProblem, 'function');
    ['slot-x', 'site-x', 'sink-x', 'chat-x', 'default', 'obs-engine', 'sites', '0abc', 'x'].forEach((id) => assert.ok(externalIdProblem(id), id));
    ['ext-a', 'hello', 'fo'].forEach((id) => assert.strictEqual(externalIdProblem(id), '', id));
    const t = mkRegistry();
    try {
      ['slot-x', 'site-y', 'chat-z', 'default', '0abc'].forEach((id) => { t.put(t.external, id); t.modes[id] = 'live'; });
      t.put(t.external, 'ext-ok');
      t.modes['ext-ok'] = 'live';
      // 内蔵は今までどおり slot-* を使える
      t.put(t.builtin, 'slot-bi');
      await t.registry.loadAll();
      ['slot-x', 'site-y', 'chat-z', 'default', '0abc'].forEach((id) => {
        assert.strictEqual(rowOf(t, id).status, 'skip', id);
        assert.strictEqual(rowOf(t, id).reason, 'reserved-id', id);
        assert.deepStrictEqual(marks(t.mark(id)), [], id);
      });
      assert.strictEqual(rowOf(t, 'ext-ok').status, 'running');
      assert.strictEqual(rowOf(t, 'slot-bi').source, 'set');
      assert.notStrictEqual(rowOf(t, 'slot-bi').reason, 'reserved-id');
    } finally { t.done(); }
    // installer も同じ規則（slot-x は bad-id）
    const ti = mkInstaller();
    try {
      const f = ti.zip('s.zip', zipEntries('slot-x'));
      assert.strictEqual((await ti.make().inspect(f)).error, 'bad-id');
    } finally { ti.done(); }
  });

  const real = createCore();
  function setupApi(rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4a2-api-'));
    const core = { STATE_DIR: dir, SERVICES_DIR: path.join(dir, 'services'), COOKIES_DIR: path.join(dir, 'cookies'), DATA_DIR: path.join(dir, 'data'), atomicWriteJsonSync: real.atomicWriteJsonSync };
    const ui = createUiSettings({ stateDir: dir, atomicWriteJsonSync: core.atomicWriteJsonSync });
    const api = createApi({
      core, confirmLive: true, uiSettings: ui,
      pluginRegistry: { reload: async (id) => ({ id, result: 'ok' }), snapshot: () => [] },
      bus: { publish() {} }, audit: { write() {} },
      devMode: { get: () => ({ devMode: true, source: 'default' }) },
      store: { snapshot: () => ({ destinations: [] }) },
      tips: { get: () => ({ features: [] }), setFeature: () => ({ ok: true }) },
      getState() { return { product: 'marust', plugins: rows, destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
    });
    const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
    const modesOf = () => { try { return JSON.parse(fs.readFileSync(path.join(core.SERVICES_DIR, 'marust-modes.json'), 'utf8')); } catch (_) { return {}; } };
    return { api, win, modesOf, done() { fs.rmSync(dir, { recursive: true, force: true }); } };
  }
  const row = (id, extra) => Object.assign({ id, name: id, kind: 'integration', status: 'running', source: 'set', requires: [], provides: [], audience: 'public', stability: 'stable', version: '1.0.0', mode: 'legacy' }, extra || {});

  await test('M4: 外部を動かす道は modes.set だけ。sites.setAutoSlot（confirmName を自動で入れる）では bad-id', async () => {
    // registry はもう slot-* の外部を skip するが、api の門はそれとは別に効く（二重の守り）
    const t = setupApi([row('slot-youtube', { source: 'user', kind: 'site' }), row('slot-niconico', { kind: 'site' })]);
    try {
      const r = await t.api.call('sites.setAutoSlot', { site: 'youtube', enabled: true }, t.win);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'bad-id');
      assert.strictEqual((t.modesOf().plugins || {})['slot-youtube'], undefined);
      // legacy に戻すのはどの道でも通る
      assert.strictEqual((await t.api.call('sites.setAutoSlot', { site: 'youtube', enabled: false }, t.win)).ok, true);
      // 内蔵は今までどおり
      assert.strictEqual((await t.api.call('sites.setAutoSlot', { site: 'niconico', enabled: true }, t.win)).ok, true);
      // modes.set で本人が入力すれば通る
      assert.strictEqual((await t.api.call('modes.set', { id: 'slot-youtube', mode: 'live', confirmName: 'slot-youtube' }, t.win)).ok, true);
    } finally { t.done(); }
  });

  // ---------------------------------------------------------------- M5
  await test('M5: isStreaming・modeOf・setLegacy・rescan は必須（無ければ作るときに throw）', async () => {
    for (const k of ['isStreaming', 'modeOf', 'setLegacy', 'rescan']) {
      const t = mkInstaller({ [k]: undefined });
      try { assert.throws(() => t.make(), new RegExp(k), k); } finally { t.done(); }
    }
  });

  await test('M5: 新しく入れるのも配信中は断る（何も置かない）', async () => {
    const t = mkInstaller();
    try {
      const inst = t.make();
      const f = t.zip('n.zip', zipEntries('new-ext'));
      t.st.streaming = true;
      assert.strictEqual((await inst.install(f, { expectSha256: shaOfFile(f) })).error, 'streaming');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'new-ext')));
      assert.deepStrictEqual(t.st.events, []);
      assert.deepStrictEqual(t.st.rescans, []);
    } finally { t.done(); }
  });

  await test('M5: legacy はファイルを動かす前に書く。書けなければ mode-write-failed で止まり、何も変わらない', async () => {
    const t = mkInstaller();
    try {
      const inst = t.make();
      const v1 = t.zip('v1.zip', zipEntries('ord-ext', '1.0.0'));
      assert.strictEqual((await inst.install(v1, { expectSha256: shaOfFile(v1) })).ok, true);
      assert.deepStrictEqual(t.st.events, [{ legacy: 'ord-ext', present: '' }], '新規: 置く前に legacy');
      const v2 = t.zip('v2.zip', zipEntries('ord-ext', '2.0.0'));
      assert.strictEqual((await inst.install(v2, { expectSha256: shaOfFile(v2) })).ok, true);
      assert.ok(/index\.js/.test(t.st.events[1].present), '更新: 古い版が置き場にあるうちに legacy');
      const before = fs.readFileSync(path.join(t.plugins, 'ord-ext', 'index.js'), 'utf8');
      t.st.legacyOk = false;
      const v3 = t.zip('v3.zip', zipEntries('ord-ext', '3.0.0'));
      assert.strictEqual((await inst.install(v3, { expectSha256: shaOfFile(v3) })).error, 'mode-write-failed');
      assert.strictEqual((await inst.restore('ord-ext')).error, 'mode-write-failed');
      assert.strictEqual((await inst.remove('ord-ext')).error, 'mode-write-failed');
      assert.strictEqual(fs.readFileSync(path.join(t.plugins, 'ord-ext', 'index.js'), 'utf8'), before, '何も変わらない');
      assert.deepStrictEqual(fs.readdirSync(t.plugins).sort(), ['ord-ext'], '作りかけが残らない');
      assert.ok(fs.existsSync(path.join(t.stateDir, 'plugins-backup', 'ord-ext-1.0.0')), 'バックアップもそのまま');
      const newOne = t.zip('n.zip', zipEntries('new2-ext'));
      assert.strictEqual((await inst.install(newOne, { expectSha256: shaOfFile(newOne) })).error, 'mode-write-failed');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'new2-ext')));
    } finally { t.done(); }
  });

  // ---------------------------------------------------------------- M6
  await test('M6: rescanExternal(id) は変えた id だけ読み直す（A が live のまま B を入れても A の start は 1 回）', async () => {
    const t = mkRegistry();
    try {
      t.put(t.external, 'ext-a');
      t.modes['ext-a'] = 'live';
      await t.registry.loadAll();
      assert.deepStrictEqual(marks(t.mark('ext-a')), ['load', 'start']);
      t.put(t.external, 'ext-b');
      t.modes['ext-b'] = 'shadow';
      await t.registry.rescanExternal('ext-b');
      assert.deepStrictEqual(marks(t.mark('ext-a')), ['load', 'start'], 'A は止まらない・読み直さない');
      assert.strictEqual(rowOf(t, 'ext-b').status, 'running');
      assert.strictEqual(rowOf(t, 'ext-a').status, 'running');
      // B を消して B だけ読み直す
      fs.rmSync(path.join(t.external, 'ext-b'), { recursive: true, force: true });
      await t.registry.rescanExternal('ext-b');
      assert.ok(!rowOf(t, 'ext-b'));
      assert.deepStrictEqual(marks(t.mark('ext-b')).slice(-2), ['destroy', 'stop']);
      assert.deepStrictEqual(marks(t.mark('ext-a')), ['load', 'start']);
      assert.strictEqual(t.registry.snapshot().filter((r) => r.id === 'ext-a').length, 1, '記録が増えない');
    } finally { t.done(); }
  });

  await test('M6: installer は rescan に変えた id を渡す', async () => {
    const t = mkInstaller();
    try {
      const inst = t.make();
      const f = t.zip('a.zip', zipEntries('resc-ext'));
      await inst.install(f, { expectSha256: shaOfFile(f) });
      await inst.remove('resc-ext');
      await inst.restore('resc-ext');
      assert.deepStrictEqual(t.st.rescans, ['resc-ext', 'resc-ext', 'resc-ext']);
    } finally { t.done(); }
  });

  // ---------------------------------------------------------------- M7
  await test('M7: install は expectSha256 が inspect と同じときだけ。無ければ・違えば断る', async () => {
    const t = mkInstaller();
    try {
      const inst = t.make();
      const f = t.zip('h.zip', zipEntries('hash-ext', '1.0.0'));
      const seen = await inst.inspect(f);
      assert.strictEqual(seen.ok, true);
      assert.strictEqual((await inst.install(f)).error, 'expect-sha256-required');
      assert.strictEqual((await inst.install(f, {})).error, 'expect-sha256-required');
      // 承認のあとで中身が変わった
      fs.writeFileSync(f, buildZip(zipEntries('hash-ext', '9.9.9')));
      assert.strictEqual((await inst.install(f, { expectSha256: seen.sha256 })).error, 'changed-since-inspect');
      assert.ok(!fs.existsSync(path.join(t.plugins, 'hash-ext')));
      assert.deepStrictEqual(fs.existsSync(t.plugins) ? fs.readdirSync(t.plugins) : [], [], '作りかけが残らない');
      // フォルダでも同じ（ハッシュは inspect の値）
      const dir = path.join(t.root, 'src', 'folder-ext');
      fs.mkdirSync(dir);
      zipEntries('folder-ext').forEach((e) => fs.writeFileSync(path.join(dir, e.name), e.data));
      const fseen = await inst.inspect(dir);
      fs.appendFileSync(path.join(dir, 'index.js'), '// changed\n');
      assert.strictEqual((await inst.install(dir, { expectSha256: fseen.sha256 })).error, 'changed-since-inspect');
      const fseen2 = await inst.inspect(dir);
      const ok = await inst.install(dir, { expectSha256: fseen2.sha256 });
      assert.strictEqual(ok.ok, true);
      assert.strictEqual(ok.sha256, fseen2.sha256);
    } finally { t.done(); }
  });

  // ---------------------------------------------------------------- M8
  await test('M8: L8d: 外部の ctx にも core が渡る（出どころ制限解除）。外部の v1 manifest は v1-not-allowed で skip', async () => {
    const t = mkRegistry();
    try {
      t.put(t.external, 'ext-c');
      t.put(t.builtin, 'bi-c');
      t.modes['ext-c'] = 'live';
      t.modes['bi-c'] = 'live';
      t.put(t.external, 'ext-v1', { id: 'ext-v1', name: 'v1', version: '1.0.0', kind: 'site', capabilities: ['title'], main: 'index.js', fanout: { requires: 'cookie', method: 'updateTitle' } });
      t.modes['ext-v1'] = 'live';
      await t.registry.loadAll();
      assert.ok(ctxOf(t, 'ext-c').core && ctxOf(t, 'ext-c').core.STATE_DIR, '外部にも ctx.core が渡る');
      assert.ok(ctxOf(t, 'bi-c').core && ctxOf(t, 'bi-c').core.STATE_DIR, '内蔵は今までどおり');
      assert.strictEqual(rowOf(t, 'ext-v1').status, 'skip');
      assert.strictEqual(rowOf(t, 'ext-v1').reason, 'v1-not-allowed');
      assert.deepStrictEqual(marks(t.mark('ext-v1')), []);
    } finally { t.done(); }
  });

  await test('M8: docs/PLUGIN-API.md に外部の制限が書いてある', async () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PLUGIN-API.md'), 'utf8');
    const at = doc.indexOf('## 外から入れるプラグインの制限');
    assert.ok(at !== -1, '見出しがある');
    const sec = doc.slice(at, at + 4000);
    ['ctx.core', 'manifestVersion', 'dataDirId', 'session.controller@1', 'chat.source@1', 'obs.streamControl', 'ext.<id>.', 'reserved-id', 'modes.set'].forEach((w) => assert.ok(sec.includes(w), w));
  });

  // ---------------------------------------------------------------- M9
  await test('M9: 版は末尾も英数字（1. や 1.0- は bad-version）', async () => {
    const t = mkInstaller();
    try {
      const inst = t.make();
      for (const v of ['1.', '1.0.', '1.0-', '1+']) {
        const f = t.zip('v' + encodeURIComponent(v) + '.zip', zipEntries('ver-ext', v));
        assert.strictEqual((await inst.inspect(f)).error, 'bad-version', v);
      }
      for (const v of ['1', '1.0.0', '1.0.0-beta.1', '2.0+b3']) {
        const f = t.zip('ok' + encodeURIComponent(v) + '.zip', zipEntries('ver-ext', v));
        assert.strictEqual((await inst.inspect(f)).ok, true, v);
      }
    } finally { t.done(); }
  });

  if (failed) { console.error('\n[p4a-star2] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] p4a ★2 fix tests passed');
})();
