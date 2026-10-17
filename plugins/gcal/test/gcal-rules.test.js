'use strict';

const M = require('../../../_marust');
const { k2 } = require(M.at('test/_k2-ctx'));

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createGcal } = require(path.join(__dirname, '..', '..', 'gcal'));

const T0 = '2026-10-04T01:00:00.000Z';
const MIN = 60 * 1000;
const ROOT = M.root; // 丸スト本体
const COMMUNITY = path.join(__dirname, '..', '..'); // みんなのプラグインの plugins/

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

function plus(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function shadowLines(dir) {
  const names = fs.readdirSync(dir).filter((name) => name.indexOf('shadow-') === 0);
  const lines = [];
  for (let i = 0; i < names.length; i += 1) {
    const text = fs.readFileSync(path.join(dir, names[i]), 'utf8').trim();
    if (!text) continue;
    const rows = text.split('\n');
    for (let j = 0; j < rows.length; j += 1) lines.push(JSON.parse(rows[j]));
  }
  return lines;
}

function assertNoSecrets(dir) {
  const banned = ['access-TEST', 'access-NEW', 'refresh-TEST', 'secret-TEST', 'client-TEST'];
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (let i = 0; i < entries.length; i += 1) {
    const file = path.join(dir, entries[i]);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (let j = 0; j < banned.length; j += 1) {
      assert.strictEqual(text.indexOf(banned[j]), -1, entries[i] + ' leaked ' + banned[j]);
    }
  }
}

function createGoogle() {
  const events = new Map();
  const calls = [];
  let seq = 1;
  let failInserts = 0;
  let hold = null;
  let holding = false;
  let conflictOnce = false;

  function resp(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      async json() { return body; }
    };
  }

  async function fetch(url, init) {
    const method = init && init.method ? init.method : 'GET';
    const headers = init && init.headers ? init.headers : {};
    calls.push({ url: String(url), method: method, body: init && init.body, headers: headers });
    const u = new URL(String(url));
    if (u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token') {
      return resp(200, { access_token: 'access-NEW', expires_in: 3600 });
    }
    if (u.origin !== 'https://www.googleapis.com') {
      throw Object.assign(new Error('blocked'), { code: 'bad-url' });
    }
    const match = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!match) throw Object.assign(new Error('blocked'), { code: 'bad-url' });
    const eventId = match[2] ? decodeURIComponent(match[2]) : '';
    if (!eventId && method === 'POST') {
      if (hold) {
        const gate = hold;
        hold = null;
        holding = true;
        await gate;
        holding = false;
      }
      if (failInserts > 0) {
        failInserts -= 1;
        return resp(503, {});
      }
      const body = JSON.parse(init.body);
      if (conflictOnce) {
        conflictOnce = false;
        return resp(409, {});
      }
      const id = 'evt-' + seq;
      seq += 1;
      events.set(id, body);
      return resp(200, { id: id });
    }
    const current = events.get(eventId);
    if (!current) return resp(404, {});
    if (method === 'GET') return resp(200, Object.assign({ id: eventId }, JSON.parse(JSON.stringify(current))));
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      if (body.end) current.end = body.end;
      if (body.summary) current.summary = body.summary;
      if (body.description) current.description = body.description;
      if (body.extendedProperties) current.extendedProperties = body.extendedProperties;
      return resp(200, Object.assign({ id: eventId }, JSON.parse(JSON.stringify(current))));
    }
    throw Object.assign(new Error('blocked'), { code: 'bad-url' });
  }

  return {
    fetch: fetch,
    calls: calls,
    events: events,
    holdInsert(promise) { hold = promise; },
    failInserts(n) { failInserts = n; },
    conflictOnce() { conflictOnce = true; },
    isHolding() { return holding; }
  };
}

function createClock() {
  let now = Date.parse(T0);
  const delays = [];
  const timers = [];
  return {
    delays: delays,
    now: function () { return new Date(now); },
    setNow: function (ms) { now = ms; },
    setTimeout: function (fn, ms) {
      const id = { fn: fn, ms: ms };
      timers.push(id);
      delays.push(ms);
      return id;
    },
    clearTimeout: function (id) {
      const index = timers.indexOf(id);
      if (index >= 0) timers.splice(index, 1);
    }
  };
}

