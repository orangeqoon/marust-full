#!/usr/bin/env node
'use strict';

/**
 * プラグインのひな形を作る（R14）。
 *   npm run new-plugin -- <id> [--site]
 * 普通のプラグイン: `plugins/<id>/`（manifest・index.js・ui/panel.html・ui/panel.js）と `test/<id>.test.js`。
 * --site（サイトを足すプラグイン）: `plugins/sites/<site>/`（manifest.json に roles.site・site.js・ui/panel.html・ui/panel.js）と `test/site-<site>.test.js`。
 *   中の役目の id は `site-<site>`（R16）。あとから sink.js・slot.js を足すときは manifest の roles に書く（docs/PLUGIN-API.md）。
 * - manifest は v2・`audience: public`・`stability: experimental`・既定 legacy（送らない）。
 * - `--site` は「サイトを足すプラグイン」。題名とカテゴリの**送信だけ**（コメントの受信は作らない。受信はわんコメ）。id は `site-` が付いても付かなくてもよい。
 * - 同じ名前のフォルダやテストがあれば、何も上書きせず止まる。ジャンクション・リンクは作らない。
 * - テストは `test/` に置くだけで `npm test` が自動で流す（R13）。作ったらすぐ通ること。
 */

const fs = require('fs');
const path = require('path');
const { manifestFor, indexFor, panelHtml, panelJs, templateFiles, title, siteOf } = require('../host/layer1/plugin-scaffold');

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

