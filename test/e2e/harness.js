'use strict';

/**
 * Electron なしで、本番と同じ部品を一時 STATE_DIR の上に組み立てる。
 * OBS は偽物。サイトへの fetch は fake-peers がプロセス内で返す。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../../host/core/core-bridge');
const { createEventBus } = require('../../host/core/event-bus');
const { createStateStore } = require('../../host/core/state-store');
const { createSessions } = require('../_k3-parts');
const { createSessionStore } = require('../_k3-parts');
const { createRegistry } = require('../../host/layer1/plugin-registry');
const { createOrchestrator, createPeersBridge } = require('../_orch');
const { createChat } = require('../_k3-parts');
const { createEngineRegistry } = require('../../host/core/engine');
const { createPreflight } = require('../../host/core/engine/preflight');
const { createBroadcast } = require('../../host/core/engine/broadcast');
const { createApi } = require('../../host/layer1/api');
const { createClients } = require('../../host/layer1/clients');
const { createLayouts } = require('../../host/layer1/layouts');
const { createGateway } = require('../../host/layer1/gateway');
const { createCaptureReceiver } = require('../../host/layer1/capture-receiver');
const { createSecretProvider } = require('../../host/core/vault');
const { createFakeBackend } = require('../../host/core/vault-backends/fake');
const { EVENTS } = require('../../host/core/events');
const { installNetworkGuard } = require('./netguard');
const { answer } = require('./fake-peers');
const { authorModeSource } = require('../helpers/author-modes');

const APP_ROOT = path.join(__dirname, '..', '..');
const MODE_IDS = [
  'broadcast',
  'obs-engine',
  'slot-rumble',
  'site-twitch',
  'twitch',
  'sink-twitch',
  'comment-send',
  'chat-kukulu',
  'raid-twitch'
];

function quiet() {}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

function pluginData(dir, id) {
  return path.join(dir, 'data', 'marust', 'plugins', id);
}

function createFakeObs(mode, bus, store) {
  const states = new Map();
  states.set('t-rumble', 'stopped');
  const calls = [];

  function listTargets() {
    const rows = [];
    for (const entry of states.entries()) {
      rows.push({ id: entry[0], name: entry[0], protocol: 'RTMP', state: entry[1], enabled: true });
    }
    return rows;
  }

  function status() {
    return {
      id: 'obs-local',
      connected: true,
      supported: true,
      mode: mode,
      missing: [],
      detail: 'fake-obs',
      profileWarning: false
    };
  }

  function capabilities() {
    return {
      createTarget: true,
      setKey: true,
      perTargetQuality: false,
      emergencyStop: true,
      write: mode === 'live'
    };
  }

  return {
    id: 'obs-local',
    modeId: 'obs-engine',
    calls: calls,
    capabilities: capabilities,
    listTargets: listTargets,
    status: status,
    anyOutputLive: function () {
      for (const state of states.values()) {
        if (state === 'live') return true;
      }
      return false;
    },
    start: function (id) {
      calls.push({ op: 'start', id: id });
      states.set(String(id), 'live');
      if (store && typeof store.updateActual === 'function') {
        try { store.updateActual('rumble-main', { engineState: 'live', siteLive: true }); } catch (err) { /* keep going */ }
      }
      if (bus) bus.publish(EVENTS.STREAM_STARTED, { reason: 'obs' }, { source: 'obs-engine' });
      return { ok: true };
    },
    stop: function (id) {
      calls.push({ op: 'stop', id: id });
      states.set(String(id), 'stopped');
      return { ok: true };
    },
    setKey: function (id, settings) {
      calls.push({ op: 'setKey', id: id, hasKey: !!(settings && settings.key), hasServer: !!(settings && settings.server) });
      return { ok: true };
    },
    async stopAll(ctx) {
      calls.push({ op: 'stopAll', reason: 'emergency' });
      const info = ctx || {};
      if (bus) {
        bus.publish(EVENTS.STREAM_STOPPING, {
          reason: 'emergency',
          at: new Date().toISOString()
        }, { source: 'obs-engine', correlationId: info.correlationId || '' });
      }
      for (const id of Array.from(states.keys())) states.set(id, 'stopped');
      return { ok: true, count: states.size };
    },
    connect: async function () { return { ok: true }; },
    shutdown: function () {},
    whenReady: function () { return Promise.resolve(); }
  };
}

