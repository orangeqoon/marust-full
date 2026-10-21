'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSlotNiconico } = require('../slot');

const SESSION = 'test_user_session_123456';
const LIVE_ID = 'lv999999999';
const NOW = 1700000000000;

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-nico-test-'));
  const calls = [];
  const events = [];

  const mockFetch = async (url, init) => {
    const u = new URL(url);
    const method = String((init && init.method) || 'GET').toUpperCase();
    const headers = init && init.headers ? init.headers : {};
    const body = init && init.body ? init.body : null;
    calls.push({ method, url, path: u.pathname, headers, body });

    if (u.pathname === '/unama/api/v2/programs/latest') {
      return {
        status: 200,
        text: async () => JSON.stringify({ data: { id: LIVE_ID, status: 'on_air', title: 'テスト番組' } })
      };
    }
    if (u.pathname === '/unama/api/v2/programs/' + LIVE_ID) {
      return {
        status: 200,
        text: async () => JSON.stringify({ data: { id: LIVE_ID, status: 'on_air', onAirSchedule: { beginTime: new Date(NOW - 60000).toISOString(), endTime: new Date(NOW + 1800000).toISOString() } } })
      };
    }
    if (u.pathname === '/watch/' + LIVE_ID) {
      return {
        status: 200,
        text: async () => '<html><div data-props="{&quot;site&quot;:{&quot;relive&quot;:{&quot;csrfToken&quot;:&quot;mock_csrf_token_abc&quot;}}}"></div></html>'
      };
    }
    if (u.pathname === '/unama/api/v3/programs/' + LIVE_ID + '/segment') {
      return {
        status: 200,
        text: async () => JSON.stringify({ meta: { status: 200 } })
      };
    }
    if (u.pathname.startsWith('/v1/my/cpp/creations/')) {
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true })
      };
    }
    return { status: 404, text: async () => 'not found' };
  };

  const secrets = {
    get: async (name) => {
      if (name === 'cookies.niconico-main') {
        return { ok: true, value: JSON.stringify({ cookies: { user_session: SESSION } }) };
      }
      return { ok: false };
    }
  };

  const bus = {
    publish: (name, payload) => events.push({ name, payload })
  };

  const ctx = {
    dataDir: dir,
    mode: () => 'live',
    secrets,
    bus,
    events: { NAMES: { SITE_TROUBLE: 'site.trouble', SLOT_ACQUIRED: 'slot.acquired' } },
    logger: () => {}
  };

  return { dir, calls, events, mockFetch, ctx };
}

