'use strict';

const M = require('../../../_marust');

// R24: 機能ごとの解禁とポップアップ（plugins/tips。K3 で host/tips.js から出した）。偽の bus と一時フォルダの tips.json だけ。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTips, TIPS } = require(path.join(__dirname, '..', '..', 'tips', 'lib/tips'));
const { createTipsStore } = require(path.join(__dirname, '..', '..', 'tips', 'lib/store'));
const { createUiSettings } = require(M.at('host/layer1/ui-settings'));

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function make(rows, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r28-tips-'));
  const settings = createTipsStore({ dir: dir });
  settings.load(null);
  const handlers = [];
  const bus = { subscribe(pattern, fn) { handlers.push([pattern, fn]); return () => {}; } };
  let t = 1000000;
  const tips = createTips({ uiSettings: settings, bus, now: () => t, getPlugins: () => rows.current, getLogin: async () => rows.login || {} });
  return {
    dir, settings, tips,
    // 配信を 1 回（開始して 10 分後に終わる）。紹介の判定は非同期なので、終わりを待つ
    async end() { handlers.filter((h) => h[0] === 'stream.started').forEach((h) => h[1]('stream.started', {})); t += 10 * 60 * 1000; await Promise.all(handlers.filter((h) => h[0] === 'stream.stopped').map((h) => h[1]('stream.stopped', {}))); await new Promise((r) => setImmediate(r)); },
    async endFast() { t += 1000; handlers.filter((h) => h[0] === 'stream.stopped').forEach((h) => h[1]('stream.stopped', {})); await new Promise((r) => setImmediate(r)); },
    startOnly() { handlers.filter((h) => h[0] === 'stream.started').forEach((h) => h[1]('stream.started', {})); },
    advance(ms) { t += ms; },
    stopOnly() { handlers.filter((h) => h[0] === 'stream.stopped').forEach((h) => h[1]('stream.stopped', {})); return new Promise((r) => setImmediate(r)); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
    file: path.join(dir, 'tips.json')
  };
}

const site = (s, mode, extra) => Object.assign({ id: 'site-' + s, audience: 'public', status: 'accepted', mode: mode, site: { id: s } }, extra || {});
const sink = (s, mode) => ({ id: 'sink-' + s, audience: 'public', status: 'accepted', mode: mode });
const slot = (s, mode) => ({ id: 'slot-' + s, audience: 'public', status: 'accepted', mode: mode });

(async () => {
  await test('3 回目の終了から、1 回の終了につき 1 つ。ニコ生の自動枠取り → YouTube の自動枠取り → … の順', async () => {
    const rows = { current: [site('niconico', 'live'), slot('niconico', 'legacy'), site('youtube', 'live'), slot('youtube', 'legacy'), site('twitch', 'live'), sink('twitch', 'legacy'), sink('youtube', 'legacy')], login: { twitch: 'logged-in', youtube: 'logged-in' } };
    const m = make(rows);
    try {
      await m.end(); await m.end();
      assert.strictEqual(m.tips.get().completedStreams, 2);
      assert.strictEqual(m.tips.get().tipPending, '', '3 回目より前は出さない');
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, 'slot-niconico');
      await m.end(); // 返事が済んでいないので、新しい紹介は決めない（1 回に 1 つ）
      assert.strictEqual(m.tips.get().tipPending, 'slot-niconico');
      assert.strictEqual(m.tips.get().completedStreams, 4);
      let r = m.tips.respond('slot-niconico', 'setup');
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.features, ['slot-niconico']);
      assert.strictEqual(r.tipPending, '');
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, 'slot-youtube');
      m.tips.respond('slot-youtube', 'later');
      assert.strictEqual(m.tips.get().tipPending, '');
      assert.deepStrictEqual(m.tips.get().tipsDone, ['slot-niconico'], '「あとで」は済みにしない');
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, 'slot-youtube', '「あとで」は次の終了でまた出る');
      m.tips.respond('slot-youtube', 'never');
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, 'bulk-title');
    } finally { m.cleanup(); }
  });

  await test('使っていないサイトの紹介は出さない。コメントの紹介は「送る」がオン・送信の役目がある・ログイン済みのサイトで決まる（送信が live かどうかは見ない）', async () => {
    const rows = { current: [site('niconico', 'legacy'), slot('niconico', 'legacy'), site('youtube', 'live'), slot('youtube', 'live')], login: {} };
    const m = make(rows);
    try {
      await m.end(); await m.end(); await m.end();
      assert.strictEqual(m.tips.get().tipPending, '', 'サイトが 1 つだけ・コメントを書き込めるサイトが無いので、出せる紹介が無い');
      rows.current.push(site('kick', 'live'));
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, 'bulk-title', '2 サイト以上で「題名の一括変更」');
      m.tips.respond('bulk-title', 'never');
      rows.current.push(sink('youtube', 'legacy'));
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, '', 'ログインが無いサイトにはコメントの紹介を出さない');
      rows.login = { youtube: 'logged-in' };
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, 'comment-send', '送信が legacy でも、ログイン済みなら紹介できる（オンにする道は画面にある）');
      m.tips.respond('comment-send', 'never');
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, '', '書き込めるサイトが 1 つだけなら一括送信は出さない');
      rows.current.push(sink('kick', 'legacy'));
      rows.login = { youtube: 'logged-in', kick: 'logged-in' };
      await m.end();
      assert.strictEqual(m.tips.get().tipPending, 'bulk-send');
    } finally { m.cleanup(); }
  });

  await test('作者専用・試験中でない非公開の役目・skip は数えない', async () => {
    const rows = { current: [site('niconico', 'live', { audience: 'author' }), slot('niconico', 'legacy'), site('youtube', 'live', { status: 'skip' }), slot('youtube', 'legacy')] };
    const m = make(rows);
    try {
      await m.end(); await m.end(); await m.end();
      assert.strictEqual(m.tips.get().tipPending, '');
    } finally { m.cleanup(); }
  });

  await test('同じ終わりを二重に数えない（30 秒以内）。開始から 5 分未満の終わりは数えない', async () => {
    const m = make({ current: [] });
    try {
      await m.end();
      await m.endFast();
      assert.strictEqual(m.tips.get().completedStreams, 1);
      // 開始から 1 分で止めた配信（試し配信）は数えない
      m.advance(10 * 60 * 1000);
      m.startOnly(); m.advance(60 * 1000);
      await m.stopOnly();
      assert.strictEqual(m.tips.get().completedStreams, 1, '5 分未満は数えない');
      // 丸ストが開始を見ていない配信（起動前から続いていた）は数える
      m.advance(10 * 60 * 1000);
      await m.stopOnly();
      assert.strictEqual(m.tips.get().completedStreams, 2);
    } finally { m.cleanup(); }
  });

  await test('機能のオン・オフと紹介の「済み」を戻す。数えた回数・済みはファイルに残る', () => {
    const rows = { current: [site('twitch', 'live'), site('kick', 'live')] };
    const m = make(rows);
    try {
      let r = m.tips.setFeature('comment-send', true);
      assert.deepStrictEqual([r.features, r.tipsDone], [['comment-send'], ['comment-send']]);
      r = m.tips.setFeature('comment-send', false);
      assert.deepStrictEqual(r.features, []);
      m.tips.respond('bulk-title', 'never');
      const saved = JSON.parse(fs.readFileSync(m.file, 'utf8'));
      assert.deepStrictEqual(saved.tipsDone, ['comment-send', 'bulk-title']);
      r = m.tips.reset();
      assert.deepStrictEqual([r.tipsDone, r.tipPending], [[], '']);
      assert.strictEqual(m.tips.setFeature('nope', true).error, 'bad-id');
      assert.strictEqual(m.tips.setFeature('bulk-send', 'yes').error, 'bad-value');
      assert.strictEqual(m.tips.respond('bulk-send', 'zzz').error, 'bad-action');
    } finally { m.cleanup(); }
  });

  await test('ui-settings: 新しいキーを検査する（回数は整数・id は決まったものだけ）。ほかのキーを壊さない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r28-ui-'));
    try {
      const s = createUiSettings({ stateDir: dir });
      assert.strictEqual(s.set({ showExperimental: true }).ok, true);
      assert.strictEqual(s.set({ completedStreams: 1.5 }).error, 'bad-value');
      assert.strictEqual(s.set({ completedStreams: -1 }).error, 'bad-value');
      assert.strictEqual(s.set({ tipPending: 'rm -rf' }).error, 'bad-value');
      assert.strictEqual(s.set({ tipsDone: 'a b' }).error, 'bad-value');
      assert.strictEqual(s.set({ completedStreams: 3, tipPending: 'bulk-send', tipsDone: 'slot-youtube', features: '' }).ok, true);
      const v = s.getView();
      assert.deepStrictEqual([v.completedStreams, v.tipPending, v.tipsDone, v.features, v.showExperimental], [3, 'bulk-send', ['slot-youtube'], [], true]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('画面: ホームに紹介とくっついた「中級機能」の一覧・ヘルプのメニュー・コメントの宛先に理由。文字は strings.js から', () => {
    const read = (rel) => fs.readFileSync(M.at(rel), 'utf8');
    const STR = require(M.at('plugins/ui-standard/shell/strings'));
    const home = read('plugins/ui-standard/shell/panels/home.js');
    ['home-tip', 'home-features', "call('tips.get'", "call('tips.respond'", 'feature.tip', 'STR.featuresHomeButton'].forEach((s) => assert.ok(home.includes(s), s));
    assert.ok(!home.includes("'新しい機能の紹介'") && !home.includes("'もう出さない'"), '文字は strings.js へ');
    // 紹介の文・開く画面は機能の manifest が名乗る（feature.tip／tipAliases）。全部の紹介 id に、文を持つ機能が 1 つある
    const X = require(M.at('test/_core-x'));
    const featureSpecs = [];
    const pushFeature = (f) => { if (f && typeof f === 'object') featureSpecs.push(f); };
    Object.values(X.pluginDirs()).forEach((d) => {
      if (!d.manifest || d.base === 'plugins-author') return;
      pushFeature(d.manifest.feature);
      Object.values(d.manifest.roles || {}).forEach((r) => pushFeature(r && r.feature));
    });
    TIPS.forEach((id) => assert.ok(featureSpecs.some((f) => f.tip && (f.tipAliases || []).concat([]).length >= 0 && (f.tipAliases || []).indexOf(id) !== -1) || ['slot-niconico', 'slot-youtube', 'bulk-title', 'comment-send'].indexOf(id) !== -1 && featureSpecs.some((f) => f.tip), id));
    assert.ok(home.includes('homeTipFeature'));
    assert.ok(read('plugins/ui-standard/shell/menubar.js').includes("call('tips.reset'") && read('plugins/ui-standard/shell/menubar.js').includes('STR.tipsResetMenu'));
    // コメントの画面は comment-send のパネル（V7）。書き込めない理由の言葉もそこにある
    const chat = read('plugins/comment-send/ui/panel.js');
    assert.ok(chat.includes('usable[siteName]') && chat.includes('このサイトには、今はコメントを書き込めません。'));
    ['sites.setCommentSend', '先に、ホームでこのサイトの「題名を送る」をオンにしてください。', 'ログインが済んでいないので書き込めません', 'コメントの書き込みがオフです。', "'sites.loginStatus'"].forEach((s) => assert.ok(chat.includes(s), s));
    assert.ok(STR.chatReasonSendOff('Twitch').includes('Twitch') && STR.chatEnableFailed('not-logged-in') !== STR.chatEnableFailed('x'));
    // 紹介は配信中には出さない（liveCount が 1 以上なら隠す）
    assert.ok(/streaming = typeof state.liveCount === 'number' && state.liveCount > 0/.test(home));
  });

  await test('API: tips.* はプラグインが出す（respond・setFeature・reset はウィンドウだけの write。get は read）。本体の api.js には無い', () => {
    assert.ok(TIPS.length === 5);
    const plugin = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ['tips.get', 'tips.respond', 'tips.setFeature', 'tips.reset'].forEach((n) => assert.ok(plugin.includes("register('" + n + "'"), n));
    assert.ok(/register\('tips\.get'[\s\S]*?access: 'read'/.test(plugin));
    ['tips.respond', 'tips.setFeature', 'tips.reset'].forEach((n) => {
      const at = plugin.indexOf("register('" + n + "'");
      const block = plugin.slice(at, plugin.indexOf('});', at));
      assert.ok(/access: 'write',\s*windowOnly: true/.test(block), n);
    });
    const src = require(M.at('test/_api-source')).read();
    assert.ok(!/'tips\.[A-Za-z]+': (\{|function)/.test(src), '本体の api.js に tips.* の行は無い');
  });

  await test('置き場: 初回だけ旧い置き場（ui-settings の写し）から写す。2 回目以降は tips.json が正。元は消さない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r28-store-'));
    try {
      const a = createTipsStore({ dir: dir });
      const v = a.load({ completedStreams: 4, tipsDone: ['bulk-title', 'zzz'], tipPending: 'bulk-send', features: ['slot-youtube'] });
      assert.deepStrictEqual([v.completedStreams, v.tipsDone, v.tipPending, v.features], [4, ['bulk-title'], 'bulk-send', ['slot-youtube']]);
      const b = createTipsStore({ dir: dir });
      const w = b.load({ completedStreams: 99, tipsDone: [], tipPending: '', features: [] });
      assert.strictEqual(w.completedStreams, 4, 'tips.json があれば旧い置き場は見ない');
      assert.strictEqual(b.set({ completedStreams: -1 }).ok, true);
      assert.strictEqual(b.getView().completedStreams, 0, '不正な値は 0');
      const none = createTipsStore({ dir: '' });
      assert.strictEqual(none.set({ completedStreams: 1 }).ok, false, '置き場が無ければ保存できない（偽りの成功にしない）');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  if (failed) { console.error('\n[r28] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] r28 tips tests passed');
})();