async function createHarness(mode) {
  if (mode !== 'shadow' && mode !== 'live') throw new Error('mode');
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w33-'));
  if (path.resolve(dir) === path.resolve(real.STATE_DIR)) throw new Error('refusing real STATE_DIR');
  const core = Object.assign({}, real, { STATE_DIR: dir });
  const guard = installNetworkGuard(answer);
  const bus = createEventBus({ logger: quiet });
  const stateStore = createStateStore({ core: core, bus: bus, logger: quiet });
  const sessions = createSessions({ store: createSessionStore({ dir: path.join(dir, 'session-test') }), bus: bus, recover: false });
  const chat = createChat({ bus: bus, logger: quiet });
  const secrets = createSecretProvider({
    core: core,
    backend: createFakeBackend(),
    allowFake: true,
    logger: quiet
  });
  let orchestrator = null;
  const registry = createRegistry({
    core: core,
    appRoot: APP_ROOT,
    bus: bus,
    chat: chat,
    secrets: secrets,
    sessions: sessions,
    store: stateStore,
    logger: quiet,
    peers: createPeersBridge(function () { return orchestrator; }),
    modeFor: function (id) {
      return orchestrator ? orchestrator.modeFor(id) : 'legacy';
    }
  });
  const modeSource = authorModeSource(core);
  orchestrator = createOrchestrator({ registry: registry, core: core, modeSource: modeSource, logger: quiet });
  const engineRegistry = createEngineRegistry();
  const engine = createFakeObs(mode, bus, stateStore);
  engineRegistry.register('obs-local', engine);

  const plugins = {};
  for (let i = 0; i < MODE_IDS.length; i += 1) plugins[MODE_IDS[i]] = mode;
  writeJson(path.join(dir, 'services', 'marust-modes.json'), { plugins: plugins });
  writeJson(path.join(pluginData(dir, 'chat-kukulu'), 'config.json'), {
    channel: 'chan1',
    account: 'main',
    intervalMs: 1000
  });
  writeJson(path.join(pluginData(dir, 'raid-twitch'), 'raid-suggested-channels.json'), {
    channels: ['raidtarget']
  });

  const oauth = JSON.stringify({
    client_id: 'fake-client',
    client_secret: 'fake-secret',
    refresh_token: 'fake-refresh',
    access_token: 'fake-access-token',
    broadcaster_id: '1001',
    expiry_date: 4102444800000
  });
  const seeded = await Promise.all([
    secrets.set('twitch.oauth', oauth, 'e2e'),
    secrets.set('rumble.livestream-api', 'fake-rumble-api-key', 'e2e'),
    secrets.set('cookies.rumble-main', 'session=fake', 'e2e'),
    secrets.set('cookies.kukulu-main', 'fake-kukulu-apikey', 'e2e')
  ]);
  for (let i = 0; i < seeded.length; i += 1) {
    if (!seeded[i] || seeded[i].ok !== true) throw new Error('vault seed failed');
  }

  stateStore.putDestination({
    id: 'rumble-main',
    site: 'rumble',
    accountId: 'main',
    enabled: true,
   
    engine: { id: 'obs-local', targetId: 't-rumble' },
    actual: { engineState: 'stopped', siteLive: false }
  });
  stateStore.putDestination({
    id: 'kukulu-main',
    site: 'kukulu',
    accountId: 'main',
    enabled: true,
   
    engine: { id: 'obs-local', targetId: 't-kukulu' },
    actual: { engineState: 'live', siteLive: true }
  });

  await registry.loadAll();

  if (guard.violations.length) {
    throw new Error('outbound during boot ' + JSON.stringify(guard.violations));
  }
  const bootWrites = guard.hits.filter(function (row) {
    return row.method === 'POST' || row.method === 'PUT' || row.method === 'PATCH' || row.method === 'DELETE';
  });
  if (bootWrites.length) throw new Error('write during boot ' + JSON.stringify(bootWrites));
  const hitMark = guard.hits.length;

  const preflight = createPreflight({
    registry: registry,
    engines: engineRegistry,
    store: stateStore,
    secrets: secrets,
    orchestrator: orchestrator,
    logger: quiet
  });
  const broadcast = createBroadcast({
    preflight: preflight,
    registry: registry,
    engines: engineRegistry,
    store: stateStore,
    sessions: sessions,
    bus: bus,
    orchestrator: orchestrator,
    logger: quiet
  });
  const clients = createClients({ core: core });
  clients.ensureWindowClient();
  const layouts = createLayouts({ core: core });
  const api = createApi({
    getState: function () {
      return { product: 'marust', mode: mode };
    },
    fanout: function (payload) {
      return orchestrator.fanout(payload);
    },
    engine: engine,
    registry: engineRegistry,
    clients: clients,
    layouts: layouts,
    sessions: sessions,
    store: stateStore,
    bus: bus,
    chat: chat,
    core: core,
    secrets: secrets,
    preflight: preflight,
    broadcast: broadcast
  });
  if (typeof registry.attachApi === 'function') registry.attachApi(api);
  const receiver = createCaptureReceiver({
    core: core,
    onStatus: async function () { return { name: 'marust', mode: mode }; }
  });
  const gateway = createGateway({
    core: core,
    receiver: receiver,
    clients: clients,
    layouts: layouts,
    api: api,
    bus: bus,
    secrets: secrets,
    store: stateStore,
    engine: engine,
    plugins: registry,
    uiRoot: path.join(APP_ROOT, 'ui')
  });

  const openSockets = new Set();
  gateway.server.on('connection', function (socket) {
    openSockets.add(socket);
    socket.on('close', function () { openSockets.delete(socket); });
  });

  await gateway.listen(18770);

  async function close() {
    const running = registry.getRunning();
    for (let i = 0; i < running.length; i += 1) {
      const rec = running[i];
      if (!rec || !rec.instance) continue;
      try { await rec.instance.stop(rec.ctx); } catch (err) { /* stop */ }
      try { await rec.instance.destroy(rec.ctx); } catch (err) { /* destroy */ }
    }
    if (gateway && gateway.clients && typeof gateway.clients.list === 'function') {
      const list = gateway.clients.list() || [];
      for (let i = 0; i < list.length; i += 1) {
        try { gateway.closeClient(list[i].id); } catch (_) { /* ignore */ }
      }
    }
    if (gateway && gateway.server) {
      if (typeof gateway.server.closeAllConnections === 'function') {
        try { gateway.server.closeAllConnections(); } catch (_) { /* ignore */ }
      }
      for (const sock of openSockets) {
        try { sock.destroy(); } catch (_) { /* ignore */ }
      }
      openSockets.clear();
      await new Promise(function (resolve) {
        gateway.server.close(function () { resolve(); });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    mode: mode,
    dir: dir,
    realStateDir: real.STATE_DIR,
    core: core,
    bus: bus,
    registry: registry,
    orchestrator: orchestrator,
    broadcast: broadcast,
    preflight: preflight,
    chat: chat,
    api: api,
    clients: clients,
    layouts: layouts,
    gateway: gateway,
    engine: engine,
    hits: guard.hits,
    hitMark: hitMark,
    violations: guard.violations,
    close: close
  };
}

module.exports = { createHarness, MODE_IDS };