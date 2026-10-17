'use strict';

// L11b: ログインの列を、二層目のプラグインがあるサイトだけにする（直す所 3）

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createSiteConfig, layer2DeclaredNames } = require('../host/layer1/site-config');

let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const sampleLayers = {
  layer1: ['youtube', 'twitch', 'nicovideo'],
  layer2: ['site-login', 'kukulu-port']
};

test('一層目のサイトのプラグインだけが動いているとき: layer2DeclaredNames は空、hasLayer2 は false', async () => {
  const snapshot = [
    { id: 'youtube', status: 'running', manifest: { secrets: ['youtube.oauth'] } },
    { id: 'twitch', status: 'running', manifest: { secrets: ['twitch.oauth'] } }
  ];
  const declared = layer2DeclaredNames(snapshot, sampleLayers);
  assert.deepStrictEqual(declared, []);

  const cfg = createSiteConfig({
    secrets: { list: async () => ({ ok: true, secrets: [] }) },
    getDeclaredNames: () => declared,
    getSites: async () => [
      { id: 'youtube', login: { type: 'oauth' }, secretNames: ['youtube.oauth'] },
      { id: 'twitch', login: { type: 'oauth' }, secretNames: ['twitch.oauth'] }
    ]
  });
  const res = await cfg.loginFacts();
  assert.strictEqual(res.ok, true);
  assert.ok(res.sites.every((s) => s.hasLayer2 === false));
});

test('二層目の site-login が running で youtube.oauth を宣言: youtube の行だけ hasLayer2: true', async () => {
  const snapshot = [
    { id: 'youtube', status: 'running', manifest: { secrets: ['youtube.oauth'] } },
    { id: 'site-login', status: 'running', manifest: { secrets: ['youtube.oauth'] } }
  ];
  const declared = layer2DeclaredNames(snapshot, sampleLayers);
  assert.deepStrictEqual(declared, ['youtube.oauth']);

  const cfg = createSiteConfig({
    secrets: { list: async () => ({ ok: true, secrets: [] }) },
    getDeclaredNames: () => declared,
    getSites: async () => [
      { id: 'youtube', login: { type: 'oauth' }, secretNames: ['youtube.oauth'] },
      { id: 'twitch', login: { type: 'oauth' }, secretNames: ['twitch.oauth'] }
    ]
  });
  const res = await cfg.loginFacts();
  assert.strictEqual(res.ok, true);
  const yt = res.sites.find((s) => s.id === 'youtube');
  const tw = res.sites.find((s) => s.id === 'twitch');
  assert.strictEqual(yt.hasLayer2, true);
  assert.strictEqual(tw.hasLayer2, false);
});

test('二層目でも status が running でなければ数えない', () => {
  const snapshot = [
    { id: 'site-login', status: 'stopped', manifest: { secrets: ['youtube.oauth'] } },
    { id: 'site-login', status: 'error', manifest: { secrets: ['twitch.oauth'] } },
    { id: 'kukulu-port', status: 'disabled', manifest: { secrets: ['kukulu.config'] } }
  ];
  const declared = layer2DeclaredNames(snapshot, sampleLayers);
  assert.deepStrictEqual(declared, []);
});

test('三層目（一覧に無い id）が twitch.oauth を宣言しても数えない', () => {
  const snapshot = [
    { id: 'my-login', status: 'running', manifest: { secrets: ['twitch.oauth'] } },
    { id: 'custom-plugin', status: 'running', manifest: { secrets: ['cookies.custom-auth'] } }
  ];
  const declared = layer2DeclaredNames(snapshot, sampleLayers);
  assert.deepStrictEqual(declared, []);
});

test('実物の plugin-layers.json と実物の site-login/manifest.json: site-login が layer2 にあり、youtube・twitch・kick が hasLayer2: true', async () => {
  const realLayers = require('../host/layer1/plugin-layers.json');
  const siteLoginManifestFile = path.join(__dirname, '..', 'plugins', 'site-login', 'manifest.json');
  const realSiteLoginManifest = JSON.parse(fs.readFileSync(siteLoginManifestFile, 'utf8'));

  assert.ok(Array.isArray(realLayers.layer2), 'layer2 は配列');
  assert.ok(realLayers.layer2.includes('site-login'), 'site-login は layer2 にあること');

  const snapshot = [
    { id: 'site-login', status: 'running', manifest: realSiteLoginManifest }
  ];
  const declared = layer2DeclaredNames(snapshot, realLayers);

  const cfg = createSiteConfig({
    secrets: { list: async () => ({ ok: true, secrets: [] }) },
    getDeclaredNames: () => declared,
    getSites: async () => [
      { id: 'youtube', login: { type: 'oauth' }, secretNames: ['youtube.oauth'] },
      { id: 'twitch', login: { type: 'oauth' }, secretNames: ['twitch.oauth'] },
      { id: 'kick', login: { type: 'oauth' }, secretNames: ['kick.oauth'] },
      { id: 'nicovideo', login: { type: 'cookie' }, secretNames: ['cookies.nicovideo-user_session'] },
      { id: 'twitcasting', login: { type: 'cookie' }, secretNames: ['cookies.twitcasting-tc_id'] }
    ]
  });
  const res = await cfg.loginFacts();
  assert.strictEqual(res.ok, true);

  const byId = Object.fromEntries(res.sites.map((s) => [s.id, s.hasLayer2]));
  assert.strictEqual(byId.youtube, true, 'youtube は hasLayer2: true');
  assert.strictEqual(byId.twitch, true, 'twitch は hasLayer2: true');
  assert.strictEqual(byId.kick, true, 'kick は hasLayer2: true');
  assert.strictEqual(byId.nicovideo, false, 'nicovideo は hasLayer2: false');
  assert.strictEqual(byId.twitcasting, false, 'twitcasting は hasLayer2: false');
});

test('実物の kukulu-port: kukulu-port が layer2 にあり、kukulu が hasLayer2: true', async () => {
  const realLayers = require('../host/layer1/plugin-layers.json');
  const kukuluPortManifestFile = path.join(__dirname, '..', 'plugins', 'kukulu-port', 'manifest.json');
  const realKukuluPortManifest = JSON.parse(fs.readFileSync(kukuluPortManifestFile, 'utf8'));

  assert.ok(realLayers.layer2.includes('kukulu-port'), 'kukulu-port は layer2 にあること');

  const snapshot = [
    { id: 'kukulu-port', status: 'running', manifest: realKukuluPortManifest }
  ];
  const declared = layer2DeclaredNames(snapshot, realLayers);
  assert.ok(declared.includes('kukulu.config'));

  const cfg = createSiteConfig({
    secrets: { list: async () => ({ ok: true, secrets: [] }) },
    getDeclaredNames: () => declared,
    getSites: async () => [
      { id: 'kukulu', login: { type: 'config' }, secretNames: ['kukulu.config'] }
    ]
  });
  const res = await cfg.loginFacts();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sites[0].hasLayer2, true, 'kukulu は hasLayer2: true');
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      console.log('ok ' + name);
    } catch (err) {
      failed += 1;
      console.error('FAIL ' + name);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  if (failed) {
    console.error(failed + ' 件失敗');
    process.exit(1);
  }
  console.log('l11b: すべて ok');
})();
