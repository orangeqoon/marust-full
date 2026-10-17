'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const { createCore } = require('../host/core/core-bridge');
const { createCaptureReceiver } = require('../host/layer1/capture-receiver');
const { createGateway } = require('../host/layer1/gateway');
const { createClients, WINDOW_ID } = require('../host/layer1/clients');
const { createApi } = require('../host/layer1/api');
const { createApprovals } = require('../host/layer1/approvals');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createSessions, createSessionStore } = require('./_k3-parts');
const { createEngineRegistry } = require('../host/core/engine');

const SECRET = 'w5-stream-9f3a-zz';
const CLI = path.join(__dirname, '..', 'cli', 'marust.js');

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function fakeCore(dir) {
  const core = createCore();
  return {
    STATE_DIR: dir,
    COOKIES_DIR: path.join(dir, 'cookies'),
    SERVICES_DIR: path.join(dir, 'services'),
    DATA_DIR: path.join(dir, 'data'),
    atomicWriteJsonSync: core.atomicWriteJsonSync
  };
}

function request(port, method, urlPath, body, headers) {
  return new Promise(function (resolve, reject) {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: urlPath,
      method: method,
      headers: Object.assign({ Host: '127.0.0.1:18770' }, headers || {}, payload == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      })
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (payload == null) req.end();
    else req.end(payload);
  });
}

function tryWs(port, headers) {
  return new Promise(function (resolve) {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: headers || {} });
    let settled = false;
    const finish = function (row) {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ws: ws }, row));
    };
    ws.once('open', function () { finish({ open: true }); });
    ws.once('unexpected-response', function (_req, res) {
      res.resume();
      finish({ open: false, status: res.statusCode });
    });
    ws.on('error', function () {});
    setTimeout(function () { finish({ open: false, status: 0 }); }, 1500);
  });
}

function rpc(ws, method, params) {
  return new Promise(function (resolve, reject) {
    const id = Math.floor(Math.random() * 1000000000);
    const timer = setTimeout(function () { reject(new Error('rpc-timeout ' + method)); }, 2000);
    function onMessage(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }));
  });
}

function runCli(args, env) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [CLI].concat(args), {
      env: Object.assign({}, process.env, env || {}),
      cwd: path.join(__dirname, '..')
    });
    const out = [];
    const err = [];
    child.stdout.on('data', function (chunk) { out.push(chunk); });
    child.stderr.on('data', function (chunk) { err.push(chunk); });
    child.on('error', reject);
    child.on('close', function (code) {
      resolve({
        code: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      });
    });
  });
}

function readLogs(dir) {
  const logDir = path.join(dir, 'logs', 'marust');
  if (!fs.existsSync(logDir)) return '';
  return fs.readdirSync(logDir)
    .filter(function (name) { return name.indexOf('api-') === 0 && name.endsWith('.jsonl'); })
    .map(function (name) { return fs.readFileSync(path.join(logDir, name), 'utf8'); })
    .join('');
}

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name);
    throw err;
  }
}

