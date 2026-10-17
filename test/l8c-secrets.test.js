'use strict';

/**
 * L8f: 秘密の「プラグインどうしの分け」と「代理」をやめる（L8c の更新）。
 * 検査項目:
 * - 三層目が守る秘密を get → manifest で宣言していれば値が取得できる（proxy-only 廃止）
 * - 三層目が自分の守る秘密でない秘密を get → 値
 * - 三層目が別のプラグインと同じ名前 → manifest で宣言していれば値が取得できる（not-own 廃止）
 * - 未宣言の秘密はどの層でも not-declared
 * - 二層目は今までどおり（守る秘密も読め、重複しても読める）
 * - ctx.secrets.useFor は存在しない（代理廃止）
 * - ctx.secrets.has での存在確認（三層目でも存在確認が可能、未宣言は not-declared）
 * - 外から入れた同じ id は三層目
 * - 層の判定（external / community は常に三層目、builtin / author は名簿に従う）
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createRegistry } = require('../host/layer1/plugin-registry');

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

function makeWorld(extraOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l8c-test-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'services'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs', 'marust'), { recursive: true });
  const core = {
    STATE_DIR: stateDir,
    atomicWriteJsonSync(target, data) {
      fs.writeFileSync(target, JSON.stringify(data));
    }
  };
  const vault = createSecretProvider(Object.assign({
    core: core,
    backend: createFakeBackend(),
    allowFake: true,
    logger() {}
  }, extraOpts || {}));
  return { dir, stateDir, core, vault, done() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

(async () => {
  await test('vault 単体: 三層目が守る秘密を get → manifest で宣言していれば値が取得できる（proxy-only 廃止）', async () => {
    const w = makeWorld();
    try {
      await w.vault.set('twitch.oauth', 'TWITCH_TOKEN_12345', 'local-window');
      w.vault.bindDeclared((id) => (id === 'custom-third' ? ['twitch.oauth'] : []));

      const got = await w.vault.getFor('custom-third', 'twitch.oauth');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(got.value, 'TWITCH_TOKEN_12345');
    } finally {
      w.done();
    }
  });

  await test('vault 単体: 三層目が自分の守る秘密でない秘密を get → 値', async () => {
    const w = makeWorld();
    try {
      await w.vault.set('my.custom-token', 'CUSTOM_SECRET_98765', 'local-window');
      w.vault.bindDeclared((id) => (id === 'custom-third' ? ['my.custom-token'] : []));

      const got = await w.vault.getFor('custom-third', 'my.custom-token');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(got.value, 'CUSTOM_SECRET_98765');
    } finally {
      w.done();
    }
  });

  await test('vault 単体: 別のプラグインと同じ名前を宣言していても値を取得できる（not-own 廃止）', async () => {
    const w = makeWorld();
    try {
      await w.vault.set('shared.token', 'SHARED_TOKEN_11111', 'local-window');
      w.vault.bindDeclared((id) => (id === 'third-a' || id === 'other-p' ? ['shared.token'] : []));

      const got = await w.vault.getFor('third-a', 'shared.token');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(got.value, 'SHARED_TOKEN_11111');
    } finally {
      w.done();
    }
  });

  await test('vault 単体: 未宣言の秘密も get できる（L8g: 以前は not-declared。悪意への守りを外した）', async () => {
    const w = makeWorld();
    try {
      await w.vault.set('undeclared.token', 'UNDEC_12345', 'local-window');
      w.vault.bindDeclared(() => []);

      const got = await w.vault.getFor('third-a', 'undeclared.token');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(got.value, 'UNDEC_12345');
    } finally {
      w.done();
    }
  });

  await test('vault 単体: 二層目は今までどおり（守る秘密も読め、重複しても読める）', async () => {
    const w = makeWorld();
    try {
      await w.vault.set('twitch.oauth', 'TWITCH_TOKEN_12345', 'local-window');
      await w.vault.set('shared.token', 'SHARED_TOKEN_11111', 'local-window');
      w.vault.bindDeclared(
        (id) => (id === 'layer2-plugin' ? ['twitch.oauth', 'shared.token'] : ['shared.token'])
      );

      const gotGuarded = await w.vault.getFor('layer2-plugin', 'twitch.oauth');
      assert.strictEqual(gotGuarded.ok, true);
      assert.strictEqual(gotGuarded.value, 'TWITCH_TOKEN_12345');

      const gotShared = await w.vault.getFor('layer2-plugin', 'shared.token');
      assert.strictEqual(gotShared.ok, true);
      assert.strictEqual(gotShared.value, 'SHARED_TOKEN_11111');
    } finally {
      w.done();
    }
  });

  await test('context (ctx.secrets): 二層目と三層目、外から入れたプラグインも manifest で宣言した秘密を取得できる', async () => {
    const w = makeWorld();
    try {
      await w.vault.set('twitch.oauth', 'TWITCH_TOKEN_12345', 'local-window');
      await w.vault.set('custom.secret', 'CUSTOM_SECRET_AAAAA', 'local-window');
      await w.vault.set('clashing.secret', 'CLASH_SECRET_BBBBB', 'local-window');
      await w.vault.set('ext.ext-plug.foo', 'EXT_SECRET_CCCCC', 'local-window');

      const authorDir = path.join(w.dir, 'author');
      const builtinDir = path.join(w.dir, 'builtin');
      const externalDir = path.join(w.dir, 'external');
      [authorDir, builtinDir, externalDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));

      const putPlugin = (where, id, manifest, indexSrc) => {
        const pdir = path.join(where, id);
        fs.mkdirSync(pdir, { recursive: true });
        const m = Object.assign({
          id: id,
          name: id,
          version: '1.0.0',
          manifestVersion: 2,
          runtime: 'inproc',
          main: 'index.js',
          kind: 'integration',
          provides: ['ui.panel@1']
        }, manifest);
        fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify(m));
        fs.writeFileSync(path.join(pdir, 'index.js'), indexSrc || 'module.exports = { load(ctx) { module.exports.ctx = ctx; }, start() {}, stop() {}, destroy() {} };');
        return pdir;
      };

      // 1. builtin 二層目: bulk-title
      const bulkDir = putPlugin(builtinDir, 'bulk-title', {
        defaultMode: 'live',
        secrets: ['twitch.oauth', 'clashing.secret']
      });

      // 2. builtin 三層目: notify-discord
      const notifyDir = putPlugin(builtinDir, 'notify-discord', {
        defaultMode: 'live',
        secrets: ['twitch.oauth', 'custom.secret', 'clashing.secret']
      });

      // 3. external 三層目: ext-plug (外から入れたプラグイン)
      const extDir = putPlugin(externalDir, 'ext-plug', {
        defaultMode: 'live',
        secrets: ['ext.ext-plug.foo']
      });

      const registry = createRegistry({
        core: w.core,
        appRoot: w.dir,
        builtinRoot: builtinDir,
        authorRoot: authorDir,
        externalRoot: externalDir,
        secrets: w.vault,
        logger() {},
        modeFor: () => 'live',
        tierFor: () => 'advanced'
      });

      await registry.loadAll();

      const bulkMod = require(path.join(bulkDir, 'index.js'));
      const notifyMod = require(path.join(notifyDir, 'index.js'));
      const extMod = require(path.join(extDir, 'index.js'));

      assert.ok(bulkMod.ctx, 'bulkMod.ctx exists');
      assert.ok(notifyMod.ctx, 'notifyMod.ctx exists');
      assert.ok(extMod.ctx, 'extMod.ctx exists');

      // (a) 二層目 bulk-title は守る秘密 twitch.oauth を取得できる
      const bulkGot = await bulkMod.ctx.secrets.get('twitch.oauth');
      assert.strictEqual(bulkGot.ok, true);
      assert.strictEqual(bulkGot.value, 'TWITCH_TOKEN_12345');

      // (b) 三層目 notify-discord も manifest で宣言した守る秘密 twitch.oauth を値のまま取得できる（L8f で proxy-only 廃止）
      const notifyGuarded = await notifyMod.ctx.secrets.get('twitch.oauth');
      assert.strictEqual(notifyGuarded.ok, true);
      assert.strictEqual(notifyGuarded.value, 'TWITCH_TOKEN_12345');

      // (c) 三層目 notify-discord は custom.secret を取得できる
      const notifyOwn = await notifyMod.ctx.secrets.get('custom.secret');
      assert.strictEqual(notifyOwn.ok, true);
      assert.strictEqual(notifyOwn.value, 'CUSTOM_SECRET_AAAAA');

      // (d) 三層目 notify-discord は他プラグイン(bulk-title)と重複した clashing.secret も取得できる（L8f で not-own 廃止）
      const notifyClash = await notifyMod.ctx.secrets.get('clashing.secret');
      assert.strictEqual(notifyClash.ok, true);
      assert.strictEqual(notifyClash.value, 'CLASH_SECRET_BBBBB');

      // (e) 二層目 bulk-title は重複していても取得できる
      const bulkClash = await bulkMod.ctx.secrets.get('clashing.secret');
      assert.strictEqual(bulkClash.ok, true);
      assert.strictEqual(bulkClash.value, 'CLASH_SECRET_BBBBB');

      // (f) external プラグインは自分の秘密 ext.ext-plug.foo を取得できる
      const extGot = await extMod.ctx.secrets.get('ext.ext-plug.foo');
      assert.strictEqual(extGot.ok, true);
      assert.strictEqual(extGot.value, 'EXT_SECRET_CCCCC');

      // (g) ctx.secrets.useFor は存在しない（L8f で代理廃止）
      assert.strictEqual(notifyMod.ctx.secrets.useFor, undefined);

      // (h) ctx.secrets.has での存在確認（三層目でも存在確認が可能）
      const hasTwitch = await notifyMod.ctx.secrets.has('twitch.oauth');
      assert.strictEqual(hasTwitch.ok, true);
      assert.strictEqual(hasTwitch.has, true);

      // (i) 宣言しているが存在する秘密
      const hasCustom = await notifyMod.ctx.secrets.has('custom.secret');
      assert.strictEqual(hasCustom.ok, true);
      assert.strictEqual(hasCustom.has, true);

      // (j) L8g: 未宣言の秘密も has・get できる（以前は not-declared）。set だけは宣言が要る
      const hasUndeclared = await notifyMod.ctx.secrets.has('undeclared.secret');
      assert.strictEqual(hasUndeclared.ok, true);
      assert.strictEqual(typeof hasUndeclared.has, 'boolean');

      const getUndeclared = await notifyMod.ctx.secrets.get('undeclared.secret');
      assert.notStrictEqual(getUndeclared.error, 'not-declared');

      const setUndeclared = await notifyMod.ctx.secrets.set('undeclared.secret', 'x');
      assert.strictEqual(setUndeclared.ok, false);
      assert.strictEqual(setUndeclared.error, 'not-declared');
    } finally {
      w.done();
    }
  });

  await test('層の判定: external / community は常に三層目、builtin / author は名簿に従う', async () => {
    const layers = require('../host/layer1/plugin-layers.json');
    assert.ok(layers.layer2.indexOf('bulk-title') !== -1, 'bulk-title is in layer2');
    assert.ok(layers.layer2.indexOf('kukulu-port') !== -1, 'kukulu-port is in layer2');

    // context.js の判定ロジック検証
    const isThirdLayer = (id, source, community) => {
      if (source === 'user' || community === true) return true;
      if (source !== 'set') return true;
      const l1 = Array.isArray(layers.layer1) ? layers.layer1 : [];
      const l2 = Array.isArray(layers.layer2) ? layers.layer2 : [];
      if (l1.indexOf(id) !== -1 || l2.indexOf(id) !== -1) return false;
      const m = /^(site|sink|slot)-([a-z0-9-]+)$/.exec(id);
      if (m && l1.indexOf(m[2]) !== -1) return false;
      return true;
    };

    // builtin: 名簿にあれば二層目、なければ三層目
    assert.strictEqual(isThirdLayer('bulk-title', 'set', false), false);
    assert.strictEqual(isThirdLayer('notify-discord', 'set', false), true);

    // author: 名簿にあれば二層目、なければ三層目
    assert.strictEqual(isThirdLayer('kukulu-port', 'set', false), false);
    assert.strictEqual(isThirdLayer('dev-storage-locator', 'set', false), true);

    // external: 名簿にある名前でも常に三層目
    assert.strictEqual(isThirdLayer('bulk-title', 'user', false), true);

    // community: 名簿にある名前でも常に三層目
    assert.strictEqual(isThirdLayer('bulk-title', 'set', true), true);
  });

  if (failed > 0) {
    console.error(`\n[l8c-secrets] ${failed} tests failed`);
    process.exit(1);
  } else {
    console.log('\n[marust] l8c-secrets tests passed');
  }
})();
