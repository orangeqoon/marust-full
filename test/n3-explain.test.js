'use strict';
require('./_ui-inline');

/**
 * N3: 画面ごとの説明の点検（PLAN-v2-roadmap §2）。
 * - ホームの各パネルに 1 行の説明（timer-hint）があること
 * - 「？」の案内ページ（はじめかた・配信キーの場所）があり、メニューと「サイトを足す」からつながること
 * - 初級で見える文に、言いかえる前の専門語（ストリームキー単独・OAuth）を出さないこと
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STR = new Function(read('plugins/ui-standard/shell/strings.js') + '; return STR;')();

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

test('hub.html の各パネルに 1 行の説明がある', () => {
  const parts = require('./_ui-source').shellDocument().split(/<section class="card"/).slice(1);
  assert.ok(parts.length >= 11); // K3 でモード・プラグイン一覧・経過時間・AI をつなぐ・診断のパネルはプラグインへ移った
  const missing = [];
  parts.forEach((p) => {
    const body = p.split('</section>')[0];
    const id = (body.match(/data-panel="([^"]+)"/) || [])[1];
    if (!/hint/.test(body)) missing.push(id);
  });
  assert.deepStrictEqual(missing, []);
});

test('案内ページがあり、5 つの初級サイトの見出し（anchor）がある', () => {
  assert.ok(fs.existsSync(path.join(ROOT, STR.startGuidePath.replace(/^\//, ''))));
  const keyPage = read(STR.streamKeyGuidePath.replace(/^\//, ''));
  ['youtube', 'niconico', 'twitch', 'twitcasting', 'kick', 'others'].forEach((id) => assert.ok(keyPage.includes('id="' + id + '"'), id));
  assert.ok(/配信キー/.test(keyPage));
});

test('「サイトを足す」とヘルプメニューから案内ページへつながる', () => {
  assert.ok(/addSiteKeyGuide/.test(read('plugins/ui-standard/shell/panels/site-add.js')));
  const menu = read('plugins/ui-standard/shell/menubar.js');
  assert.ok(/STR\.helpStartGuide/.test(menu) && /STR\.helpKeyGuide/.test(menu));
});

test('サイトの id と、案内ページの anchor が合う（初級の 5 サイト）', () => {
  ['youtube', 'niconico', 'twitch', 'twitcasting', 'kick'].forEach((id) => {
    assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'sites', id, 'manifest.json')), id);
  });
});

test('初級で見える文は、配信キー・配信の送り先に言いかえてある', () => {
  [STR.addSiteGuide, STR.addSiteCustomNote, STR.loginIntro, STR.addSiteNeedKey].forEach((text) => {
    assert.ok(!/ストリームキー/.test(text), text.slice(0, 30));
    assert.ok(/配信キー/.test(text), text.slice(0, 30));
  });
  assert.ok(/OAuth/.test(STR.loginIntro) === false);
  assert.ok(/金庫/.test(STR.vaultLostWarn) && /保管場所/.test(STR.vaultLostWarn));
});

test('案内ページは style-src self の窓口で出る: <style> を使わず guide.css を読む', () => {
  const dir = path.join(ROOT, 'plugins', 'ui-standard', 'shell', 'guide');
  assert.ok(fs.existsSync(path.join(dir, 'guide.css')));
  fs.readdirSync(dir).filter((f) => /\.html$/.test(f)).forEach((f) => {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html), f + ' に inline の style');
    assert.ok(html.includes('href="guide.css"'), f);
  });
});

test('配信キーの案内: ニコ生は「番組ごとに変わる」「キーの入れ替えを丸ストが行う」と言い切らない', () => {
  const page = read('plugins/ui-standard/shell/guide/stream-key.html');
  assert.ok(!/番組ごとに変わ/.test(page) && !/キーの入れ替えを丸ストが/.test(page));
});

if (failed) { console.error('\n[n3] ' + failed + ' failed'); process.exit(1); }
console.log('\n[marust] n3 explain tests passed');
