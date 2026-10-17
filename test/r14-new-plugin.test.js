'use strict';

/**
 * R14: プラグインのひな形（`npm run new-plugin -- <id> [--site]`）。
 * 一時的な id で本物のフォルダに作り、作ったテストを実際に流し、最後に必ず消す。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { generate, plan } = require('../cli/new-plugin');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function cleanup(id) {
  fs.rmSync(path.join(ROOT, 'plugins', id), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'plugins', 'sites', id.replace(/^site-/, '')), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'test', id + '.test.js'), { force: true });
}

function runGenerated(id) {
  return spawnSync(process.execPath, [path.join(ROOT, 'test', id + '.test.js')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
}

(async () => {
  await test('id の検査: 小文字・数字・ハイフンだけ。先頭は英字', () => {
    ['', 'A', 'a', '1abc', 'a b', '../x', 'a_b', 'x'.repeat(40)].forEach((id) => {
      assert.strictEqual(generate({ id: id, root: ROOT }).error, 'bad-id', JSON.stringify(id));
    });
  });

  await test('--site は id が site- で始まる。manifest は v2・公開・試験中・既定 legacy・追加サイト・ログイン不要・受信（chat.*）を持たない', () => {
    const files = Object.fromEntries(plan('site-demo-x', true));
    const m = JSON.parse(files['plugins/sites/demo-x/manifest.json']);
    assert.deepStrictEqual([m.manifestVersion, m.audience, m.stability, m.roles.site.defaultMode, m.site.tier, m.site.login.type], [2, 'public', 'experimental', 'legacy', 'extra', 'none']);
    assert.deepStrictEqual(Object.keys(m.roles), ['site'], '最初は site の役目だけ');
    assert.deepStrictEqual(m.roles.site.provides, ['stream.site@1', 'ui.panel@1']);
    assert.strictEqual(m.site.id, 'demo-x');
    assert.ok(!m.roles.site.provides.some((x) => /^chat\./.test(x)));
    assert.ok(/updateMetadata/.test(files['plugins/sites/demo-x/site.js']));
    const plain = Object.fromEntries(plan('demo-y', false));
    assert.strictEqual(JSON.parse(plain['plugins/demo-y/manifest.json']).site, undefined);
    assert.ok(!/updateMetadata/.test(plain['plugins/demo-y/index.js']));
    assert.strictEqual(Object.keys(plain).length, 6);
  });

  await test('ひな形が AGENTS.md を作り、中に「秘密」と ctx.secrets の語がある', () => {
    const plain = Object.fromEntries(plan('demo-y', false));
    assert.ok(plain['plugins/demo-y/AGENTS.md'], 'plugins/demo-y/AGENTS.md が生成一覧にある');
    assert.ok(plain['plugins/demo-y/AGENTS.md'].includes('秘密'), 'AGENTS.md に「秘密」の語がある');
    assert.ok(plain['plugins/demo-y/AGENTS.md'].includes('ctx.secrets'), 'AGENTS.md に「ctx.secrets」の語がある');

    const site = Object.fromEntries(plan('site-demo-x', true));
    assert.ok(site['plugins/sites/demo-x/AGENTS.md'], 'plugins/sites/demo-x/AGENTS.md が生成一覧にある');
    assert.ok(site['plugins/sites/demo-x/AGENTS.md'].includes('秘密'), 'AGENTS.md に「秘密」の語がある');
    assert.ok(site['plugins/sites/demo-x/AGENTS.md'].includes('ctx.secrets'), 'AGENTS.md に「ctx.secrets」の語がある');
  });

  await test('作る → 作ったテストが通る → 同じ名前は上書きせず止まる（普通のプラグイン）', () => {
    const id = 'zz-r14-plain';
    cleanup(id);
    try {
      const made = generate({ id: id, root: ROOT });
      assert.strictEqual(made.ok, true, JSON.stringify(made));
      assert.strictEqual(made.files.length, 6);
      const run = runGenerated(id);
      assert.strictEqual(run.status, 0, run.stdout + run.stderr);
      const before = fs.readFileSync(path.join(ROOT, 'plugins', id, 'manifest.json'), 'utf8');
      fs.writeFileSync(path.join(ROOT, 'plugins', id, 'manifest.json'), before + '\n');
      const again = generate({ id: id, root: ROOT });
      assert.deepStrictEqual([again.ok, again.error], [false, 'exists']);
      assert.strictEqual(fs.readFileSync(path.join(ROOT, 'plugins', id, 'manifest.json'), 'utf8'), before + '\n', '上書きしない');
    } finally { cleanup(id); }
  });

  await test('作る → 作ったテストが通る（--site。id に site- が付く）。テストだけが残っていても止まる', () => {
    const id = 'site-zz-r14-site';
    cleanup(id);
    try {
      const made = generate({ id: 'zz-r14-site', site: true, root: ROOT });
      assert.strictEqual(made.ok, true, JSON.stringify(made));
      assert.strictEqual(made.id, id);
      const run = runGenerated(id);
      assert.strictEqual(run.status, 0, run.stdout + run.stderr);
      fs.rmSync(path.join(ROOT, 'plugins', 'sites', 'zz-r14-site'), { recursive: true, force: true });
      assert.strictEqual(generate({ id: 'zz-r14-site', site: true, root: ROOT }).error, 'exists', 'テストが残っていれば作らない');
    } finally { cleanup(id); }
  });

  await test('生成物が残っていない・package.json に登録済み・説明が PLUGIN-API にある', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'plugins', 'zz-r14-plain')) && !fs.existsSync(path.join(ROOT, 'plugins', 'sites', 'zz-r14-site')));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts['new-plugin'], 'node cli/new-plugin.js');
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'PLUGIN-API.md'), 'utf8');
    assert.ok(doc.includes('最小のプラグイン') && doc.includes('サイトを足すプラグイン') && doc.includes('npm run new-plugin'));
  });

  if (failed) { console.error('\n[r14] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] r14 new-plugin tests passed');
})();
