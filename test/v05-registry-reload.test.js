'use strict';
require('./_ui-inline');

/**
 * V0.5 S1: registry のログの箱・lastError（where は相対パス:行）・同時読み直しの busy。
 * 一時フォルダの偽のプラグインだけ。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRegistry } = require('../host/layer1/plugin-registry');
const { cleanText, cleanError } = require('../host/layer1/plugin-errors');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v05-reg-'));
  const builtin = path.join(root, 'builtin');
  fs.mkdirSync(builtin, { recursive: true });
  const registry = createRegistry({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: builtin,
    authorRoot: path.join(root, 'no-author'),
    externalRoot: path.join(root, 'state', 'plugins'),
    logger() {}
  });
  const put = (id, source) => {
    const dir = path.join(builtin, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'] }));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
    return dir;
  };
  return { root, registry, put, done() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const OK_SRC = 'module.exports = { load(ctx) { ctx.logger("info", "hello " + ctx.pluginDir); }, start() {}, stop() {}, destroy() {} };\n';
const rowOf = (t, id) => t.registry.snapshot().find((r) => r.id === id);
const leaks = (value, root) => {
  const text = JSON.stringify(value);
  return text.toLowerCase().includes(root.toLowerCase().replace(/\\/g, '\\\\')) || text.includes(os.homedir().replace(/\\/g, '\\\\'));
};

(async () => {
  await test('cleanText / cleanError: 絶対パスは <plugin>・<app>・~ になり、where は相対パス:行', () => {
    const dir = path.join(os.tmpdir(), 'x-plugin');
    const err = new Error('bad ' + path.join(dir, 'index.js'));
    err.stack = 'Error: bad\n    at f (' + path.join(dir, 'sub', 'a.js') + ':12:3)\n    at g (C:\\other\\z.js:1:1)';
    const out = cleanError(err, dir, os.tmpdir());
    assert.strictEqual(out.where, 'sub/a.js:12');
    assert.ok(!out.message.includes(dir));
    assert.ok(out.message.includes('<plugin>'));
    assert.strictEqual(cleanText('token=abc ' + os.homedir(), dir, os.tmpdir()).includes('abc'), false);
    assert.strictEqual(cleanError(new Error('x'), dir, os.tmpdir()).where, '');
  });

  await test('空白を含むフォルダでも where が取れる・8.3 の短い名前やユーザー名は伏せる', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v05-sp-'));
    const dir = path.join(base, 'Mister Smith', 'my plugin');
    try {
      const err = new Error('boom');
      err.stack = 'Error: boom\n    at load (' + path.join(dir, 'sub dir', 'a.js') + ':7:5)\n    at Module._compile (node:internal/modules/cjs/loader:1:1)';
      assert.strictEqual(cleanError(err, dir, os.tmpdir()).where, 'sub dir/a.js:7');
      const syntax = new Error('Unexpected token');
      syntax.stack = path.join(dir, 'index.js') + ':12\n  let = ;\n      ^\nSyntaxError: Unexpected token';
      assert.strictEqual(cleanError(syntax, dir, os.tmpdir()).where, 'index.js:12');
      assert.strictEqual(cleanText(['C:', 'Users', 'MISTER~1', 'AppData', 'x'].join(String.fromCharCode(92)), dir, os.tmpdir()).indexOf('MISTER'), -1);
      const user = os.userInfo().username;
      if (user && user.length >= 3) assert.strictEqual(cleanText('hello ' + user + ' world', dir, os.tmpdir()).indexOf(user), -1);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  await test('構文エラー: reload の答えに where=index.js:<行>・絶対パス無し・直すと ok で lastError が null', async () => {
    const t = mk();
    try {
      t.put('demo', OK_SRC);
      await t.registry.loadAll();
      assert.strictEqual(rowOf(t, 'demo').status, 'running');
      t.put('demo', 'module.exports = {\n  load() {},\n  start() { let = ; },\n};\n');
      const bad = await t.registry.reload('demo');
      assert.strictEqual(bad.result, 'error');
      assert.ok(bad.error && /^index\.js:3$/.test(bad.error.where), JSON.stringify(bad.error));
      assert.ok(!leaks(bad, t.root));
      assert.ok(rowOf(t, 'demo').lastError);
      assert.ok(!leaks(rowOf(t, 'demo').lastError, t.root));
      t.put('demo', OK_SRC);
      const good = await t.registry.reload('demo');
      assert.strictEqual(good.result, 'ok');
      assert.strictEqual(rowOf(t, 'demo').lastError, null);
    } finally { t.done(); }
  });

  await test('load で throw: where は throw の行・ログの箱に入るがパスは出ない', async () => {
    const t = mk();
    try {
      t.put('boom', 'module.exports = {\n  load() { throw new Error("nope " + __dirname); },\n  start() {}, stop() {}, destroy() {}\n};\n');
      await t.registry.loadAll();
      const row = rowOf(t, 'boom');
      assert.strictEqual(row.status, 'load-failed');
      assert.strictEqual(row.lastError.where, 'index.js:2');
      assert.ok(!leaks(row.lastError, t.root));
      const lines = t.registry.logsOf('boom');
      assert.ok(lines.length >= 1);
      assert.ok(!leaks(lines, t.root));
    } finally { t.done(); }
  });

  await test('logsOf: ctx.logger の行が古い順で出る・200 行を超えると古いのが落ちる・n の範囲', async () => {
    const t = mk();
    try {
      t.put('chatty', 'let c; module.exports = { load(ctx) { c = ctx; ctx.logger("info", "first"); }, start() { for (let i = 0; i < 250; i++) c.logger("info", "line " + i); }, stop() {}, destroy() {} };\n');
      await t.registry.loadAll();
      const all = t.registry.logsOf('chatty', 500);
      assert.strictEqual(all.length, 200);
      assert.strictEqual(all[0].text, 'line 50');
      assert.strictEqual(all[199].text, 'line 249');
      assert.strictEqual(t.registry.logsOf('chatty').length, 50);
      assert.strictEqual(t.registry.logsOf('chatty', 3).length, 3);
      assert.deepStrictEqual(t.registry.logsOf('nobody'), []);
    } finally { t.done(); }
  });

  await test('ctx.logger の 1 行は 500 文字まで・秘密は伏せる', async () => {
    const t = mk();
    try {
      t.put('long', 'module.exports = { load(ctx) { ctx.logger("info", "a".repeat(2000)); ctx.logger("info", "token=SECRETVALUE"); }, start() {}, stop() {}, destroy() {} };\n');
      await t.registry.loadAll();
      const lines = t.registry.logsOf('long');
      assert.ok(lines[0].text.length <= 500);
      assert.ok(!JSON.stringify(lines).includes('SECRETVALUE'));
    } finally { t.done(); }
  });

  await test('同時に 2 回の reload: 片方は busy', async () => {
    const t = mk();
    try {
      t.put('demo', OK_SRC);
      await t.registry.loadAll();
      const [a, b] = await Promise.all([t.registry.reload('demo'), t.registry.reload('demo')]);
      const results = [a.message, b.message].sort();
      assert.ok(results.includes('busy'), JSON.stringify([a, b]));
      assert.strictEqual([a, b].filter((r) => r.result === 'ok').length, 1);
      const after = await t.registry.reload('demo');
      assert.strictEqual(after.result, 'ok');
      const [c, d] = await Promise.all([t.registry.reloadAll(), t.registry.reload('demo')]);
      assert.ok(d.message === 'busy' || (Array.isArray(c) && c[0].message === 'busy'));
    } finally { t.done(); }
  });

  await test('rescanExternal: 既定は busy で throw、{ wait: true } は空くまで待って走る（インストーラ用）', async () => {
    const t = mk();
    try {
      t.put('demo', OK_SRC);
      await t.registry.loadAll();
      const slow = t.registry.reload('demo'); // busy を握る
      await assert.rejects(() => t.registry.rescanExternal('x'), /busy/);
      const w1 = t.registry.rescanExternal('x', { wait: true });
      const w2 = t.registry.rescanExternal('y', { wait: true });
      const order = [];
      w1.then(() => order.push('w1'));
      w2.then(() => order.push('w2'));
      await slow;
      await Promise.all([w1, w2]);
      assert.deepStrictEqual(order, ['w1', 'w2'], '待った順に 1 つずつ');
      // 全部終わったら busy は解ける
      assert.strictEqual((await t.registry.reload('demo')).result, 'ok');
    } finally { t.done(); }
  });

  if (failed) { console.error('\n[v05-registry] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] v05 registry reload tests passed');
})();
