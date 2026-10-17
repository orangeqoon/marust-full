'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-state-'));
  return {
    dir,
    core: {
      STATE_DIR: dir,
      atomicWriteJsonSync: real.atomicWriteJsonSync
    }
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
    await test('state save then reload is equal', async () => {
      const bag = tempCore();
      try {
        const store = createStateStore({ core: bag.core, logger() {} });
        const missed = store.updateActual('missing', { title: 'x' });
        assert.strictEqual(missed.reason, 'unknown-destination');
        assert.strictEqual(store.snapshot().destinations.length, 0);
        store.putDestination({
          id: 'youtube-main',
          site: 'youtube',
          obsTargetId: 'obs-1',
          enabled: true,
         
          actual: { obsState: 'stopped', siteLive: false, lastError: '', updatedAt: '2026-10-04T00:00:00.000Z' }
        });
        const before = store.snapshot();
        assert.strictEqual(before.schemaVersion, 1);
        const again = createStateStore({ core: bag.core, logger() {} });
        assert.deepStrictEqual(again.snapshot(), before);
        const raw = JSON.parse(fs.readFileSync(store.filePath(), 'utf8'));
        assert.strictEqual(raw.schemaVersion, 1);
        assert.ok(!('desired' in raw.destinations[0]));
        assert.ok(!('session' in raw));
      } finally {
        rimraf(bag.dir);
      }
    });

    await test('broken state json is quarantined without logging contents', async () => {
      const bag = tempCore();
      const logs = [];
      try {
        const file = path.join(bag.dir, 'data', 'marust', 'state.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{"broken":"SECRET_BODY"', 'utf8');
        const store = createStateStore({
          core: bag.core,
          logger: (level, message) => logs.push(level + ':' + message)
        });
        assert.deepStrictEqual(store.snapshot(), { schemaVersion: 1, destinations: [] });
        assert.ok(!fs.existsSync(file));
        const moved = fs.readdirSync(path.dirname(file)).filter((name) => name.indexOf('state.json.broken-') === 0);
        assert.strictEqual(moved.length, 1);
        assert.ok(fs.readFileSync(path.join(path.dirname(file), moved[0]), 'utf8').includes('SECRET_BODY'));
        assert.ok(logs.some((line) => line === 'warn:state load failed count=1'));
        assert.ok(!logs.join('\n').includes('SECRET_BODY'));
      } finally {
        rimraf(bag.dir);
      }
    });

    await test('actual update keeps engine state only (no title/category, no drift event); disabled rows are omitted from the summary', async () => {
      const bag = tempCore();
      try {
        const bus = createEventBus({ logger() {} });
        const seen = [];
        bus.subscribe('destination.drift', (name, payload) => seen.push(payload.id), { pluginId: 'drift' });
        const store = createStateStore({ core: bag.core, bus, logger() {} });
        store.putDestination({ id: 'off', enabled: false, actual: { siteLive: false } });
        store.putDestination({ id: 'on', enabled: true, actual: { siteLive: false } });
        const r = store.updateActual('on', { title: 'Z', category: 'Q', siteLive: true });
        assert.strictEqual(r.ok, true);
        await bus.flush();
        assert.deepStrictEqual(seen, []);
        const actual = store.snapshot().destinations.find((row) => row.id === 'on').actual;
        assert.strictEqual(actual.siteLive, true);
        assert.ok(!('title' in actual) && !('category' in actual));
        assert.deepStrictEqual(store.destinationSummary(), { count: 1 });
      } finally {
        rimraf(bag.dir);
      }
    });

    await test('null destination rows are dropped with a count and do not crash', async () => {
      const bag = tempCore();
      const logs = [];
      try {
        const file = path.join(bag.dir, 'data', 'marust', 'state.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
          schemaVersion: 1,
          destinations: [null, { site: 'x' }, { id: 5 }, { id: 'ok', enabled: true, desired: { title: 'a', category: 'b', live: false }, actual: { title: 'a', category: 'b', siteLive: false } }],
          session: null
        }));
        const store = createStateStore({
          core: bag.core,
          logger: (level, message) => logs.push(level + ':' + message)
        });
        assert.deepStrictEqual(store.snapshot().destinations.map((row) => row.id), ['ok']);
        const updated = store.updateActual('ok', { title: 'a' });
        assert.strictEqual(updated.ok, true);
        assert.ok(logs.some((line) => line === 'warn:state destinations dropped count=3'));
        assert.ok(!logs.join('\n').includes('"site"'));
      } finally {
        rimraf(bag.dir);
      }
    });

    await test('newer schemaVersion is read-only and is not quarantined', async () => {
      const bag = tempCore();
      const logs = [];
      try {
        const file = path.join(bag.dir, 'data', 'marust', 'state.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const body = JSON.stringify({
          schemaVersion: 2,
          destinations: [{ id: 'keep', enabled: true, desired: { title: 'T', category: '', live: false }, actual: { title: 'T', category: '', siteLive: false }, note: 'SECRET_BODY' }],
          session: null
        });
        fs.writeFileSync(file, body);
        const store = createStateStore({
          core: bag.core,
          logger: (level, message) => logs.push(level + ':' + message)
        });
        assert.strictEqual(store.isReadOnly(), true);
        assert.ok(store.warning().includes('読み取り専用'));
        assert.strictEqual(store.snapshot().schemaVersion, 2);
        assert.strictEqual(store.snapshot().destinations[0].id, 'keep');
        assert.strictEqual(store.putDestination({ id: 'x', enabled: true }).reason, 'read-only');
        assert.strictEqual(store.updateActual('keep', { title: 'nope' }).reason, 'read-only');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), body);
        const names = fs.readdirSync(path.dirname(file));
        assert.ok(!names.some((name) => name.indexOf('broken') !== -1));
        assert.ok(logs.some((line) => line === 'warn:state schema newer count=1'));
        assert.ok(!logs.join('\n').includes('SECRET_BODY'));
      } finally {
        rimraf(bag.dir);
      }
    });

  } finally {
    cleanup();
  }

  if (failed) {
    console.error('[marust] state-store tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] state-store tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
