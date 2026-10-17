'use strict';

/**
 * R22（M2.5 評価 Must 4）: host/core/engine/obs-stream-control.js。
 * 切り替えの途中で人が止めた（非常停止・手動の停止）ら、自動で再開して上書きしない。
 */

const assert = require('assert');
const { createObsStreamControl } = require('../host/core/engine/obs-stream-control');

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function make(over) {
  const o = over || {};
  const clock = { t: 1000 };
  const sent = [];
  const conn = {
    getStatus: () => ({ connected: o.connected !== false }),
    controlStream: async (action) => { sent.push(action); return {}; }
  };
  const orch = { modeFor: (id) => (id === 'obs-engine' ? (o.engineMode || 'live') : 'legacy') };
  const ctl = createObsStreamControl({
    getOrchestrator: () => orch,
    getConnection: () => (o.noConnection ? null : conn),
    now: () => clock.t
  });
  return { ctl, clock, sent };
}

(async () => {
  await test('OBS 操作がオフ（obs-engine が live でない）なら止めも始めもしない・check も断る', async () => {
    const bag = make({ engineMode: 'legacy' });
    for (const action of ['stop', 'start', 'check']) {
      await assert.rejects(bag.ctl.control(action), (e) => e.message === 'obs-control-off');
    }
    assert.deepStrictEqual(bag.sent, []);
  });

  await test('OBS につながっていなければ obs-not-connected（check でも）', async () => {
    const off = make({ connected: false });
    await assert.rejects(off.ctl.control('check'), (e) => e.code === 'OBS_NOT_CONNECTED');
    const none = make({ noConnection: true });
    await assert.rejects(none.ctl.control('stop'), (e) => e.code === 'OBS_NOT_CONNECTED');
    assert.deepStrictEqual(off.sent, []);
  });

  await test('check は OBS を動かさない。stop → start は通る', async () => {
    const bag = make();
    await bag.ctl.control('check');
    assert.deepStrictEqual(bag.sent, []);
    bag.clock.t = 2000;
    await bag.ctl.control('stop');
    bag.clock.t = 9000;
    await bag.ctl.control('start');
    assert.deepStrictEqual(bag.sent, ['stop', 'start']);
  });

  await test('stop と start の間に人が止めた（非常停止・手動）なら start を断る', async () => {
    for (const reason of ['emergency', 'manual']) {
      const bag = make();
      bag.clock.t = 2000;
      await bag.ctl.control('stop');
      bag.clock.t = 4000;
      bag.ctl.onStopping({ reason: reason });
      bag.clock.t = 9000;
      await assert.rejects(bag.ctl.control('start'), (e) => e.message === 'human-stopped', reason);
      assert.deepStrictEqual(bag.sent, ['stop']);
    }
  });

  await test('OBS 自身の停止（reason obs）や、切り替えの前に人が止めていた場合は start を断らない', async () => {
    const bag = make();
    bag.ctl.onStopping({ reason: 'emergency' }); // t=1000: 切り替えより前の人の停止
    bag.clock.t = 2000;
    await bag.ctl.control('stop');
    bag.clock.t = 3000;
    bag.ctl.onStopping({ reason: 'obs' }); // 自分の stop が起こした OBS の停止通知
    bag.ctl.onStopping(null);
    bag.ctl.onStopping({});
    bag.clock.t = 9000;
    await bag.ctl.control('start');
    assert.deepStrictEqual(bag.sent, ['stop', 'start']);
  });

  await test('同じ時刻の人の停止は人を優先して断る。知らない操作は拒否', async () => {
    const bag = make();
    bag.clock.t = 2000;
    await bag.ctl.control('stop');
    bag.ctl.onStopping({ reason: 'manual' }); // 同じ時刻
    await assert.rejects(bag.ctl.control('start'), (e) => e.message === 'human-stopped');
    await assert.rejects(bag.ctl.control('restart'), (e) => e.message === 'bad-action');
  });

  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
})();
