'use strict';

const M = require('../../../_marust');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createRegistry } = require(M.at('host/layer1/plugin-registry'));
const raidMod = require(path.join(__dirname, '..', '..', 'raid-twitch'));
const overlayMod = require(path.join(__dirname, '..', '..', 'overlay-basic'));
const { createRaidTwitch } = raidMod;
const { createOverlayBasic } = overlayMod;

const ROOT = M.root; // 丸スト本体
const COMMUNITY = path.join(__dirname, '..', '..'); // みんなのプラグインの plugins/
const RAID_DIR = path.join(COMMUNITY, 'raid-twitch');
const OVERLAY_DIR = path.join(COMMUNITY, 'overlay-basic');
const NOW = '2026-10-04T03:00:00.000Z';
const NOW_MS = Date.parse(NOW);

const ACCESS = 'SENTINEL-TW-ACCESS-VALUE';
const CLIENT = 'SENTINEL-TW-CLIENT-VALUE';
const SECRET = 'SENTINEL-TW-SECRET-VALUE';
const REFRESH = 'SENTINEL-TW-REFRESH-VALUE';
const SECRETS = [ACCESS, CLIENT, SECRET, REFRESH];

const LIVE = {
  alpha: { user_id: '9001', user_login: 'alpha', viewer_count: 40 },
  beta: { user_id: '9002', user_login: 'beta', viewer_count: 3 },
  gamma: { user_id: '9003', user_login: 'gamma', viewer_count: 7 },
  delta: { user_id: '55', user_login: 'delta', viewer_count: 2 }
};

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

function jsonResponse(status, body) {
  const text = JSON.stringify(body == null ? {} : body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async text() { return text; }
  };
}

function header(call, name) {
  const headers = call && call.init && call.init.headers ? call.init.headers : {};
  const want = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === want) return headers[keys[i]];
  }
  return undefined;
}

function oauthValue(extra) {
  const body = {
    client_id: CLIENT,
    client_secret: SECRET,
    refresh_token: REFRESH,
    access_token: ACCESS,
    broadcaster_id: '4242'
  };
  if (extra) {
    const keys = Object.keys(extra);
    for (let i = 0; i < keys.length; i += 1) body[keys[i]] = extra[keys[i]];
  }
  return JSON.stringify(body);
}

function boot(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-raid-'));
  const calls = [];
  const logs = [];
  const secretGets = [];
  const world = {
    live: Object.prototype.hasOwnProperty.call(opts, 'live') ? opts.live : LIVE,
    followed: opts.followed || [],
    followers: opts.followers || [],
    calls: calls
  };
  let secret = Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : oauthValue();
  let mode = opts.mode || 'legacy';
  const plugin = createRaidTwitch({
    fetch: async function fetch(url, init) {
      calls.push({ url: String(url), init: init || {} });
      const parsed = new URL(String(url));
      if (parsed.origin !== 'https://api.twitch.tv') return jsonResponse(404, {});
      if (parsed.pathname === '/helix/streams') {
        const names = parsed.searchParams.getAll('user_login');
        const data = [];
        for (let i = 0; i < names.length; i += 1) {
          if (world.live[names[i]]) data.push(world.live[names[i]]);
        }
        return jsonResponse(200, { data: data });
      }
      if (parsed.pathname === '/helix/raids') {
        return jsonResponse(200, { data: [{ created_at: NOW, is_mature: false }] });
      }
      if (parsed.pathname === '/helix/channels/followed') {
        return jsonResponse(200, { data: world.followed, pagination: {} });
      }
      if (parsed.pathname === '/helix/channels/followers') {
        return jsonResponse(200, { data: world.followers, pagination: {} });
      }
      if (parsed.pathname === '/helix/users') {
        return jsonResponse(200, { data: [{ id: '4242', login: 'self' }] });
      }
      return jsonResponse(404, {});
    },
    now: function now() { return new Date(NOW_MS); }
  });
  const ctx = {
    id: 'raid-twitch',
    dataDir: dir,
    mode: function modeFn() { return mode; },
    logger: function logger(level, message) { logs.push(String(level) + ' ' + String(message)); },
    secrets: {
      async get(name) {
        secretGets.push(name);
        if (name !== 'twitch.oauth') return { ok: false, error: 'not-declared' };
        if (typeof secret !== 'string' || !secret) return { ok: false, error: 'unavailable' };
        return { ok: true, value: secret };
      }
    }
  };
  plugin.load(ctx);
  return {
    plugin: plugin,
    ctx: ctx,
    dir: dir,
    calls: calls,
    logs: logs,
    secretGets: secretGets,
    world: world,
    setMode: function setMode(next) { mode = next; },
    setSecret: function setSecret(next) { secret = next; }
  };
}

