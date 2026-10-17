'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createCore } = require('../host/core/core-bridge');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createEventBus } = require('../host/core/event-bus');
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

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const V1_PLUGIN = `'use strict';
module.exports = {
  load() {},
  start() {},
  stop() {},
  destroy() {},
  isConfigured() { return true; },
  health() { return { ok: true }; },
  updateStream() { return { ok: true }; },
  onObsEvent() { return { ok: true }; }
};
`;

const V2_PLUGIN = `'use strict';
module.exports = {
  load() {},
  start() {},
  stop() {},
  destroy() {},
  onEvent(name, payload, meta) {
    this.events = this.events || [];
    this.events.push({ name, payload, meta });
  }
};
`;

async function main() {
  await test('v1 manifest maps to v2 equivalent without rewriting the file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-reg-v1-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-reg-state-'));
    try {
      const dir = path.join(root, 'alpha');
      const manifestPath = path.join(dir, 'manifest.json');
      writeJson(manifestPath, {
        id: 'alpha',
        name: 'Alpha',
        version: '0.1.0',
        main: 'index.js',
        kind: 'site',
        capabilities: ['title', 'category', 'obs-start', 'obs-stop'],
        fanout: { requires: 'title-or-category', method: 'updateStream' }
      });
      fs.writeFileSync(path.join(dir, 'index.js'), V1_PLUGIN);
      const before = hash(manifestPath);
      const registry = createRegistry({
        core: { STATE_DIR: state },
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(state, 'plugins'),
        logger() {}
      });
      const rows = await registry.loadAll();
      const row = rows.find((item) => item.id === 'alpha');
      assert.strictEqual(row.status, 'running');
      assert.deepStrictEqual(row.manifest.provides, ['stream.site@1', 'stream.lifecycle@1']);
      assert.deepStrictEqual(row.manifest.fanout, { requires: 'title-or-category', method: 'updateStream' });
      assert.ok(row.manifest.manifestVersion !== 2);
      assert.strictEqual(hash(manifestPath), before);
      const disk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(!Object.prototype.hasOwnProperty.call(disk, 'provides'));
    } finally {
      rimraf(root);
      rimraf(state);
    }
  });

  await test('invalid v2 fields warn only and the plugin still starts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-reg-v2-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-reg-state-'));
    const logs = [];
    try {
      const dir = path.join(root, 'v2bad');
      const manifestPath = path.join(dir, 'manifest.json');
      writeJson(manifestPath, {
        id: 'v2bad',
        name: 'Bad fields',
        version: '1.0.0',
        manifestVersion: 2,
        runtime: 'inproc',
        main: 'index.js',
        provides: ['nope', 'ui.panel@1'],
        subscribes: ['session.*', 'nope'],
        secrets: [123, 'google.oauth'],
        timeouts: { onEvent: -5, health: 1500 },
        defaultMode: 'sometimes',
        configSchema: '../secrets.json'
      });
      fs.writeFileSync(path.join(dir, 'index.js'), V2_PLUGIN);
      const before = fs.readFileSync(manifestPath, 'utf8');
      const bus = createEventBus({ logger() {} });
      const registry = createRegistry({
        core: { STATE_DIR: state },
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(state, 'plugins'),
        bus,
        logger: (level, message) => logs.push(level + ':' + message)
      });
      const rows = await registry.loadAll();
      const row = rows.find((item) => item.id === 'v2bad');
      assert.strictEqual(row.status, 'running');
      assert.deepStrictEqual(row.manifest.provides, ['ui.panel@1']);
      assert.deepStrictEqual(row.manifest.subscribes, ['session.*']);
      assert.deepStrictEqual(row.manifest.secrets, ['google.oauth']);
      assert.strictEqual(row.manifest.timeouts.health, 1500);
      assert.ok(!Object.prototype.hasOwnProperty.call(row.manifest.timeouts, 'onEvent'));
      assert.ok(row.manifest.defaultMode == null);
      assert.ok(row.manifest.configSchema == null);
      const text = logs.join('\n');
      assert.ok(text.includes('ignore provides count=1'));
      assert.ok(text.includes('ignore subscribes count=1'));
      assert.ok(text.includes('ignore secrets count=1'));
      assert.ok(text.includes('ignore timeout'));
      assert.ok(text.includes('ignore defaultMode'));
      assert.ok(text.includes('ignore configSchema'));
      assert.ok(!text.includes('123'));
      assert.ok(!text.includes('../secrets.json'));
      assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), before);
      const running = registry.getRunning().find((item) => item.id === 'v2bad');
      bus.publish(EVENTS.SESSION_PAUSED, { title: 'x' });
      bus.publish('nope', { title: 'y' });
      await bus.flush();
      const names = running.instance.events.map((item) => item.name);
      assert.deepStrictEqual(names, [EVENTS.SESSION_PAUSED]);
      assert.strictEqual(running.instance.events[0].meta.pluginId, 'v2bad');
    } finally {
      rimraf(root);
      rimraf(state);
    }
  });

  await test('child runtime is listed and does not start', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-reg-child-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-reg-state-'));
    try {
      const dir = path.join(root, 'childplug');
      writeJson(path.join(dir, 'manifest.json'), {
        id: 'childplug',
        name: 'Child',
        version: '1.0.0',
        manifestVersion: 2,
        runtime: 'child',
        main: 'index.js',
        provides: ['session.recorder@1'],
        subscribes: ['session.*']
      });
      fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nrequire('fs').writeFileSync(require('path').join(__dirname, 'STARTED'), '1');\n");
      const registry = createRegistry({
        core: { STATE_DIR: state },
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(state, 'plugins'),
        logger() {}
      });
      const rows = await registry.loadAll();
      const row = rows.find((item) => item.id === 'childplug');
      assert.strictEqual(row.status, 'listed-not-started');
      assert.strictEqual(row.reason, 'runtime-not-supported-yet');
      assert.ok(!fs.existsSync(path.join(dir, 'STARTED')));
      assert.strictEqual(registry.getRunning().length, 0);
    } finally {
      rimraf(root);
      rimraf(state);
    }
  });

  if (failed) {
    console.error('[marust] registry tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] registry tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
