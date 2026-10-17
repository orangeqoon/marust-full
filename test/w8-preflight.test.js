'use strict';

const assert = require('assert');
const { createPreflight } = require('../host/core/engine/preflight');

const LEAK = 'SECRET-VALUE-SHOULD-NOT-LEAK';

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

function has(result, code) {
  return result.items.some(function (row) { return row.code === code; });
}

function item(result, code) {
  return result.items.find(function (row) { return row.code === code; });
}

function assertShape(result) {
  assert.strictEqual(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.items));
  const expectOk = !result.items.some(function (row) { return row.level === 'error'; });
  assert.strictEqual(result.ok, expectOk);
  for (let i = 0; i < result.items.length; i += 1) {
    const row = result.items[i];
    assert.strictEqual(typeof row.id, 'string');
    assert.ok(row.id.length > 0);
    assert.ok(row.level === 'ok' || row.level === 'warn' || row.level === 'error');
    assert.strictEqual(typeof row.code, 'string');
    assert.strictEqual(typeof row.message, 'string');
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'value'));
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'secret'));
    if (row.destinationId != null) assert.strictEqual(typeof row.destinationId, 'string');
  }
  assert.strictEqual(JSON.stringify(result).indexOf(LEAK), -1);
}

function world() {
  const calls = { get: 0, describe: 0, configured: 0 };
  const dest = {
    id: 'youtube-main',
    site: 'youtube',
    accountId: 'youtube-main',
    engine: { id: 'obs-local', targetId: 'yt-1' },
    enabled: true,
  };
  const bag = {
    calls: calls,
    destinations: [dest],
    engine: {
      id: 'obs-local',
      modeId: 'obs-engine',
      status: function () {
        return { connected: true, supported: true, mode: 'live', profileWarning: false, missing: [] };
      },
      listTargets: function () {
        return [{ id: 'yt-1', state: 'stopped' }];
      }
    },
    site: {
      id: 'youtube',
      status: 'running',
      manifest: { kind: 'site', provides: ['stream.site@1'], secrets: [] },
      instance: {
        isConfigured: function () {
          calls.configured += 1;
          return true;
        }
      }
    },
    slots: [],
    modes: { broadcast: 'live', 'obs-engine': 'live' }
  };
  bag.engines = {
    get: function (id) { return id === 'obs-local' ? bag.engine : null; },
    list: function () { return ['obs-local']; }
  };
  bag.secrets = {
    describe: function (name) {
      calls.describe += 1;
      return Promise.resolve({
        ok: true,
        value: LEAK,
        secret: { name: name, updatedAt: '', size: 3, expiresAt: null, value: LEAK }
      });
    },
    get: function () {
      calls.get += 1;
      return Promise.resolve({ ok: true, value: LEAK });
    }
  };
  bag.store = {
    snapshot: function () { return { destinations: bag.destinations }; }
  };
  bag.registry = {
    getRunning: function () {
      const rows = [];
      if (bag.site && bag.site.status === 'running' && bag.site.instance) rows.push(bag.site);
      for (let i = 0; i < bag.slots.length; i += 1) {
        const row = bag.slots[i];
        if (row && row.status === 'running' && row.instance) rows.push(row);
      }
      return rows;
    },
    snapshot: function () {
      const rows = [];
      if (bag.site) rows.push(bag.site);
      for (let i = 0; i < bag.slots.length; i += 1) rows.push(bag.slots[i]);
      return rows;
    }
  };
  bag.orchestrator = {
    modeFor: function (id) {
      if (Object.prototype.hasOwnProperty.call(bag.modes, id)) return bag.modes[id];
      return 'live';
    }
  };
  return bag;
}

function preflight(bag, opts) {
  return createPreflight(Object.assign({
    registry: bag.registry,
    engines: bag.engines,
    store: bag.store,
    secrets: bag.secrets,
    orchestrator: bag.orchestrator
  }, opts || {}));
}

async function runOf(bag, ids, opts) {
  const result = await preflight(bag, opts).run(ids);
  assertShape(result);
  assert.strictEqual(bag.calls.get, 0);
  return result;
}

function rumble(bag) {
  bag.destinations[0].id = 'rumble-main';
  bag.destinations[0].site = 'rumble';
  bag.destinations[0].accountId = 'rumble-main';
  bag.destinations[0].engine = { id: 'obs-local', targetId: 'rb-1' };
  bag.engine.listTargets = function () { return [{ id: 'rb-1', state: 'stopped' }]; };
  bag.site = {
    id: 'rumble',
    status: 'running',
    manifest: { kind: 'site', provides: ['stream.site@1'], secrets: [] },
    instance: {
      isConfigured: function () {
        bag.calls.configured += 1;
        return true;
      }
    }
  };
}

