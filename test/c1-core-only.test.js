'use strict';

/**
 * 計画 C・C1-3: 核だけで動く。セット（プラグインの置き場）を空にして組み立て、
 * 窓口の API（CLI の status・destinations・start・stop・stop-all が呼ぶ名前）とトレイのメニュー（開く・全部止める・終了）を確かめる。
 * Electron は起動しない（トレイは偽の Tray/Menu）。本物のサイトにはつながない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createSessions, createSessionStore, createChat } = require('./_k3-parts');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createOrchestrator } = require('../host/layer1/orchestrator');
const { createModeSource } = require('../host/layer1/mode-source');
const { createEngineRegistry } = require('../host/core/engine');
const { createPreflight } = require('../host/core/engine/preflight');
const { createBroadcast } = require('../host/core/engine/broadcast');
const { createApi, IPC_PERMISSIONS } = require('../host/layer1/api');
const { createClients, WINDOW_ID } = require('../host/layer1/clients');
const { createLayouts } = require('../host/layer1/layouts');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createTray, MENU_LABELS } = require('../host/layer1/tray');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
function quiet() {}

function fakeEngine(calls) {
  const states = new Map([['t1', 'stopped']]);
  return {
    id: 'obs-local',
    modeId: 'obs-engine',
    calls: calls,
    capabilities: () => ({ createTarget: true, setKey: true, perTargetQuality: false, emergencyStop: true, write: true }),
    listTargets: () => Array.from(states.entries()).map(([id, state]) => ({ id, name: id, protocol: 'RTMP', state, enabled: true })),
    status: () => ({ id: 'obs-local', connected: true, supported: true, mode: 'shadow', missing: [], detail: 'fake-obs', profileWarning: false }),
    anyOutputLive: () => Array.from(states.values()).indexOf('live') !== -1,
    start: (id) => { calls.push('start:' + id); states.set(String(id), 'live'); return { ok: true }; },
    stop: (id) => { calls.push('stop:' + id); states.set(String(id), 'stopped'); return { ok: true }; },
    setKey: () => ({ ok: true }),
    stopAll: async () => { calls.push('stopAll'); for (const id of Array.from(states.keys())) states.set(id, 'stopped'); return { ok: true, count: states.size }; },
    connect: async () => ({ ok: true }),
    shutdown() {},
    whenReady: () => Promise.resolve()
  };
}

async function build() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-core-'));
  if (path.resolve(dir) === path.resolve(real.STATE_DIR)) throw new Error('refusing real STATE_DIR');
  const emptySet = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c1-set-'));
  const core = Object.assign({}, real, { STATE_DIR: dir });
  const bus = createEventBus({ logger: quiet });
  const store = createStateStore({ core, bus, logger: quiet });
  const sessions = createSessions({ store: createSessionStore({ dir: path.join(dir, 'session-test') }), bus, recover: false });
  const chat = createChat({ bus, logger: quiet });
  const secrets = createSecretProvider({ core, backend: createFakeBackend(), allowFake: true, logger: quiet });
  let orchestrator = null;
  // セットは全部空（セット・作者用・みんなのプラグインのどれも無い）
  const registry = createRegistry({
    core, appRoot: emptySet, builtinRoot: emptySet, authorRoot: emptySet, communityRoot: '',
    externalRoot: path.join(dir, 'plugins'), bus, chat, secrets, sessions, store, logger: quiet,
    modeFor: (id) => (orchestrator ? orchestrator.modeFor(id) : 'legacy')
  });
  orchestrator = createOrchestrator({ registry, core, modeSource: createModeSource(), logger: quiet });
  const calls = [];
  const engine = fakeEngine(calls);
  const engines = createEngineRegistry();
  engines.register('obs-local', engine);
  store.putDestination({ id: 'sample-main', site: 'sample', accountId: 'main', enabled: true, engine: { id: 'obs-local', targetId: 't1' }, actual: { engineState: 'stopped', siteLive: false } });
  const rows = await registry.loadAll();
  const preflight = createPreflight({ registry, engines, store, secrets, orchestrator, logger: quiet });
  const broadcast = createBroadcast({ preflight, registry, engines, store, sessions, bus, orchestrator, logger: quiet });
  const clients = createClients({ core });
  clients.ensureWindowClient();
  const layouts = createLayouts({ core });
  const api = createApi({
    getState: () => ({ product: 'marust', mode: 'shadow' }),
    fanout: (payload) => orchestrator.fanout(payload),
    engine, registry: engines, clients, layouts, sessions, store, bus, chat, core, secrets, preflight, broadcast
  });
  if (typeof registry.attachApi === 'function') registry.attachApi(api);
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  return { api, win, rows, registry, calls, engine, done() { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(emptySet, { recursive: true, force: true }); } };
}

async function main() {
  const t = await build();
  try {
    await test('セットが空でも起動できる（プラグインの行が 0・読み込みの失敗が無い）', async () => {
      assert.deepStrictEqual(t.rows.filter((r) => r.status === 'skip'), []);
      assert.strictEqual(t.registry.getRunning().length, 0);
    });

    await test('CLI の status（hub.getState）・destinations（destination.list）・plugins.list', async () => {
      const state = await t.api.call('hub.getState', {}, t.win);
      assert.notStrictEqual(state.ok, false, JSON.stringify(state));
      const list = await t.api.call('destination.list', {}, t.win);
      assert.ok(Array.isArray(list.destinations) && list.destinations.some((d) => d.id === 'sample-main'), JSON.stringify(list));
      const plugins = await t.api.call('plugins.list', {}, t.win);
      assert.deepStrictEqual(plugins.plugins.filter((p) => p.state === 'running'), []);
    });

    await test('CLI の start・stop・stop-all が呼ぶ API が、核だけで通る', async () => {
      const started = await t.api.call('destination.start', { id: 'sample-main' }, t.win);
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      assert.ok(t.calls.indexOf('start:t1') !== -1);
      const stopped = await t.api.call('destination.stop', { id: 'sample-main' }, t.win);
      assert.strictEqual(stopped.ok, true, JSON.stringify(stopped));
      assert.ok(t.calls.indexOf('stop:t1') !== -1);
      await t.api.call('destination.start', { id: 'sample-main' }, t.win);
      const all = await t.api.call('broadcast.stopAll', {}, t.win);
      assert.strictEqual(all.ok, true, JSON.stringify(all));
      assert.strictEqual(t.engine.anyOutputLive(), false);
    });

    await test('トレイのメニュー（開く・ブラウザで開く・全部止める・終了）は核だけで動く', async () => {
      let opened = 0;
      let quit = 0;
      let menu = null;
      function Tray() { this.setToolTip = () => {}; this.setContextMenu = () => {}; this.setImage = () => {}; this.destroy = () => {}; }
      const tray = createTray({
        Tray,
        Menu: { buildFromTemplate: (tpl) => { menu = tpl; return tpl; } },
        nativeImage: { createFromPath: (p) => ({ p }) },
        getButtonState: () => ({ connected: true, live: false }),
        emergencyStop: () => t.api.call('engine.emergencyStop', {}, { permissions: IPC_PERMISSIONS.slice(), via: 'tray', kind: 'tray' }),
        openWindow: () => { opened += 1; },
        quit: () => { quit += 1; },
        openBrowser: () => {}
      });
      assert.deepStrictEqual(menu.map((i) => i.label), [MENU_LABELS.open, MENU_LABELS.browser, MENU_LABELS.emergency, MENU_LABELS.quit]);
      await t.api.call('destination.start', { id: 'sample-main' }, t.win);
      assert.strictEqual(t.engine.anyOutputLive(), true);
      await tray.click(MENU_LABELS.open);
      assert.strictEqual(opened, 1);
      const r = await tray.click(MENU_LABELS.emergency);
      assert.ok(r && r.ok !== false, JSON.stringify(r));
      assert.strictEqual(t.engine.anyOutputLive(), false);
      await tray.click(MENU_LABELS.quit);
      assert.strictEqual(quit, 1);
      tray.destroy();
    });
  } finally {
    t.done();
  }
  if (failed) { console.error('[marust] c1 core-only tests failed ' + failed); process.exit(1); }
  console.log('[marust] c1 core-only tests passed');
}
main().catch((err) => { console.error(err); process.exit(1); });
