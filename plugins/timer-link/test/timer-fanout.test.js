'use strict';

const M = require('../../../_marust');

// K3: タイマーを始めたときの題名・カテゴリの自動送信。確認の門は核の予約（host/layer1/fanout-gate.js）、頼むのはプラグイン timer-link。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createFanoutReserved } = require(M.at('host/layer1/fanout-gate'));
const timerLink = require(path.join(__dirname, '..', '..', 'timer-link', 'index.js'));

function make(init) {
  const state = Object.assign({
    summary: { live: 1, shadow: 0, legacy: 0, liveIds: ['site-twitch'] },
    ack: true,
    ackIds: ['site-twitch'],
    sent: [],
    reserved: []
  }, init || {});
  const fr = createFanoutReserved({
    summarize: () => state.summary,
    getReservation: () => ({ ack: state.ack, liveIds: state.ackIds }),
    setReservation: (ids) => { state.reserved.push(ids.slice()); state.ackIds = ids.slice(); },
    fanout: async (p) => { state.sent.push(p); return state.fanoutResult; }
  });
  return { state, fr };
}

async function main() {
  // 予約の範囲内の live は、核が確認済みの印を付けて送る（プラグインは付けられない）
  let m = make();
  let r = await m.fr.send({ title: ' 作業 ', category: 'Art' });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(m.state.sent[0], { title: '作業', category: 'Art', confirmed: true, allowedLiveIds: ['site-twitch'] });

  // 両方空なら送らない
  r = await m.fr.send({ title: '  ', category: '' });
  assert.deepStrictEqual(r, { ok: false, error: 'empty' });
  // 題名だけでも送る
  r = await m.fr.send({ title: 'only', category: '' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(m.state.sent[1].category, '');
  assert.strictEqual(m.state.sent.length, 2);

  // 本番があるのに最初の確認が未了なら送らない
  m.state.ack = false;
  r = await m.fr.send({ title: 't' });
  assert.deepStrictEqual(r, { ok: false, error: 'needs-ack' });
  assert.strictEqual(m.state.sent.length, 2);

  // 予約に無い live が増えていたら送らない（画面でもう一度確認すると予約が書き直される）
  m.state.ack = true;
  m.state.summary = { live: 2, shadow: 0, legacy: 0, liveIds: ['site-twitch', 'site-youtube'] };
  r = await m.fr.send({ title: 't' });
  assert.deepStrictEqual(r, { ok: false, error: 'needs-ack' });
  assert.strictEqual(m.state.sent.length, 2);
  // ホームの知らせ用: どの送り先が予約に無いか（hub.getState の timerFanout）
  assert.deepStrictEqual([m.fr.last().reason, m.fr.last().missing], ['needs-ack', ['site-youtube']]);
  // 予約より減る（live が少ない）のは構わない
  m.state.summary = { live: 1, shadow: 0, legacy: 1, liveIds: ['site-twitch'] };
  r = await m.fr.send({ title: 't' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([m.fr.last().reason, m.fr.last().missing], ['sent', []], '送れたら知らせは消える');

  // 旧い確認（送り先の控えが無い）は、今の live を 1 回だけ予約として採用する
  m = make({ ackIds: null, summary: { live: 1, shadow: 0, legacy: 0, liveIds: ['site-kick'] } });
  r = await m.fr.send({ title: 't' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(m.state.reserved, [['site-kick']]);
  m.state.summary = { live: 2, shadow: 0, legacy: 0, liveIds: ['site-kick', 'site-twitch'] };
  r = await m.fr.send({ title: 't' });
  assert.strictEqual(r.error, 'needs-ack', '採用したあとは、増えた live を通さない');

  // shadow だけなら確認なしで送る（記録のみ）
  m = make({ ack: false, summary: { live: 0, shadow: 2, legacy: 0, liveIds: [] } });
  r = await m.fr.send({ title: 't' });
  assert.strictEqual(r.ok, true);

  // 全部 legacy なら何もしない
  m = make({ summary: { live: 0, shadow: 0, legacy: 5, liveIds: [] } });
  r = await m.fr.send({ title: 't' });
  assert.deepStrictEqual(r, { ok: false, error: 'legacy' });
  assert.strictEqual(m.state.sent.length, 0);

  // 送信が失敗しても投げない・送る係が無ければ no-plugin
  m = make({ summary: { live: 0, shadow: 1, legacy: 0, liveIds: [] } });
  m.state.fanoutResult = { ok: false, error: 'no-plugin' };
  r = await m.fr.send({ title: 't' });
  assert.deepStrictEqual(r, { ok: false, error: 'no-plugin' });
  const bad = createFanoutReserved({ summarize: () => ({ live: 0, shadow: 1, liveIds: [] }), getReservation: () => ({ ack: true, liveIds: [] }), setReservation() {}, fanout: async () => { throw new Error('x'); } });
  assert.deepStrictEqual(await bad.send({ title: 't' }), { ok: false, error: 'failed' });

  // プラグイン timer-link: session.started（source が timer）を hub.fanoutReserved に頼むだけ。confirmed も allowedLiveIds も渡さない
  const calls = [];
  let handler = null;
  let mode = 'live';
  const ctx = {
    mode: () => mode,
    events: { NAMES: { SESSION_STARTED: 'session.started' } },
    bus: { subscribe: (pattern, fn) => { assert.strictEqual(pattern, 'session.started'); handler = fn; return () => {}; } },
    api: { call: async (method, params) => { calls.push([method, params]); return { ok: true }; } }
  };
  timerLink.load(ctx);
  assert.strictEqual(typeof handler, 'function');
  assert.strictEqual(typeof timerLink.onEvent, 'function', 'manifest の subscribes があるプラグインは onEvent を持つ');
  await handler('session.started', { source: 'timer', title: ' 題 ', category: ' カ ' }, { source: 'session' });
  assert.deepStrictEqual(calls, [['hub.fanoutReserved', { title: '題', category: 'カ' }]]);
  // session 以外の出どころ・timer 以外・両方空・切（legacy）は頼まない
  await handler('session.started', { source: 'timer', title: 'x' }, { source: 'someone' });
  await handler('session.started', { source: 'manual', title: 'x' }, { source: 'session' });
  await handler('session.started', { source: 'timer', title: '', category: '' }, { source: 'session' });
  mode = 'legacy';
  await handler('session.started', { source: 'timer', title: 'x' }, { source: 'session' });
  assert.strictEqual(calls.length, 1);
  // confirmed を渡す道が無い
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/confirmed|allowedLiveIds/.test(src), 'timer-link は confirmed・allowedLiveIds を扱わない');
  console.log('[marust] timer fanout tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