function fakeGateway() {
  const seen = [];
  const server = http.createServer(function (req, res) {
    seen.push({ type: 'http', url: req.url, origin: req.headers.origin || '' });
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', function (req, socket, head) {
    seen.push({
      type: 'upgrade',
      origin: Object.prototype.hasOwnProperty.call(req.headers, 'origin') ? String(req.headers.origin) : '',
      originPresent: Object.prototype.hasOwnProperty.call(req.headers, 'origin'),
      authorization: req.headers.authorization || ''
    });
    wss.handleUpgrade(req, socket, head, function (ws) {
      ws.on('message', function (data) {
        const msg = JSON.parse(data.toString());
        seen.push({ type: 'rpc', method: msg.method, params: msg.params || {} });
        if (msg.method === 'hub.getState') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, mode: 'legacy' } }));
          return;
        }
        if (msg.method === 'destination.start' && msg.params && msg.params.id === 'need-approval') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { ok: false, pending: true, approvalId: 'abc' }
          }));
          setTimeout(function () {
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'event',
              params: {
                name: 'approval.resolved',
                payload: { approvalId: 'abc', ok: true, error: '', result: { ok: true, id: 'need-approval' } }
              }
            }));
          }, 30);
          return;
        }
        if (msg.method === 'destination.start') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, id: msg.params.id } }));
          return;
        }
        if (msg.method === 'broadcast.stopAll') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, items: [] } }));
          return;
        }
        if (msg.method === 'engine.emergencyStop') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, stopped: true } }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: false, error: 'unknown-method' } }));
      });
    });
  });
  return {
    seen: seen,
    listen: function () {
      return new Promise(function (resolve) {
        server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
      });
    },
    close: function () {
      return new Promise(function (resolve) {
        for (const client of wss.clients) {
          try { client.terminate(); } catch (_) { /* gone */ }
        }
        server.close(function () { resolve(); });
      });
    }
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w5-'));
  const core = fakeCore(dir);
  const bus = createEventBus({ logger: function () {} });
  const calls = [];
  let stopped = 0;
  const fakeEngine = {
    start: function (id) {
      calls.push({ op: 'start', id: id });
      return { ok: true, id: id };
    },
    stop: function (id) {
      calls.push({ op: 'stop', id: id });
      return { ok: true, id: id };
    },
    setKey: function (id, settings) {
      calls.push({ op: 'setKey', id: id, key: settings.key });
      return { ok: true };
    },
    status: function () { return { connected: false }; },
    listTargets: function () { return []; },
    setEnabled: function () { return { ok: true }; },
    create: function () { return { ok: true }; },
    remove: function () { return { ok: true }; },
    linkDestination: function () { return { ok: true }; },
    unlinkDestination: function () { return { ok: true }; },
    stopAll: function () {
      stopped += 1;
      return { ok: true };
    }
  };
  const registry = createEngineRegistry();
  registry.register('obs-local', fakeEngine);
  const store = createStateStore({ core: core, bus: bus, logger: function () {} });
  const sessions = createSessions({ store: createSessionStore({ dir: dir }), bus: bus, recover: false, heartbeatMs: 60000 });
  let clock = 1700000000000;
  const api = createApi({
    now: function () { return clock; },
    setTimer: function () { return 0; },
    clearTimer: function () {},
    core: core,
    bus: bus,
    store: store,
    sessions: sessions,
    registry: registry,
    engine: fakeEngine,
    getState: function () { return { product: 'marust', mode: 'legacy' }; },
    fanout: function () { return { ok: true, sent: true }; },
    forceLegacy: function () { return { mode: 'legacy' }; },
    timer: { getState: function () { return { displayMs: 0 }; } },
    timerCommand: function () { return { ok: true }; },
    clients: null,
    layouts: null
  });
  const windowCtx = {
    permissions: ['read', 'write', 'emergency'],
    clientId: WINDOW_ID,
    kind: 'window',
    via: 'ws'
  };
  const approvalCtx = {
    permissions: ['read', 'write', 'emergency'],
    clientId: 'native-1',
    kind: 'native',
    requiresApproval: true,
    via: 'ws'
  };
  const nativeCtx = {
    permissions: ['read', 'write'],
    clientId: 'native-open',
    kind: 'native',
    requiresApproval: false,
    via: 'ws'
  };

  const clients = createClients({ core: core, randomInt: function () { return 424242; } });
  const receiver = createCaptureReceiver({ core: core, onStatus: async function () { return { name: 'marust' }; } });
  const gatewayApi = createApi({
    getState: function () { return { product: 'marust', mode: 'legacy' }; },
    fanout: function () { return { ok: true }; },
    forceLegacy: function () { return { mode: 'legacy' }; },
    timer: { getState: function () { return { displayMs: 0 }; } },
    timerCommand: function () { return { ok: true }; },
    engine: fakeEngine,
    registry: registry,
    clients: clients,
    store: store,
    sessions: sessions,
    bus: bus,
    core: core
  });
  const gateway = createGateway({
    core: core,
    receiver: receiver,
    clients: clients,
    api: gatewayApi,
    bus: bus,
    uiRoot: path.join(__dirname, '..', 'ui'),
    vendorRoot: path.join(__dirname, '..', 'node_modules', 'dockview')
  });
  const server = await gateway.listen(0);
  const port = server.address().port;
  const sockets = [];

  try {
    await test('saved clients gain kind on read', async function () {
      const bag = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w5-kind-'));
      try {
        const old = createClients({ core: fakeCore(bag), randomInt: function () { return 111111; } });
        const file = old.file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
          clients: [
            { id: WINDOW_ID, name: 'この PC のウィンドウ', permissions: ['read', 'write', 'emergency'], tokenHash: 'aa', createdAt: 't', lastSeenAt: 't' },
            { id: 'phone', name: '携帯', permissions: ['read'], tokenHash: 'bb', createdAt: 't', lastSeenAt: 't' },
            { id: 'cli', name: 'CLI', kind: 'native', requiresApproval: true, permissions: ['read', 'write'], tokenHash: 'cc', createdAt: 't', lastSeenAt: 't' },
            { id: 'forged', name: '偽', kind: 'window', permissions: ['read'], tokenHash: 'dd', createdAt: 't', lastSeenAt: 't' }
          ]
        }));
        const listed = old.list();
        const byId = function (id) { return listed.find(function (row) { return row.id === id; }); };
        assert.strictEqual(byId(WINDOW_ID).kind, 'window');
        assert.strictEqual(byId(WINDOW_ID).requiresApproval, false);
        assert.strictEqual(byId('phone').kind, 'browser');
        assert.strictEqual(byId('phone').requiresApproval, false);
        assert.strictEqual(byId('cli').kind, 'native');
        assert.strictEqual(byId('cli').requiresApproval, true);
        assert.strictEqual(byId('forged').kind, 'browser');
      } finally {
        rimraf(bag);
      }
    });

    await test('native pairing keeps the same code rules and rejects the other channel', async function () {
      let when = 5000;
      let seq = 0;
      const bag = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w5-pair-'));
      try {
        const timed = createClients({
          core: fakeCore(bag),
          now: function () { return when; },
          randomInt: function () {
            seq += 1;
            return 222220 + seq;
          }
        });
        const native = timed.beginPairing({
          name: 'CLI',
          kind: 'native',
          requiresApproval: true,
          permissions: ['read', 'write']
        });
        assert.strictEqual(native.code, '222221');
        assert.strictEqual(timed.redeem(native.code).error, 'bad-code');
        const redeemed = timed.redeem(native.code, { kind: 'native', name: 'CLI' });
        assert.strictEqual(redeemed.ok, true);
        assert.strictEqual(redeemed.client.kind, 'native');
        assert.strictEqual(redeemed.client.requiresApproval, true);
        assert.strictEqual(redeemed.client.name, 'CLI');
        assert.strictEqual(timed.redeem(native.code, { kind: 'native', name: 'CLI' }).error, 'no-code');

        when = 9000;
        const again = timed.beginPairing({ name: '次', kind: 'native', permissions: ['read'] });
        when += 120001;
        assert.strictEqual(timed.redeem(again.code, { kind: 'native', name: '次' }).error, 'expired');

        when = 20000;
        const locked = timed.beginPairing({ name: '回数', kind: 'native', permissions: ['read'] });
        for (let i = 0; i < 4; i += 1) {
          assert.strictEqual(timed.redeem('000000', { kind: 'native', name: '回数' }).error, 'bad-code');
        }
        assert.strictEqual(timed.redeem('000000', { kind: 'native', name: '回数' }).error, 'locked');
        assert.strictEqual(timed.redeem(locked.code, { kind: 'native', name: '回数' }).error, 'no-code');

        const browser = timed.beginPairing({ name: 'ブラウザ', permissions: ['read', 'emergency'] });
        assert.strictEqual(timed.redeem(browser.code, { kind: 'native', name: 'CLI' }).error, 'bad-code');
        const viaBrowser = timed.redeem(browser.code);
        assert.strictEqual(viaBrowser.ok, true);
        assert.strictEqual(viaBrowser.client.kind, 'browser');
        assert.strictEqual(viaBrowser.client.requiresApproval, false);
      } finally {
        rimraf(bag);
      }
    });

    await test('api.describe lists every method and params drive validation', async function () {
      api.registerPluginAction('demo', 'ping', 'read', function () { return { ok: true, pong: true }; });
      const described = await api.call('api.describe', {});
      assert.strictEqual(described.ok, true);
      const names = described.methods.map(function (row) { return row.method; });
      assert.deepStrictEqual(names.slice().sort(), api.methods.slice().sort());
      const start = described.methods.find(function (row) { return row.method === 'engine.start'; });
      assert.strictEqual(start.permission, 'write');
      assert.strictEqual(start.windowOnly, false);
      assert.strictEqual(start.params.id.type, 'string');
      assert.strictEqual(start.params.id.required, true);
      assert.strictEqual(start.params.id.max, 80);
      const approve = described.methods.find(function (row) { return row.method === 'approval.approve'; });
      assert.strictEqual(approve.windowOnly, true);
      assert.strictEqual(approve.permission, 'write');
      const plugin = described.methods.find(function (row) { return row.method === 'plugin.demo.ping'; });
      assert.strictEqual(plugin.permission, 'read');
      assert.deepStrictEqual(plugin.params, {});
      assert.ok(plugin.description.length > 0);
      assert.strictEqual((await api.call('engine.start', { id: 'x'.repeat(81) })).error, 'id-length');
      assert.strictEqual((await api.call('engine.create', { name: 'n'.repeat(101), protocol: 'RTMP', server: 's', key: 'k' })).error, 'name-length');
      assert.strictEqual((await api.call('engine.create', { name: 'n', protocol: 'HLS', server: 's', key: 'k' })).error, 'protocol');
      assert.strictEqual((await api.call('engine.setKey', { id: 't', key: '   ' })).error, 'key-empty');
      assert.strictEqual((await api.call('engine.setKey', { id: 't', key: 'kept', server: '   ' })).error, 'server-empty');
      assert.strictEqual((await api.call('layout.save', { name: '   ', data: { version: 1 } }, nativeCtx)).error, 'layout-name');
      const loose = await api.call('hub.fanout', { title: 't'.repeat(600) });
      assert.strictEqual(loose.ok, true);
      assert.strictEqual((await api.call('clients.beginPairing', { name: 'a', kind: 'n'.repeat(17) }, windowCtx)).error, 'kind-length');
    });

    await test('destination.start uses the engine registry', async function () {
      calls.length = 0;
      store.putDestination({
        id: 'yt',
        site: 'youtube',
        accountId: 'me',
        engine: { id: 'obs-local', targetId: 'target-9' },
        enabled: true,
        actual: { engineState: 'idle' }
      });
      store.putDestination({ id: 'bare', site: 'local', engine: null, enabled: true });
      store.putDestination({
        id: 'other',
        site: 'kick',
        engine: { id: 'missing-engine', targetId: 't' },
        enabled: true
      });
      const listed = await api.call('destination.list', {}, { permissions: ['read'], kind: 'native', clientId: 'n' });
      const yt = listed.destinations.find(function (row) { return row.id === 'yt'; });
      assert.deepStrictEqual(yt, {
        id: 'yt',
        site: 'youtube',
        account: 'me',
        engineId: 'obs-local',
        keyTail: null,
        status: 'idle',
        siteLive: false
      });
      const started = await api.call('destination.start', { id: 'yt' }, nativeCtx);
      assert.strictEqual(started.ok, true);
      assert.deepStrictEqual(calls.filter(function (row) { return row.op === 'start'; }), [{ op: 'start', id: 'target-9' }]);
      const stoppedRow = await api.call('destination.stop', { id: 'yt' }, nativeCtx);
      assert.strictEqual(stoppedRow.ok, true);
      assert.strictEqual(calls[calls.length - 1].op, 'stop');
      assert.strictEqual(calls[calls.length - 1].id, 'target-9');
      assert.strictEqual((await api.call('destination.start', { id: 'missing' }, nativeCtx)).error, 'unknown-destination');
      assert.strictEqual((await api.call('destination.start', { id: 'bare' }, nativeCtx)).error, 'no-engine');
      assert.strictEqual((await api.call('destination.stop', { id: 'other' }, nativeCtx)).error, 'no-engine');
    });

    await test('requiresApproval queues writes, blocks emergency, and only the window settles them', async function () {
      calls.length = 0;
      const queued = await api.call('engine.start', { id: 'live' }, approvalCtx);
      assert.strictEqual(queued.ok, false);
      assert.strictEqual(queued.pending, true);
      assert.ok(queued.approvalId);
      assert.strictEqual(calls.length, 0);
      const listed = await api.call('approval.list', {}, { permissions: ['read'], kind: 'native', clientId: 'native-1' });
      assert.strictEqual(listed.approvals.length, 1);
      assert.strictEqual(listed.approvals[0].method, 'engine.start');
      assert.deepStrictEqual(listed.approvals[0].paramNames, ['id']);
      const deniedByNative = await api.call('approval.approve', { id: queued.approvalId }, approvalCtx);
      assert.strictEqual(deniedByNative.error, 'forbidden');
      assert.strictEqual(calls.length, 0);
      const denied = await api.call('approval.deny', { id: queued.approvalId }, windowCtx);
      assert.strictEqual(denied.ok, true);
      assert.strictEqual(denied.result.error, 'denied');
      assert.strictEqual(calls.length, 0);
      assert.strictEqual((await api.call('approval.approve', { id: queued.approvalId }, windowCtx)).error, 'not-found');

      const again = await api.call('engine.start', { id: 'live' }, approvalCtx);
      const approved = await api.call('approval.approve', { id: again.approvalId }, windowCtx);
      assert.strictEqual(approved.ok, true);
      assert.strictEqual(approved.result.ok, true);
      assert.strictEqual(approved.result.id, 'live');
      assert.strictEqual(calls.filter(function (row) { return row.op === 'start' && row.id === 'live'; }).length, 1);

      const beforeStop = stopped;
      const emerg = await api.call('engine.emergencyStop', {}, approvalCtx);
      assert.strictEqual(emerg.error, 'forbidden');
      assert.strictEqual(stopped, beforeStop);

      const expiring = await api.call('engine.start', { id: 'late' }, approvalCtx);
      clock += 120001;
      const left = await api.call('approval.list', {}, { permissions: ['read'], kind: 'browser', clientId: 'reader' });
      assert.ok(!left.approvals.some(function (row) { return row.approvalId === expiring.approvalId; }));
      assert.ok(!calls.some(function (row) { return row.id === 'late'; }));
      const missed = await api.call('approval.approve', { id: expiring.approvalId }, windowCtx);
      assert.strictEqual(missed.error, 'not-found');
    });

    await test('audit log keeps parameter names and drops values', async function () {
      const queued = await api.call('engine.setKey', { id: 't1', key: SECRET, restartIfActive: false }, approvalCtx);
      assert.strictEqual(queued.pending, true);
      const text = readLogs(dir);
      assert.ok(text.includes('"method":"engine.setKey"'), text);
      assert.ok(text.includes('"key"'), text);
      assert.ok(!text.includes(SECRET), text);
      const lines = text.trim().split('\n').map(function (line) { return JSON.parse(line); });
      const pending = lines.find(function (row) { return row.method === 'engine.setKey' && row.error === 'pending'; });
      assert.ok(pending);
      assert.deepStrictEqual(pending.paramNames, ['id', 'key', 'restartIfActive']);
      assert.strictEqual(pending.ok, false);
      assert.strictEqual(pending.clientId, 'native-1');
      assert.strictEqual(pending.kind, 'native');
      assert.ok(!Object.prototype.hasOwnProperty.call(pending, 'params'));
      const approved = await api.call('approval.approve', { id: queued.approvalId }, windowCtx);
      assert.strictEqual(approved.result.ok, true);
      assert.ok(calls.some(function (row) { return row.op === 'setKey' && row.key === SECRET; }));
      const after = readLogs(dir);
      assert.ok(!after.includes(SECRET), after);
      const windowSecret = 'window-only-secret-zz';
      await api.call('engine.setKey', { id: 't1', key: windowSecret }, windowCtx);
      assert.ok(calls.some(function (row) { return row.key === windowSecret; }));
      assert.ok(!readLogs(dir).includes(windowSecret));
      assert.ok(readLogs(dir).includes('"error":"expired"'));
    });

    await test('short-lived approvals expire without running', async function () {
      const seen = [];
      const approvals = createApprovals({
        ttlMs: 30,
        onResolved: function (payload) { seen.push(payload); }
      });
      let ran = 0;
      const local = createApi({
        approvals: approvals,
        engine: {
          start: function () { ran += 1; return { ok: true }; },
          status: function () { return {}; },
          listTargets: function () { return []; },
          stop: function () { return { ok: true }; },
          setEnabled: function () { return { ok: true }; },
          setKey: function () { return { ok: true }; },
          create: function () { return { ok: true }; },
          remove: function () { return { ok: true }; },
          linkDestination: function () { return { ok: true }; },
          unlinkDestination: function () { return { ok: true }; },
          stopAll: function () { return { ok: true }; }
        },
        getState: function () { return {}; },
        fanout: function () { return { ok: true }; },
        forceLegacy: function () { return {}; },
        timer: { getState: function () { return {}; } },
        timerCommand: function () { return {}; }
      });
      const queued = await local.call('engine.start', { id: 'soon' }, approvalCtx);
      assert.strictEqual(queued.pending, true);
      await new Promise(function (resolve) { setTimeout(resolve, 80); });
      assert.strictEqual(ran, 0);
      assert.ok(seen.some(function (row) { return row.approvalId === queued.approvalId && row.error === 'expired'; }));
      approvals.stop();
    });

    await test('origin keeps the cookie check and native requires a native bearer', async function () {
      const browserHeaders = {
        Host: '127.0.0.1:18770',
        Origin: 'http://127.0.0.1:18770'
      };
      const nativePair = clients.beginPairing({
        name: 'CLI',
        kind: 'native',
        permissions: ['read', 'write', 'emergency']
      });
      const withOrigin = await request(port, 'POST', '/pair/native', {
        code: nativePair.code,
        name: 'CLI'
      }, { Origin: 'http://127.0.0.1:18770' });
      assert.strictEqual(withOrigin.status, 403);
      assert.strictEqual(JSON.parse(withOrigin.body).error, 'origin');
      assert.ok(!withOrigin.headers['set-cookie']);

      const paired = await request(port, 'POST', '/pair/native', { code: nativePair.code, name: 'CLI' });
      assert.strictEqual(paired.status, 200);
      assert.ok(!paired.headers['set-cookie']);
      const body = JSON.parse(paired.body);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(typeof body.token, 'string');
      assert.ok(body.token.length >= 32);
      assert.strictEqual(body.client.kind, 'native');
      const reuse = await request(port, 'POST', '/pair/native', { code: nativePair.code, name: 'CLI' });
      assert.strictEqual(reuse.status, 401);

      const bearerOnly = await tryWs(port, Object.assign({
        Authorization: 'Bearer ' + body.token
      }, browserHeaders));
      assert.strictEqual(bearerOnly.open, false);
      if (bearerOnly.ws) bearerOnly.ws.close();

      const browserPair = clients.beginPairing({ name: 'ブラウザ', permissions: ['read', 'write'] });
      const browserRedeem = clients.redeem(browserPair.code);
      assert.strictEqual(browserRedeem.client.kind, 'browser');
      const browserBearer = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Authorization: 'Bearer ' + browserRedeem.token
      });
      assert.strictEqual(browserBearer.open, false);
      const noToken = await tryWs(port, { Host: '127.0.0.1:18770' });
      assert.strictEqual(noToken.open, false);
      const nativeWs = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Authorization: 'Bearer ' + body.token
      });
      assert.strictEqual(nativeWs.open, true);
      sockets.push(nativeWs.ws);
      const state = await rpc(nativeWs.ws, 'hub.getState', {});
      assert.strictEqual(state.result.mode, 'legacy');
      const cookieWs = await tryWs(port, Object.assign({
        Cookie: 'marust_session=' + browserRedeem.token
      }, browserHeaders));
      assert.strictEqual(cookieWs.open, true);
      sockets.push(cookieWs.ws);

      const badBrowser = clients.beginPairing({ name: '別', permissions: ['read'] });
      const wrongChannel = await request(port, 'POST', '/pair/native', { code: badBrowser.code, name: 'CLI' });
      assert.strictEqual(wrongChannel.status, 401);
      const stillBrowser = await request(port, 'POST', '/pair', { code: badBrowser.code }, browserHeaders);
      assert.strictEqual(stillBrowser.status, 200);
      assert.ok(String(stillBrowser.headers['set-cookie']).includes('HttpOnly'));
    });

    await test('approved calls are delivered as approval.resolved', async function () {
      const pair = clients.beginPairing({
        name: '承認',
        kind: 'native',
        requiresApproval: true,
        permissions: ['read', 'write', 'emergency']
      });
      const posted = await request(port, 'POST', '/pair/native', { code: pair.code, name: '承認' });
      const token = JSON.parse(posted.body).token;
      const ws = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Authorization: 'Bearer ' + token
      });
      assert.strictEqual(ws.open, true);
      sockets.push(ws.ws);
      calls.length = 0;
      const queued = await rpc(ws.ws, 'destination.start', { id: 'yt' });
      assert.strictEqual(queued.result.pending, true);
      const event = new Promise(function (resolve, reject) {
        const timer = setTimeout(function () { reject(new Error('no approval event')); }, 1500);
        function onMessage(data) {
          const msg = JSON.parse(data.toString());
          if (!msg || msg.method !== 'event' || !msg.params || msg.params.name !== 'approval.resolved') return;
          if (!msg.params.payload || msg.params.payload.approvalId !== queued.result.approvalId) return;
          clearTimeout(timer);
          ws.ws.off('message', onMessage);
          resolve(msg.params.payload);
        }
        ws.ws.on('message', onMessage);
      });
      const approved = await gatewayApi.call('approval.approve', { id: queued.result.approvalId }, windowCtx);
      assert.strictEqual(approved.ok, true);
      const payload = await event;
      assert.strictEqual(payload.ok, true);
      assert.strictEqual(payload.result.id, 'target-9');
      assert.ok(!JSON.stringify(payload).includes(SECRET));
      const emerg = await rpc(ws.ws, 'engine.emergencyStop', {});
      assert.strictEqual(emerg.result.error, 'forbidden');
    });

    await test('CLI talks to a fake gateway', async function () {
      const fake = fakeGateway();
      const fakePort = await fake.listen();
      const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w5-cli-'));
      const env = { SCRIPTS_STATE: state };
      try {
        fs.mkdirSync(path.join(state, 'services'), { recursive: true });
        fs.writeFileSync(path.join(state, 'services', 'marust-cli.json'), JSON.stringify({
          token: 'ab'.repeat(32),
          name: 'CLI'
        }));
        const status = await runCli(['status', '--json', '--port', String(fakePort)], env);
        assert.strictEqual(status.code, 0, status.stderr);
        assert.strictEqual(JSON.parse(status.stdout).mode, 'legacy');
        assert.ok(fake.seen.some(function (row) {
          return row.type === 'upgrade' && row.originPresent === false && row.authorization.indexOf('Bearer ') === 0;
        }));
        const started = await runCli(['start', 'yt', '--json', '--port', String(fakePort)], env);
        assert.strictEqual(started.code, 0, started.stderr);
        assert.strictEqual(JSON.parse(started.stdout).id, 'yt');
        assert.ok(fake.seen.some(function (row) {
          return row.type === 'rpc' && row.method === 'destination.start' && row.params.id === 'yt';
        }));
        const before = fake.seen.length;
        const stopped = await runCli(['stop-all', '--port', String(fakePort)], env);
        assert.strictEqual(stopped.code, 0, stopped.stderr);
        assert.ok(fake.seen.slice(before).some(function (row) { return row.type === 'rpc' && row.method === 'broadcast.stopAll'; }));
        const emStopped = await runCli(['emergency-stop', '--port', String(fakePort)], env);
        assert.strictEqual(emStopped.code, 0, emStopped.stderr);
        assert.ok(fake.seen.slice(before).some(function (row) { return row.type === 'rpc' && row.method === 'broadcast.stopAll'; }));
        const pending = await runCli(['start', 'need-approval', '--json', '--port', String(fakePort)], env);
        assert.strictEqual(pending.code, 0, pending.stderr + pending.stdout);
        assert.ok(pending.stderr.includes('marust のウィンドウで承認してください（abc）'));
        assert.strictEqual(JSON.parse(pending.stdout).ok, true);
        const downPort = await new Promise(function (resolve) {
          const probe = net.createServer();
          probe.listen(0, '127.0.0.1', function () {
            const n = probe.address().port;
            probe.close(function () { resolve(n); });
          });
        });
        const down = await runCli(['status', '--port', String(downPort)], env);
        assert.notStrictEqual(down.code, 0);
        assert.ok((down.stderr + down.stdout).includes('Agent が動いていません'));
      } finally {
        await fake.close();
        rimraf(state);
      }
    });

    await test('CLI pair stores the token and status reaches the gateway', async function () {
      const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w5-paircli-'));
      try {
        const opened = clients.beginPairing({
          name: '窓',
          kind: 'native',
          permissions: ['read', 'write']
        });
        const paired = await runCli(['pair', opened.code, '--port', String(port), '--json'], { SCRIPTS_STATE: state });
        assert.strictEqual(paired.code, 0, paired.stderr);
        const saved = JSON.parse(fs.readFileSync(path.join(state, 'services', 'marust-cli.json'), 'utf8'));
        assert.ok(saved.token.length >= 32);
        assert.ok(!paired.stdout.includes(saved.token));
        const status = await runCli(['status', '--json', '--port', String(port)], { SCRIPTS_STATE: state });
        assert.strictEqual(status.code, 0, status.stderr);
        assert.strictEqual(JSON.parse(status.stdout).mode, 'legacy');
      } finally {
        rimraf(state);
      }
    });
  } finally {
    for (let i = 0; i < sockets.length; i += 1) {
      try { sockets[i].close(); } catch (_) { /* gone */ }
    }
    sessions.stop();
    await new Promise(function (resolve) { server.close(function () { resolve(); }); });
    rimraf(dir);
  }
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
