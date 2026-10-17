'use strict';
require('./_ui-inline');

/**
 * V1 C2: createApi の registerPluginMethod（プラグインが出す API）。偽のハンドラだけ。
 * 権限・承認・開発者モードの門は dispatch のまま、devOnly/noApproval は付けさせない。
 */

const assert = require('assert');
const { createApi, CORE_NAMESPACES } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function setup(extra) {
  const dev = { on: true };
  const api = createApi(Object.assign({
    audit: { write() {} },
    devMode: { get: () => ({ devMode: dev.on, source: 'default' }) },
    getState() { return { product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
  }, extra || {}));
  return { api, dev };
}
const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
const mcp = { clientId: 'mcp-1', kind: 'native', permissions: ['read', 'write'], requiresApproval: true, via: 'ws' };
const okHandler = () => ({ ok: true });
const reg = (t, id, method, opts, handler, meta) => t.api.registerPluginMethod(id, method, opts, handler || okHandler, meta || { audience: 'public' });
const row = async (t, method) => (await t.api.call('api.describe', {}, win)).methods.find((m) => m.method === method);

(async () => {
  await test('正しく登録: describe に出る・owner が id・noApproval は false', async () => {
    const t = setup();
    assert.deepStrictEqual(reg(t, 'demo', 'demoNs.ping', { access: 'read', description: 'ぴん' }), { ok: true, method: 'demoNs.ping' });
    const r = await row(t, 'demoNs.ping');
    assert.strictEqual(r.owner, 'demo');
    assert.strictEqual(r.noApproval, false);
    assert.strictEqual(r.permission, 'read');
    assert.strictEqual(r.description, 'ぴん');
    assert.strictEqual((await row(t, 'hub.getState')).owner, '');
    assert.deepStrictEqual(await t.api.call('demoNs.ping', {}, win), { ok: true });
  });

  await test('断る: bad-method / reserved / bad-access / bad-option / bad-params / taken', async () => {
    const t = setup();
    const err = (id, m, o, h) => reg(t, id, m, o, h).error;
    for (const m of ['ping', 'a.b.c', 'Demo.ping', '1x.ping', 'demo.', 'demo.1a', '']) assert.strictEqual(err('demo', m, { access: 'read' }), 'bad-method', m);
    for (const m of ['engine.start', 'plugin.x', 'api.foo']) assert.strictEqual(err('demo', m, { access: 'read' }), 'reserved', m);
    for (const a of ['emergency', 'chat-write', 'ext-write', '', undefined]) assert.strictEqual(err('demo', 'demoNs.x', { access: a }), 'bad-access', String(a));
    for (const o of [{ devOnly: false }, { noApproval: true }, { permission: 'read' }, { audience: 'public' }]) {
      assert.strictEqual(err('demo', 'demoNs.x', Object.assign({ access: 'write' }, o)), 'bad-option', JSON.stringify(o));
    }
    assert.strictEqual(err('demo', 'demoNs.x', null), 'bad-option');
    assert.strictEqual(err('demo', 'demoNs.x', { access: 'read', description: 'x'.repeat(201) }), 'bad-option');
    assert.strictEqual(err('demo', 'demoNs.x', { access: 'read', params: { a: { type: 'string', loose: true } } }), 'bad-params');
    assert.strictEqual(err('demo', 'demoNs.x', { access: 'read', params: { a: { layoutName: true } } }), 'bad-params');
    assert.strictEqual(err('demo', 'demoNs.x', { access: 'read', params: { a: { type: 'weird' } } }), 'bad-params');
    const many = {};
    for (let i = 0; i < 21; i += 1) many['p' + i] = { type: 'string' };
    assert.strictEqual(err('demo', 'demoNs.x', { access: 'read', params: many }), 'bad-params');
    assert.strictEqual(err('demo', 'demoNs.x', { access: 'read' }, 'nope'), 'bad-handler');
    assert.strictEqual(err('Bad Id', 'demoNs.x', { access: 'read' }), 'bad-id');
    assert.strictEqual(reg(t, 'demo', 'demoNs.one', { access: 'read' }).ok, true);
    assert.strictEqual(err('demo', 'demoNs.one', { access: 'read' }), 'taken', '同じメソッド');
    assert.strictEqual(err('other', 'demoNs.two', { access: 'read' }), 'taken', '別の id が同じ名前空間');
    assert.strictEqual(reg(t, 'demo', 'demoNs.two', { access: 'read' }).ok, true, '同じ持ち主なら別メソッドは可');
  });

  await test('本体の各名前空間は、プラグインが登録できない', () => {
    const t = setup();
    assert.strictEqual(CORE_NAMESPACES.length, 21); // K3: session・tips・update・diagnostics・hotkeys・auth・sites はプラグインが出す
    assert.ok(Object.isFrozen(CORE_NAMESPACES));
    for (const ns of CORE_NAMESPACES) assert.strictEqual(reg(t, 'demo', ns + '.x', { access: 'read' }).error, 'reserved', ns);
  });

  await test('引数の検査は呼ぶ前に効く・渡した params を直しても残らない・info は凍結', async () => {
    const t = setup();
    let calls = 0;
    const seen = [];
    reg(t, 'demo', 'demoNs.rep', { access: 'read', params: { days: { type: 'number', min: 1, max: 30, integer: true, rangeError: 'bad-days', typeError: 'bad-days' } } }, (p) => { calls += 1; seen.push(p); p.days = 99; p.extra = 1; return { ok: true }; });
    assert.deepStrictEqual(await t.api.call('demoNs.rep', { days: 31 }, win), { ok: false, error: 'bad-days' });
    assert.strictEqual(calls, 0);
    const input = { days: 3 };
    await t.api.call('demoNs.rep', input, win);
    assert.strictEqual(input.days, 3, '呼び出し側の物は直らない');
    await t.api.call('demoNs.rep', { days: 4 }, win);
    assert.strictEqual(seen[1].days, 99);
    assert.strictEqual(calls, 2);
    let got;
    reg(t, 'demo', 'demoNs.info', { access: 'read' }, (_p, i) => { got = i; return { ok: true }; });
    await t.api.call('demoNs.info', {}, win);
    assert.deepStrictEqual(got, { kind: 'window', clientId: WINDOW_ID });
    assert.ok(Object.isFrozen(got));
  });

  await test('requiresApproval の write は pending → 承認で走る。外してから承認は unknown-method。read は承認なし', async () => {
    const t = setup();
    let ran = 0;
    reg(t, 'demo', 'demoNs.w', { access: 'write' }, () => { ran += 1; return { ok: true }; });
    reg(t, 'demo', 'demoNs.r', { access: 'read' });
    const held = await t.api.call('demoNs.w', {}, mcp);
    assert.strictEqual(held.pending, true);
    assert.strictEqual(ran, 0);
    const done = await t.api.call('approval.approve', { id: held.approvalId }, win);
    assert.strictEqual(done.ok, true, JSON.stringify(done));
    assert.strictEqual(ran, 1);
    const held2 = await t.api.call('demoNs.w', {}, mcp);
    t.api.unregisterPlugin('demo');
    const gone = await t.api.call('approval.approve', { id: held2.approvalId }, win);
    assert.ok(JSON.stringify(gone).includes('unknown-method'), JSON.stringify(gone));
    assert.strictEqual(ran, 1);
    reg(t, 'demo', 'demoNs.r', { access: 'read' });
    assert.deepStrictEqual(await t.api.call('demoNs.r', {}, mcp), { ok: true });
  });

  await test('audience dev / author → 開発者モードでないと dev-only。public は通る', async () => {
    const t = setup();
    reg(t, 'devp', 'devNs.x', { access: 'read' }, okHandler, { audience: 'dev' });
    reg(t, 'auth', 'authNs.x', { access: 'read' }, okHandler, { audience: 'author' });
    reg(t, 'pub', 'pubNs.x', { access: 'read' }, okHandler, { audience: 'public' });
    t.dev.on = false;
    assert.strictEqual((await t.api.call('devNs.x', {}, win)).error, 'dev-only');
    assert.strictEqual((await t.api.call('authNs.x', {}, win)).error, 'dev-only');
    assert.strictEqual((await t.api.call('pubNs.x', {}, win)).ok, true);
    t.dev.on = true;
    assert.strictEqual((await t.api.call('devNs.x', {}, win)).ok, true);
  });

  await test('答え: 秘密の欄は消える・物でない / ok が真偽でない → bad-result・遅い → timeout・例外 → failed', async () => {
    const t = setup({ pluginMethodTimeoutMs: 50 });
    reg(t, 'demo', 'demoNs.sec', { access: 'read' }, () => ({ ok: true, token: 'abc', nested: { password: 'p', keep: 1 } }));
    reg(t, 'demo', 'demoNs.str', { access: 'read' }, () => 'x');
    reg(t, 'demo', 'demoNs.okstr', { access: 'read' }, () => ({ ok: 'yes' }));
    reg(t, 'demo', 'demoNs.slow', { access: 'read' }, () => new Promise((r) => setTimeout(() => r({ ok: true }), 400)));
    reg(t, 'demo', 'demoNs.boom', { access: 'read' }, () => { throw new Error('x'); });
    const sec = await t.api.call('demoNs.sec', {}, win);
    assert.ok(!JSON.stringify(sec).includes('abc') && !JSON.stringify(sec).includes('"p"'), JSON.stringify(sec));
    assert.strictEqual(sec.nested.keep, 1);
    assert.strictEqual((await t.api.call('demoNs.str', {}, win)).error, 'bad-result');
    assert.strictEqual((await t.api.call('demoNs.okstr', {}, win)).error, 'bad-result');
    assert.strictEqual((await t.api.call('demoNs.slow', {}, win)).error, 'timeout');
    assert.strictEqual((await t.api.call('demoNs.boom', {}, win)).error, 'failed');
  });

  await test('unregisterPlugin: plugin.<id>.* と持ち主の行が消え、他の id は残る・名前空間も空く', async () => {
    const t = setup();
    reg(t, 'demo', 'demoNs.a', { access: 'read' });
    t.api.registerPluginAction('demo', 'ping', 'read', okHandler);
    reg(t, 'other', 'otherNs.a', { access: 'read' });
    t.api.unregisterPlugin('demo');
    assert.strictEqual((await t.api.call('demoNs.a', {}, win)).error, 'unknown-method');
    assert.strictEqual((await t.api.call('plugin.demo.ping', {}, win)).error, 'unknown-method');
    assert.strictEqual((await t.api.call('otherNs.a', {}, win)).ok, true);
    assert.strictEqual(reg(t, 'third', 'demoNs.a', { access: 'read' }).ok, true, '空いた名前空間は取れる');
  });

  await test('chat-write だけの端末は read は呼べ、write は forbidden。windowOnly は窓以外 forbidden', async () => {
    const t = setup();
    reg(t, 'demo', 'demoNs.r', { access: 'read' });
    reg(t, 'demo', 'demoNs.w', { access: 'write' });
    reg(t, 'demo', 'demoNs.win', { access: 'read', windowOnly: true });
    const chat = { clientId: 'c1', kind: 'native', permissions: ['read', 'chat-write'] };
    assert.strictEqual((await t.api.call('demoNs.r', {}, chat)).ok, true);
    assert.strictEqual((await t.api.call('demoNs.w', {}, chat)).error, 'forbidden');
    assert.strictEqual((await t.api.call('demoNs.win', {}, { clientId: 'x', kind: 'native', permissions: ['read'] })).error, 'forbidden');
    assert.strictEqual((await t.api.call('demoNs.win', {}, win)).ok, true);
  });

  if (failed) { console.error('\n[v1-api-register] ' + failed + ' failed'); process.exit(1); }
  console.log('\n[marust] v1 api register tests passed');
})();
