'use strict';

/**
 * 計画 C・C5: needs の口。表と定数、coreApi 2 は断る、1 と未記載は警告、log は常に、ui.panel、PLUGIN_API_MIN。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createEventBus } = require('../host/core/event-bus');
const { PLUGIN_API_VERSION, PLUGIN_API_MIN, judgeCoreApi, coreApiProblem } = require('../host/layer1/registry/manifest');
const { CTX_PORT_NAMES } = require('../host/layer1/registry/ctx-ports');
const { manifestFor } = require('../host/layer1/plugin-scaffold');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function writePlugin(root, id, extra) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({
    id: id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js'
  }, extra)));
  const src = "'use strict';\nmodule.exports = { load(ctx) { global.__c5 = global.__c5 || {}; global.__c5['" + id + "'] = ctx; }, start() {}, stop() {}, destroy() {} };\n";
  fs.writeFileSync(path.join(dir, 'index.js'), src);
}

function needsMessage(err, name) {
  return err && err.code === 'needs-missing' && err.message === 'needs に "' + name + '" がありません';
}

async function main() {
  await test('口の表は核の定数と一致する', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PLUGIN-API.md'), 'utf8');
    const block = doc.split('<!-- c5-ports -->')[1].split('<!-- /c5-ports -->')[0];
    const names = [];
    block.split('\n').forEach((line) => {
      const match = /^\| `([^`]+)` \|/.exec(line);
      if (match) names.push(match[1]);
    });
    assert.deepStrictEqual(names, CTX_PORT_NAMES.slice());
    ['id', 'pluginDir', 'manifest', 'logger', 'redact', 'log', 'events.names', 'app', 'mode'].forEach((name) => {
      const row = block.split('\n').find((line) => line.indexOf('| `' + name + '` |') === 0);
      assert.ok(row && row.indexOf('常に渡す') !== -1, name);
    });
    const note = doc.split('<!-- /c5-ports -->')[1].split('## ')[0];
    ['storage', 'events.subscribe', 'events.emit', 'ui.panel', 'api.register'].forEach((name) => {
      assert.ok(note.includes(name), name);
    });
    assert.ok(note.includes('読む') && note.includes('書く') && note.includes('合図を受ける') && note.includes('合図を出す') && note.includes('画面を足す') && note.includes('窓口にメソッドを足す'));
  });

  await test('版は 2・下限は 1・古すぎは core-api-too-old', () => {
    assert.strictEqual(PLUGIN_API_VERSION, 2);
    assert.strictEqual(PLUGIN_API_MIN, 1);
    assert.strictEqual(judgeCoreApi(1, 2, 2), 'core-api-too-old');
    assert.strictEqual(judgeCoreApi(2, 2, 1), '');
    assert.strictEqual(coreApiProblem({}), '');
    assert.strictEqual(coreApiProblem({ coreApi: null }), '');
    assert.strictEqual(coreApiProblem({ coreApi: 1 }), '');
    assert.strictEqual(coreApiProblem({ coreApi: 2 }), '');
    assert.strictEqual(coreApiProblem({ coreApi: 3 }), 'core-api-too-new');
    assert.strictEqual(coreApiProblem({ coreApi: 0 }), 'bad-core-api');
  });

  await test('ひな形の manifest は coreApi 2。mode は常に渡すので needs は無い', () => {
    const tool = JSON.parse(manifestFor('demo-tool', false));
    assert.strictEqual(tool.coreApi, 2);
    assert.ok(!Object.prototype.hasOwnProperty.call(tool, 'needs'));
    const site = JSON.parse(manifestFor('site-demo', true));
    assert.strictEqual(site.coreApi, 2);
    assert.ok(!Object.prototype.hasOwnProperty.call(site.roles.site, 'needs'));
  });

  await test('coreApi 2 は宣言なしを断り、宣言と log は動く。1 と未記載は警告', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c5-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c5-state-'));
    const logs = [];
    delete global.__c5;
    try {
      writePlugin(root, 'bare', { coreApi: 2 });
      writePlugin(root, 'with-sec', { coreApi: 2, needs: ['secrets'] });
      writePlugin(root, 'with-obs', { coreApi: 2, needs: ['obs.read'] });
      writePlugin(root, 'with-ui', { coreApi: 2, needs: ['ui.panel'], panels: [{ name: 'main', title: '元', file: 'ui/panel.html' }] });
      writePlugin(root, 'obs-ctl', { coreApi: 2, needs: ['obs.streamControl'] });
      writePlugin(root, 'old', { coreApi: 1 });
      writePlugin(root, 'omit', {});
      writePlugin(root, 'future', { coreApi: 3 });
      const registry = createRegistry({
        core: { STATE_DIR: state },
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(state, 'plugins'),
        bus: createEventBus({ logger() {} }),
        secrets: { async getFor() { return { ok: true, value: 'token-value' }; } },
        obsControl: async () => ({ ok: true }),
        logger: (level, message) => logs.push(level + ':' + message)
      });
      const rows = await registry.loadAll();
      const by = (id) => rows.find((row) => row.id === id);
      assert.strictEqual(by('bare').status, 'running', by('bare').reason);
      assert.strictEqual(by('future').status, 'skip');
      assert.strictEqual(by('future').reason, 'core-api-too-new');
      const bare = global.__c5.bare;
      assert.throws(() => { void bare.secrets; }, (err) => needsMessage(err, 'secrets'));
      assert.throws(() => bare.bus.publish('x', {}), (err) => needsMessage(err, 'events.emit'));
      assert.strictEqual(bare.obs, undefined);
      assert.throws(() => { void bare.ui; }, (err) => needsMessage(err, 'ui.panel'));
      const ctl = global.__c5['obs-ctl'];
      assert.strictEqual(typeof ctl.obs.streamControl, 'function');
      assert.throws(() => { void ctl.obs.getStreamStatus; }, (err) => needsMessage(err, 'obs.read'));
      assert.throws(() => { void ctl.obs.isStreaming; }, (err) => needsMessage(err, 'obs.read'));
      assert.deepStrictEqual(await ctl.obs.streamControl({ action: 'check' }), { ok: false, error: 'not-live' });
      assert.strictEqual(bare.config, undefined);
      assert.strictEqual(bare.log.appendJsonl('note', { a: 1 }), true);
      const sec = global.__c5['with-sec'];
      assert.deepStrictEqual(await sec.secrets.get('any'), { ok: true, value: 'token-value' });
      assert.strictEqual(global.__c5['with-obs'].obs, undefined);
      const uiCtx = global.__c5['with-ui'];
      assert.deepStrictEqual(uiCtx.ui.panel({ name: 'extra', title: '追加', file: 'ui/panel.html' }), { ok: true, name: 'extra' });
      assert.deepStrictEqual(uiCtx.ui.panel({ name: 'extra', title: '追加', file: 'ui/panel.html' }), { ok: false, error: 'taken' });
      assert.deepStrictEqual(uiCtx.ui.panel({ name: 'NO', title: '', file: 'nope' }), { ok: false, error: 'bad-panel' });
      const live = registry.snapshot().find((row) => row.id === 'with-ui').manifest.panels.map((panel) => panel.name);
      assert.deepStrictEqual(live, ['main', 'extra']);
      assert.deepStrictEqual(uiCtx.manifest.panels.map((panel) => panel.name), ['main']);
      const old = global.__c5.old;
      assert.strictEqual(typeof old.secrets.get, 'function');
      assert.strictEqual(typeof global.__c5.omit.secrets.get, 'function');
      const warned = logs.filter((line) => line.indexOf('needs-undeclared') !== -1);
      assert.ok(warned.some((line) => line.indexOf('old') !== -1 && line.indexOf('secrets') !== -1), warned.join('\n'));
      assert.ok(warned.some((line) => line.indexOf('omit') !== -1 && line.indexOf('secrets') !== -1), warned.join('\n'));
      const before = logs.length;
      void old.secrets;
      void global.__c5.omit.secrets;
      assert.strictEqual(logs.length, before);
    } finally {
      delete global.__c5;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  await test('常に渡す口は宣言なしで使える・strict でも断らない', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c5-always-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c5-always-state-'));
    delete global.__c5;
    try {
      writePlugin(root, 'bare', { coreApi: 2 });
      const registry = createRegistry({
        core: { STATE_DIR: state },
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(state, 'plugins'),
        bus: createEventBus({ logger() {} }),
        app: { version: '1.2.3', releasesRepo: 'own/marust' },
        logger() {}
      });
      const rows = await registry.loadAll();
      assert.strictEqual(rows.find((row) => row.id === 'bare').status, 'running');
      const ctx = global.__c5.bare;
      assert.strictEqual(ctx.id, 'bare');
      assert.strictEqual(typeof ctx.pluginDir, 'string');
      assert.ok(ctx.pluginDir.length > 0);
      assert.strictEqual(ctx.manifest.id, 'bare');
      assert.strictEqual(typeof ctx.logger, 'function');
      ctx.logger('info', 'always');
      assert.strictEqual(ctx.redact('token=abc'), ctx.redact('token=abc'));
      assert.ok(ctx.events && ctx.events.NAMES);
      assert.deepStrictEqual(Object.assign({}, ctx.app), { version: '1.2.3', releasesRepo: 'own/marust' });
      assert.strictEqual(ctx.mode(), 'legacy');
      assert.strictEqual(ctx.log.appendJsonl('note', { a: 1 }), true);
      assert.throws(() => { void ctx.secrets; }, (err) => needsMessage(err, 'secrets'));
    } finally {
      delete global.__c5;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  if (failed) { console.error('[marust] c5 needs tests failed ' + failed); process.exit(1); }
  console.log('[marust] c5 needs tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
