'use strict';

/** grok-control（Grok で操作）。偽物だけ。外へは通信しない。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() { throw new Error('real fetch blocked'); };

const ROOT = path.join(__dirname, '..', '..', '..');
const { createRegistry } = require('../../../host/layer1/plugin-registry');
const { checkPluginCall } = require('../../../host/layer1/plugin-api-check');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'grok-control', 'manifest.json'), 'utf8'));
const plugin = require('..');
const intents = require('../lib/intents');

const WRITE_OR_DANGER = ['hub.fanout', 'broadcast.start', 'broadcast.stop', 'broadcast.stopAll', 'engine.emergencyStop', 'engine.start', 'engine.stop', 'destination.start', 'destination.stop'];
const AI_EXCLUDED = /^(secrets\.|clients\.|approval\.|vault\.)|^(engine\.emergencyStop|engine\.setKey|engine\.link|chat\.publish|hub\.fanoutReserved|sites\.loginFacts|sites\.loginStates)$/;

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function fakeCtx(mode, opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-control-'));
  const calls = [];
  const replies = Object.assign({
    'broadcast.status': { ok: true, running: false, last: null },
    'engine.status': { ok: true, connected: true, streamKey: 'test-key-xxxx' },
    'broadcast.preflight': { ok: true, checks: [] },
    'destination.list': { ok: true, destinations: [
      { id: 'yt-1', site: 'youtube', enabled: true, actual: { engineState: 'live', siteLive: true }, keyTail: 'xxxx' },
      { id: 'nico-1', site: 'niconico', enabled: true, actual: { engineState: '', siteLive: false }, keyTail: 'yyyy' },
      { id: 'tw-1', site: 'twitch', enabled: false, actual: { engineState: '', siteLive: false }, keyTail: null }
    ] }
  }, o.replies || {});
  const ctx = {
    id: 'grok-control',
    manifest: JSON.parse(JSON.stringify(manifest)),
    dataDir: dir,
    mode: () => mode,
    logger() {},
    redact: (s) => String(s).replace(/test-key-[a-z0-9]+/g, '[redacted]'),
    api: {
      call(method, params) {
        calls.push({ method, params });
        if (manifest.api.calls.indexOf(method) === -1) return Promise.resolve({ ok: false, error: 'not-declared' });
        return Promise.resolve(replies[method] || { ok: false, error: 'unknown-method' });
      }
    }
  };
  return { ctx, calls, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

(async () => {
  await test('manifest: v2・公開・試験中・既定は送らない（legacy）・版は 0.1.0・秘密なし', () => {
    assert.strictEqual(manifest.manifestVersion, 2);
    assert.strictEqual(manifest.audience, 'public');
    assert.strictEqual(manifest.stability, 'experimental');
    assert.strictEqual(manifest.defaultMode, 'legacy');
    assert.strictEqual(manifest.version, '0.1.0');
    assert.strictEqual(manifest.secrets, undefined);
    assert.strictEqual(manifest.external, undefined, '外へは通信しない');
  });

  await test('manifest: api.calls は読むだけの名前だけ・プラグインから呼べる名前・AI から外したものは無い', () => {
    assert.ok(Array.isArray(manifest.api.calls) && manifest.api.calls.length > 0);
    manifest.api.calls.forEach((m) => {
      assert.strictEqual(checkPluginCall(m).ok, true, m);
      assert.ok(WRITE_OR_DANGER.indexOf(m) === -1, '書き込みを api.calls に入れない: ' + m);
      assert.ok(!AI_EXCLUDED.test(m), 'AI から外した名前: ' + m);
    });
    assert.ok(manifest.needs.indexOf('api.call') !== -1 && manifest.needs.indexOf('storage') !== -1);
  });

  await test('manifest: actions と index.js の actions が同じ', () => {
    assert.deepStrictEqual(Object.keys(manifest.actions).sort(), Object.keys(plugin.actions).sort());
    assert.strictEqual(manifest.actions.command, 'read');
  });

  await test('レジストリが受け付ける', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-control-reg-'));
    try {
      const registry = createRegistry({ appRoot: ROOT, core: { STATE_DIR: stateDir }, logger() {} });
      const found = registry.discover().filter((r) => r.id === 'grok-control');
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].status, 'accepted', found[0].reason);
    } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
  });

  await test('intents: 日本語と英語の言い方を直す', () => {
    const cases = [
      ['タイトルを「雑談」にしてください', 'setTitle', 'hub.fanout', { title: '雑談' }],
      ['題名を朝活に変えて', 'setTitle', 'hub.fanout', { title: '朝活' }],
      ['set title to Morning chat', 'setTitle', 'hub.fanout', { title: 'Morning chat' }],
      ['カテゴリをゲームにして', 'setCategory', 'hub.fanout', { category: 'ゲーム' }],
      ['ステータス教えて', 'status', 'broadcast.status', {}],
      ['配信前チェックして', 'preflight', 'broadcast.preflight', {}],
      ['配信先を教えて', 'destinations', 'destination.list', {}],
      ['プラグイン bulk-title の状態', 'pluginStatus', 'plugin.status', { id: 'bulk-title' }],
      ['全部止めて', 'stopAll', 'broadcast.stopAll', {}],
      ['緊急停止して', 'emergencyStop', 'engine.emergencyStop', {}]
    ];
    cases.forEach(([text, id, method, params]) => {
      const r = intents.parse(text);
      assert.strictEqual(r.intent, id, text);
      assert.strictEqual(r.method, method, text);
      assert.deepStrictEqual(r.params, params, text);
    });
    const start = intents.parse('YouTubeで配信開始');
    assert.strictEqual(start.intent, 'broadcastStart');
    assert.deepStrictEqual(start.sites, ['youtube']);
    assert.strictEqual(start.params.confirmed, undefined, '本体の確認を飛ばす confirmed は付けない');
    assert.strictEqual(intents.parse('配信止めて').intent, 'broadcastStop');
    assert.strictEqual(intents.parse('こんにちは').error, 'no-intent');
    assert.strictEqual(intents.parse('   ').error, 'empty-text');
  });

  await test('command: live の読む操作は api.calls の名前だけ呼び、秘密らしい欄は落とす', async () => {
    const f = fakeCtx('live');
    try {
      const p = plugin.create();
      p.load(f.ctx);
      const r = await p.command({ text: 'ステータス教えて' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.executed, true);
      assert.deepStrictEqual(f.calls.map((c) => c.method), ['broadcast.status', 'engine.status']);
      assert.strictEqual(r.result['engine.status'].connected, true);
      assert.strictEqual(JSON.stringify(r).indexOf('test-key-xxxx'), -1, '秘密を返さない');
      p.destroy();
    } finally { f.done(); }
  });

  await test('command: 題名（書き込み）は実行せず、CLI と MCP の呼び方を返す', async () => {
    const f = fakeCtx('live');
    try {
      const p = plugin.create();
      p.load(f.ctx);
      const r = await p.command({ text: 'タイトルを雑談にして' });
      assert.strictEqual(r.executed, false);
      assert.strictEqual(r.kind, 'write');
      assert.deepStrictEqual(r.next.cliArgs, ['call', 'hub.fanout', '{"title":"雑談"}']);
      assert.strictEqual(r.next.mcpTool, 'marust_hub_fanout');
      assert.strictEqual(f.calls.length, 0, '書き込みのために本体を呼ばない');
      p.destroy();
    } finally { f.done(); }
  });

  await test('command: 配信開始は confirm が無いと確かめを求め、あっても実行しない（配信先は読むだけで埋める）', async () => {
    const f = fakeCtx('live');
    try {
      const p = plugin.create();
      p.load(f.ctx);
      const a = await p.command({ text: '配信開始' });
      assert.strictEqual(a.needsConfirm, true);
      assert.strictEqual(a.executed, false);
      assert.strictEqual(a.next, undefined);
      assert.deepStrictEqual(a.params.destinationIds, ['yt-1', 'nico-1'], '使う（enabled）配信先');
      const b = await p.command({ text: 'ニコニコで配信を始めて', confirm: true });
      assert.strictEqual(b.executed, false);
      assert.strictEqual(b.next.method, 'broadcast.start');
      assert.deepStrictEqual(b.next.params, { destinationIds: ['nico-1'] });
      const c = await p.command({ text: '配信止めて', confirm: true });
      assert.deepStrictEqual(c.next.params, { destinationIds: ['yt-1'] }, '送信中の配信先');
      const methods = f.calls.map((x) => x.method);
      assert.ok(methods.every((m) => m === 'destination.list'), '読むだけ: ' + methods.join(','));
      p.destroy();
    } finally { f.done(); }
  });

  await test('command: 緊急停止は AI に任せない', async () => {
    const f = fakeCtx('live');
    try {
      const p = plugin.create();
      p.load(f.ctx);
      const r = await p.command({ text: '緊急停止', confirm: true });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'not-for-ai');
      assert.strictEqual(r.next, undefined);
      assert.strictEqual(f.calls.length, 0);
      p.destroy();
    } finally { f.done(); }
  });

  await test('command: shadow と dryRun は何も呼ばず、直した結果だけ返す', async () => {
    const f = fakeCtx('shadow');
    try {
      const p = plugin.create();
      p.load(f.ctx);
      const r = await p.command({ text: 'ステータス教えて' });
      assert.strictEqual(r.executed, false);
      assert.strictEqual(r.dryRun, true);
      assert.strictEqual(r.next.method, 'broadcast.status');
      assert.strictEqual(f.calls.length, 0);
      p.destroy();
    } finally { f.done(); }
  });

  await test('command: 引数の検査', async () => {
    const f = fakeCtx('live');
    try {
      const p = plugin.create();
      p.load(f.ctx);
      assert.strictEqual((await p.command({})).error, 'empty-text');
      assert.strictEqual((await p.command({ text: 'x'.repeat(501) })).error, 'text-too-long');
      assert.strictEqual((await p.command({ text: '今日はいい天気' })).error, 'no-intent');
      p.destroy();
    } finally { f.done(); }
  });

  await test('history: dataDir に残り、伏せ・切り詰め・読み直し・消去ができる', async () => {
    const f = fakeCtx('live');
    try {
      const p = plugin.create();
      p.load(f.ctx);
      await p.command({ text: 'タイトルを test-key-abcd にして' });
      for (let i = 0; i < 60; i += 1) await p.command({ text: '配信先を教えて' });
      const file = path.join(f.dir, 'history.json');
      const saved = fs.readFileSync(file, 'utf8');
      assert.strictEqual(saved.indexOf('test-key-abcd'), -1, '履歴に秘密を残さない');
      assert.strictEqual(JSON.parse(saved).length, 50);
      const q = plugin.create();
      q.load(f.ctx);
      assert.strictEqual(q.actions.history({ n: 5 }).history.length, 5);
      assert.strictEqual(q.getStatus().historyCount, 50);
      assert.deepStrictEqual(q.actions.clearHistory(), { ok: true });
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).length, 0);
      p.destroy(); q.destroy();
    } finally { f.done(); }
  });

  await test('getStatus・intents・ping は読むだけ', () => {
    const p = plugin.create();
    p.load({ mode: () => 'legacy' });
    const s = p.getStatus();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.mode, 'legacy');
    assert.ok(p.actions.intents().intents.some((x) => x.id === 'setTitle'));
    assert.strictEqual(p.actions.ping().pong, true);
    p.destroy();
  });

  await test('パネル: innerHTML を使わず、自分の操作だけ呼ぶ', () => {
    const js = fs.readFileSync(path.join(ROOT, 'plugins', 'grok-control', 'ui', 'panel.js'), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(/.test(js));
    assert.ok(/'plugin\.' \+ ID \+ '\.'/.test(js));
  });

  if (failed) { console.error('\n[grok-control] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] grok-control tests passed');
})();