function raids(calls) {
  return calls.filter(function (call) { return call.url.indexOf('/helix/raids') !== -1; });
}

function paths(calls) {
  return calls.map(function (call) { return new URL(call.url).pathname; });
}

function assertManual(calls) {
  for (let i = 0; i < calls.length; i += 1) {
    assert.strictEqual(calls[i].init.redirect, 'manual', calls[i].url);
    assert.strictEqual(calls[i].init.cache, 'no-store');
    assert.ok(calls[i].init.body == null, calls[i].url);
    assert.strictEqual(header(calls[i], 'Client-Id'), CLIENT);
    assert.strictEqual(header(calls[i], 'Authorization'), 'Bearer ' + ACCESS);
    assert.strictEqual(new URL(calls[i].url).origin, 'https://api.twitch.tv');
  }
}

function blobOf(box, extra) {
  let files = '';
  const names = ['last-raid.json', 'raid-cache.json', 'raid-suggested-channels.json'];
  for (let i = 0; i < names.length; i += 1) {
    const file = path.join(box.dir, names[i]);
    if (fs.existsSync(file)) files += '\n' + fs.readFileSync(file, 'utf8');
  }
  return box.logs.join('\n') + files + '\n' + (extra || '');
}

function assertClean(text) {
  const blob = text == null ? '' : String(text);
  for (let i = 0; i < SECRETS.length; i += 1) {
    assert.strictEqual(blob.indexOf(SECRETS[i]), -1, SECRETS[i]);
  }
  assert.strictEqual(blob.toLowerCase().indexOf('bearer ' + ACCESS.toLowerCase()), -1);
}

function freshCache(dir, mutuals) {
  fs.writeFileSync(path.join(dir, 'raid-cache.json'), JSON.stringify({
    updatedAt: NOW_MS,
    mutuals: mutuals || []
  }));
}

