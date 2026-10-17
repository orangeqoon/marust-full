'use strict';
require('./_ui-inline');

/**
 * P4a: 外から入れるプラグインの検証・展開・更新・戻す・消す（host/core/plugin-install.js。PLAN-plugin-core §7.3）。
 * 偽のもの（一時フォルダ・手で作った zip・偽の状態）だけ。本物のサイト・OBS・Google には触らない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const { createPluginInstaller, safeText, checkRelPath } = require('../host/layer1/plugin-install');
const { buildZip, LINK, FILE } = require('./_zip-fixture');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const MAIN_SRC = 'module.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n';
function manifest(id, version, extra) {
  return Object.assign({ id, name: 'テスト ' + id, version: version || '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'], defaultMode: 'live' }, extra || {});
}
const good = (id, version, extra) => [
  { name: 'manifest.json', data: JSON.stringify(manifest(id, version, extra)) },
  { name: 'index.js', data: MAIN_SRC + '// ' + (version || '1.0.0') + '\n' }
];

function mk(over) {
  const o = over || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4a-'));
  const stateDir = path.join(root, 'state');
  const builtin = path.join(root, 'builtin');
  fs.mkdirSync(path.join(builtin, 'timer'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const st = { streaming: false, mode: 'legacy', legacy: [], rescan: 0, audit: [] };
  const inst = createPluginInstaller(Object.assign({
    stateDir,
    builtinRoots: [builtin],
    reservedIds: () => ['author-only'],
    isStreaming: async () => st.streaming,
    modeOf: () => st.mode,
    setLegacy: (id) => { st.legacy.push(id); return { ok: true }; },
    rescan: async () => { st.rescan += 1; },
    audit: (line) => st.audit.push(line),
    random: (() => { let n = 0; return () => 'r' + (n += 1); })()
  }, o.opts || {}));
  const zip = (name, entries) => { const f = path.join(src, name); fs.writeFileSync(f, buildZip(entries)); return f; };
  const plugins = path.join(stateDir, 'plugins');
  const backup = path.join(stateDir, 'plugins-backup');
  // ★2 M7: install は inspect で見せた sha256 を渡したときだけ入る（画面と同じ手順）
  const install = async (source) => {
    const seen = await inst.inspect(source);
    return seen.ok ? inst.install(source, { expectSha256: seen.sha256 }) : seen;
  };
  return {
    root, stateDir, builtin, src, st, inst, install, zip, plugins, backup,
    // 失敗したあとの後始末の検査: 作りかけ（.tmp-*）が残らず、置き場にも何も増えない
    expectClean(ids) {
      const names = fs.existsSync(plugins) ? fs.readdirSync(plugins).sort() : [];
      assert.deepStrictEqual(names, (ids || []).slice().sort(), '置き場に余計なものが残った: ' + names.join(','));
    },
    done() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

async function rejects(t, entries, code, label) {
  const f = t.zip((label || code) + '.zip', entries);
  const r = await t.install(f);
  assert.strictEqual(r.ok, false, label || code);
  assert.strictEqual(r.error, code, (label || code) + ' → ' + r.error);
  t.expectClean([]);
  assert.strictEqual(t.st.rescan, 0);
  assert.deepStrictEqual(t.st.legacy, []);
}

(async () => {
  await test('正しい zip（manifest が先頭）: inspect は何も残さない・install で置かれて legacy・監査はハッシュの先頭 12 文字だけ', async () => {
    const t = mk();
    try {
      const f = t.zip('good.zip', good('hello-ext', '1.0.0', { secrets: ['ext.hello-ext.token'], needs: ['obs.read'] }));
      const seen = await t.inst.inspect(f);
      assert.strictEqual(seen.ok, true);
      assert.deepStrictEqual([seen.id, seen.version, seen.format, seen.updates], ['hello-ext', '1.0.0', 'zip', false]);
      assert.deepStrictEqual(seen.uses, { secrets: ['ext.hello-ext.token'], needs: ['obs.read'], provides: ['ui.panel@1'], slots: [], menu: [] });
      assert.match(seen.sha256, /^[0-9a-f]{64}$/);
      assert.strictEqual(seen.sourceName, 'good.zip');
      t.expectClean([]);
      const r = await t.install(f);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.updated, false);
      assert.ok(fs.existsSync(path.join(t.plugins, 'hello-ext', 'index.js')));
      const rec = JSON.parse(fs.readFileSync(path.join(t.plugins, 'hello-ext', '.install.json'), 'utf8'));
      assert.deepStrictEqual([rec.id, rec.version, rec.sha256, rec.format], ['hello-ext', '1.0.0', seen.sha256, 'zip']);
      t.expectClean(['hello-ext']);
      assert.deepStrictEqual(t.st.legacy, ['hello-ext'], '入れた直後は必ず legacy を書く');
      assert.strictEqual(t.st.rescan, 1);
      assert.deepStrictEqual(t.st.audit, [{ action: 'plugin.install', id: 'hello-ext', version: '1.0.0', sha: seen.sha256.slice(0, 12) }]);
    } finally { t.done(); }
  });

  await test('1 つのフォルダに包んだ zip（__MACOSX は無視）も入る', async () => {
    const t = mk();
    try {
      const wrapped = good('wrapped-ext').map((e) => ({ name: 'wrapped-ext/' + e.name, data: e.data }));
      const f = t.zip('wrapped.zip', [{ name: 'wrapped-ext/', attrs: (0o040755 << 16) >>> 0 }].concat(wrapped, [{ name: '__MACOSX/x', data: 'junk' }]));
      assert.strictEqual((await t.install(f)).ok, true);
      assert.ok(fs.existsSync(path.join(t.plugins, 'wrapped-ext', 'manifest.json')));
      t.expectClean(['wrapped-ext']);
    } finally { t.done(); }
  });

  await test('フォルダから入れる（フォルダの中のフォルダも）・同じ内容なら同じハッシュ', async () => {
    const t = mk();
    try {
      const dir = path.join(t.src, 'folder-ext');
      fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
      good('folder-ext').forEach((e) => fs.writeFileSync(path.join(dir, e.name), e.data));
      fs.writeFileSync(path.join(dir, 'ui', 'panel.html'), '<p>x</p>');
      const a = await t.inst.inspect(dir);
      const b = await t.inst.inspect(dir);
      assert.strictEqual(a.ok, true);
      assert.strictEqual(a.format, 'folder');
      assert.strictEqual(a.sha256, b.sha256);
      assert.strictEqual(a.fileCount, 3);
      assert.strictEqual((await t.install(dir)).ok, true);
      assert.ok(fs.existsSync(path.join(t.plugins, 'folder-ext', 'ui', 'panel.html')));
      t.expectClean(['folder-ext']);
    } finally { t.done(); }
  });

  await test('悪い zip: パスのはみ出し（.. ・絶対パス・ドライブ・バックスラッシュ・UNC）', async () => {
    const t = mk();
    try {
      const base = good('evil-ext');
      await rejects(t, base.concat([{ name: '../evil.js', data: 'x' }]), 'bad-path', 'dotdot');
      await rejects(t, base.concat([{ name: 'ui/../../evil.js', data: 'x' }]), 'bad-path', 'dotdot-inner');
      await rejects(t, base.concat([{ name: '/etc/evil.js', data: 'x' }]), 'bad-path', 'absolute');
      await rejects(t, base.concat([{ name: 'C:/evil.js', data: 'x' }]), 'bad-path', 'drive');
      await rejects(t, base.concat([{ name: 'C:\\evil.js', data: 'x' }]), 'bad-path', 'drive-backslash');
      await rejects(t, base.concat([{ name: 'ui\\evil.js', data: 'x' }]), 'bad-path', 'backslash');
      await rejects(t, base.concat([{ name: '\\\\server\\share\\evil.js', data: 'x' }]), 'bad-path', 'unc');
    } finally { t.done(); }
  });

  await test('悪い zip: Windows の予約名・ADS・末尾の点や空白・制御文字・向きを変える文字', async () => {
    const t = mk();
    try {
      const base = good('evil-ext');
      let n = 0;
      for (const bad of ['nul', 'NUL.txt', 'con', 'aux.js', 'COM1', 'lpt9.log', 'com\u00b9.txt', 'ui/prn.html', 'a.js:stream', 'a.js.', 'a.js ', 'dir./x.js', 'x\u0007.js', 'x\u202e.js', 'x\u200b.js', 'a?.js', 'a*.js', 'a<b>.js']) {
        await rejects(t, base.concat([{ name: bad, data: 'x' }]), 'bad-path', 'name' + (n += 1));
      }
      assert.strictEqual(checkRelPath('ok/file.js', false), '');
      assert.strictEqual(checkRelPath('日本語/ファイル.js', false), '', '日本語の名前は通す');
    } finally { t.done(); }
  });

  await test('悪い zip: 大文字小文字だけ・NFC/NFD だけ違う重複', async () => {
    const t = mk();
    try {
      const base = good('evil-ext');
      await rejects(t, base.concat([{ name: 'INDEX.js', data: 'x' }]), 'duplicate-path', 'case');
      await rejects(t, base.concat([{ name: 'ui/a.js', data: 'x' }, { name: 'UI/A.JS', data: 'x' }]), 'duplicate-path', 'case-dir');
      await rejects(t, base.concat([{ name: 'caf\u00e9.js', data: 'x' }, { name: 'cafe\u0301.js', data: 'x' }]), 'duplicate-path', 'nfc');
      await rejects(t, base.concat([{ name: 'index.js', data: 'x' }]), 'duplicate-path', 'same-name');
    } finally { t.done(); }
  });

  await test('悪い zip: シンボリックリンク・暗号化・予約の名前（.install.json）', async () => {
    const t = mk();
    try {
      const base = good('evil-ext');
      await rejects(t, base.concat([{ name: 'link.js', data: '/etc/passwd', attrs: LINK }]), 'link-not-allowed', 'symlink');
      await rejects(t, base.concat([{ name: 'dev', data: '', attrs: ((0o020000 << 16) >>> 0) }]), 'link-not-allowed', 'special');
      await rejects(t, base.concat([{ name: 'secret.bin', data: 'x', encrypted: true }]), 'zip-invalid', 'encrypted');
      await rejects(t, base.concat([{ name: '.install.json', data: '{}' }]), 'bad-path', 'install-json');
    } finally { t.done(); }
  });

  await test('悪い zip: 大きすぎる（申告の合計・1 ファイル・個数）と、申告をごまかした zip', async () => {
    const t = mk();
    try {
      const base = good('big-ext');
      const mb = (n) => Buffer.alloc(n * 1024 * 1024);
      await rejects(t, base.concat([{ name: 'a.bin', data: mb(11) }]), 'too-big', 'one-file-11mb'); // 1 ファイル 10 MB まで
      await rejects(t, base.concat([{ name: 'a.bin', data: mb(9) }, { name: 'b.bin', data: mb(9) }, { name: 'c.bin', data: mb(9) }]), 'too-big', 'total-27mb'); // 合計 20 MB まで
      await rejects(t, base.concat([{ name: 'bomb.bin', data: mb(300) }]), 'too-big', 'bomb-300mb'); // 圧縮すると小さい（zip 爆弾）
      const many = [];
      for (let i = 0; i < 2001; i += 1) many.push({ name: 'f' + i + '.txt', data: 'x', method: 0 });
      await rejects(t, base.concat(many), 'too-many-files', 'files-2001');
      // 申告より実際が大きい／小さい: 読んだバイト数が合わないので止まる
      await rejects(t, base.concat([{ name: 'lie.bin', data: Buffer.alloc(5000, 1), usize: 10 }]), 'zip-invalid', 'lie-small');
      await rejects(t, base.concat([{ name: 'lie2.bin', data: Buffer.alloc(10, 1), usize: 5000 }]), 'zip-invalid', 'lie-big');
      // 保存だけ（圧縮なし）で申告が違う
      await rejects(t, base.concat([{ name: 'lie3.bin', data: Buffer.alloc(100, 1), usize: 50, method: 0 }]), 'zip-invalid', 'lie-stored');
      // zip ファイルそのものが大きすぎる
      const huge = path.join(t.src, 'huge.zip');
      fs.writeFileSync(huge, Buffer.alloc(21 * 1024 * 1024));
      assert.strictEqual((await t.install(huge)).error, 'too-big');
      t.expectClean([]);
    } finally { t.done(); }
  });

  await test('悪い zip: zip でないもの・壊れたもの・空・存在しない・manifest が無い・ほかの層', async () => {
    const t = mk();
    try {
      const notZip = path.join(t.src, 'x.zip');
      fs.writeFileSync(notZip, 'this is not a zip');
      assert.strictEqual((await t.install(notZip)).error, 'zip-invalid');
      const cut = buildZip(good('cut-ext'));
      fs.writeFileSync(notZip, cut.subarray(0, cut.length - 30));
      assert.strictEqual((await t.install(notZip)).error, 'zip-invalid');
      assert.strictEqual((await t.install(path.join(t.src, 'nope.zip'))).error, 'not-found');
      assert.strictEqual((await t.install('')).error, 'not-found');
      assert.strictEqual((await t.install(null)).error, 'not-found');
      await rejects(t, [{ name: 'index.js', data: MAIN_SRC }], 'no-manifest', 'no-manifest');
      await rejects(t, [{ name: 'a/manifest.json', data: '{}' }, { name: 'b/index.js', data: 'x' }], 'no-manifest', 'two-tops');
      t.expectClean([]);
    } finally { t.done(); }
  });

  await test('manifest の検査: v2・inproc・id・版・main・サイトの形・secrets の名前空間・obs.streamControl・内蔵と同じ id', async () => {
    const t = mk();
    try {
      const zipOf = (m, extra) => [{ name: 'manifest.json', data: typeof m === 'string' ? m : JSON.stringify(m) }, { name: 'index.js', data: MAIN_SRC }].concat(extra || []);
      await rejects(t, zipOf('{not json'), 'bad-manifest', 'json');
      await rejects(t, zipOf(manifest('m-ext', '1.0.0', { manifestVersion: 1 })), 'bad-manifest', 'v1');
      await rejects(t, zipOf(manifest('m-ext', '1.0.0', { runtime: 'child' })), 'bad-runtime', 'child');
      await rejects(t, zipOf(manifest('M_EXT')), 'bad-id', 'id-case');
      await rejects(t, zipOf(manifest('x')), 'bad-id', 'id-short');
      await rejects(t, zipOf(manifest('site-evil')), 'bad-id', 'prefix-site');
      await rejects(t, zipOf(manifest('chat-evil')), 'bad-id', 'prefix-chat');
      await rejects(t, zipOf(manifest('../evil')), 'bad-id', 'id-path');
      await rejects(t, zipOf(manifest('timer')), 'id-reserved', 'same-as-builtin');
      await rejects(t, zipOf(manifest('obs-engine')), 'id-reserved', 'core-id');
      await rejects(t, zipOf(manifest('author-only')), 'id-reserved', 'same-as-author');
      await rejects(t, zipOf(manifest('v-ext', '../../1')), 'bad-version', 'version-path');
      await rejects(t, zipOf(Object.assign(manifest('v-ext'), { version: '' })), 'bad-version', 'version-empty');
      await rejects(t, zipOf(manifest('m-ext', '1.0.0', { main: '../x.js' })), 'bad-main', 'main-escape');
      await rejects(t, zipOf(manifest('m-ext', '1.0.0', { main: 'nope.js' })), 'bad-main', 'main-missing');
      await rejects(t, zipOf(manifest('m-ext', '1.0.0', { roles: { site: { main: 'site.js' } } })), 'site-format-not-allowed', 'roles');
      // L8g: ext.<id>. の縛りは外した（cookies.niconico-main や ext.other.token も宣言できる）。名前の形（小文字・数字・点・ハイフン）だけ残る
      await rejects(t, zipOf(manifest('m-ext', '1.0.0', { secrets: ['ext.m-ext.TOKEN'] })), 'secret-namespace', 'secret-case');
      await rejects(t, zipOf(manifest('m-ext', '1.0.0', { needs: ['obs.read', 'obs.streamControl'] })), 'needs-not-allowed', 'stream-control');
      await rejects(t, zipOf(manifest('m-ext'), [{ name: 'x', data: '' }, { name: 'X/', attrs: 0 }]), 'duplicate-path', 'file-vs-dir');
      await rejects(t, zipOf('{"x":"' + 'a'.repeat(300 * 1024) + '"}'), 'bad-manifest', 'manifest-too-big');
      // 全部合格する形
      assert.strictEqual((await t.install(t.zip('ok.zip', zipOf(manifest('ok-ext', '1.0.0', { secrets: ['ext.ok-ext.token', 'ext.ok-ext.a.b-c', 'twitch.oauth', 'ext.other.token'], needs: ['obs.read'] }))))).ok, true);
    } finally { t.done(); }
  });

  await test('フォルダの検査: リンク（ジャンクション・シンボリックリンク）・予約名・大きすぎ・manifest 無し', async () => {
    const t = mk();
    try {
      const mkSrc = (name) => {
        const dir = path.join(t.src, name);
        fs.mkdirSync(dir, { recursive: true });
        good('f-ext').forEach((e) => fs.writeFileSync(path.join(dir, e.name), e.data));
        return dir;
      };
      const target = path.join(t.root, 'target');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'secret.txt'), 'top secret');
      let linked = false;
      const withLink = mkSrc('with-junction');
      try { fs.symlinkSync(target, path.join(withLink, 'lnk'), 'junction'); linked = true; } catch (_) { /* 作れない環境 */ }
      if (linked) {
        const r = await t.install(withLink);
        assert.strictEqual(r.error, 'link-not-allowed');
        t.expectClean([]);
      }
      const withFileLink = mkSrc('with-symlink');
      let fileLinked = false;
      try { fs.symlinkSync(path.join(target, 'secret.txt'), path.join(withFileLink, 'lnk.txt'), 'file'); fileLinked = true; } catch (_) { /* 権限が無い環境 */ }
      if (fileLinked) {
        assert.strictEqual((await t.install(withFileLink)).error, 'link-not-allowed');
        t.expectClean([]);
      }
      // 選んだフォルダ自体がリンク
      const rootLink = path.join(t.src, 'root-link');
      let rootLinked = false;
      try { fs.symlinkSync(mkSrc('real'), rootLink, 'junction'); rootLinked = true; } catch (_) { /* 作れない環境 */ }
      if (rootLinked) {
        assert.strictEqual((await t.install(rootLink)).error, 'link-not-allowed');
        t.expectClean([]);
      }
      const reserved = mkSrc('reserved');
      fs.writeFileSync(path.join(reserved, 'aux.js'), 'x');
      assert.strictEqual((await t.install(reserved)).error, 'bad-path');
      const big = mkSrc('big');
      fs.writeFileSync(path.join(big, 'big.bin'), Buffer.alloc(11 * 1024 * 1024));
      assert.strictEqual((await t.install(big)).error, 'too-big');
      const none = path.join(t.src, 'none');
      fs.mkdirSync(none);
      fs.writeFileSync(path.join(none, 'index.js'), MAIN_SRC);
      assert.strictEqual((await t.install(none)).error, 'no-manifest');
      t.expectClean([]);
    } finally { t.done(); }
  });

  await test('更新: 古い版は plugins-backup に 1 つだけ。同じ id でも legacy に戻る。戻す＝入れ替わる', async () => {
    const t = mk();
    try {
      assert.strictEqual((await t.install(t.zip('v1.zip', good('upd-ext', '1.0.0')))).ok, true);
      const u2 = await t.install(t.zip('v2.zip', good('upd-ext', '2.0.0')));
      assert.deepStrictEqual([u2.ok, u2.updated, u2.previousVersion], [true, true, '1.0.0']);
      assert.ok(fs.existsSync(path.join(t.backup, 'upd-ext-1.0.0', 'index.js')));
      assert.match(fs.readFileSync(path.join(t.plugins, 'upd-ext', 'index.js'), 'utf8'), /2\.0\.0/);
      assert.deepStrictEqual(t.st.audit.map((a) => a.action), ['plugin.install', 'plugin.update']);
      const u3 = await t.install(t.zip('v3.zip', good('upd-ext', '3.0.0')));
      assert.strictEqual(u3.previousVersion, '2.0.0');
      assert.deepStrictEqual(fs.readdirSync(t.backup).sort(), ['upd-ext-2.0.0'], '古い版は 1 つだけ');
      assert.deepStrictEqual(t.st.legacy, ['upd-ext', 'upd-ext', 'upd-ext'], '更新のたびに legacy を書く');
      const back = await t.inst.restore('upd-ext');
      assert.deepStrictEqual([back.ok, back.version, back.previousVersion], [true, '2.0.0', '3.0.0']);
      assert.match(fs.readFileSync(path.join(t.plugins, 'upd-ext', 'index.js'), 'utf8'), /2\.0\.0/);
      assert.deepStrictEqual(fs.readdirSync(t.backup).sort(), ['upd-ext-3.0.0']);
      assert.strictEqual(t.st.audit[t.st.audit.length - 1].action, 'plugin.restore');
      t.expectClean(['upd-ext']);
      assert.deepStrictEqual(t.inst.list().installed.map((x) => [x.id, x.version, x.backupVersion]), [['upd-ext', '2.0.0', '3.0.0']]);
      // 戻せるものが無い／不正な id
      assert.strictEqual((await t.inst.restore('nothing-ext')).error, 'no-backup');
      assert.strictEqual((await t.inst.restore('../x')).error, 'bad-id');
    } finally { t.done(); }
  });

  await test('更新・戻す・消すは、配信中と live のあいだは断る（何も動かない）。legacy／shadow なら通る', async () => {
    const t = mk();
    try {
      await t.install(t.zip('v1.zip', good('gate-ext', '1.0.0')));
      const before = fs.readFileSync(path.join(t.plugins, 'gate-ext', 'index.js'), 'utf8');
      t.st.streaming = true;
      assert.strictEqual((await t.install(t.zip('v2.zip', good('gate-ext', '2.0.0')))).error, 'streaming');
      assert.strictEqual((await t.inst.remove('gate-ext')).error, 'streaming');
      t.st.streaming = false;
      t.st.mode = 'live';
      assert.strictEqual((await t.install(t.zip('v2b.zip', good('gate-ext', '2.0.0')))).error, 'live');
      assert.strictEqual((await t.inst.remove('gate-ext')).error, 'live');
      assert.strictEqual(fs.readFileSync(path.join(t.plugins, 'gate-ext', 'index.js'), 'utf8'), before, '何も変わらない');
      assert.ok(!fs.existsSync(t.backup) || fs.readdirSync(t.backup).length === 0);
      t.expectClean(['gate-ext']);
      t.st.mode = 'shadow';
      assert.strictEqual((await t.install(t.zip('v2c.zip', good('gate-ext', '2.0.0')))).ok, true);
      // 戻すも同じ
      t.st.mode = 'live';
      assert.strictEqual((await t.inst.restore('gate-ext')).error, 'live');
      assert.ok(fs.existsSync(path.join(t.backup, 'gate-ext-1.0.0')), '戻せなかったらバックアップは元の場所');
      t.st.streaming = true;
      t.st.mode = 'legacy';
      assert.strictEqual((await t.inst.restore('gate-ext')).error, 'streaming');
      assert.ok(fs.existsSync(path.join(t.backup, 'gate-ext-1.0.0')));
      t.expectClean(['gate-ext']);
    } finally { t.done(); }
  });

  await test('消す＝plugins-backup へ移す。もう一度入れても legacy。消えたものは消せない。不正な id は断る', async () => {
    const t = mk();
    try {
      await t.install(t.zip('v1.zip', good('del-ext', '1.0.0')));
      t.st.legacy.length = 0;
      const r = await t.inst.remove('del-ext');
      assert.deepStrictEqual(r, { ok: true, id: 'del-ext', version: '1.0.0' });
      t.expectClean([]);
      assert.ok(fs.existsSync(path.join(t.backup, 'del-ext-1.0.0', 'manifest.json')));
      assert.deepStrictEqual(t.st.legacy, ['del-ext'], '消すときも legacy を書く（あとで同じ名前が入っても動かない）');
      assert.strictEqual(t.st.audit[t.st.audit.length - 1].action, 'plugin.remove');
      assert.strictEqual((await t.inst.remove('del-ext')).error, 'not-installed');
      for (const bad of ['', '../x', 'a/b', 'A_B', 'x', null, 5]) assert.strictEqual((await t.inst.remove(bad)).error, 'bad-id');
      // 戻す
      assert.strictEqual((await t.inst.restore('del-ext')).ok, true);
      t.expectClean(['del-ext']);
      // 内蔵のフォルダは消せない
      assert.strictEqual((await t.inst.remove('timer')).error, 'not-installed');
      assert.ok(fs.existsSync(path.join(t.builtin, 'timer')));
    } finally { t.done(); }
  });

  await test('作りかけ（.tmp-*）は次の操作で片付く。同時に頼んでも順番に処理される', async () => {
    const t = mk();
    try {
      fs.mkdirSync(path.join(t.plugins, '.tmp-old'), { recursive: true });
      fs.writeFileSync(path.join(t.plugins, '.tmp-old', 'x'), 'x');
      const [a, b] = await Promise.all([
        t.install(t.zip('a.zip', good('par-a', '1.0.0'))),
        t.install(t.zip('b.zip', good('par-b', '1.0.0')))
      ]);
      assert.deepStrictEqual([a.ok, b.ok], [true, true]);
      t.expectClean(['par-a', 'par-b']);
    } finally { t.done(); }
  });

  await test('表示用の文字: 制御文字・bidi を通さない／ファイル名も同じ', async () => {
    assert.strictEqual(safeText('a\u202eb\u0007c\u200bd\n', 10), 'abcd');
    assert.strictEqual(safeText(null), '');
    assert.strictEqual(safeText('x'.repeat(200), 5), 'xxxxx');
    const t = mk();
    try {
      const f = t.zip('evil\u202egpj.zip', good('disp-ext'));
      const r = await t.inst.inspect(f);
      assert.ok(r.ok);
      assert.ok(!/[\u202e\u0007]/.test(r.sourceName) && !/[\u202e]/.test(r.name));
    } finally { t.done(); }
  });

  await test('部品: yauzl は完全一致の版で固定・lock に integrity がある', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(pkg.dependencies.yauzl, /^3\.\d+\.\d+$/, '^ や ~ を付けない');
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
    const row = lock.packages['node_modules/yauzl'];
    assert.strictEqual(row.version, pkg.dependencies.yauzl);
    assert.match(row.integrity, /^sha512-/);
    assert.ok(!row.dev, '配る exe に入る（devDependencies ではない）');
  });

  if (failed) { console.error('\n[p4a-install] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] p4a plugin install tests passed');
})();