function secretValue(clock, extra) {
  const expiry = extra && Object.prototype.hasOwnProperty.call(extra, 'expiry_date')
    ? extra.expiry_date
    : clock.now().getTime() + 3600 * 1000;
  return JSON.stringify({
    access_token: 'access-TEST',
    refresh_token: 'refresh-TEST',
    expiry_date: expiry,
    client_id: 'client-TEST',
    client_secret: 'secret-TEST'
  });
}

function boot(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-gcal-'));
  const modeBox = { mode: opts.mode || 'live' };
  const clock = opts.clock || createClock();
  const google = opts.google || createGoogle();
  const secretBox = { mode: opts.secret || 'ok', expiry: opts.expiry };
  if (opts.config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(opts.config));
  const plugin = createGcal({
    fetch: google.fetch,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const ctx = {
    id: 'gcal',
    pluginDir: path.join(COMMUNITY, 'gcal'),
    manifest: {},
    dataDir: dir, ...k2(dir),
    core: {},
    logger: function () {},
    emit: function () {},
    mode: function () { return modeBox.mode; },
    bus: {
      publish: function () { return 0; },
      subscribe: function () { return function () {}; }
    },
    sessions: {
      view: function () { return { active: false, title: '', state: 'none', elapsedMs: 0 }; }
    },
    secrets: {
      get: async function () {
        if (secretBox.mode === 'unavailable') return { ok: false, error: 'unavailable' };
        if (secretBox.mode === 'bad') return { ok: true, value: 'not-json' };
        return { ok: true, value: secretValue(clock, { expiry_date: secretBox.expiry }) };
      }
    },
    overlay: { publish: function () { return { ok: false, error: 'unknown-overlay' }; } }
  };
  return { dir: dir, plugin: plugin, ctx: ctx, modeBox: modeBox, clock: clock, google: google, secretBox: secretBox };
}

function meta(at) {
  return {
    id: 'm-1',
    version: 1,
    occurredAt: at,
    source: 'session',
    correlationId: '',
    pluginId: 'gcal'
  };
}

function session(over) {
  const row = Object.assign({
    id: 's-1',
    title: '丸スト',
    category: '',
    plannedSec: 3600,
    source: 'timer',
    state: 'running',
    startedAt: T0,
    endedAt: null,
    lastAliveAt: T0,
    segments: [{ startedAt: T0 }],
    recovered: false
  }, over || {});
  return row;
}

async function until(fn) {
  for (let i = 0; i < 50; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting');
}

function posts(google) {
  return google.calls.filter((call) => call.method === 'POST' && call.url.indexOf('/events') !== -1);
}

function patches(google) {
  return google.calls.filter((call) => call.method === 'PATCH');
}

function bodyOf(call) {
  return JSON.parse(call.body);
}

async function main() {
  await test('manifest v2 declares recorder, panel, secrets, and timeouts', async () => {
    const manifest = readJson(path.join(COMMUNITY, 'gcal', 'manifest.json'));
    const schema = path.join(COMMUNITY, 'gcal', manifest.configSchema);
    assert.strictEqual(manifest.id, 'gcal');
    assert.strictEqual(manifest.manifestVersion, 2);
    assert.strictEqual(manifest.runtime, 'inproc');
    assert.strictEqual(manifest.defaultMode, 'legacy');
    assert.deepStrictEqual(manifest.provides, ['session.recorder@1', 'ui.panel@1']);
    assert.deepStrictEqual(manifest.subscribes, ['session.*']);
    assert.deepStrictEqual(manifest.secrets, ['google.oauth']);
    assert.strictEqual(manifest.timeouts.onEvent, 15000);
    assert.strictEqual(manifest.actions.getStatus, 'read');
    assert.strictEqual(manifest.actions.flushQueue, 'write');
    assert.strictEqual(manifest.panels.length, 1);
    assert.strictEqual(manifest.panels[0].file, 'ui/panel.html');
    assert.ok(fs.existsSync(schema));
    const html = fs.readFileSync(path.join(COMMUNITY, 'gcal', 'ui', 'panel.html'), 'utf8');
    assert.ok(html.indexOf('src="panel.js"') !== -1);
    assert.ok(html.indexOf('href="panel.css"') !== -1);
    assert.strictEqual(/<script(?![^>]*\bsrc=)/.test(html), false);
    assert.strictEqual(html.indexOf('onclick='), -1);
    const panelJs = fs.readFileSync(path.join(COMMUNITY, 'gcal', 'ui', 'panel.js'), 'utf8');
    assert.ok(panelJs.indexOf('plugin.gcal.getStatus') !== -1);
    assert.ok(panelJs.indexOf('plugin.gcal.flushQueue') !== -1);
    const src = fs.readFileSync(path.join(COMMUNITY, 'gcal', 'index.js'), 'utf8');
    assert.strictEqual(src.indexOf("require('googleapis')"), -1);
    assert.strictEqual(src.indexOf('require("googleapis")'), -1);
    assert.strictEqual(src.indexOf("require('http')"), -1);
    assert.strictEqual(src.indexOf("require('https')"), -1);
  });

  await test('C1 C2 C7 empty title, planned seconds, primary calendar, and fixed description', async () => {
    const bag = boot({ mode: 'live' });
    try {
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({
        title: '',
        plannedSec: 90,
        startedAt: T0
      }), meta(T0));
      const created = posts(bag.google);
      assert.strictEqual(created.length, 1);
      assert.ok(created[0].url.indexOf('/calendars/primary/events') !== -1);
      assert.strictEqual(created[0].headers.Authorization, 'Bearer access-TEST');
      const body = bodyOf(created[0]);
      assert.strictEqual(body.summary, '丸スト');
      assert.strictEqual(body.description, 'Recorded by NeonTimer Compact');
      assert.strictEqual(body.start.dateTime, T0);
      assert.strictEqual(body.end.dateTime, plus(T0, 90 * 1000));
      assert.strictEqual(body.extendedProperties.private.marust, '1');
      assert.strictEqual(body.extendedProperties.private.sessionId, 's-1');
      assert.strictEqual(bag.google.calls.some((call) => call.url.indexOf('oauth2.googleapis.com') !== -1), false);
      assertNoSecrets(bag.dir);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('C2 countup uses provisionalCountupSeconds when plannedSec is absent', async () => {
    const bag = boot({ mode: 'live' });
    try {
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({
        title: '配信',
        plannedSec: null,
        startedAt: T0
      }), meta(T0));
      const body = bodyOf(posts(bag.google)[0]);
      assert.strictEqual(body.summary, '配信');
      assert.strictEqual(Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime), 3600 * 1000);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('C3 pause and end finalize at that time and a later end does not stretch a pause', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const pauseAt = plus(T0, 2 * MIN);
      const endAt = plus(T0, 10 * MIN);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 3600 }), meta(T0));
      await bag.plugin.onEvent('session.paused', session({
        state: 'paused',
        startedAt: T0,
        segments: [{ startedAt: T0, endedAt: pauseAt }]
      }), meta(pauseAt));
      const id = Array.from(bag.google.events.keys())[0];
      assert.strictEqual(bag.google.events.get(id).end.dateTime, pauseAt);
      assert.strictEqual(patches(bag.google).length, 1);
      await bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      assert.strictEqual(patches(bag.google).length, 1);
      assert.strictEqual(bag.google.events.get(id).end.dateTime, pauseAt);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('C3 minimum length is 60 seconds', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endAt = plus(T0, 10 * 1000);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 3600 }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      const id = Array.from(bag.google.events.keys())[0];
      assert.strictEqual(bag.google.events.get(id).end.dateTime, plus(T0, 60 * 1000));
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('C4 D6 same title merges at exactly 10 minutes', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endAt = plus(T0, 2 * MIN);
      const again = plus(endAt, 10 * MIN);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 3600 }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      const id = Array.from(bag.google.events.keys())[0];
      await bag.plugin.onEvent('session.started', session({
        id: 's-2',
        startedAt: again,
        plannedSec: 1800
      }), meta(again));
      assert.strictEqual(posts(bag.google).length, 1);
      assert.strictEqual(bag.google.events.size, 1);
      assert.strictEqual(bag.google.events.get(id).end.dateTime, plus(again, 1800 * 1000));
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('D6 a different title inside the gap is a new event', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endAt = plus(T0, 2 * MIN);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 3600 }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      const firstId = Array.from(bag.google.events.keys())[0];
      const frozen = bag.google.events.get(firstId).end.dateTime;
      await bag.plugin.onEvent('session.started', session({
        id: 's-2',
        title: '別の仕事',
        startedAt: plus(endAt, MIN),
        plannedSec: 600
      }), meta(plus(endAt, MIN)));
      assert.strictEqual(bag.google.events.size, 2);
      assert.strictEqual(bag.google.events.get(firstId).end.dateTime, frozen);
      assert.strictEqual(posts(bag.google).length, 2);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('C4 D6 an 11 minute gap stays a separate event', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endAt = plus(T0, 2 * MIN);
      const again = plus(endAt, 11 * MIN);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 3600 }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      const firstId = Array.from(bag.google.events.keys())[0];
      const frozen = bag.google.events.get(firstId).end.dateTime;
      await bag.plugin.onEvent('session.started', session({
        id: 's-2',
        startedAt: again,
        plannedSec: 600
      }), meta(again));
      assert.strictEqual(bag.google.events.size, 2);
      assert.strictEqual(bag.google.events.get(firstId).end.dateTime, frozen);
      const second = bodyOf(posts(bag.google)[1]);
      assert.strictEqual(second.start.dateTime, again);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('C5 ending and starting again immediately extends the same event', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endAt = plus(T0, 120 * 1000);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({
        title: '続き',
        startedAt: T0,
        plannedSec: 120
      }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        title: '続き',
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      await bag.plugin.onEvent('session.started', session({
        id: 's-2',
        title: '続き',
        startedAt: endAt,
        plannedSec: null
      }), meta(endAt));
      assert.strictEqual(posts(bag.google).length, 1);
      assert.strictEqual(bag.google.events.size, 1);
      const id = Array.from(bag.google.events.keys())[0];
      assert.strictEqual(bag.google.events.get(id).end.dateTime, plus(endAt, 3600 * 1000));
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('C6 an end requested during create finalizes after the insert', async () => {
    const bag = boot({ mode: 'live' });
    try {
      let release = null;
      const gate = new Promise((resolve) => { release = resolve; });
      bag.google.holdInsert(gate);
      const endAt = plus(T0, 2 * MIN);
      await bag.plugin.load(bag.ctx);
      const started = bag.plugin.onEvent('session.started', session({
        startedAt: T0,
        plannedSec: 3600
      }), meta(T0));
      await until(() => bag.google.isHolding());
      const ended = bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      release();
      await started;
      await ended;
      assert.strictEqual(posts(bag.google).length, 1);
      assert.strictEqual(bodyOf(posts(bag.google)[0]).end.dateTime, plus(T0, 3600 * 1000));
      const id = Array.from(bag.google.events.keys())[0];
      assert.strictEqual(bag.google.events.get(id).end.dateTime, endAt);
      assert.strictEqual(bag.plugin.actions.getStatus({}, bag.ctx).queueCount, 0);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('pause finalizes and resume merges inside the gap but not after 11 minutes', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const pauseAt = plus(T0, 2 * MIN);
      const resumeAt = plus(pauseAt, 30 * 1000);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 3600 }), meta(T0));
      await bag.plugin.onEvent('session.paused', session({
        state: 'paused',
        startedAt: T0,
        segments: [{ startedAt: T0, endedAt: pauseAt }]
      }), meta(pauseAt));
      const id = Array.from(bag.google.events.keys())[0];
      await bag.plugin.onEvent('session.resumed', session({
        state: 'running',
        startedAt: T0,
        plannedSec: 3600,
        segments: [{ startedAt: T0, endedAt: pauseAt }, { startedAt: resumeAt }]
      }), meta(resumeAt));
      assert.strictEqual(posts(bag.google).length, 1);
      assert.strictEqual(bag.google.events.get(id).end.dateTime, plus(resumeAt, 3600 * 1000));
      await bag.plugin.onEvent('session.paused', session({
        state: 'paused',
        startedAt: T0,
        segments: [
          { startedAt: T0, endedAt: pauseAt },
          { startedAt: resumeAt, endedAt: plus(resumeAt, 2 * MIN) }
        ]
      }), meta(plus(resumeAt, 2 * MIN)));
      const late = plus(bag.google.events.get(id).end.dateTime, 11 * MIN);
      const frozen = bag.google.events.get(id).end.dateTime;
      await bag.plugin.onEvent('session.resumed', session({
        state: 'running',
        startedAt: T0,
        plannedSec: 600,
        segments: [{ startedAt: late }]
      }), meta(late));
      assert.strictEqual(posts(bag.google).length, 2);
      assert.strictEqual(bag.google.events.get(id).end.dateTime, frozen);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('recordSources ignores manual and obs until configured', async () => {
    const bag = boot({ mode: 'shadow' });
    try {
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ source: 'manual', startedAt: T0 }), meta(T0));
      await bag.plugin.onEvent('session.started', session({ source: 'obs', id: 's-obs', startedAt: T0 }), meta(T0));
      assert.strictEqual(bag.google.calls.length, 0);
      assert.strictEqual(shadowLines(bag.dir).length, 0);
      await bag.plugin.onEvent('session.started', session({ source: 'timer', startedAt: T0 }), meta(T0));
      assert.strictEqual(shadowLines(bag.dir).length, 1);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('events that are not from sessions and retitle do nothing', async () => {
    const bag = boot({ mode: 'live' });
    try {
      await bag.plugin.load(bag.ctx);
      const foreign = Object.assign({}, meta(T0), { source: 'gcal' });
      await bag.plugin.onEvent('session.started', session({ startedAt: T0 }), foreign);
      await bag.plugin.onEvent('session.retitled', session({ title: '変更', startedAt: T0 }), meta(T0));
      assert.strictEqual(bag.google.calls.length, 0);
      assert.strictEqual(bag.plugin.actions.getStatus({}, bag.ctx).lastOp, null);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('an unmarked event is not patched', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endAt = plus(T0, 2 * MIN);
      bag.google.events.set('evt-foreign', {
        summary: 'Foreign',
        start: { dateTime: T0 },
        end: { dateTime: endAt }
      });
      fs.writeFileSync(path.join(bag.dir, 'state.json'), JSON.stringify({
        version: 1,
        active: null,
        last: {
          eventId: 'evt-foreign',
          sessionId: 's-old',
          title: '丸スト',
          start: T0,
          end: endAt
        }
      }));
      await bag.plugin.load(bag.ctx);
      const again = plus(endAt, 5 * MIN);
      await bag.plugin.onEvent('session.started', session({
        id: 's-new',
        startedAt: again,
        plannedSec: 600
      }), meta(again));
      assert.strictEqual(patches(bag.google).length, 0);
      assert.ok(bag.google.calls.some((call) => call.method === 'GET' && call.url.indexOf('evt-foreign') !== -1));
      assert.strictEqual(posts(bag.google).length, 1);
      assert.strictEqual(bag.google.events.get('evt-foreign').end.dateTime, endAt);
      const created = bodyOf(posts(bag.google)[0]);
      assert.strictEqual(created.extendedProperties.private.marust, '1');
      assert.strictEqual(created.start.dateTime, again);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('a failed send is queued and flush retries it', async () => {
    const bag = boot({ mode: 'live' });
    try {
      bag.google.failInserts(1);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 120 }), meta(T0));
      const status = bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(status.queueCount, 1);
      assert.strictEqual(status.lastError, 'http-503');
      const queued = readJson(path.join(bag.dir, 'queue.json'));
      assert.strictEqual(queued.items.length, 1);
      assert.strictEqual(queued.items[0].op, 'create');
      assert.strictEqual(bag.google.events.size, 0);
      const flushed = await bag.plugin.actions.flushQueue({}, bag.ctx);
      assert.strictEqual(flushed.ok, true);
      assert.strictEqual(flushed.queueCount, 0);
      assert.strictEqual(flushed.sent, 1);
      assert.strictEqual(flushed.lastError, null);
      assert.strictEqual(bag.google.events.size, 1);
      assertNoSecrets(bag.dir);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('retry backoff grows from 30 seconds to 10 minutes', async () => {
    const bag = boot({ mode: 'live' });
    try {
      bag.google.failInserts(20);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0 }), meta(T0));
      for (let i = 0; i < 5; i += 1) await bag.plugin.actions.flushQueue({}, bag.ctx);
      assert.deepStrictEqual(bag.clock.delays.slice(0, 6), [
        30000,
        60000,
        120000,
        240000,
        480000,
        600000
      ]);
      await bag.plugin.actions.flushQueue({}, bag.ctx);
      assert.strictEqual(bag.clock.delays[6], 600000);
      assert.ok(bag.clock.delays.every((ms) => ms <= 600000));
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('an unavailable secret is queued without an error or a fetch', async () => {
    const bag = boot({ mode: 'live', secret: 'unavailable' });
    try {
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 90 }), meta(T0));
      const status = bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(status.ok, true);
      assert.strictEqual(status.queueCount, 1);
      assert.strictEqual(status.lastError, null);
      assert.strictEqual(bag.google.calls.length, 0);
      bag.secretBox.mode = 'ok';
      const flushed = await bag.plugin.actions.flushQueue({}, bag.ctx);
      assert.strictEqual(flushed.queueCount, 0);
      assert.strictEqual(flushed.lastError, null);
      assert.strictEqual(posts(bag.google).length, 1);
      assert.strictEqual(bodyOf(posts(bag.google)[0]).summary, '丸スト');
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('shadow writes jsonl and does not call fetch', async () => {
    const bag = boot({ mode: 'shadow' });
    try {
      const title = 'あいうえおかきくけこさしすせそたちつてとな';
      const endAt = plus(T0, 2 * MIN);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({
        title: title,
        startedAt: T0,
        plannedSec: 3600
      }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        title: title,
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      assert.strictEqual(bag.google.calls.length, 0);
      const lines = shadowLines(bag.dir);
      assert.deepStrictEqual(lines.map((line) => line.op), ['create', 'finalize']);
      assert.strictEqual(lines[0].title, Array.from(title).slice(0, 20).join(''));
      assert.strictEqual(lines[0].start, T0);
      assert.strictEqual(lines[0].end, plus(T0, 3600 * 1000));
      assert.strictEqual(lines[1].end, endAt);
      const status = bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(status.mode, 'shadow');
      assert.strictEqual(status.lastOp, 'finalize');
      assert.strictEqual(status.queueCount, 0);
      assert.strictEqual(status.lastError, null);
      const names = fs.readdirSync(bag.dir).filter((name) => name.indexOf('shadow-') === 0);
      assert.strictEqual(names.length, 1);
      assert.ok(/^shadow-\d{8}\.jsonl$/.test(names[0]));
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('legacy does nothing', async () => {
    const bag = boot({ mode: 'legacy' });
    try {
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0 }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: plus(T0, 2 * MIN)
      }), meta(plus(T0, 2 * MIN)));
      assert.strictEqual(bag.google.calls.length, 0);
      assert.deepStrictEqual(fs.readdirSync(bag.dir), []);
      const status = bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(status.mode, 'legacy');
      assert.strictEqual(status.lastOp, null);
      assert.strictEqual(status.queueCount, 0);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('restart reloads the previous event and merges', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endAt = plus(T0, 2 * MIN);
      const again = plus(endAt, 5 * MIN);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 3600 }), meta(T0));
      await bag.plugin.onEvent('session.ended', session({
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      const id = Array.from(bag.google.events.keys())[0];
      bag.plugin.destroy();
      const next = createGcal({
        fetch: bag.google.fetch,
        now: bag.clock.now,
        setTimeout: bag.clock.setTimeout,
        clearTimeout: bag.clock.clearTimeout
      });
      await next.load(bag.ctx);
      const before = bag.google.calls.length;
      await next.onEvent('session.started', session({
        id: 's-2',
        startedAt: again,
        plannedSec: 900
      }), meta(again));
      const fresh = bag.google.calls.slice(before);
      assert.strictEqual(fresh.filter((call) => call.method === 'POST' && call.url.indexOf('/events') !== -1).length, 0);
      assert.ok(fresh.some((call) => call.method === 'PATCH' && call.url.indexOf(encodeURIComponent(id)) !== -1));
      assert.strictEqual(bag.google.events.size, 1);
      assert.strictEqual(bag.google.events.get(id).end.dateTime, plus(again, 900 * 1000));
      next.destroy();
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('recovered end finalizes at endedAt', async () => {
    const bag = boot({ mode: 'live' });
    try {
      const endedAt = plus(T0, 30 * MIN);
      bag.clock.setNow(Date.parse(plus(T0, 5 * 60 * MIN)));
      bag.google.events.set('evt-keep', {
        summary: '丸スト',
        description: 'Recorded by NeonTimer Compact',
        start: { dateTime: T0 },
        end: { dateTime: plus(T0, 3600 * 1000) },
        extendedProperties: { private: { marust: '1', sessionId: 's-old' } }
      });
      fs.writeFileSync(path.join(bag.dir, 'state.json'), JSON.stringify({
        version: 1,
        active: {
          eventId: 'evt-keep',
          sessionId: 's-old',
          title: '丸スト',
          start: T0,
          end: plus(T0, 3600 * 1000),
          pending: false
        },
        last: null
      }));
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.ended', session({
        id: 's-old',
        state: 'ended',
        startedAt: T0,
        endedAt: endedAt,
        lastAliveAt: endedAt,
        recovered: true
      }), meta(plus(T0, 5 * 60 * MIN)));
      assert.strictEqual(bag.google.events.get('evt-keep').end.dateTime, endedAt);
      assert.strictEqual(patches(bag.google).length, 1);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('settings replace the NeonTimer defaults', async () => {
    const bag = boot({
      mode: 'live',
      config: {
        mergeGapMinutes: 5,
        minEventSeconds: 120,
        provisionalCountupSeconds: 1800,
        calendarId: 'team',
        recordSources: ['timer', 'obs'],
        defaultTitle: '配信',
        description: 'marust test'
      }
    });
    try {
      const endAt = plus(T0, 30 * 1000);
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({
        title: '  ',
        source: 'obs',
        startedAt: T0,
        plannedSec: null
      }), meta(T0));
      const created = bodyOf(posts(bag.google)[0]);
      assert.ok(posts(bag.google)[0].url.indexOf('/calendars/team/events') !== -1);
      assert.strictEqual(created.summary, '配信');
      assert.strictEqual(created.description, 'marust test');
      assert.strictEqual(created.end.dateTime, plus(T0, 1800 * 1000));
      await bag.plugin.onEvent('session.ended', session({
        title: '',
        source: 'obs',
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      const id = Array.from(bag.google.events.keys())[0];
      assert.strictEqual(bag.google.events.get(id).end.dateTime, plus(T0, 120 * 1000));
      const inside = plus(bag.google.events.get(id).end.dateTime, 5 * MIN);
      await bag.plugin.onEvent('session.started', session({
        id: 's-2',
        title: '配信',
        source: 'obs',
        startedAt: inside,
        plannedSec: 60
      }), meta(inside));
      assert.strictEqual(posts(bag.google).length, 1);
      await bag.plugin.onEvent('session.ended', session({
        id: 's-2',
        title: '配信',
        source: 'obs',
        state: 'ended',
        startedAt: inside,
        endedAt: plus(inside, 3 * MIN)
      }), meta(plus(inside, 3 * MIN)));
      const outside = plus(bag.google.events.get(id).end.dateTime, 6 * MIN);
      const postsBefore = posts(bag.google).length;
      await bag.plugin.onEvent('session.started', session({
        id: 's-3',
        title: '配信',
        source: 'obs',
        startedAt: outside,
        plannedSec: 60
      }), meta(outside));
      assert.strictEqual(posts(bag.google).length, postsBefore + 1);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('an expired secret is refreshed in memory and not written down', async () => {
    const bag = boot({ mode: 'live', expiry: Date.parse(T0) - 1000 });
    try {
      await bag.plugin.load(bag.ctx);
      await bag.plugin.onEvent('session.started', session({ startedAt: T0, plannedSec: 90 }), meta(T0));
      const tokenCall = bag.google.calls.find((call) => call.url.indexOf('oauth2.googleapis.com/token') !== -1);
      assert.ok(tokenCall);
      assert.ok(String(tokenCall.body).indexOf('grant_type=refresh_token') !== -1);
      const created = posts(bag.google)[0];
      assert.strictEqual(created.headers.Authorization, 'Bearer access-NEW');
      assertNoSecrets(bag.dir);
    } finally {
      bag.plugin.destroy();
      rimraf(bag.dir);
    }
  });

  await test('create sends a stable calendar id and treats 409 as success', async () => {
    const first = boot({ mode: 'live' });
    const second = boot({ mode: 'live' });
    const conflict = boot({ mode: 'live' });
    try {
      await first.plugin.load(first.ctx);
      await first.plugin.onEvent('session.started', session({
        id: 's-1',
        title: '配信',
        startedAt: T0,
        plannedSec: 90
      }), meta(T0));
      const id1 = bodyOf(posts(first.google)[0]).id;
      assert.ok(/^[0-9a-v]{5,1024}$/.test(id1), id1);
      assert.strictEqual(id1.indexOf('-'), -1);
      assert.strictEqual(id1.indexOf('s-1'), -1);

      await second.plugin.load(second.ctx);
      await second.plugin.onEvent('session.started', session({
        id: 's-1',
        title: '別の題名',
        startedAt: T0,
        plannedSec: 90
      }), meta(T0));
      assert.strictEqual(bodyOf(posts(second.google)[0]).id, id1);
      const endAt = plus(T0, 2 * MIN);
      await second.plugin.onEvent('session.ended', session({
        id: 's-1',
        state: 'ended',
        startedAt: T0,
        endedAt: endAt
      }), meta(endAt));
      const otherAt = plus(T0, 30 * MIN);
      await second.plugin.onEvent('session.started', session({
        id: 's-2',
        title: '別の題名',
        startedAt: otherAt,
        plannedSec: 90
      }), meta(otherAt));
      const later = posts(second.google);
      const id2 = bodyOf(later[later.length - 1]).id;
      assert.notStrictEqual(id2, id1);
      assert.ok(/^[0-9a-v]{5,1024}$/.test(id2), id2);

      conflict.google.conflictOnce();
      await conflict.plugin.load(conflict.ctx);
      await conflict.plugin.onEvent('session.started', session({
        id: 's-9',
        startedAt: T0,
        plannedSec: 90
      }), meta(T0));
      assert.strictEqual(posts(conflict.google).length, 1);
      const sentId = bodyOf(posts(conflict.google)[0]).id;
      assert.ok(/^[0-9a-v]{5,1024}$/.test(sentId), sentId);
      const status = conflict.plugin.actions.getStatus({}, conflict.ctx);
      assert.strictEqual(status.queueCount, 0);
      assert.strictEqual(status.lastError, null);
      assert.strictEqual(status.lastOp, 'create');
      assert.strictEqual(conflict.google.events.size, 0);
      const state = readJson(path.join(conflict.dir, 'state.json'));
      assert.strictEqual(state.active.eventId, sentId);
      assert.deepStrictEqual(readJson(path.join(conflict.dir, 'queue.json')).items, []);
    } finally {
      first.plugin.destroy();
      second.plugin.destroy();
      conflict.plugin.destroy();
      rimraf(first.dir);
      rimraf(second.dir);
      rimraf(conflict.dir);
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
