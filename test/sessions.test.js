'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createSessionStore } = require('./_k3-parts');
const { createSessions, DEFAULT_HEARTBEAT_MS } = require('./_k3-parts');
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

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function tempCore() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-session-'));
  return {
    dir,
    core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync }
  };
}

function watchReal() {
  const core = createCore();
  const dir = path.join(core.STATE_DIR, 'data', 'marust');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return function cleanup() {
    if (!fs.existsSync(dir)) return;
    const extra = fs.readdirSync(dir).filter((name) => before.indexOf(name) === -1);
    for (const name of extra) fs.rmSync(path.join(dir, name), { force: true });
    assert.deepStrictEqual(extra, []);
  };
}

async function main() {
  const cleanup = watchReal();
  try {
    await test('session start pause resume end event order', async () => {
      const bag = tempCore();
      try {
        const bus = createEventBus({ logger() {} });
        const names = [];
        bus.subscribe('session.*', (name) => names.push(name), { pluginId: 'order' });
        const store = createSessionStore({ dir: bag.dir }); store.load();
        const sessions = createSessions({ store, bus, recover: false, heartbeatMs: 60000, setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
        assert.strictEqual(sessions.heartbeatMs, 60000);
        const started = sessions.start({ title: '題名', category: 'Games', plannedSec: 90, source: 'manual' });
        assert.strictEqual(started.ok, true);
        assert.strictEqual(sessions.pause().ok, true);
        assert.strictEqual(sessions.resume().ok, true);
        assert.strictEqual(sessions.end().ok, true);
        await bus.flush();
        assert.deepStrictEqual(names, [
          EVENTS.SESSION_STARTED,
          EVENTS.SESSION_PAUSED,
          EVENTS.SESSION_RESUMED,
          EVENTS.SESSION_ENDED
        ]);
        const saved = store.snapshot().session;
        assert.strictEqual(saved.state, 'ended');
        assert.strictEqual(saved.title, '題名');
        assert.strictEqual(names.includes(EVENTS.SESSION_RETITLED), false);
      } finally {
        rimraf(bag.dir);
      }
    });

    await test('second concurrent start is rejected', async () => {
      const bag = tempCore();
      try {
        const bus = createEventBus({ logger() {} });
        const names = [];
        bus.subscribe('session.*', (name) => names.push(name), { pluginId: 'once' });
        const store = createSessionStore({ dir: bag.dir }); store.load();
        const sessions = createSessions({
          store,
          bus,
          recover: false,
          setIntervalFn() { return { unref() {} }; },
          clearIntervalFn() {}
        });
        assert.strictEqual(sessions.start({ title: 'one', source: 'timer' }).ok, true);
        const again = sessions.start({ title: 'two', source: 'obs' });
        assert.strictEqual(again.ok, false);
        assert.strictEqual(again.reason, 'session-active');
        assert.strictEqual(store.snapshot().session.title, 'one');
        await bus.flush();
        assert.deepStrictEqual(names, [EVENTS.SESSION_STARTED]);
        sessions.stop();
      } finally {
        rimraf(bag.dir);
      }
    });

    await test('startup recovery ends a running session at lastAliveAt', async () => {
      const bag = tempCore();
      try {
        const file = path.join(bag.dir, 'session.json');
        const alive = '2026-10-04T00:10:00.000Z';
        fs.writeFileSync(file, JSON.stringify({
          schemaVersion: 1,
          session: {
            id: 's-recover',
            title: 'old',
            category: 'cat',
            plannedSec: 60,
            source: 'manual',
            state: 'running',
            startedAt: '2026-10-04T00:00:00.000Z',
            lastAliveAt: alive,
            segments: [{ startedAt: '2026-10-04T00:00:00.000Z' }]
          }
        }));
        const bus = createEventBus({ logger() {} });
        const seen = [];
        bus.subscribe(EVENTS.SESSION_ENDED, (name, payload) => seen.push(payload), { pluginId: 'recover' });
        const store = createSessionStore({ dir: bag.dir }); store.load();
        createSessions({ store, bus, heartbeatMs: DEFAULT_HEARTBEAT_MS });
        await bus.flush();
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].recovered, true);
        assert.strictEqual(seen[0].endedAt, alive);
        assert.strictEqual(seen[0].state, 'ended');
        assert.strictEqual(store.snapshot().session.state, 'ended');
        assert.strictEqual(store.snapshot().session.endedAt, alive);
        assert.strictEqual(DEFAULT_HEARTBEAT_MS, 30000);
      } finally {
        rimraf(bag.dir);
      }
    });

    await test('heartbeat interval is injectable', async () => {
      const bag = tempCore();
      try {
        let tick = null;
        let t = Date.parse('2026-10-04T01:00:00.000Z');
        const bus = createEventBus({ logger() {} });
        const store = createSessionStore({ dir: bag.dir }); store.load();
        const sessions = createSessions({
          store,
          bus,
          recover: false,
          heartbeatMs: 30000,
          now: () => new Date(t),
          setIntervalFn(fn, ms) {
            assert.strictEqual(ms, 30000);
            tick = fn;
            return { unref() {} };
          },
          clearIntervalFn() { tick = null; }
        });
        sessions.start({ title: 'beat', source: 'manual' });
        const first = store.snapshot().session.lastAliveAt;
        assert.strictEqual(typeof tick, 'function');
        t += 45000;
        tick();
        const second = store.snapshot().session.lastAliveAt;
        assert.notStrictEqual(second, first);
        assert.strictEqual(second, new Date(t).toISOString());
        sessions.end();
        assert.strictEqual(tick, null);
      } finally {
        rimraf(bag.dir);
      }
    });
  } finally {
    cleanup();
  }

  if (failed) {
    console.error('[marust] sessions tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] sessions tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
