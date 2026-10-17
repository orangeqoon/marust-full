'use strict';
require('./_ui-inline');

/**
 * V5: 段階（tier。v3 §5）。manifest の tier・今の段階より上のプラグインは require も load も start もしない・
 * 段階を変えたときの反映（applyTier）・配信中は変えられない・印のプラグインは段階で切ってあるのと同じ。
 * 一時フォルダの偽のプラグイン・偽の状態だけ。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApi } = require('../host/layer1/api');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { resolveUiLevel } = require('../host/layer1/ui-settings');
const { WINDOW_ID } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

// require された順・止められた順を、プラグインのコードが global に残す
const SRC = (id) => `(global.__v5 = global.__v5 || []).push('require:${id}');
module.exports = {
  load() { global.__v5.push('load:${id}'); },
  start() { global.__v5.push('start:${id}'); },
  stop() { global.__v5.push('stop:${id}'); },
  destroy() { global.__v5.push('destroy:${id}'); }
};\n`;

function setup(opts) {
  const o = opts || {};
  global.__v5 = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-tier-'));
  const builtin = path.join(root, 'builtin');
  const external = path.join(root, 'state', 'plugins');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  const put = (where, id, extra) => {
    const dir = path.join(where, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: ['ui.panel@1'] }, extra || {})));
    fs.writeFileSync(path.join(dir, 'index.js'), SRC(id));
  };
  put(builtin, 'p-basic', { tier: 'basic' });
  put(builtin, 'p-standard', { tier: 'standard' });
  put(builtin, 'p-advanced', { tier: 'advanced' });
  put(builtin, 'p-feature-std', { feature: { label: 'x', level: 'standard', activation: 'live' } });
  put(builtin, 'p-none');
  put(builtin, 'p-bad-tier', { tier: 'expert' });
  const level = { value: o.level || 'basic', throws: false };
  const dev = { value: false };
  const registry = createRegistry({
    core: { STATE_DIR: path.join(root, 'state') },
    appRoot: root,
    builtinRoot: builtin,
    authorRoot: o.authorRoot || path.join(root, 'no-author'),
    externalRoot: external,
    logger() {},
    tierFor: o.noTierFor ? undefined : () => { if (level.throws) throw new Error('boom'); return level.value; },
    devModeFor: o.devMode ? () => dev.value : undefined,
    modeFor: () => 'live'
  });
  return { root, builtin, external, registry, level, dev, put, done() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const ran = () => global.__v5.slice();
const rowOf = (t, id) => t.registry.snapshot().find((r) => r.id === id);
const runningIds = (t) => t.registry.getRunning().map((r) => r.id).sort();

(async () => {
  await test('初級: tier basic だけ動く。上のものは require も load も start もしない（accepted / tier-not-loaded）', async () => {
    const t = setup({ level: 'basic' });
    try {
      t.registry.discover();
      await t.registry.loadAll();
      assert.deepStrictEqual(runningIds(t), ['p-basic']);
      assert.deepStrictEqual(ran(), ['require:p-basic', 'load:p-basic', 'start:p-basic']);
      for (const id of ['p-standard', 'p-advanced', 'p-feature-std', 'p-none', 'p-bad-tier']) {
        assert.strictEqual(rowOf(t, id).status, 'accepted', id);
        assert.strictEqual(rowOf(t, id).reason, 'tier-not-loaded', id);
        assert.ok(t.registry.tierBlocked(id), id);
      }
      assert.ok(!t.registry.tierBlocked('p-basic'));
    } finally { t.done(); }
  });

  await test('中級: basic と standard（feature.level が standard のものも）。tier の無い・変な値のものは上級扱い', async () => {
    const t = setup({ level: 'standard' });
    try {
      t.registry.discover();
      await t.registry.loadAll();
      assert.deepStrictEqual(runningIds(t), ['p-basic', 'p-feature-std', 'p-standard']);
      assert.ok(t.registry.tierBlocked('p-none'));
      assert.ok(t.registry.tierBlocked('p-bad-tier'));
      assert.ok(!ran().includes('require:p-advanced'));
    } finally { t.done(); }
  });

  await test('上級: 全部動く。snapshot に tier が出る', async () => {
    const t = setup({ level: 'advanced' });
    try {
      t.registry.discover();
      await t.registry.loadAll();
      assert.strictEqual(runningIds(t).length, 6);
      const tiers = Object.fromEntries(t.registry.snapshot().map((r) => [r.id, r.tier]));
      assert.deepStrictEqual(tiers, { 'p-basic': 'basic', 'p-standard': 'standard', 'p-advanced': 'advanced', 'p-feature-std': 'standard', 'p-none': 'advanced', 'p-bad-tier': 'advanced' });
    } finally { t.done(); }
  });

  await test('tierFor が無い（骨格・試験）なら段階で止めない。tierFor が投げたら読まない側（basic）', async () => {
    const a = setup({ noTierFor: true });
    try {
      a.registry.discover();
      await a.registry.loadAll();
      assert.strictEqual(runningIds(a).length, 6);
    } finally { a.done(); }
    const b = setup({ level: 'advanced' });
    try {
      b.level.throws = true;
      b.registry.discover();
      await b.registry.loadAll();
      assert.deepStrictEqual(runningIds(b), ['p-basic']);
    } finally { b.done(); }
  });

  await test('外から入れたものは、manifest が basic と言っても上級まで読まない。初級のあいだは legacy でなくても動かない', async () => {
    const t = setup({ level: 'standard' });
    try {
      t.put(t.external, 'ext-x', { tier: 'basic' });
      t.registry.discover();
      await t.registry.loadAll();
      assert.strictEqual(rowOf(t, 'ext-x').tier, 'advanced');
      assert.strictEqual(rowOf(t, 'ext-x').reason, 'tier-not-loaded');
      assert.ok(!ran().includes('require:ext-x'));
    } finally { t.done(); }
  });

  await test('applyTier: 上げると読み込む・下げると止める（destroy・stop）。もう一度上げると戻る。保存した段階の読み直しは applyTier の時だけ', async () => {
    const t = setup({ level: 'basic' });
    try {
      t.registry.discover();
      await t.registry.loadAll();
      t.level.value = 'advanced'; // 保存だけ先に変わっても、applyTier までは読み込みの判断は変わらない
      assert.deepStrictEqual(runningIds(t), ['p-basic']);
      assert.ok(t.registry.tierBlocked('p-standard'));
      const up = await t.registry.applyTier();
      assert.strictEqual(up.ok, true);
      assert.strictEqual(up.tier, 'advanced');
      assert.strictEqual(up.started.length, 5);
      assert.strictEqual(runningIds(t).length, 6);
      assert.ok(!t.registry.tierBlocked('p-standard'));
      global.__v5.length = 0;
      t.level.value = 'standard';
      const down = await t.registry.applyTier();
      assert.deepStrictEqual(down.stopped.sort(), ['p-advanced', 'p-bad-tier', 'p-none']);
      assert.deepStrictEqual(runningIds(t), ['p-basic', 'p-feature-std', 'p-standard']);
      assert.ok(ran().includes('destroy:p-advanced') && ran().includes('stop:p-advanced'));
      assert.ok(!ran().some((x) => x.endsWith(':p-standard')), '残るものには触らない');
      assert.strictEqual(rowOf(t, 'p-advanced').reason, 'tier-not-loaded');
      t.level.value = 'advanced';
      await t.registry.applyTier();
      assert.strictEqual(runningIds(t).length, 6);
    } finally { t.done(); }
  });

  await test('applyTier keepObs: OBS を握るもの（slot）だけ今のまま。ほかは入れ替える。keepObs なしの次の applyTier で追いつく', async () => {
    const t = setup({ level: 'advanced' });
    try {
      t.put(t.builtin, 'p-slot', { tier: 'standard', role: 'slot', capabilities: ['obs-start', 'obs-stop'] });
      fs.appendFileSync(path.join(t.builtin, 'p-slot', 'index.js'), 'module.exports.onObsEvent = () => {};' + String.fromCharCode(10));
      t.registry.discover();
      await t.registry.loadAll();
      assert.ok(runningIds(t).includes('p-slot'), JSON.stringify(rowOf(t, 'p-slot')));
      global.__v5.length = 0;
      t.level.value = 'basic';
      const down = await t.registry.applyTier({ keepObs: true });
      assert.strictEqual(down.ok, true);
      assert.deepStrictEqual(down.deferred, ['p-slot']);
      assert.deepStrictEqual(runningIds(t), ['p-basic', 'p-slot'], '枠取りは動いたまま、ほかは止まる');
      assert.ok(!ran().some((x) => x.endsWith(':p-slot')), '枠取りには触らない');
      assert.strictEqual(t.registry.tierBlocked('p-slot'), false, '先送り中は、最後に合わせた段階で判断する');
      assert.deepStrictEqual(t.registry.pendingTier(), ['p-slot']);
      const caught = await t.registry.applyTier();
      assert.deepStrictEqual(caught.stopped, ['p-slot']);
      assert.deepStrictEqual(caught.deferred, []);
      assert.deepStrictEqual(runningIds(t), ['p-basic']);
      assert.deepStrictEqual(t.registry.pendingTier(), []);
      // 上げるときも同じ: 枠取りは起こさず、ほかは起こす
      t.level.value = 'advanced';
      const up = await t.registry.applyTier({ keepObs: true });
      assert.deepStrictEqual(up.deferred, ['p-slot']);
      assert.ok(!runningIds(t).includes('p-slot') && runningIds(t).includes('p-advanced'));
      // 元の段階に戻せば、先送りは消える（何も動かさない）
      t.level.value = 'basic';
      const back = await t.registry.applyTier({ keepObs: true });
      assert.deepStrictEqual(back.deferred, []);
    } finally { t.done(); }
  });

  await test('audience dev: 段階ではなく開発者モードで読む（初級でも開発者モードがオンなら動く・上級でもオフなら動かない）。切り替えは applyTier で反映', async () => {
    const t = setup({ level: 'basic', devMode: true });
    try {
      t.put(t.builtin, 'p-dev', { tier: 'advanced', audience: 'dev' });
      t.registry.discover();
      await t.registry.loadAll();
      assert.ok(!runningIds(t).includes('p-dev'), '開発者モードがオフ');
      assert.strictEqual(t.registry.tierBlocked('p-dev'), true);
      t.dev.value = true;
      const on = await t.registry.applyTier();
      assert.deepStrictEqual(on.started, ['p-dev'], '初級のまま開発者モードをオンにすると読まれる');
      assert.deepStrictEqual(runningIds(t), ['p-basic', 'p-dev']);
      t.level.value = 'advanced';
      t.dev.value = false;
      const off = await t.registry.applyTier();
      assert.ok(off.stopped.includes('p-dev'), '上級でも開発者モードがオフなら止まる');
      assert.ok(runningIds(t).includes('p-advanced'));
      assert.ok(!runningIds(t).includes('p-dev'));
    } finally { t.done(); }
  });

  await test('applyTier: 読み直し中（busy）は断る', async () => {
    const t = setup({ level: 'basic' });
    try {
      t.registry.discover();
      await t.registry.loadAll();
      const slow = t.registry.reloadAll(); // busy を取る（待たない）
      const refused = await t.registry.applyTier();
      assert.deepStrictEqual(refused, { ok: false, error: 'busy' });
      await slow;
    } finally { t.done(); }
  });

  await test('reload(id): 段階より上のものは skip / tier-not-loaded（動かさない）', async () => {
    const t = setup({ level: 'basic' });
    try {
      t.registry.discover();
      await t.registry.loadAll();
      const out = await t.registry.reload('p-standard');
      assert.deepStrictEqual(out, { id: 'p-standard', result: 'skip', message: 'tier-not-loaded' });
      assert.ok(!ran().includes('require:p-standard'));
    } finally { t.done(); }
  });

  await test('resolveUiLevel: 保存した値が先。無ければ開発者モード／作者用の配り物は上級・そうでなければ初級', () => {
    assert.strictEqual(resolveUiLevel('standard', { devMode: true }), 'standard');
    assert.strictEqual(resolveUiLevel('', {}), 'basic');
    assert.strictEqual(resolveUiLevel(undefined, undefined), 'basic');
    assert.strictEqual(resolveUiLevel('', { devMode: true }), 'advanced');
    assert.strictEqual(resolveUiLevel('', { authorBuild: true }), 'advanced');
    assert.strictEqual(resolveUiLevel('nope', { devMode: false }), 'basic');
  });
})().then(() => {
  runApiTests().then(() => {
    if (failed) { console.error('[v5-tier] ' + failed + ' failed'); process.exit(1); }
    console.log('[v5-tier] all passed');
  });
});

// ---- api（ui.setSettings・ui.getSettings・印の行を段階で隠す）

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

function apiSetup(opts) {
  const o = opts || {};
  const stored = { uiLevel: o.stored || '' };
  const sets = [];
  const calls = [];
  const applyOpts = [];
  const events = [];
  const registry = {
    paths: { authorRoot: o.authorRoot || path.join(os.tmpdir(), 'v5-no-such-author-dir') },
    blocked: new Set(o.blocked || []),
    tierBlocked(id) { return this.blocked.has(id); },
    applied: o.applied || o.stored || 'basic',
    appliedTier() { return this.applied; },
    async applyTier(opt) { calls.push('applyTier'); applyOpts.push(opt || {}); this.applied = stored.uiLevel || this.applied; if (o.applyResult) return o.applyResult; return { ok: true, tier: stored.uiLevel, stopped: [], started: [], deferred: o.deferred || [] }; }
  };
  const dev = { on: o.devMode === true };
  const live = { n: o.liveCount || 0 };
  const uiSettings = {
    set(patch) { sets.push(patch); if (patch.uiLevel !== undefined) stored.uiLevel = patch.uiLevel; return Object.assign({ ok: true }, { showExperimental: false }); },
    get() { return { showExperimental: false }; },
    getView() { return { readable: true, showExperimental: false, uiLevel: stored.uiLevel, setupDone: false, fanoutAck: false, setupStep: 0, setupSkipped: [], setupSites: [] }; }
  };
  const api = createApi({
    pluginRegistry: registry,
    uiSettings,
    bus: { publish(name, payload) { events.push({ name, payload }); } },
    audit: { write() {} },
    devMode: { get: () => ({ devMode: dev.on, source: 'default' }), set(v) { dev.on = v === true; return { ok: true, devMode: dev.on }; } },
    orchestrator: { modeSetting: () => 'live', modeFor: () => 'live' },
    getState() { if (o.stateThrows) throw new Error('no-state'); return { product: 'marust', plugins: [], destinations: { liveCount: live.n }, engineStatus: { connected: true } }; }
  });
  return { api, stored, calls, applyOpts, events, registry, dev, live, sets };
}

async function runApiTests() {
  await test('ui.getSettings: 保存が無ければ、初級（開発者モードでも作者用の配り物でもないとき）', async () => {
    const t = apiSetup({});
    assert.strictEqual((await t.api.call('ui.getSettings', {}, win)).uiLevel, 'basic');
  });

  await test('ui.getSettings: 保存が無くて開発者モードなら上級。作者用の配り物（plugins-author がある）も上級', async () => {
    const t = apiSetup({ devMode: true });
    assert.strictEqual((await t.api.call('ui.getSettings', {}, win)).uiLevel, 'advanced');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-author-'));
    try {
      const a = apiSetup({ authorRoot: dir });
      assert.strictEqual((await a.api.call('ui.getSettings', {}, win)).uiLevel, 'advanced');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('ui.setSettings uiLevel: 変えると保存して applyTier を 1 回呼び、modes.changed を出す。同じ段階なら呼ばない', async () => {
    const t = apiSetup({ stored: 'basic' });
    const out = await t.api.call('ui.setSettings', { uiLevel: 'standard' }, win);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.uiLevel, 'standard');
    assert.deepStrictEqual(t.calls, ['applyTier']);
    assert.ok(t.events.some((e) => e.name === 'modes.changed'));
    t.calls.length = 0;
    const same = await t.api.call('ui.setSettings', { uiLevel: 'standard' }, win);
    assert.strictEqual(same.ok, true);
    assert.deepStrictEqual(t.calls, []);
    const other = await t.api.call('ui.setSettings', { fanoutAck: true }, win);
    assert.strictEqual(other.ok, true);
    assert.deepStrictEqual(t.calls, []);
  });

  await test('ui.setSettings uiLevel: 配信中でも変えられる（保存して applyTier を keepObs で呼ぶ。先送りの id を返す）', async () => {
    const t = apiSetup({ stored: 'basic', liveCount: 2, deferred: ['slot-youtube'] });
    const out = await t.api.call('ui.setSettings', { uiLevel: 'advanced' }, win);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(t.stored.uiLevel, 'advanced');
    assert.deepStrictEqual(t.calls, ['applyTier']);
    assert.deepStrictEqual(t.applyOpts, [{ keepObs: true }]);
    assert.deepStrictEqual(out.deferred, ['slot-youtube']);
    // 配信中でないなら keepObs なし
    const t2 = apiSetup({ stored: 'basic' });
    await t2.api.call('ui.setSettings', { uiLevel: 'advanced' }, win);
    assert.deepStrictEqual(t2.applyOpts, [{ keepObs: false }]);
  });

  await test('ui.setSettings uiLevel: 反映が busy なら、段階を元に戻して busy を返す', async () => {
    const t = apiSetup({ stored: 'basic', applyResult: { ok: false, error: 'busy' } });
    const out = await t.api.call('ui.setSettings', { uiLevel: 'advanced' }, win);
    assert.deepStrictEqual(out, { ok: false, error: 'busy' });
    assert.strictEqual(t.stored.uiLevel, 'basic');
    assert.ok(!t.events.some((e) => e.name === 'modes.changed'));
  });

  await test('devmode.set: 段階を保存していないとき、段階が変わるなら applyTier（配信中は keepObs）', async () => {
    const t = apiSetup({});
    const on = await t.api.call('devmode.set', { value: true }, win);
    assert.strictEqual(on.ok, true);
    assert.deepStrictEqual(t.calls, ['applyTier']);
    const t2 = apiSetup({ stored: 'standard' });
    await t2.api.call('devmode.set', { value: true }, win);
    assert.deepStrictEqual(t2.calls, ['applyTier'], '段階は変わらなくても、開発者プラグインがあるので反映する');
    const t3 = apiSetup({ liveCount: 1 });
    await t3.api.call('devmode.set', { value: true }, win);
    assert.deepStrictEqual(t3.calls, ['applyTier'], '配信中でも反映する');
    assert.deepStrictEqual(t3.applyOpts, [{ keepObs: true }], '自動枠取りだけ今のまま');
  });

  await test('ui.setSettings uiLevel: 配信中か分からない（getState が読めない）ときも変えられる（keepObs。OBS を握るものは触らない）', async () => {
    const t = apiSetup({ stored: 'basic', stateThrows: true });
    const out = await t.api.call('ui.setSettings', { uiLevel: 'advanced' }, win);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(t.applyOpts, [{ keepObs: true }]);
    assert.strictEqual(t.stored.uiLevel, 'advanced');
    const d = apiSetup({ stateThrows: true });
    await d.api.call('devmode.set', { value: true }, win);
    assert.deepStrictEqual(d.applyOpts, [{ keepObs: true }]);
  });

  await test('ui.setSettings uiLevel: 反映に失敗して戻すとき、未保存だった段階を値として保存しない（保存は消す）', async () => {
    const t = apiSetup({ stored: '', applyResult: { ok: false, error: 'busy' } });
    const out = await t.api.call('ui.setSettings', { uiLevel: 'advanced' }, win);
    assert.deepStrictEqual(out, { ok: false, error: 'busy' });
    assert.strictEqual(t.stored.uiLevel, '', '未保存に戻る');
    assert.deepStrictEqual(t.sets[t.sets.length - 1], { uiLevel: '' });
  });

  await test('配信中に開発者モードを切って画面の段階が変わっても、レジストリには keepObs で反映する。配信のあとの選び直しも反映される', async () => {
    const t = apiSetup({ liveCount: 1, applied: 'basic' });
    await t.api.call('devmode.set', { value: true }, win); // 保存なし→画面は上級に見える
    assert.deepStrictEqual(t.applyOpts, [{ keepObs: true }]);
    assert.strictEqual((await t.api.call('ui.getSettings', {}, win)).uiLevel, 'advanced');
  });

  await test('先送りがあるとき、配信中は ui.getSettings で追いつかず、配信が終われば applyTier（keepObs なし）で追いつく', async () => {
    const t = apiSetup({ stored: 'basic', liveCount: 1 });
    let pending = ['slot-youtube'];
    t.registry.pendingTier = () => pending.slice();
    const base = t.registry.applyTier;
    t.registry.applyTier = async function (opt) { const r = await base.call(this, opt); pending = []; return r; };
    assert.deepStrictEqual((await t.api.call('ui.getSettings', {}, win)).deferred, ['slot-youtube']);
    assert.deepStrictEqual(t.calls, [], '配信中は追いつかない');
    t.live.n = 0;
    assert.deepStrictEqual((await t.api.call('ui.getSettings', {}, win)).deferred, []);
    assert.deepStrictEqual(t.applyOpts, [{ keepObs: false }]);
  });

  await test('印の行（modeGated / featurePlugin）は、段階で読み込まないあいだ無いものとして扱う', async () => {
    const t = apiSetup({ blocked: ['hk'] });
    t.api.registerPluginMethod('hk', 'hkNs.ping', { access: 'read' }, () => ({ ok: true }), { audience: 'public', modeGated: true });
    t.api.registerPluginMethod('free', 'freeNs.ping', { access: 'read' }, () => ({ ok: true }), { audience: 'public', modeGated: true });
    const names = (await t.api.call('api.describe', {}, win)).methods.map((m) => m.method);
    assert.ok(!names.includes('hkNs.ping'));
    assert.ok(names.includes('freeNs.ping'));
    assert.deepStrictEqual(await t.api.call('hkNs.ping', {}, win), { ok: false, error: 'unknown-method' });
    t.registry.blocked.clear();
    assert.deepStrictEqual(await t.api.call('hkNs.ping', {}, win), { ok: true });
  });
}
