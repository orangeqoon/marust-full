'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEventBus } = require('../host/core/event-bus');
const { EVENTS } = require('../host/core/events');

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

async function main() {
  await test('event bus wildcard delivers only matching names', async () => {
    const bus = createEventBus({ logger() {} });
    const names = [];
    bus.subscribe('session.*', (name) => names.push(name), { pluginId: 'wild' });
    assert.strictEqual(bus.publish(EVENTS.SESSION_STARTED, { n: 1 }), 1);
    assert.strictEqual(bus.publish(EVENTS.SESSION_ENDED, { n: 2 }), 1);
    assert.strictEqual(bus.publish(EVENTS.BROADCAST_STOPPED, { n: 3 }), 0);
    await bus.flush();
    assert.deepStrictEqual(names, [EVENTS.SESSION_STARTED, EVENTS.SESSION_ENDED]);
  });

  await test('one subscriber throwing does not affect others', async () => {
    const logs = [];
    const bus = createEventBus({ logger: (level, message) => logs.push(level + ':' + message) });
    const seen = [];
    bus.subscribe(EVENTS.CHAT_MESSAGE, () => {
      throw new Error('boom');
    }, { pluginId: 'bad' });
    bus.subscribe(EVENTS.CHAT_MESSAGE, (name, payload) => {
      seen.push(payload.n);
    }, { pluginId: 'good' });
    const handed = bus.publish(EVENTS.CHAT_MESSAGE, { n: 7 });
    assert.strictEqual(handed, 2);
    await bus.flush();
    assert.deepStrictEqual(seen, [7]);
    assert.ok(logs.some((line) => line.startsWith('error:')));
  });

  await test('subscriber order is preserved and payloads are not shared', async () => {
    const bus = createEventBus({ logger() {} });
    const first = [];
    const second = [];
    bus.subscribe(EVENTS.VIEWER_COUNT, (name, payload) => first.push(payload.n), { pluginId: 'first' });
    bus.subscribe(EVENTS.VIEWER_COUNT, (name, payload) => second.push(payload.n), { pluginId: 'second' });
    bus.publish(EVENTS.VIEWER_COUNT, { n: 1 });
    bus.publish(EVENTS.VIEWER_COUNT, { n: 2 });
    bus.publish(EVENTS.VIEWER_COUNT, { n: 3 });
    await bus.flush();
    assert.deepStrictEqual(first, [1, 2, 3]);
    assert.deepStrictEqual(second, [1, 2, 3]);

    const original = { n: 1, nested: { ok: true } };
    let seen;
    bus.subscribe(EVENTS.AUTH_UPDATED, (name, payload) => {
      seen = payload;
      payload.n = 9;
      payload.nested.ok = false;
    }, { pluginId: 'clone' });
    bus.publish(EVENTS.AUTH_UPDATED, original);
    await bus.flush();
    assert.notStrictEqual(seen, original);
    assert.strictEqual(original.n, 1);
    assert.strictEqual(original.nested.ok, true);
    assert.strictEqual(seen.n, 9);
    assert.strictEqual(seen.nested.ok, false);
  });

  await test('queue over cap drops the oldest and logs the count only', async () => {
    const logs = [];
    const bus = createEventBus({ logger: (level, message) => logs.push(level + ':' + message) });
    const got = [];
    bus.subscribe(EVENTS.VIEWER_COUNT, (name, payload) => got.push(payload.n), { pluginId: 'cap' });
    for (let n = 1; n <= 1001; n += 1) {
      bus.publish(EVENTS.VIEWER_COUNT, { n, secret: 'drop-secret-' + n });
    }
    await bus.flush();
    assert.strictEqual(got.length, 1000);
    assert.strictEqual(got[0], 2);
    assert.strictEqual(got[999], 1001);
    const drop = logs.filter((line) => line.startsWith('warn:event-bus drop count='));
    assert.ok(drop.length >= 1);
    assert.ok(drop.every((line) => /^warn:event-bus drop count=\d+$/.test(line)));
    assert.ok(!logs.join('\n').includes('drop-secret-'));
  });

  await test('unknown event name warns but is still delivered', async () => {
    const logs = [];
    const bus = createEventBus({ logger: (level, message) => logs.push(level + ':' + message) });
    const seen = [];
    bus.subscribe('not.a.real.event', (name, payload) => seen.push(payload.token), { pluginId: 'u' });
    const handed = bus.publish('not.a.real.event', { token: 'should-not-be-logged' });
    assert.strictEqual(handed, 1);
    await bus.flush();
    assert.deepStrictEqual(seen, ['should-not-be-logged']);
    assert.ok(logs.some((line) => line === 'warn:unknown event count=1'));
    assert.ok(!logs.join('\n').includes('should-not-be-logged'));
    logs.length = 0;
    bus.publish(EVENTS.AUTH_UPDATED, {});
    await bus.flush();
    assert.ok(!logs.some((line) => line.includes('unknown event')));
  });


  await test('timeout waits so a 1.5s handler with a 1s timeout stays at concurrency 1', async () => {
    const bus = createEventBus({ logger() {} });
    let current = 0;
    let max = 0;
    const seen = [];
    bus.subscribe(EVENTS.SESSION_STARTED, (name, payload) => {
      current += 1;
      if (current > max) max = current;
      seen.push(payload.n);
      return new Promise((resolve) => {
        setTimeout(() => {
          current -= 1;
          resolve();
        }, 1500);
      });
    }, { pluginId: 'slow', timeoutMs: 1000 });
    bus.publish(EVENTS.SESSION_STARTED, { n: 1 });
    bus.publish(EVENTS.SESSION_STARTED, { n: 2 });
    await bus.flush();
    assert.strictEqual(max, 1);
    assert.deepStrictEqual(seen, [1, 2]);
    assert.strictEqual(current, 0);
  });

  await test('stuck subscriber drops the queue and clears when the body settles', async () => {
    const logs = [];
    const bus = createEventBus({
      logger: (level, message) => logs.push(level + ':' + message),
      stuckAfterMs: 40
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let running = 0;
    let max = 0;
    const seen = [];
    bus.subscribe(EVENTS.SESSION_STARTED, (name, payload) => {
      running += 1;
      if (running > max) max = running;
      seen.push(payload.n);
      return gate.then(() => { running -= 1; });
    }, { pluginId: 'stuck', timeoutMs: 30 });
    bus.publish(EVENTS.SESSION_STARTED, { n: 1, secret: 'stuck-secret' });
    bus.publish(EVENTS.SESSION_STARTED, { n: 2, secret: 'stuck-secret' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.strictEqual(max, 1);
    assert.deepStrictEqual(seen, [1]);
    const stuck = logs.filter((line) => line.startsWith('warn:event-bus stuck count='));
    assert.deepStrictEqual(stuck, ['warn:event-bus stuck count=1']);
    assert.ok(!logs.join('\n').includes('stuck-secret'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    bus.publish(EVENTS.SESSION_STARTED, { n: 3 });
    await bus.flush();
    assert.deepStrictEqual(seen, [1, 3]);
    assert.strictEqual(running, 0);
    const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'core', 'event-bus.js'), 'utf8');
    assert.ok(src.includes('STUCK_FLOOR_MS = 60000'));
    assert.ok(src.includes('timeoutMs * 3'));
    assert.ok(src.includes('opts.stuckAfterMs'));
  });

  if (failed) {
    console.error('[marust] event-bus tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] event-bus tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