function testFor(id, site) {
  return `'use strict';

/** ${id}（ひな形から生成）。偽物だけ。外へは通信しない。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const ROOT = path.join(__dirname, '..');
const { createRegistry } = require('../host/layer1/plugin-registry');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', ${site ? "'sites', '" + siteOf(id) + "'" : "'" + id + "'"}, 'manifest.json'), 'utf8'));
const plugin = require('../plugins/${site ? 'sites/' + siteOf(id) + '/site' : id}');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

(async () => {
  await test('manifest: v2・公開・試験中・既定は送らない（legacy）', () => {
    assert.strictEqual(manifest.manifestVersion, 2);
    assert.strictEqual(manifest.audience, 'public');
    assert.strictEqual(manifest.stability, 'experimental');
    assert.strictEqual(${site ? 'manifest.roles.site.defaultMode' : 'manifest.defaultMode'}, 'legacy');
    assert.strictEqual(manifest.secrets, undefined, '秘密を使うときは、名前を manifest に書いてからテストを直す');
  });

  await test('レジストリが受け付ける', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), '${id}-reg-'));
    try {
      const registry = createRegistry({ appRoot: ROOT, core: { STATE_DIR: stateDir }, logger() {} });
      const found = registry.discover().filter((r) => r.id === '${id}');
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].status, 'accepted', found[0].reason);
    } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
  });

  await test('getStatus は読むだけで、モードを返す', () => {
    const p = plugin.create();
    p.load({ mode: () => 'legacy' });
    const s = p.getStatus();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.mode, 'legacy');
    p.destroy();
  });
${site ? `
  await test('updateMetadata: legacy は何もしない・shadow は外へ出さない（dryRun）・live は未実装のうちは失敗を返す', async () => {
    const p = plugin.create();
    p.load({ mode: () => 'legacy' });
    assert.deepStrictEqual(await p.updateMetadata({ title: 't' }, {}), { ok: true });
    assert.deepStrictEqual(await p.updateMetadata({ title: 't' }, { mode: 'shadow' }), { ok: true, dryRun: true });
    assert.strictEqual((await p.updateMetadata({ title: 't' }, { mode: 'live' })).error, 'not-implemented');
    p.destroy();
  });

  await test('サイトの説明（site）: id・名前・URL は https か空。コメント受信は作らない', () => {
    assert.ok(manifest.site && manifest.site.id && manifest.site.name);
    assert.strictEqual(manifest.site.tier, 'extra', '追加サイトは試験中から');
    const urls = [manifest.site.keyHelpUrl, manifest.site.tosUrl].concat((manifest.site.ingest || []).map((x) => x && x.url));
    assert.ok(urls.every((u) => u === null || u === undefined || /^https:\\/\\//.test(u)), 'URL は https か null');
    assert.ok(!${site ? 'manifest.roles.site.provides' : 'manifest.provides'}.some((x) => /^chat\\./.test(x)), 'コメントの受信（chat.source）は作らない。受信はわんコメ');
  });
` : ''}
  if (failed) { console.error('\\n[${id}] ' + failed + ' failed'); process.exit(1); }
  console.log('\\n[marust] ${id} tests passed');
})();
`;
}

function agentsMdFor(id, site) {
  void site;
  return `# ${title(id)} — AI が最初に読む 1 枚

このプラグインは丸スト（marust）の中で動きます。約束の詳しい内容は丸スト本体の \`docs/PLUGIN-API.md\` を見てください。

## 秘密（ストリームキー・Cookie・API キー・トークン・パスワード）について
- \`ctx.secrets.get(名前)\` で受け取る値は秘密です。サイトへ送るヘッダーなどにはそのまま使えます。
- 値をログ・画面・戻り値・合図・エラーの文・チャットの返事に出さないでください。コードや試験に本物の値を書かないでください（試験は \`test-key-xxxx\` のような偽の値）。
- 理由: 丸ストは出口で伏せますが、伏せられるのは金庫に入った値だけです。写した文字列や一部を切り出した物は伏せられません。
- 使う人に「キーを貼って」と頼まないでください（丸ストの画面の欄に入れてもらいます）。
- 秘密の名前は manifest の \`secrets\` に書いてください。書かないと \`set\` できません。
`;
}

/** 作るファイルの一覧（パスは appRoot からの相対）。副作用なし。 */
function plan(id, site) {
  if (site) {
    const s = siteOf(id);
    const dir = 'plugins/sites/' + s + '/';
    return [
      [dir + 'manifest.json', manifestFor(id, true)],
      [dir + 'site.js', indexFor('site-' + s, true)],
      [dir + 'ui/panel.html', panelHtml('site-' + s)],
      [dir + 'ui/panel.js', panelJs('site-' + s)],
      [dir + 'AGENTS.md', agentsMdFor('site-' + s, true)],
      ['test/site-' + s + '.test.js', testFor('site-' + s, true)]
    ];
  }
  return [
    ['plugins/' + id + '/manifest.json', manifestFor(id, false)],
    ['plugins/' + id + '/index.js', indexFor(id, false)],
    ['plugins/' + id + '/ui/panel.html', panelHtml(id)],
    ['plugins/' + id + '/ui/panel.js', panelJs(id)],
    ['plugins/' + id + '/AGENTS.md', agentsMdFor(id, false)],
    ['test/' + id + '.test.js', testFor(id, false)]
  ];
}

/** 戻り: { ok, error?, id?, files? }。1 つでも既にあれば、何も書かずに { ok:false, error:'exists' }。 */
function generate(opts) {
  const o = opts || {};
  let id = String(o.id || '');
  const site = o.site === true;
  if (site && id && !/^site-/.test(id)) id = 'site-' + id;
  if (!ID_RE.test(id)) return { ok: false, error: 'bad-id' };
  const root = o.root;
  const files = plan(id, site);
  for (const [rel] of files) {
    if (fs.existsSync(path.join(root, rel))) return { ok: false, error: 'exists', path: rel };
  }
  const folder = site ? path.join('plugins', 'sites', siteOf(id)) : path.join('plugins', id);
  if (fs.existsSync(path.join(root, folder))) return { ok: false, error: 'exists', path: folder.split(path.sep).join('/') };
  // 同じ id の役目が、旧い置き場（plugins/<id>/）や別のサイトのフォルダにすでにあるときも作らない
  if (site && fs.existsSync(path.join(root, 'plugins', 'site-' + siteOf(id)))) return { ok: false, error: 'exists', path: 'plugins/site-' + siteOf(id) };
  for (const [rel, text] of files) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
  }
  return { ok: true, id: id, files: files.map((f) => f[0]) };
}

function main(argv) {
  const args = argv.slice(2);
  const site = args.includes('--site');
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('使い方: npm run new-plugin -- <id> [--site]   （id は小文字・数字・ハイフン。--site は題名を送るサイトのプラグイン）');
    return 2;
  }
  const res = generate({ id: id, site: site, root: path.join(__dirname, '..') });
  if (!res.ok) {
    console.error(res.error === 'exists' ? '既にあるので作りませんでした: ' + res.path : 'id が使えません（小文字・数字・ハイフンで 2〜31 文字、先頭は英字）');
    return 1;
  }
  console.log('作りました: ' + res.files.join(', '));
  console.log('次: npm test で、作ったテストが通るか確かめてください。docs/PLUGIN-API.md に作り方があります。');
  return 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { generate, plan, ID_RE, manifestFor, indexFor, panelHtml, panelJs, templateFiles };
