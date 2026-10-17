'use strict';
const { requirePlugin } = require('./_plugins');

const assert = require('assert');
const twitch = require('./_plugins').requirePlugin('site-twitch');
const kick = requirePlugin('site-kick');

function response(status, body) {
  return { status: status, text: async function () { return JSON.stringify(body); } };
}

function context(mode, secret, logs) {
  return {
    mode: function () { return mode; },
    logger: function (level, message) { logs.push(String(level) + ':' + String(message)); },
    secrets: {
      get: async function (name) { return { ok: true, value: JSON.stringify(secret) }; },
      set: async function () { return { ok: true }; }
    }
  };
}

async function check(name, pluginFactory, url, secret) {
  const logs = [];
  let calls = 0;
  const plugin = pluginFactory({
    fetch: async function (actualUrl) {
      calls += 1;
      assert.ok(actualUrl.indexOf(url) === 0);
      return response(200, { data: Array.from({ length: 12 }, function (_, i) {
        return { id: String(i + 1), name: 'Category ' + (i + 1) };
      }) });
    },
    now: function () { return new Date('2026-10-05T00:00:00.000Z'); }
  });
  const ctx = context('live', secret, logs);
  plugin.load(ctx);
  assert.deepStrictEqual(await plugin.suggestCategories('a'), { ok: true, items: [] });
  assert.strictEqual(calls, 0, name + ' short query');
  ctx.mode = function () { return 'legacy'; };
  assert.deepStrictEqual(await plugin.suggestCategories('game'), { ok: false, error: 'legacy' });
  assert.strictEqual(calls, 0, name + ' legacy');
  ctx.mode = function () { return 'live'; };
  const first = await plugin.suggestCategories(' game ');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.items.length, 10);
  assert.deepStrictEqual(Object.keys(first.items[0]).sort(), ['id', 'name']);
  assert.strictEqual(calls, 1, name + ' first request');
  const second = await plugin.suggestCategories(' game ');
  assert.deepStrictEqual(second, first);
  assert.strictEqual(calls, 1, name + ' cache');
  assert.strictEqual(logs.join('\n').indexOf(secret.access_token), -1, name + ' token log');
  plugin.destroy();
}

(async function () {
  await check('twitch', twitch.createSiteTwitch, 'https://api.twitch.tv/helix/search/categories', {
    client_id: 'client', client_secret: 'secret', access_token: 'access-token', refresh_token: 'refresh-token'
  });
  await check('kick', kick.createSiteKick, 'https://api.kick.com/public/v1/categories', {
    client_id: 'client', client_secret: 'secret', access_token: 'access-token', refresh_token: 'refresh-token'
  });
  console.log('w53-category-suggest: ok');
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
