'use strict';
require('./_ui-inline');

/**
 * V3 C1: 機能のプラグインを切っている（legacy）あいだ、行を無いものとして扱う門（V3-13）。
 * 偽の orchestrator でモードの読み方を数える。本体の行（featurePlugin つき）は C4 で hotkeys.* につけるときに
 * test/w16-hotkeys.test.js で確かめる。
 */

const assert = require('assert');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

function setup(modes) {
  const reads = [];
  const orchestrator = {
    // 設定上のモード（forceLegacy では変わらない）
    modeSetting(id) { reads.push('setting:' + id); return modes[id] || 'legacy'; },
    // 実効のモード（forceLegacy のとき全部 legacy になる、を真似る）
    modeFor(id) { reads.push('for:' + id); return 'legacy'; }
  };
  const api = createApi({
    orchestrator,
    audit: { write() {} },
    devMode: { get: () => ({ devMode: true, source: 'default' }) },
    getState() { return { product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }; }
  });
  return { api, reads, modes };
}

const gated = (t, id, method) => t.api.registerPluginMethod(id, method, { access: 'read' }, () => ({ ok: true }), { audience: 'public', modeGated: true });
const names = async (t) => (await t.api.call('api.describe', {}, win)).methods.map((m) => m.method);

(async () => {
  await test('modeGated の行: legacy なら describe に無く call は unknown-method・live なら出る・設定上のモードを見る（forceLegacy で隠さない）', async () => {
    const t = setup({ alpha: 'live', beta: 'legacy' });
    gated(t, 'alpha', 'alphaNs.ping');
    gated(t, 'beta', 'betaNs.ping');
    const list = await names(t);
    assert.ok(list.includes('alphaNs.ping'));
    assert.ok(!list.includes('betaNs.ping'));
    assert.deepStrictEqual(await t.api.call('alphaNs.ping', {}, win), { ok: true });
    assert.deepStrictEqual(await t.api.call('betaNs.ping', {}, win), { ok: false, error: 'unknown-method' });
    assert.ok(t.reads.every((r) => r.startsWith('setting:')), 'modeFor（forceLegacy 込み）は呼ばない: ' + t.reads.join(','));
    t.modes.beta = 'shadow';
    assert.ok((await names(t)).includes('betaNs.ping'), 'legacy 以外なら出る');
  });

  await test('modeGated でない行は、モードを見ずに常に出る', async () => {
    const t = setup({});
    t.api.registerPluginMethod('free', 'freeNs.ping', { access: 'read' }, () => ({ ok: true }), { audience: 'public' });
    t.reads.length = 0;
    assert.ok((await names(t)).includes('freeNs.ping'));
    assert.ok(!t.reads.some((r) => r.endsWith(':free')), '自分の id のモードは読まない');
  });

  await test('1 回の api.describe で、同じプラグインのモードは 1 回だけ読む（V2-result Later 3）', async () => {
    const t = setup({ many: 'live' });
    for (let i = 0; i < 5; i += 1) gated(t, 'many', 'manyNs.m' + i);
    t.reads.length = 0;
    await t.api.call('api.describe', {}, win);
    assert.strictEqual(t.reads.filter((r) => r === 'setting:many').length, 1, t.reads.join(','));
    // describe をもう一度呼べば、また 1 回読む（古い答えを覚えたままにしない）
    await t.api.call('api.describe', {}, win);
    assert.strictEqual(t.reads.filter((r) => r === 'setting:many').length, 2);
  });

  await test('orchestrator が無い・モードを読めない・投げるときは、隠さない', async () => {
    const bare = createApi({ audit: { write() {} }, devMode: { get: () => ({ devMode: true, source: 'default' }) }, getState: () => ({ product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }) });
    bare.registerPluginMethod('x', 'xNs.ping', { access: 'read' }, () => ({ ok: true }), { audience: 'public', modeGated: true });
    assert.ok((await bare.call('api.describe', {}, win)).methods.some((m) => m.method === 'xNs.ping'));
    const throwing = createApi({ orchestrator: { modeSetting() { throw new Error('x'); } }, audit: { write() {} }, devMode: { get: () => ({ devMode: true, source: 'default' }) }, getState: () => ({ product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } }) });
    throwing.registerPluginMethod('x', 'xNs.ping', { access: 'read' }, () => ({ ok: true }), { audience: 'public', modeGated: true });
    assert.deepStrictEqual(await throwing.call('xNs.ping', {}, win), { ok: true });
  });

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
  console.log('v3-feature-gate: all ok');
})();
