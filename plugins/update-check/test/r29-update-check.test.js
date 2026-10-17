'use strict';

// 「更新を確かめる」（host/update-check.js）。偽の fetch だけ。本物の GitHub にはつながない。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createUpdateCheck, isNewer, parseVersion } = require('../lib/check');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8'); }
function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status: status, text: async () => text };
}

(async () => {
  await test('版の比較: 数字で比べる。v 付き・予備の印つきも読む。読めなければ新しくない', () => {
    assert.deepStrictEqual(parseVersion('v1.2.3'), [1, 2, 3]);
    assert.strictEqual(parseVersion('1.2'), null);
    assert.strictEqual(isNewer('0.10.0', '0.9.9'), true);
    assert.strictEqual(isNewer('v0.2.0', '0.2.0'), false);
    assert.strictEqual(isNewer('0.1.9', '0.2.0'), false);
    assert.strictEqual(isNewer('abc', '0.2.0'), false);
    assert.strictEqual(isNewer('1.0.0-rc1', '0.9.0'), true);
  });

  await test('リポジトリ名が空・形が違うなら not-configured で、fetch を呼ばない', async () => {
    let called = 0;
    const f = async () => { called += 1; return reply(200, {}); };
    for (const repo of ['', undefined, 'no-slash', 'a/b/c', '../x/y', 'a/b?x=1']) {
      const r = await createUpdateCheck({ repo, version: '0.2.0', fetch: f }).check();
      assert.deepStrictEqual([r.ok, r.error], [false, 'not-configured'], String(repo));
    }
    assert.strictEqual(called, 0);
  });

  await test('新しい版: 版・URL・newer だけを返す。送るのは User-Agent と Accept だけ・読む先は固定', async () => {
    const seen = [];
    const f = async (url, init) => { seen.push([url, init]); return reply(200, { tag_name: 'v0.3.0', html_url: 'https://github.com/own/marust/releases/tag/v0.3.0', body: 'x'.repeat(100), assets: [{ secret: 1 }] }); };
    const r = await createUpdateCheck({ repo: 'own/marust', version: '0.2.0', fetch: f }).check();
    assert.deepStrictEqual(r, { ok: true, current: '0.2.0', latest: '0.3.0', newer: true, url: 'https://github.com/own/marust/releases/tag/v0.3.0' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0][0], 'https://api.github.com/repos/own/marust/releases/latest');
    assert.deepStrictEqual(Object.keys(seen[0][1].headers).sort(), ['Accept', 'User-Agent']);
    assert.strictEqual(seen[0][1].redirect, 'error');
  });

  await test('同じ版・古い版は newer:false。別のサイトの URL は空にする', async () => {
    const same = await createUpdateCheck({ repo: 'own/marust', version: '0.3.0', fetch: async () => reply(200, { tag_name: 'v0.3.0', html_url: 'https://github.com/own/marust/releases/tag/v0.3.0' }) }).check();
    assert.strictEqual(same.newer, false);
    const evil = await createUpdateCheck({ repo: 'own/marust', version: '0.1.0', fetch: async () => reply(200, { tag_name: 'v0.3.0', html_url: 'https://evil.example/x' }) }).check();
    assert.strictEqual(evil.newer, true);
    assert.strictEqual(evil.url, '');
  });

  await test('公開された版が無い（404）: none。失敗は符号だけ（network / timeout / bad-response）', async () => {
    const none = await createUpdateCheck({ repo: 'own/marust', version: '0.2.0', fetch: async () => reply(404, {}) }).check();
    assert.deepStrictEqual([none.ok, none.none, none.newer], [true, true, false]);
    const down = await createUpdateCheck({ repo: 'own/marust', version: '0.2.0', fetch: async () => { throw new Error('SECRET-URL'); } }).check();
    assert.deepStrictEqual([down.ok, down.error], [false, 'network']);
    assert.ok(!JSON.stringify(down).includes('SECRET'));
    const bad = await createUpdateCheck({ repo: 'own/marust', version: '0.2.0', fetch: async () => reply(200, 'not json') }).check();
    assert.strictEqual(bad.error, 'bad-response');
    const badTag = await createUpdateCheck({ repo: 'own/marust', version: '0.2.0', fetch: async () => reply(200, { tag_name: 'latest' }) }).check();
    assert.strictEqual(badTag.error, 'bad-response');
    const huge = await createUpdateCheck({ repo: 'own/marust', version: '0.2.0', fetch: async () => reply(200, 'x'.repeat(300 * 1024)) }).check();
    assert.strictEqual(huge.error, 'bad-response');
    const slow = await createUpdateCheck({ repo: 'own/marust', version: '0.2.0', timeoutMs: 20, fetch: (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); }) }).check();
    assert.strictEqual(slow.error, 'timeout');
  });

  await test('つなぎ: API は update.check（読み取り・ウィンドウだけ）。ヘルプのメニューから押したときだけ呼ぶ。自動の呼び出しは無い', () => {
    const plugin = read('plugins/update-check/index.js');
    assert.ok(/register\('update\.check'[\s\S]*access: 'read',\s*windowOnly: true,/.test(plugin));
    assert.ok(!require('../../../test/_api-source').read().includes('update.check'), '本体の api.js に update.check は無い（K3 でプラグインへ）');
    const menu = read('plugins/ui-standard/shell/menubar.js');
    assert.ok(menu.includes("call('update.check'") && menu.includes('STR.updateMenu'));
    const calls = (menu.match(/update\.check/g) || []).length;
    assert.strictEqual(calls, 1, 'update.check を呼ぶのはメニューの 1 か所だけ');
    ['plugins/ui-standard/shell/hub.js', 'plugins/ui-standard/shell/panels/home.js', 'plugins/ui-standard/shell/setup.js'].forEach((f) => assert.ok(!read(f).includes('update.check'), f));
    const pkg = JSON.parse(read('package.json'));
    assert.strictEqual(typeof pkg.marustReleasesRepo, 'string');
  });

  if (failed) { console.error('[r29] ' + failed + ' failed'); process.exit(1); }
  console.log('[marust] r29 update-check tests passed');
})();