function slotRow(status, instance) {
  return {
    id: 'rumble-slot',
    status: status,
    manifest: {
      provides: ['stream.slot@1'],
      slotFor: ['rumble'],
      secrets: ['rumble.livestream-api', 'cookies.rumble-main']
    },
    instance: instance
  };
}

async function main() {
  await test('healthy-is-ok', async function () {
    const bag = world();
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.items.length, 0);
    assert.strictEqual(bag.calls.describe, 0);
    assert.strictEqual(bag.calls.get, 0);
    assert.strictEqual(bag.calls.configured, 1);
  });

  await test('engine-disconnected', async function () {
    const down = world();
    down.engine.status = function () {
      return { connected: false, supported: false, mode: 'live', profileWarning: false, missing: ['list_capabilities'] };
    };
    const closed = await runOf(down, ['youtube-main']);
    assert.strictEqual(item(closed, 'engine-disconnected').level, 'error');
    assert.strictEqual(item(closed, 'engine-disconnected').scope, 'global');
    assert.strictEqual(item(closed, 'engine-disconnected').destinationId, undefined);
    assert.ok(!has(closed, 'engine-unsupported'));
    assert.strictEqual(closed.ok, false);

    const missing = world();
    missing.destinations[0].engine = { id: 'cloud', targetId: 'c1' };
    const absent = await runOf(missing, ['youtube-main']);
    assert.ok(has(absent, 'engine-disconnected'));
    assert.ok(!has(absent, 'engine-unsupported'));
    assert.ok(!has(absent, 'target-missing'));
  });

  await test('engine-unsupported', async function () {
    const bag = world();
    bag.engine.status = function () {
      return { connected: true, supported: false, mode: 'live', profileWarning: false, missing: ['list_capabilities'] };
    };
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(item(result, 'engine-unsupported').level, 'error');
    assert.ok(!has(result, 'engine-disconnected'));
    assert.strictEqual(result.ok, false);
  });

  await test('engine-read-only', async function () {
    const shadow = world();
    shadow.engine.status = function () {
      return { connected: true, supported: true, mode: 'shadow', profileWarning: false, missing: [] };
    };
    const fromStatus = await runOf(shadow, ['youtube-main']);
    assert.strictEqual(fromStatus.ok, true);
    assert.strictEqual(item(fromStatus, 'engine-read-only').level, 'warn');
    assert.ok(item(fromStatus, 'engine-read-only').message.indexOf('shadow') !== -1);
    assert.ok(item(fromStatus, 'engine-read-only').message.indexOf('書き込まれません') !== -1);

    const legacy = world();
    legacy.engine.status = function () {
      return { connected: true, supported: true, profileWarning: false, missing: [] };
    };
    legacy.modes['obs-engine'] = 'legacy';
    const fromMode = await runOf(legacy, ['youtube-main']);
    assert.strictEqual(fromMode.ok, true);
    assert.ok(item(fromMode, 'engine-read-only').message.indexOf('legacy') !== -1);
  });

  await test('destination-unknown', async function () {
    const bag = world();
    const result = await runOf(bag, ['no-such-dest']);
    assert.strictEqual(item(result, 'destination-unknown').level, 'error');
    assert.strictEqual(item(result, 'destination-unknown').destinationId, 'no-such-dest');
    assert.ok(!has(result, 'engine-disconnected'));
    assert.strictEqual(result.ok, false);
  });

  await test('destination-disabled', async function () {
    const bag = world();
    bag.destinations[0].enabled = false;
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(item(result, 'destination-disabled').level, 'error');
    assert.ok(!has(result, 'destination-unknown'));
    assert.ok(!has(result, 'engine-disconnected'));
    assert.strictEqual(result.ok, false);
  });

  await test('destination-unlinked', async function () {
    const bare = world();
    bare.destinations[0].engine = null;
    const noEngine = await runOf(bare, ['youtube-main']);
    assert.strictEqual(item(noEngine, 'destination-unlinked').level, 'error');
    assert.ok(!has(noEngine, 'engine-disconnected'));
    assert.ok(!has(noEngine, 'target-missing'));

    const half = world();
    half.destinations[0].engine = { id: 'obs-local', targetId: '' };
    const noTarget = await runOf(half, ['youtube-main']);
    assert.ok(has(noTarget, 'destination-unlinked'));
    assert.ok(!has(noTarget, 'target-missing'));
    assert.ok(!has(noTarget, 'engine-disconnected'));
  });

  await test('target-missing', async function () {
    const bag = world();
    bag.engine.listTargets = function () { return [{ id: 'other', state: 'stopped' }]; };
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(item(result, 'target-missing').level, 'error');
    assert.ok(!has(result, 'target-already-live'));
    assert.ok(!has(result, 'obs-profile-warning'));
    assert.strictEqual(result.ok, false);
  });

  await test('target-already-live', async function () {
    const bag = world();
    bag.engine.listTargets = function () { return [{ id: 'yt-1', state: 'live' }]; };
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(item(result, 'target-already-live').level, 'warn');
    assert.strictEqual(item(result, 'target-already-live').destinationId, 'youtube-main');
    assert.ok(has(result, 'obs-profile-warning'));
    assert.strictEqual(result.ok, true);
  });

  await test('site-not-configured', async function () {
    const unset = world();
    unset.site.instance.isConfigured = function () {
      unset.calls.configured += 1;
      return false;
    };
    const falsy = await runOf(unset, ['youtube-main']);
    assert.strictEqual(item(falsy, 'site-not-configured').level, 'warn');
    assert.ok(item(falsy, 'site-not-configured').message.indexOf('未設定') !== -1);
    assert.strictEqual(falsy.ok, true);

    const down = world();
    down.site.status = 'accepted';
    down.site.instance = null;
    const stopped = await runOf(down, ['youtube-main']);
    assert.strictEqual(item(stopped, 'site-not-configured').level, 'warn');
    assert.ok(item(stopped, 'site-not-configured').message.indexOf('起動していない') !== -1);
  });

  await test('obs-profile-warning', async function () {
    const bag = world();
    bag.engine.listTargets = function () { return [{ id: 'yt-1', state: 'connecting' }]; };
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(item(result, 'obs-profile-warning').level, 'warn');
    assert.ok(item(result, 'obs-profile-warning').message.indexOf('プロファイル') !== -1);
    assert.ok(!has(result, 'target-already-live'));
    assert.ok(!Object.prototype.hasOwnProperty.call(item(result, 'obs-profile-warning'), 'destinationId'));
    assert.strictEqual(result.ok, true);

    const flagged = world();
    flagged.engine.status = function () {
      return { connected: true, supported: true, mode: 'live', profileWarning: true, missing: [] };
    };
    const fromFlag = await runOf(flagged, ['youtube-main']);
    assert.ok(has(fromFlag, 'obs-profile-warning'));
    assert.ok(!has(fromFlag, 'target-already-live'));
  });

  await test('broadcast-mode-legacy', async function () {
    const bag = world();
    bag.modes.broadcast = 'legacy';
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(item(result, 'broadcast-mode').level, 'warn');
    assert.ok(item(result, 'broadcast-mode').message.indexOf('何もしません') !== -1);
    assert.ok(!Object.prototype.hasOwnProperty.call(item(result, 'broadcast-mode'), 'destinationId'));
  });

  await test('broadcast-mode-shadow', async function () {
    const bag = world();
    bag.modes.broadcast = 'shadow';
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(result.ok, true);
    assert.ok(item(result, 'broadcast-mode').message.indexOf('記録だけ') !== -1);
    assert.ok(!has(result, 'engine-disconnected'));
  });

  await test('check-throw-isolates', async function () {
    const bag = world();
    bag.engine.listTargets = function () { throw new Error('cookie=' + LEAK); };
    bag.site.instance.isConfigured = function () {
      bag.calls.configured += 1;
      return false;
    };
    const result = await runOf(bag, ['youtube-main']);
    assert.ok(has(result, 'preflight-check-failed'));
    assert.strictEqual(item(result, 'preflight-check-failed').level, 'warn');
    assert.ok(has(result, 'site-not-configured'));
    assert.ok(!has(result, 'engine-disconnected'));
    assert.ok(!has(result, 'engine-unsupported'));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(bag.calls.configured, 1);

    const thrown = world();
    thrown.site.instance.isConfigured = function () {
      throw new Error('authorization=' + LEAK);
    };
    const failedCheck = await runOf(thrown, ['youtube-main']);
    assert.ok(has(failedCheck, 'preflight-check-failed'));
    assert.ok(!has(failedCheck, 'site-not-configured'));
    assert.strictEqual(failedCheck.ok, true);
  });

  await test('isConfigured-timeout', async function () {
    const bag = world();
    bag.site.instance.isConfigured = function () { return new Promise(function () {}); };
    const started = Date.now();
    const result = await runOf(bag, ['youtube-main'], { callTimeoutMs: 40, budgetMs: 5000 });
    const took = Date.now() - started;
    assert.ok(took < 1000, 'took ' + took);
    assert.strictEqual(item(result, 'site-not-configured').level, 'warn');
    assert.ok(item(result, 'site-not-configured').message.indexOf('時間内') !== -1);
    assert.strictEqual(result.ok, true);
  });

  await test('budget-returns-quickly', async function () {
    const bag = world();
    bag.engine.status = function () { return new Promise(function () {}); };
    bag.site.instance.isConfigured = function () {
      bag.calls.configured += 1;
      return true;
    };
    const started = Date.now();
    const result = await runOf(bag, ['youtube-main'], { budgetMs: 60, callTimeoutMs: 8000 });
    const took = Date.now() - started;
    assert.ok(took < 1000, 'took ' + took);
    assert.ok(has(result, 'preflight-check-failed'));
    assert.ok(item(result, 'preflight-check-failed').message.indexOf('時間内') !== -1);
    assert.strictEqual(bag.calls.configured, 0);
    assert.strictEqual(bag.calls.get, 0);
  });

  await test('fake-clock-skips-slow-check', async function () {
    let clock = 0;
    const bag = world();
    bag.engine.status = function () {
      clock += 6000;
      return { connected: true, supported: true, mode: 'live', profileWarning: false, missing: [] };
    };
    bag.site.instance.isConfigured = function () {
      bag.calls.configured += 1;
      return new Promise(function () {});
    };
    const started = Date.now();
    const result = await runOf(bag, ['youtube-main'], { now: function () { return clock; }, budgetMs: 5000 });
    assert.ok(Date.now() - started < 500, 'took ' + (Date.now() - started));
    assert.strictEqual(bag.calls.configured, 0);
    assert.ok(has(result, 'preflight-check-failed'));
    assert.strictEqual(bag.calls.get, 0);
  });

  await test('one-destination-does-not-hide-another', async function () {
    const bag = world();
    bag.destinations.push({
      id: 'twitch-main',
      site: 'twitch',
      enabled: true,
     
      engine: { id: 'obs-local', targetId: 'missing-target' }
    });
    const result = await runOf(bag, ['nope', 'youtube-main', 'twitch-main']);
    assert.strictEqual(item(result, 'destination-unknown').destinationId, 'nope');
    assert.ok(result.items.some(function (row) {
      return row.code === 'target-missing' && row.destinationId === 'twitch-main';
    }));
    assert.ok(!result.items.some(function (row) {
      return row.destinationId === 'youtube-main' && row.level === 'error';
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(bag.calls.configured >= 1, true);
  });

  await test('static-skips-slot', async function () {
    const bag = world();
    const result = await runOf(bag, ['youtube-main']);
    assert.strictEqual(result.ok, true);
    assert.ok(!has(result, 'slot-provider-missing'));
    assert.strictEqual(bag.calls.describe, 0);
  });

  await test('run-without-ids-uses-store', async function () {
    const bag = world();
    bag.destinations.push({
      id: 'twitch-main',
      site: 'twitch',
      enabled: false,
     
      engine: { id: 'obs-local', targetId: 'tw-1' }
    });
    bag.engine.listTargets = function () {
      return [{ id: 'yt-1', state: 'stopped' }, { id: 'tw-1', state: 'stopped' }];
    };
    const result = await runOf(bag);
    assert.strictEqual(item(result, 'destination-disabled').destinationId, 'twitch-main');
    assert.ok(!result.items.some(function (row) {
      return row.code === 'destination-disabled' && row.destinationId === 'youtube-main';
    }));
    assert.strictEqual(result.ok, false);
  });

  await test('default-registry-shape', async function () {
    const bag = world();
    const result = await createPreflight({
      registry: bag.registry,
      engines: { registry: bag.engines, engine: bag.engine },
      store: bag.store,
      secrets: bag.secrets,
      orchestrator: bag.orchestrator
    }).run(['youtube-main']);
    assertShape(result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(bag.calls.get, 0);
  });

  await test('missing-deps-do-not-throw', async function () {
    const result = await createPreflight().run(['youtube-main']);
    assertShape(result);
    assert.strictEqual(result.ok, false);
    assert.ok(has(result, 'destination-unknown'));
    assert.ok(item(result, 'broadcast-mode').message.indexOf('何もしません') !== -1);
  });

  if (failed) {
    console.error('[marust] w8 preflight tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] w8 preflight tests passed');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
