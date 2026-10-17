'use strict';
require('../../../test/_ui-inline');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const lib = require('../lib/golive');
const { relatedPlugins } = lib;
const { createApi } = require('../../../host/layer1/api');
const { attachDevShadow } = require('../../../test/_dev-shadow');

const TOKEN = 'PLANTED_SECRET_VALUE_w34';

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

// 旧い形の deps（secrets・destinations・modes）を、今の形（facts = 本体の diagnostics.siteFacts の答え）に直す。判定の文面の試験をそのまま使うため。
function adapt(deps) {
  return {
    facts: async function (site, names, ids) {
      const out = { ok: true, site: site, secrets: null, plugins: null, destinations: null };
      const s = deps.secrets;
      if (s && typeof s === 'object') {
        try {
          if (typeof s.describe === 'function') {
            out.secrets = {};
            for (const name of names) { const row = await s.describe(name); out.secrets[name] = !!(row && row.ok === true); }
          } else if (typeof s.list === 'function') {
            const listed = await s.list();
            if (listed && listed.ok === true && Array.isArray(listed.secrets)) {
              const have = new Set(listed.secrets.map(function (r) { return r && r.name; }));
              out.secrets = {};
              names.forEach(function (n) { out.secrets[n] = have.has(n); });
            }
          }
        } catch (_) { out.secrets = null; }
      }
      try {
        const d = typeof deps.destinations === 'function' ? await deps.destinations() : deps.destinations;
        if (Array.isArray(d)) {
          out.destinations = d.filter(function (row) { return row && String(row.site) === site; }).map(function (row) {
            const bound = row.engine && typeof row.engine === 'object' ? row.engine : null;
            return {
              id: String(row.id),
              enabled: row.enabled === true,
              engineId: bound && typeof bound.id === 'string' && bound.targetId != null && String(bound.targetId).trim() ? bound.id : ''
            };
          });
        }
      } catch (_) { out.destinations = null; }
      try {
        const m = typeof deps.modes === 'function' ? await deps.modes() : deps.modes;
        if (m && m.ok === true && Array.isArray(m.plugins)) {
          const by = new Map(m.plugins.map(function (r) { return [r.id, r]; }));
          out.plugins = {};
          ids.forEach(function (id) { out.plugins[id] = by.has(id) ? by.get(id).mode : 'missing'; });
        }
      } catch (_) { out.plugins = null; }
      return out;
    },
    preflight: deps.preflight,
    shadowReport: deps.shadowReport
  };
}

function check(site, deps) {
  return lib.check(site, adapt(deps));
}

function byStep(result, name) {
  return result.steps.find(function (row) { return row.step === name; });
}

function livePlugins(site) {
  return relatedPlugins(site).map(function (id) {
    return { id: id, mode: 'live', name: TOKEN, value: TOKEN };
  });
}

function baseDeps(extra) {
  const deps = {
    secrets: {
      describe: async function (name) {
        return { ok: true, secret: { name: name, value: TOKEN, ciphertext: TOKEN } };
      }
    },
    destinations: function () {
      return [{
        id: 'rumble-main',
        site: 'rumble',
        enabled: true,
        engine: { id: 'obs-local', targetId: TOKEN },
        desired: { title: TOKEN, category: TOKEN },
        actual: { streamKey: TOKEN }
      }];
    },
    preflight: async function () {
      return {
        ok: true,
        items: [{ level: 'ok', code: 'ready', message: TOKEN, destinationId: TOKEN }]
      };
    },
    shadowReport: async function () {
      return { ok: true, sites: { rumble: { count: 2, title: TOKEN, summary: TOKEN } } };
    },
    modes: async function () {
      return { ok: true, plugins: livePlugins('rumble') };
    }
  };
  return Object.assign(deps, extra || {});
}

function assertNoSecret(result) {
  const text = JSON.stringify(result);
  assert.strictEqual(text.indexOf(TOKEN), -1, text);
}

async function devApi(extra) {
  const api = createApi(Object.assign({ audit: { write: function () {} } }, extra));
  const attached = await attachDevShadow(api, {});
  return { api: api, done: attached.done };
}