async function main() {
  await test('manifests match the raid and overlay contract', async function () {
    const raid = JSON.parse(fs.readFileSync(path.join(RAID_DIR, 'manifest.json'), 'utf8'));
    assert.strictEqual(raid.id, 'raid-twitch');
    assert.strictEqual(raid.manifestVersion, 2);
    assert.strictEqual(raid.runtime, 'inproc');
    assert.strictEqual(raid.kind, 'integration');
    assert.strictEqual(raid.defaultMode, 'legacy');
    assert.deepStrictEqual(raid.provides, ['stream.lifecycle@1', 'ui.panel@1']);
    assert.deepStrictEqual(raid.subscribes, ['stream.stopping']);
    assert.deepStrictEqual(raid.secrets, ['twitch.oauth']);
    assert.strictEqual(raid.actions.getStatus, 'read');
    assert.strictEqual(raid.actions.setSuggested, 'write');
    assert.strictEqual(raid.panels[0].file, 'ui/panel.html');
    const overlay = JSON.parse(fs.readFileSync(path.join(OVERLAY_DIR, 'manifest.json'), 'utf8'));
    assert.strictEqual(overlay.id, 'overlay-basic');
    assert.strictEqual(overlay.manifestVersion, 2);
    assert.strictEqual(overlay.runtime, 'inproc');
    assert.strictEqual(overlay.defaultMode, 'legacy');
    assert.deepStrictEqual(overlay.subscribes, ['session.*', 'engine.target.changed', 'modes.changed']);
    assert.deepStrictEqual(overlay.overlays.map(function (row) { return row.name; }), ['title', 'live-sites']);
    assert.deepStrictEqual(overlay.overlays[0].fields, ['title']);
    assert.deepStrictEqual(overlay.overlays[1].fields, ['sites']);
    const panel = fs.readFileSync(path.join(RAID_DIR, 'ui', 'panel.js'), 'utf8')
      + fs.readFileSync(path.join(RAID_DIR, 'ui', 'panel.html'), 'utf8')
      + fs.readFileSync(path.join(RAID_DIR, 'ui', 'panel.css'), 'utf8');
    assert.strictEqual(panel.indexOf('access_token'), -1);
    assert.strictEqual(panel.indexOf('client_secret'), -1);
    assert.strictEqual(panel.indexOf('refresh_token'), -1);
    assert.strictEqual(panel.toLowerCase().indexOf('bearer'), -1);
  });

  await test('live raid uses the NeonTimer Helix shape and the quietest suggested channel', async function () {
    const box = boot({ mode: 'live' });
    try {
      const saved = box.plugin.actions.setSuggested({ channels: ['Alpha', 'beta', 'nope token'] }, box.ctx);
      assert.deepStrictEqual(saved, { ok: true, count: 2 });
      freshCache(box.dir, ['gamma']);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.dryRun, false);
      assert.strictEqual(result.login, 'beta');
      assert.strictEqual(result.source, 'suggested');
      assert.strictEqual(result.viewerCount, 3);
      const posted = raids(box.calls);
      assert.strictEqual(posted.length, 1);
      const url = new URL(posted[0].url);
      assert.strictEqual(url.pathname, '/helix/raids');
      assert.strictEqual(url.searchParams.get('from_broadcaster_id'), '4242');
      assert.strictEqual(url.searchParams.get('to_broadcaster_id'), '9002');
      assert.strictEqual(posted[0].init.method, 'POST');
      assertManual(box.calls);
      assert.ok(paths(box.calls).indexOf('/helix/channels/followed') === -1);
      assert.ok(paths(box.calls).indexOf('/helix/users') === -1);
      const status = await box.plugin.actions.getStatus({}, box.ctx);
      assert.strictEqual(status.ok, true);
      assert.strictEqual(status.configured, true);
      assert.strictEqual(status.last.login, 'beta');
      assert.deepStrictEqual(status.candidates.map(function (row) { return row.login; }), ['alpha', 'beta', 'gamma']);
      assertClean(blobOf(box, JSON.stringify(status) + JSON.stringify(result)));
    } finally {
      rimraf(box.dir);
    }
  });

  await test('emergency does not raid and does not touch secrets or Helix', async function () {
    const box = boot({ mode: 'live' });
    try {
      box.plugin.actions.setSuggested({ channels: ['beta'] }, box.ctx);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'emergency' }, {});
      assert.deepStrictEqual(result, { ok: true, dryRun: false, skipped: 'emergency' });
      assert.strictEqual(box.calls.length, 0);
      assert.strictEqual(box.secretGets.length, 0);
      assertClean(blobOf(box, JSON.stringify(result)));
    } finally {
      rimraf(box.dir);
    }
  });

  await test('all candidates offline is a no-op with no raid request', async function () {
    const box = boot({ mode: 'live', live: {} });
    try {
      box.plugin.actions.setSuggested({ channels: ['alpha', 'beta'] }, box.ctx);
      freshCache(box.dir, ['gamma']);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.deepStrictEqual(result, { ok: true, dryRun: false, skipped: 'no-candidate' });
      assert.strictEqual(raids(box.calls).length, 0);
      assert.ok(box.calls.length >= 1);
      assert.ok(paths(box.calls).every(function (item) { return item === '/helix/streams'; }));
      assertManual(box.calls);
    } finally {
      rimraf(box.dir);
    }
  });

  await test('missing secret does nothing outbound', async function () {
    const box = boot({ mode: 'live', secret: null });
    try {
      box.plugin.actions.setSuggested({ channels: ['beta'] }, box.ctx);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.deepStrictEqual(result, { ok: true, dryRun: false, skipped: 'no-credentials' });
      assert.strictEqual(box.calls.length, 0);
      const status = await box.plugin.actions.getStatus({}, box.ctx);
      assert.strictEqual(status.configured, false);
      assertClean(blobOf(box, JSON.stringify(status) + JSON.stringify(result)));
    } finally {
      rimraf(box.dir);
    }
  });

  await test('legacy does nothing outbound', async function () {
    const box = boot({ mode: 'legacy' });
    try {
      box.plugin.actions.setSuggested({ channels: ['beta'] }, box.ctx);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.deepStrictEqual(result, { ok: true, dryRun: false, skipped: 'legacy' });
      assert.strictEqual(box.calls.length, 0);
      assert.strictEqual(box.secretGets.length, 0);
    } finally {
      rimraf(box.dir);
    }
  });

  await test('shadow records the raid target and does not POST a raid', async function () {
    const box = boot({ mode: 'shadow' });
    try {
      box.plugin.actions.setSuggested({ channels: ['alpha', 'beta'] }, box.ctx);
      freshCache(box.dir, []);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.login, 'beta');
      assert.strictEqual(result.source, 'suggested');
      assert.strictEqual(raids(box.calls).length, 0);
      assert.ok(paths(box.calls).indexOf('/helix/streams') !== -1);
      const saved = JSON.parse(fs.readFileSync(path.join(box.dir, 'last-raid.json'), 'utf8'));
      assert.strictEqual(saved.dryRun, true);
      assert.strictEqual(saved.login, 'beta');
      assert.strictEqual(saved.skipped, '');
      const again = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, { dryRun: true });
      assert.strictEqual(again.dryRun, true);
      assert.strictEqual(raids(box.calls).length, 0);
      const status = await box.plugin.actions.getStatus({}, box.ctx);
      assert.strictEqual(status.last.dryRun, true);
      assert.strictEqual(status.last.login, 'beta');
      assertClean(blobOf(box, JSON.stringify(status)));
    } finally {
      rimraf(box.dir);
    }
  });

  await test('live with meta.dryRun stays inside and does not POST', async function () {
    const box = boot({ mode: 'live' });
    try {
      box.plugin.actions.setSuggested({ channels: ['beta'] }, box.ctx);
      freshCache(box.dir, []);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, { dryRun: true });
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.login, 'beta');
      assert.strictEqual(raids(box.calls).length, 0);
    } finally {
      rimraf(box.dir);
    }
  });

  await test('suggested live channel wins over a quieter mutual', async function () {
    const box = boot({ mode: 'live' });
    try {
      box.plugin.actions.setSuggested({ channels: ['alpha'] }, box.ctx);
      freshCache(box.dir, ['gamma']);
      const result = await box.plugin.onEvent('stream.stopping', {}, {});
      assert.strictEqual(result.login, 'alpha');
      assert.strictEqual(result.source, 'suggested');
      assert.strictEqual(result.viewerCount, 40);
      assert.strictEqual(new URL(raids(box.calls)[0].url).searchParams.get('to_broadcaster_id'), '9001');
      assert.ok(paths(box.calls).indexOf('/helix/channels/followed') === -1);
    } finally {
      rimraf(box.dir);
    }
  });

  await test('mutual followers are used when nobody suggested is live, and a fresh cache skips Helix follow lists', async function () {
    const box = boot({ mode: 'live', live: { gamma: LIVE.gamma } });
    try {
      box.plugin.actions.setSuggested({ channels: ['alpha'] }, box.ctx);
      freshCache(box.dir, ['gamma']);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.strictEqual(result.login, 'gamma');
      assert.strictEqual(result.source, 'mutual');
      assert.strictEqual(new URL(raids(box.calls)[0].url).searchParams.get('to_broadcaster_id'), '9003');
      assert.ok(paths(box.calls).indexOf('/helix/channels/followed') === -1);
      assert.ok(paths(box.calls).indexOf('/helix/channels/followers') === -1);
    } finally {
      rimraf(box.dir);
    }
  });

  await test('a stale mutual cache refreshes from followed and followers', async function () {
    const box = boot({
      mode: 'live',
      live: { delta: LIVE.delta },
      followed: [{ broadcaster_id: '55', broadcaster_login: 'Delta' }],
      followers: [{ user_id: '55', user_login: 'delta' }]
    });
    try {
      fs.writeFileSync(path.join(box.dir, 'raid-cache.json'), JSON.stringify({
        updatedAt: NOW_MS - (200 * 24 * 60 * 60 * 1000),
        mutuals: ['gamma']
      }));
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.strictEqual(result.login, 'delta');
      assert.strictEqual(result.source, 'mutual');
      assert.ok(paths(box.calls).indexOf('/helix/channels/followed') !== -1);
      assert.ok(paths(box.calls).indexOf('/helix/channels/followers') !== -1);
      const followed = box.calls.find(function (call) { return call.url.indexOf('/helix/channels/followed') !== -1; });
      const url = new URL(followed.url);
      assert.strictEqual(url.searchParams.get('user_id'), '4242');
      assert.strictEqual(url.searchParams.get('first'), '100');
      const cache = JSON.parse(fs.readFileSync(path.join(box.dir, 'raid-cache.json'), 'utf8'));
      assert.deepStrictEqual(cache.mutuals, ['delta']);
      assert.strictEqual(cache.updatedAt, NOW_MS);
      assert.strictEqual(new URL(raids(box.calls)[0].url).searchParams.get('to_broadcaster_id'), '55');
      assertClean(blobOf(box, JSON.stringify(result)));
    } finally {
      rimraf(box.dir);
    }
  });

  await test('broadcaster id falls back to Helix users when the secret omits it', async function () {
    const box = boot({
      mode: 'live',
      secret: oauthValue({ broadcaster_id: '' })
    });
    try {
      box.plugin.actions.setSuggested({ channels: ['beta'] }, box.ctx);
      freshCache(box.dir, []);
      const result = await box.plugin.onEvent('stream.stopping', { reason: 'user' }, {});
      assert.strictEqual(result.login, 'beta');
      assert.ok(paths(box.calls).indexOf('/helix/users') !== -1);
      assert.strictEqual(new URL(raids(box.calls)[0].url).searchParams.get('from_broadcaster_id'), '4242');
    } finally {
      rimraf(box.dir);
    }
  });

  await test('overlay fields stay strings for title and live sites', async function () {
    const published = [];
    const session = { active: true, title: '朝の回', state: 'running', elapsedMs: 1 };
    const destinations = [
      { id: '1', site: 'Twitch', actual: { engineState: 'live', siteLive: false } },
      { id: '2', site: 'YouTube', actual: { engineState: 'stopped', siteLive: false } },
      { id: '3', site: 'Kick', actual: { engineState: 'idle', siteLive: true } },
      { id: '4', site: 12, actual: { engineState: 'live', siteLive: true } },
      { id: '5', site: 'Twitch', actual: { engineState: 'live', siteLive: true } }
    ];
    const plugin = createOverlayBasic();
    const ctx = {
      id: 'overlay-basic',
      sessions: { view: function view() { return session; } },
      destinations: { list: function list() { return { ok: true, destinations: destinations }; } },
      overlay: {
        publish: function publish(name, values) {
          published.push({ name: name, values: values });
          return { ok: true, values: values };
        }
      }
    };
    plugin.load(ctx);
    plugin.onEvent('session.retitled', { title: 15, token: ACCESS });
    session.title = 'あ'.repeat(201);
    plugin.onEvent('session.retitled', { title: session.title });
    plugin.onEvent('engine.target.changed', {
      engineId: 'obs-local',
      targetId: 't1',
      name: 'ignored-because-list',
      state: 'live'
    });
    destinations[0].actual.engineState = 'stopped';
    destinations[0].actual.siteLive = false;
    destinations[4].actual.engineState = 'stopped';
    destinations[4].actual.siteLive = false;
    plugin.onEvent('engine.target.changed', { targetId: 't1', name: 'Twitch', state: 'stopped' });
    session.active = false;
    plugin.onEvent('session.ended', { title: '朝の回' });

    function last(name) {
      const rows = published.filter(function (row) { return row.name === name; });
      assert.ok(rows.length > 0, name);
      return rows[rows.length - 1].values;
    }
    const titleValues = published.filter(function (row) { return row.name === 'title'; }).map(function (row) { return row.values; });
    assert.strictEqual(titleValues[0].title, '朝の回');
    assert.strictEqual(titleValues[titleValues.length - 2].title.length, 200);
    assert.strictEqual(last('title').title, '');
    assert.strictEqual(last('live-sites').sites, 'Kick');
    const mid = published.filter(function (row) { return row.name === 'live-sites'; });
    assert.strictEqual(mid[0].values.sites, 'Kick · Twitch');
    for (let i = 0; i < published.length; i += 1) {
      const values = published[i].values;
      const keys = Object.keys(values);
      assert.ok(keys.length >= 1);
      for (let j = 0; j < keys.length; j += 1) {
        assert.strictEqual(typeof values[keys[j]], 'string', keys[j]);
        assert.ok(keys[j] === 'title' || keys[j] === 'sites');
        assert.strictEqual(values[keys[j]].indexOf(ACCESS), -1);
      }
    }
    ctx.destinations.list = function list() { return { ok: false, error: 'unavailable' }; };
    plugin.onEvent('engine.target.changed', { targetId: 'pic', name: 'Picarto', state: 'live' });
    plugin.onEvent('engine.target.changed', { targetId: 'yt', name: 'YouTube', state: 'live' });
    assert.strictEqual(last('live-sites').sites, 'Picarto · YouTube');
    plugin.onEvent('engine.target.changed', { targetId: 'yt', name: 'YouTube', state: 'stopped' });
    assert.strictEqual(last('live-sites').sites, 'Picarto');
    assert.strictEqual(typeof last('title').title, 'string');
  });

  await test('registry accepts both plugins', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-reg-'));
    try {
      const plugins = path.join(root, 'plugins');
      fs.mkdirSync(plugins);
      fs.cpSync(RAID_DIR, path.join(plugins, 'raid-twitch'), { recursive: true });
      fs.cpSync(OVERLAY_DIR, path.join(plugins, 'overlay-basic'), { recursive: true });
      const registry = createRegistry({
        appRoot: root,
        core: { STATE_DIR: path.join(root, 'state') },
        builtinRoot: plugins,
        externalRoot: path.join(root, 'external'),
        logger: function logger() {}
      });
      const found = registry.discover();
      const raid = found.find(function (rec) { return rec.id === 'raid-twitch'; });
      const overlay = found.find(function (rec) { return rec.id === 'overlay-basic'; });
      assert.strictEqual(raid.status, 'accepted', raid && raid.reason);
      assert.strictEqual(overlay.status, 'accepted', overlay && overlay.reason);
      assert.deepStrictEqual(raid.manifest.secrets, ['twitch.oauth']);
      assert.strictEqual(raid.manifest.defaultMode, 'legacy');
      const loaded = await registry.loadAll();
      assert.strictEqual(loaded.find(function (rec) { return rec.id === 'raid-twitch'; }).status, 'running');
      assert.strictEqual(loaded.find(function (rec) { return rec.id === 'overlay-basic'; }).status, 'running');
      const hub = registry.overlayHub.getLatest('overlay-basic', 'title');
      assert.strictEqual(typeof hub.title, 'string');
      const sites = registry.overlayHub.getLatest('overlay-basic', 'live-sites');
      assert.strictEqual(typeof sites.sites, 'string');
    } finally {
      rimraf(root);
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('all passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});