async function runTests() {
  console.log('Testing niconico slot auto-close and endBroadcast...');

  // Test 1: endBroadcast dryRun
  {
    const f = makeFixture();
    const slot = createSlotNiconico({ fetch: f.mockFetch, now: () => NOW });
    slot.load(f.ctx);
    const res = await slot.endBroadcast({}, { dryRun: true });
    assert.deepStrictEqual(res, { ok: true, dryRun: true }, 'dryRun should return ok and dryRun: true');
    assert.strictEqual(f.calls.length, 0, 'dryRun should not make any HTTP calls');
    slot.destroy();
    fs.rmSync(f.dir, { recursive: true, force: true });
    console.log('ok 1 - endBroadcast dryRun makes no calls');
  }

  // Test 2: endBroadcast live
  {
    const f = makeFixture();
    const slot = createSlotNiconico({ fetch: f.mockFetch, now: () => NOW });
    slot.load(f.ctx);
    const res = await slot.endBroadcast({}, {});
    if (!res.ok) console.log('DEBUG res:', res, 'calls:', f.calls.map(c => [c.method, c.path]));
    assert.strictEqual(res.ok, true, 'live endBroadcast should succeed');
    assert.strictEqual(res.liveId, LIVE_ID, 'liveId should match');
    assert.ok(f.calls.some((c) => c.method === 'PUT' && c.path.includes('/segment')), 'PUT /segment state=end called');
    slot.destroy();
    fs.rmSync(f.dir, { recursive: true, force: true });
    console.log('ok 2 - endBroadcast live ends program');
  }

  // Test 3: autoCloseOnObsStop and autoCloseDelaySec defaults and setConfig
  {
    const f = makeFixture();
    const slot = createSlotNiconico({ fetch: f.mockFetch, now: () => NOW });
    slot.load(f.ctx);
    const s1 = await slot.actions.getStatus({}, f.ctx);
    assert.strictEqual(s1.config.autoCloseOnObsStop, true, 'default autoCloseOnObsStop is true');
    assert.strictEqual(s1.config.autoCloseMin, 1, 'default autoCloseMin is 1');
    assert.strictEqual(s1.config.autoCloseDelaySec, 60, 'default autoCloseDelaySec is 60');

    const s2 = slot.actions.setConfig({ autoCloseOnObsStop: false, autoCloseDelaySec: 30 }, f.ctx);
    assert.strictEqual(s2.ok, true);
    assert.strictEqual(s2.config.autoCloseOnObsStop, false);
    assert.strictEqual(s2.config.autoCloseDelaySec, 30);
    slot.destroy();
    fs.rmSync(f.dir, { recursive: true, force: true });
    console.log('ok 3 - slot config handles autoClose options');
  }

  // Test 4: obs-stop schedules auto-close when autoCloseDelaySec is 60, or immediate when 0
  {
    const f = makeFixture();
    const slot = createSlotNiconico({ fetch: f.mockFetch, now: () => NOW });
    slot.load(f.ctx);
    // Scheduled when delay > 0
    const sched = await slot.onObsEvent('obs-stop', {});
    assert.deepStrictEqual(sched, { scheduled: true, delaySec: 60 });

    // Immediate when delay is 0
    slot.actions.setConfig({ autoCloseDelaySec: 0 }, f.ctx);
    const res = await slot.onObsEvent('obs-stop', {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.liveId, LIVE_ID);
    assert.ok(f.calls.some((c) => c.method === 'PUT' && c.path.includes('/segment')), 'obs-stop triggered program end');
    slot.destroy();
    fs.rmSync(f.dir, { recursive: true, force: true });
    console.log('ok 4 - obs-stop triggers program end (immediate or scheduled)');
  }

  // Test 5: obs-stop does not trigger when autoCloseOnObsStop is false
  {
    const f = makeFixture();
    const slot = createSlotNiconico({ fetch: f.mockFetch, now: () => NOW });
    slot.load(f.ctx);
    slot.actions.setConfig({ autoCloseOnObsStop: false }, f.ctx);
    await slot.onObsEvent('obs-stop', {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(f.calls.length, 0, 'no calls made when autoCloseOnObsStop is false');
    slot.destroy();
    fs.rmSync(f.dir, { recursive: true, force: true });
    console.log('ok 5 - obs-stop respects autoCloseOnObsStop: false');
  }

  // Test 6: onEvent broadcast.stopped triggers auto close
  {
    const f = makeFixture();
    const slot = createSlotNiconico({ fetch: f.mockFetch, now: () => NOW });
    slot.load(f.ctx);
    slot.actions.setConfig({ autoCloseDelaySec: 0 }, f.ctx);
    const res = await slot.onEvent('broadcast.stopped', {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.liveId, LIVE_ID);
    assert.ok(f.calls.some((c) => c.method === 'PUT' && c.path.includes('/segment')), 'broadcast.stopped triggered program end');
    slot.destroy();
    fs.rmSync(f.dir, { recursive: true, force: true });
    console.log('ok 6 - onEvent broadcast.stopped triggers program end');
  }

  // Test 7: obs-start cancels pending auto-close timer
  {
    const f = makeFixture();
    const slot = createSlotNiconico({ fetch: f.mockFetch, now: () => NOW });
    slot.load(f.ctx);
    // Trigger obs-stop (scheduled for 60s)
    const sched = await slot.onObsEvent('obs-stop', {});
    assert.deepStrictEqual(sched, { scheduled: true, delaySec: 60 });

    // Now OBS resumes (obs-start event)
    const cancelRes = await slot.onObsEvent('obs-start', {});
    assert.deepStrictEqual(cancelRes, { cancelled: true });

    slot.destroy();
    fs.rmSync(f.dir, { recursive: true, force: true });
    console.log('ok 7 - obs-start cancels pending auto-close timer');
  }

  console.log('All niconico auto-close tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