async function main() {
  await test('rumble checklist marks each step', async function () {
    const result = await check('rumble', baseDeps());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.site, 'rumble');
    assert.strictEqual(result.steps.length, 6);
    assert.deepStrictEqual(result.steps.map(function (row) { return row.step; }), [
      'login', 'destination', 'preflight', 'shadow', 'modes', 'neontimer'
    ]);
    assert.strictEqual(byStep(result, 'login').level, 'ok');
    assert.strictEqual(byStep(result, 'login').code, 'secrets-ready');
    assert.ok(byStep(result, 'login').detail.indexOf('rumble.livestream-api') !== -1);
    assert.ok(byStep(result, 'login').detail.indexOf('cookies.rumble-main') !== -1);
    assert.strictEqual(byStep(result, 'destination').level, 'ok');
    assert.strictEqual(byStep(result, 'destination').code, 'destination-linked');
    assert.strictEqual(byStep(result, 'preflight').level, 'ok');
    assert.strictEqual(byStep(result, 'preflight').code, 'preflight-ok');
    assert.strictEqual(byStep(result, 'shadow').level, 'ok');
    assert.strictEqual(byStep(result, 'shadow').code, 'shadow-seen');
    assert.ok(byStep(result, 'shadow').detail.indexOf('2') !== -1);
    assert.strictEqual(byStep(result, 'modes').level, 'ok');
    assert.strictEqual(byStep(result, 'modes').code, 'modes-live');
    assert.ok(byStep(result, 'modes').detail.indexOf('slot-rumble=live') !== -1);
    assert.ok(byStep(result, 'modes').detail.indexOf('obs-engine=live') !== -1);
    assert.strictEqual(byStep(result, 'neontimer').level, 'todo');
    assert.strictEqual(byStep(result, 'neontimer').code, 'neontimer-manual');
    assert.ok(byStep(result, 'neontimer').detail.indexOf('NeonTimer') !== -1);
    assertNoSecret(result);
  });

  await test('missing login points at NeonTimer import', async function () {
    const result = await check('youtube', baseDeps({
      secrets: {
        describe: async function () { return { ok: false, error: 'not-found', value: TOKEN }; }
      },
      destinations: [{ id: 'yt', site: 'youtube', enabled: true, engine: { id: 'obs-local', targetId: 't1' } }],
      shadowReport: async function () { return { ok: true, sites: { youtube: { count: 0 } } }; },
      modes: async function () { return { ok: true, plugins: livePlugins('youtube') }; }
    }));
    const login = byStep(result, 'login');
    assert.strictEqual(login.level, 'todo');
    assert.strictEqual(login.code, 'secrets-missing');
    assert.ok(login.detail.indexOf('NeonTimer から取り込む') !== -1);
    assert.strictEqual(byStep(result, 'shadow').code, 'shadow-none');
    assert.strictEqual(byStep(result, 'shadow').level, 'todo');
    assertNoSecret(result);
  });

  await test('partial secrets warn with the missing name only', async function () {
    const result = await check('rumble', baseDeps({
      secrets: {
        list: async function () {
          return { ok: true, secrets: [{ name: 'rumble.livestream-api', value: TOKEN, size: 99 }] };
        }
      }
    }));
    const login = byStep(result, 'login');
    assert.strictEqual(login.level, 'warn');
    assert.strictEqual(login.code, 'secrets-partial');
    assert.ok(login.detail.indexOf('cookies.rumble-main') !== -1);
    assert.ok(login.detail.indexOf('NeonTimer から取り込む') !== -1);
    assert.strictEqual(login.detail.indexOf('rumble.livestream-api'), -1);
    assertNoSecret(result);
  });

  await test('unlinked destination is not ok', async function () {
    const unlinked = await check('twitch', baseDeps({
      destinations: [{ id: 'twitch-main', site: 'twitch', enabled: true, engine: null, title: TOKEN }],
      modes: async function () { return { ok: true, plugins: livePlugins('twitch') }; },
      shadowReport: async function () { return { ok: true, sites: { twitch: { count: 1 } } }; }
    }));
    assert.strictEqual(byStep(unlinked, 'destination').level, 'todo');
    assert.strictEqual(byStep(unlinked, 'destination').code, 'destination-unlinked');
    assert.strictEqual(byStep(unlinked, 'preflight').code, 'preflight-ok');
  });

  await test('preflight errors stay codes and do not copy messages', async function () {
    const seen = [];
    const result = await check('rumble', baseDeps({
      preflight: async function (ids) {
        seen.push(ids.slice());
        return {
          ok: false,
          items: [
            { level: 'error', code: 'slot-missing', message: TOKEN },
            { level: 'warn', code: 'engine-idle', message: TOKEN }
          ]
        };
      }
    }));
    assert.deepStrictEqual(seen[0], ['rumble-main']);
    const row = byStep(result, 'preflight');
    assert.strictEqual(row.level, 'warn');
    assert.strictEqual(row.code, 'preflight-error');
    assert.ok(row.detail.indexOf('slot-missing') !== -1);
    assert.strictEqual(row.detail.indexOf('engine-idle'), -1);
    assertNoSecret(result);
  });

  await test('shadow report absence says it cannot be judged', async function () {
    const called = [];
    const missing = await check('rumble', baseDeps({ shadowReport: null }));
    assert.strictEqual(byStep(missing, 'shadow').level, 'warn');
    assert.strictEqual(byStep(missing, 'shadow').code, 'shadow-unknown');
    assert.strictEqual(byStep(missing, 'shadow').detail, '判定できない');
    const broken = await check('rumble', baseDeps({
      shadowReport: async function (query) {
        called.push(query);
        return { ok: false, error: TOKEN, sites: { rumble: { count: 9, title: TOKEN } } };
      }
    }));
    assert.deepStrictEqual(called[0], { days: 7, site: 'rumble' });
    assert.strictEqual(byStep(broken, 'shadow').detail, '判定できない');
    assertNoSecret(broken);
  });

  await test('legacy and missing plugins are todo, shadow mix is warn', async function () {
    const legacy = await check('kick', baseDeps({
      destinations: [{ id: 'kick-main', site: 'kick', enabled: true, engine: { id: 'obs-local', targetId: 'k' } }],
      shadowReport: async function () { return { ok: true, sites: {} }; },
      modes: async function () {
        const plugins = livePlugins('kick');
        plugins[0].mode = 'legacy';
        return { ok: true, plugins: plugins };
      }
    }));
    assert.strictEqual(byStep(legacy, 'modes').level, 'todo');
    assert.strictEqual(byStep(legacy, 'modes').code, 'modes-legacy');
    assert.ok(byStep(legacy, 'modes').detail.indexOf('site-kick=legacy') !== -1);
    assert.ok(byStep(legacy, 'modes').detail.indexOf('slot-rumble') === -1);
    const missing = await check('kick', baseDeps({
      modes: async function () { return { ok: true, plugins: [] }; }
    }));
    assert.strictEqual(byStep(missing, 'modes').code, 'modes-missing');
    assert.ok(byStep(missing, 'modes').detail.indexOf('site-kick=なし') !== -1);
    assert.strictEqual(byStep(missing, 'destination').code, 'destination-missing');
    assert.strictEqual(byStep(missing, 'preflight').code, 'preflight-none');
    const mixed = await check('kick', baseDeps({
      modes: async function () {
        return {
          ok: true,
          plugins: relatedPlugins('kick').map(function (id, index) {
            return { id: id, mode: index === 0 ? 'shadow' : 'live' };
          })
        };
      }
    }));
    assert.strictEqual(byStep(mixed, 'modes').level, 'warn');
    assert.strictEqual(byStep(mixed, 'modes').code, 'modes-shadow');
    const down = await check('kick', baseDeps({ modes: async function () { return { ok: false, error: TOKEN }; } }));
    assert.strictEqual(byStep(down, 'modes').detail, '判定できない');
    assertNoSecret(down);
  });

  await test('unknown site is rejected', async function () {
    const direct = await check('not-a-site', baseDeps());
    assert.strictEqual(direct.ok, false);
    assert.strictEqual(direct.error, 'unknown-site');
    assert.ok(!direct.steps);
    const blank = await check('', baseDeps());
    assert.strictEqual(blank.error, 'unknown-site');
    const world = await devApi({});
    try {
      assert.strictEqual(world.api.permissionFor('golive.check'), 'read');
      const denied = await world.api.call('golive.check', { site: 'Rumble' }, { permissions: ['read'], clientId: 'local-window' });
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.error, 'unknown-site');
      const empty = await world.api.call('golive.check', {}, { permissions: ['read'] });
      assert.strictEqual(empty.error, 'unknown-site');
      assertNoSecret(denied);
    } finally { world.done(); }
  });

  await test('api read path (golive.check -> diagnostics.siteFacts / broadcast.preflight) does not echo secret values', async function () {
    const queries = [];
    const world = await devApi({
      secrets: {
        describe: async function (name) {
          return { ok: true, value: TOKEN, secret: { name: name, value: TOKEN } };
        },
        list: async function () {
          return { ok: true, secrets: [{ name: 'rumble.livestream-api', value: TOKEN }, { name: 'cookies.rumble-main', value: TOKEN }] };
        }
      },
      store: {
        snapshot: function () {
          return {
            destinations: [{
              id: 'rumble-main',
              site: 'rumble',
              enabled: true,
              engine: { id: 'obs-local', targetId: TOKEN },
              desired: { title: TOKEN }
            }]
          };
        }
      },
      preflight: {
        run: async function (ids) {
          queries.push(ids.slice());
          return { ok: false, items: [{ id: '1', destinationId: 'rumble-main', level: 'warn', code: 'engine-idle', message: TOKEN }] };
        }
      },
      getState: async function () {
        return { plugins: livePlugins('rumble'), notes: [TOKEN] };
      }
    });
    try {
      const result = await world.api.call('golive.check', { site: 'rumble' }, {
        permissions: ['read'],
        clientId: 'browser-1',
        kind: 'browser'
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(byStep(result, 'login').code, 'secrets-ready');
      assert.strictEqual(byStep(result, 'destination').code, 'destination-linked');
      assert.strictEqual(byStep(result, 'preflight').code, 'preflight-warn');
      assert.ok(byStep(result, 'preflight').detail.indexOf('engine-idle') !== -1);
      assert.strictEqual(byStep(result, 'shadow').code, 'shadow-unknown', 'STATE_DIR が無いので shadow の記録は読めない');
      assert.strictEqual(byStep(result, 'modes').code, 'modes-unavailable');
      assert.deepStrictEqual(queries[0], ['rumble-main']);
      assertNoSecret(result);
      const facts = await world.api.call('diagnostics.siteFacts', { site: 'rumble', secretNames: ['rumble.livestream-api', 'nope'], pluginIds: [] }, { permissions: ['read'] });
      assert.deepStrictEqual(facts.secrets, { 'rumble.livestream-api': true, nope: false });
      assert.deepStrictEqual(facts.destinations, [{ id: 'rumble-main', enabled: true, engineId: 'obs-local' }]);
      assertNoSecret(facts);
    } finally { world.done(); }
    const off = await devApi({ devMode: { get: function () { return { devMode: false, source: 'default' }; } } });
    try {
      assert.strictEqual((await off.api.call('diagnostics.siteFacts', { site: 'rumble' }, { permissions: ['read'] })).error, 'dev-only');
      assert.strictEqual((await off.api.call('golive.check', { site: 'rumble' }, { permissions: ['read'] })).error, 'dev-only');
    } finally { off.done(); }
  });

  await test('the panel is a dev-shadow plug-in panel that only reads (no mode / secret writes)', async function () {
    const dir = path.join(__dirname, '..', '..', '..', 'plugins', 'dev-shadow');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.panels.some(function (p) { return p.name === 'golive' && p.file === 'ui/golive.html'; }));
    const js = fs.readFileSync(path.join(dir, 'ui', 'golive.js'), 'utf8');
    assert.ok(js.indexOf("method: 'golive.check'") !== -1);
    ['modes.set', 'modes.setDefault', 'secrets.set', 'secrets.remove', 'broadcast.start', 'importRun'].forEach(function (word) {
      assert.strictEqual(js.indexOf(word), -1, word);
    });
    assert.ok(fs.readFileSync(path.join(dir, 'ui', 'golive.css'), 'utf8').indexOf('.golive-ok') !== -1);
  });

  if (failed) {
    console.error('[marust] w34 tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] w34 tests passed');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
