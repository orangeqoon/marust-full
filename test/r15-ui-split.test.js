'use strict';
require('./_ui-inline');

/**
 * R15: 画面のファイル分け。ui/core/*.js（共通の部品）と plugins/ui-standard/shell/panels/<id>.js（1 パネル 1 ファイル）。
 * 動きは変えない。ここでは「どのパネルも、ちょうど 1 つのファイルが登録している」「hub.html が全部読む」ことと、
 * M4 Should 7（案内のあと、前に開いていたパネルを戻す）・Should 8（ホームの集計を関数として試す）を確かめる。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { listJs, UI } = require('./_ui-source');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
const read = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8');

function panelIds() {
  const src = read('core/state.js');
  const block = /var PANELS = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, 'PANELS が core/state.js にある');
  return Array.from(block[1].matchAll(/^\s*\['([a-z0-9-]+)'/gm)).map((m) => m[1]);
}

test('PANELS の id は、ちょうど 1 つの plugins/ui-standard/shell/panels/*.js が registerPanel している（ファイル名 = id）', () => {
  const ids = panelIds();
  assert.ok(ids.length >= 13, ids.join()); // K3: モード・プラグイン一覧・経過時間・AI をつなぐ・診断もプラグインへ。 題名・コメント・オーバーレイ・回線の余裕・ホットキーはプラグインのパネルへ移した（V7）
  const files = listJs(path.join(UI, 'panels'));
  const owners = {};
  files.forEach((f) => {
    const src = fs.readFileSync(f, 'utf8');
    Array.from(src.matchAll(/registerPanel\('([a-z0-9-]+)'/g)).forEach((m) => {
      (owners[m[1]] = owners[m[1]] || []).push(path.basename(f, '.js'));
    });
  });
  ids.forEach((id) => assert.deepStrictEqual(owners[id], [id], 'パネル ' + id + ' を登録するファイルは panels/' + id + '.js だけ'));
  Object.keys(owners).forEach((id) => assert.ok(ids.includes(id), 'PANELS に無い id を登録している: ' + id));
  assert.strictEqual(files.length, ids.length, 'panels/ にパネルでないファイルが混じっている');
});

test('メニュー（plugins/ui-standard/shell/menubar.js の categoryRows）に出る固定の id は、すべて PANELS にある', () => {
  const ids = panelIds();
  const bar = read('menubar.js');
  const rows = Array.from(bar.matchAll(/ids: \[([^\]]*)\]/g)).flatMap((m) => Array.from(m[1].matchAll(/'([a-z0-9:-]+)'/g)).map((x) => x[1]));
  assert.ok(rows.length >= 2); // 本体の行は home・obs だけ。題名・コメントなどはパネルの menu の名乗りで出る（計画 X・P1）
  // plugin:<id>:<panel> はプラグインのパネル（題名・コメント。V7）。本体の PANELS には無い
  rows.filter((id) => id.indexOf('plugin:') !== 0).forEach((id) => assert.ok(ids.includes(id), 'メニューの id が PANELS に無い: ' + id));
});

test('hub.html: core → 各パネル → hub.js の順で全部読む。panels/ のファイルは 1 つも読み漏らさない', () => {
  const html = require('./_ui-source').shellDocument();
  const at = (s) => html.indexOf('<script src="' + s + '"></script>');
  ['/plugins/ui-standard/shell/strings.js', '/plugins/ui-standard/shell/core/state.js', '/plugins/ui-standard/shell/core/util.js', '/plugins/ui-standard/shell/core/panels.js', '/plugins/ui-standard/shell/core/dock.js'].reduce((prev, s) => {
    assert.ok(at(s) > prev, s + ' の位置');
    return at(s);
  }, -1);
  const hubAt = at('/plugins/ui-standard/shell/hub.js');
  assert.ok(hubAt > 0);
  listJs(path.join(UI, 'panels')).forEach((f) => {
    const s = '/plugins/ui-standard/shell/panels/' + path.basename(f);
    assert.ok(at(s) > at('/plugins/ui-standard/shell/core/panels.js') && at(s) < hubAt, s + ' は core の後・hub.js の前');
  });
});

test('hub.js は小さい（起動 boot と OBS 状態の 2 つだけ）。パネルの init は initRegisteredPanels が呼ぶ', () => {
  const hub = read('hub.js');
  assert.ok(hub.split('\n').length < 170, 'hub.js が太っている'); // K3: 上のバーのモード表示が加わった
  assert.ok(hub.includes('initRegisteredPanels();'));
  assert.ok(!/\binit(Modes|Chat|Sites|Uplink|Secrets|Metadata)\(\)/.test(hub), 'パネルの init を hub.js から直に呼ばない');
});

test('各パネルのファイルは、先頭に use strict と 1 行の説明を持つ', () => {
  listJs(path.join(UI, 'panels')).concat(listJs(path.join(UI, 'core'))).forEach((f) => {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    assert.strictEqual(lines[0], "'use strict';", path.basename(f));
  });
});

// ---- M4 Should 7: 案内（setup.js）が既存パネルを移して使い、閉じたら元に戻す ----
function setupContext(openIds) {
  const bin = { children: [], appendChild(el) { el.parent = bin; this.children.push(el); } };
  const into = { children: [], appendChild(el) { el.parent = into; this.children.push(el); } };
  const sections = {};
  const closed = [];
  const opened = [];
  const ctx = {
    document: { getElementById: (id) => (id === 'panel-bin' ? bin : null) },
    panelRoot: (id) => { sections[id] = sections[id] || { id, parent: bin }; return sections[id]; },
    dockApi: { getPanel: (id) => (openIds.includes(id) ? { id } : null) },
    closePanel: (id) => { closed.push(id); },
    openPanel: (id) => { opened.push(id); },
    call: () => Promise.resolve({}),
    STR: {},
    window: {}
  };
  vm.createContext(ctx);
  // setup.js の末尾は module.exports。ここでは関数だけ使う。
  vm.runInContext(read('setup.js').replace(/\nif \(typeof module[^\n]*\n?/, '\n') + '\nthis.__api = { setupEmbed: setupEmbed, setupClose: setupClose, setupState: setupState };', ctx);
  return { api: ctx.__api, bin, into, closed, opened };
}

test('案内: ドックで開いていたパネルは閉じて案内へ移し、閉じたら bin へ戻して、元どおり開く', () => {
  const t = setupContext(['obs-connect']);
  assert.strictEqual(t.api.setupEmbed('obs-connect', t.into), true);
  assert.strictEqual(t.api.setupEmbed('site-add', t.into), true);
  assert.deepStrictEqual(t.closed, ['obs-connect'], '開いていたものだけ閉じる');
  assert.strictEqual(t.into.children.length, 2);
  t.api.setupClose();
  assert.strictEqual(t.bin.children.length, 2, '部品は bin へ戻る（作り直さない＝イベントの二重登録なし）');
  assert.deepStrictEqual(t.opened, ['obs-connect'], '前に開いていたものだけ戻す');
  t.api.setupClose();
  assert.deepStrictEqual(t.opened, ['obs-connect'], '2 回閉じても二重に開かない');
});

test('案内: パネルが無いときは何もしない', () => {
  const t = setupContext([]);
  t.api.setupEmbed('obs-connect', t.into);
  assert.deepStrictEqual(t.closed, []);
  t.api.setupClose();
  assert.deepStrictEqual(t.opened, []);
});

// ---- M4 Should 8: ホームの集計（生きている・つなぎ中・止まっている） ----
test('homeSiteRows の destState: live > connecting > stopped > none。有効かどうかは全部の配信先が有効なときだけ', () => {
  const home = require('../plugins/ui-standard/shell/panels/home');
  const rows = [{ id: 'site-twitch', audience: 'public', site: { name: 'Twitch', tier: 'core' }, send: true }];
  const state = (targets) => home.homeSiteRows(rows, targets)[0];
  assert.strictEqual(state([]).destState, 'none');
  assert.strictEqual(state([{ site: 'twitch', state: 'stopped', enabled: true }]).destState, 'stopped');
  assert.strictEqual(state([{ site: 'twitch', state: 'reconnecting', enabled: true }]).destState, 'connecting');
  assert.strictEqual(state([{ site: 'twitch', state: 'starting' }, { site: 'twitch', state: 'live' }]).destState, 'live');
  assert.strictEqual(state([{ site: 'twitch', state: 'stopped', enabled: true }, { site: 'twitch', state: 'stopped', enabled: false }]).destEnabled, false);
  assert.strictEqual(state([{ site: 'twitch', state: 'stopped', enabled: true }]).destEnabled, true);
});

if (failed) { console.error('\n[r15] ' + failed + ' failed'); process.exit(1); }
console.log('\n[marust] r15 ui split tests passed');
