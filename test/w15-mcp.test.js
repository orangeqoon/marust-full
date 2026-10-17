'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const { createCore } = require('../host/core/core-bridge');
const { createCaptureReceiver } = require('../host/layer1/capture-receiver');
const { createGateway } = require('../host/layer1/gateway');
const { createClients, WINDOW_ID, MCP_PERMISSIONS } = require('../host/layer1/clients');
const { createApi } = require('../host/layer1/api');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');
const { createSessions, createSessionStore } = require('./_k3-parts');
const { createEngineRegistry } = require('../host/core/engine');
const mcp = require('../plugins/ai-connect/mcp/server');

const SERVER = path.join(__dirname, '..', 'plugins', 'ai-connect', 'mcp', 'server.js');
const windowCtx = {
  permissions: ['read', 'write', 'emergency'],
  clientId: WINDOW_ID,
  kind: 'window',
  via: 'ws'
};

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

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function paramHasSecret(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const names = Object.keys(params);
  for (let i = 0; i < names.length; i += 1) {
    const folded = String(names[i]).toLowerCase();
    if (folded.indexOf('key') !== -1) return true;
    if (folded.indexOf('token') !== -1) return true;
    if (folded.indexOf('password') !== -1) return true;
    if (folded.indexOf('secret') !== -1) return true;
    if (folded.indexOf('cookie') !== -1) return true;
  }
  return false;
}

function shouldHide(row) {
  if (!row || row.windowOnly === true) return true;
  if (row.permission === 'emergency') return true;
  if (typeof row.method === 'string' && row.method.indexOf('secrets.') === 0) return true;
  if (typeof row.method === 'string' && row.method.indexOf('clients.') === 0) return true;
  if (row.method === 'approval.approve' || row.method === 'approval.deny') return true;
  if (row.method === 'engine.setKey' || row.method === 'engine.link') return true;
  if (row.method === 'engine.emergencyStop') return true;
  if (row.method === 'chat.publish') return true;
  if (row.method === 'hub.fanoutReserved' || row.method === 'sites.loginFacts' || row.method === 'sites.loginStates') return true;
  if (paramHasSecret(row.params)) return true;
  return false;
}

function assertNoToken(text, token, label) {
  if (token && String(text).indexOf(token) !== -1) throw new Error('token leaked in ' + label);
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

function runMcp(args, env) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [SERVER].concat(args), {
      env: Object.assign({}, process.env, env || {}),
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = [];
    const err = [];
    child.stdout.on('data', function (chunk) { out.push(chunk); });
    child.stderr.on('data', function (chunk) { err.push(chunk); });
    const timer = setTimeout(function () {
      try { child.kill(); } catch (_) { /* gone */ }
      reject(new Error('mcp-timeout'));
    }, 8000);
    child.on('error', function (error) {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', function (code) {
      clearTimeout(timer);
      resolve({
        code: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      });
    });
  });
}

function openMcp(args, env) {
  const child = spawn(process.execPath, [SERVER].concat(args || []), {
    env: Object.assign({}, process.env, env || {}),
    cwd: path.join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const lines = [];
  const err = [];
  const pending = new Map();
  let buf = '';
  let seq = 0;
  child.stdout.on('data', function (chunk) {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line.trim()) continue;
      lines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && msg.id != null && pending.has(msg.id)) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });
  child.stderr.on('data', function (chunk) { err.push(chunk); });
  child.on('exit', function () {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('mcp-exit'));
    }
    pending.clear();
  });
  return {
    lines: lines,
    stdout: function () { return lines.join('\n'); },
    stderr: function () { return Buffer.concat(err).toString('utf8'); },
    request: function (method, params, timeoutMs) {
      const id = ++seq;
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error('timeout ' + method));
        }, timeoutMs || 8000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
      });
    },
    notify: function (method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }) + '\n');
    },
    close: function () {
      return new Promise(function (resolve) {
        if (child.exitCode != null) {
          resolve();
          return;
        }
        const timer = setTimeout(function () {
          try { child.kill(); } catch (_) { /* gone */ }
          resolve();
        }, 1500);
        child.once('exit', function () {
          clearTimeout(timer);
          resolve();
        });
        try { child.stdin.end(); } catch (_) {
          try { child.kill(); } catch (err) { /* gone */ }
        }
      });
    }
  };
}

function resultText(msg) {
  const content = msg && msg.result && Array.isArray(msg.result.content) ? msg.result.content : [];
  return content[0] && content[0].text ? String(content[0].text) : '';
}

function rpc(ws, method, params) {
  return new Promise(function (resolve, reject) {
    const id = Math.floor(Math.random() * 1000000000);
    const timer = setTimeout(function () { reject(new Error('rpc-timeout')); }, 2000);
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

function connectNative(port, token) {
  return new Promise(function (resolve) {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', {
      headers: {
        Host: '127.0.0.1:18770',
        Authorization: 'Bearer ' + token
      }
    });
    let settled = false;
    function finish(row) {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ws: ws }, row));
    }
    ws.once('open', function () { finish({ open: true }); });
    ws.once('unexpected-response', function (_req, res) {
      res.resume();
      finish({ open: false, status: res.statusCode });
    });
    ws.on('error', function () {});
    setTimeout(function () { finish({ open: false, status: 0 }); }, 1500);
  });
}

async function waitApprovalId(api) {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const listed = await api.call('approval.list', {}, windowCtx);
    const rows = listed && Array.isArray(listed.approvals) ? listed.approvals : [];
    if (rows.length && rows[0].approvalId) return rows[0].approvalId;
    await delay(30);
  }
  throw new Error('no approval');
}

async function startStack(ttlMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w15-'));
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
    setKey: function () { return { ok: true }; },
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
  store.putDestination({
    id: 'yt',
    site: 'youtube',
    accountId: 'me',
    engine: { id: 'obs-local', targetId: 'target-9' },
    enabled: true,
    actual: { engineState: 'idle' }
  });
  const sessions = createSessions({ store: createSessionStore({ dir: dir }), bus: bus, recover: false, heartbeatMs: 60000 });
  const clients = createClients({ core: core });
  const apiDeps = {
    bus: bus,
    store: store,
    sessions: sessions,
    registry: registry,
    engine: fakeEngine,
    clients: clients,
    core: core,
    getState: function () { return { product: 'marust', mode: 'legacy' }; },
    fanout: function () { return { ok: true }; },
    forceLegacy: function () { return { mode: 'legacy' }; },
    timer: { getState: function () { return { displayMs: 0 }; } },
    timerCommand: function () { return { ok: true }; }
  };
  if (ttlMs != null) apiDeps.approvalTtlMs = ttlMs;
  const api = createApi(apiDeps);
  api.registerPluginAction('w15probe', 'ping', 'read', function () { return { ok: true, pong: true }; });
  // ai-connect（K3）が入っている印。MCP は最初に ai.status を読み、入っていなければ「切ってある」と答える
  api.registerPluginMethod('ai-connect', 'ai.status', { access: 'read', params: {} }, function () { return { ok: true, enabled: true }; }, { audience: 'public' });
  const receiver = createCaptureReceiver({ core: core, onStatus: async function () { return { name: 'marust' }; } });
  const gateway = createGateway({
    core: core,
    receiver: receiver,
    clients: clients,
    api: api,
    bus: bus,
    uiRoot: path.join(__dirname, '..', 'ui'),
    vendorRoot: path.join(__dirname, '..', 'node_modules', 'dockview')
  });
  const server = await gateway.listen(0);
  return {
    dir: dir,
    port: server.address().port,
    api: api,
    clients: clients,
    calls: calls,
    stopped: function () { return stopped; },
    stop: async function () {
      try { sessions.stop(); } catch (_) { /* already stopped */ }
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(function (resolve) { server.close(function () { resolve(); }); });
      rimraf(dir);
    }
  };
}

function readAudit(dir) {
  const logDir = path.join(dir, 'logs', 'marust');
  if (!fs.existsSync(logDir)) return '';
  return fs.readdirSync(logDir)
    .filter(function (name) { return name.indexOf('api-') === 0; })
    .map(function (name) { return fs.readFileSync(path.join(logDir, name), 'utf8'); })
    .join('');
}

async function main() {
  await test('pure helpers hide emergency, secrets, clients, approvals, and setKey', async function () {
    assert.strictEqual(mcp.PAIR_HINT, 'node plugins/ai-connect/mcp/server.js pair でペアリングしてください');
    assert.strictEqual(mcp.isExcluded({ method: 'engine.emergencyStop', permission: 'emergency', windowOnly: false }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'secrets.list', permission: 'read', windowOnly: false }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'secrets.set', permission: 'write', windowOnly: true }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'clients.list', permission: 'read', windowOnly: false }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'clients.beginPairing', permission: 'write', windowOnly: true }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'approval.approve', permission: 'write', windowOnly: true }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'approval.deny', permission: 'write', windowOnly: true }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'engine.setKey', permission: 'write', windowOnly: false }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'chat.publish', permission: 'chat-write', windowOnly: false, params: { messages: { type: 'array' } } }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'engine.create', permission: 'write', windowOnly: false, params: { key: { type: 'string' }, name: { type: 'string' } } }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'engine.link', permission: 'write', windowOnly: false, params: { destinationId: { type: 'string' } } }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'example.save', permission: 'write', windowOnly: false, params: { apiToken: { type: 'string' } } }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'example.save', permission: 'write', windowOnly: false, params: { userPassword: { type: 'string' } } }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'example.save', permission: 'write', windowOnly: false, params: { clientSecret: { type: 'string' } } }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'example.save', permission: 'write', windowOnly: false, params: { sessionCookie: { type: 'string' } } }), true);
    assert.strictEqual(mcp.isExcluded({ method: 'hub.getState', permission: 'read', windowOnly: false }), false);
    assert.strictEqual(mcp.isExcluded({ method: 'destination.start', permission: 'write', windowOnly: false, params: { id: { type: 'string' } } }), false);
    assert.strictEqual(mcp.isExcluded({ method: 'layout.save', permission: 'write', windowOnly: false, params: { name: { type: 'string' }, data: { type: 'object' } } }), false);
    assert.strictEqual(mcp.isExcluded({ method: 'approval.list', permission: 'read', windowOnly: false }), false);
    assert.deepStrictEqual(MCP_PERMISSIONS, ['read', 'write']);
    const schema = mcp.schemaFor({
      id: { type: 'string', required: true, max: 80 },
      limit: { type: 'number', required: false, min: 1, max: 200 }
    });
    assert.strictEqual(schema.type, 'object');
    assert.strictEqual(schema.properties.id.type, 'string');
    assert.strictEqual(schema.properties.id.maxLength, 80);
    assert.deepStrictEqual(schema.required, ['id']);
    assert.strictEqual(schema.properties.limit.minimum, 1);
    assert.strictEqual(schema.properties.limit.maximum, 200);
    const write = mcp.describeTool({ method: 'destination.start', permission: 'write', description: '配信先を開始する' });
    assert.ok(write.includes('配信先を開始する'));
    assert.ok(write.includes('承認待ちになります'));
    assert.ok(write.includes(' / '));
    assert.ok(write.includes('Waits for approval'));
    assert.strictEqual(write.indexOf('\n'), -1);
    const read = mcp.describeTool({ method: 'hub.getState', permission: 'read', description: 'ハブの状態を返す' });
    assert.ok(read.includes('Return the hub state'));
    assert.strictEqual(read.indexOf('承認待ちになります'), -1);
    const plugin = mcp.describeTool({ method: 'plugin.w15probe.go', permission: 'write', description: '動かす' });
    assert.ok(plugin.includes('承認待ちになります'));
    assert.ok(plugin.includes('Write'));
    assert.strictEqual(mcp.toolName('plugin.w15probe.ping'), 'marust_plugin_w15probe_ping');
  });

  await test('mcp pairing forces native read and write with approval', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w15-clients-'));
    try {
      const clients = createClients({ core: fakeCore(dir) });
      const opened = clients.beginPairing({
        name: 'AI（MCP）',
        mcp: true,
        kind: 'widget',
        requiresApproval: false,
        permissions: ['read', 'write', 'emergency']
      });
      assert.strictEqual(opened.ok, true);
      const redeemed = clients.redeem(opened.code, { kind: 'native', name: 'AI（MCP）' });
      assert.strictEqual(redeemed.ok, true);
      assert.strictEqual(redeemed.client.kind, 'native');
      assert.strictEqual(redeemed.client.requiresApproval, true);
      assert.deepStrictEqual(redeemed.client.permissions, ['read', 'write']);
      assert.ok(redeemed.client.permissions.indexOf('emergency') === -1);
      const plain = clients.beginPairing({ name: '既定' });
      const plainRedeemed = clients.redeem(plain.code);
      assert.deepStrictEqual(plainRedeemed.client.permissions, ['read', 'emergency']);
      assert.strictEqual(plainRedeemed.client.requiresApproval, false);
    } finally {
      rimraf(dir);
    }
  });

  await test('the window panel offers an MCP pairing button', async function () {
    const hub = hubSource();
    assert.ok(hub.includes("mcpButton.textContent = 'AI（MCP）をつなぐ'"));
    assert.ok(hub.includes("mcpButton.id = 'pair-mcp'"));
    assert.ok(hub.includes("name: 'AI（MCP）'"));
    assert.ok(hub.includes("kind: 'native'"));
    assert.ok(hub.includes('requiresApproval: true'));
    assert.ok(hub.includes("permissions: ['read', 'write']"));
    assert.ok(hub.includes('mcp: true'));
    assert.ok(hub.includes('if (!isWindow || !can.write) return;'));
    const html = require('./_ui-source').shellDocument();
    assert.ok(html.includes('id="client-admin" hidden'));
  });

  await test('unpaired tools/list tells the caller to pair and does not connect', async function () {
    const hits = { n: 0 };
    const probe = net.createServer(function (socket) {
      hits.n += 1;
      socket.destroy();
    });
    const port = await new Promise(function (resolve) {
      probe.listen(0, '127.0.0.1', function () { resolve(probe.address().port); });
    });
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w15-unpaired-'));
    const session = openMcp(['--port', String(port)], {
      SCRIPTS_STATE: state,
      MARUST_MCP_PORT: String(port),
      MARUST_MCP_DESCRIBE_MS: '60000'
    });
    try {
      const early = await session.request('tools/list', {});
      assert.strictEqual(early.error && early.error.code, -32002);
      const init = await session.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'w15-fake', version: '0' }
      });
      assert.strictEqual(init.result.protocolVersion, '2024-11-05');
      assert.strictEqual(init.result.serverInfo.name, 'marust');
      assert.strictEqual(init.result.capabilities.tools.listChanged, true);
      session.notify('notifications/initialized', {});
      const discover = await session.request('server/discover', {});
      assert.strictEqual(discover.error && discover.error.code, -32601);
      const listed = await session.request('tools/list', {});
      assert.strictEqual(listed.result.guidance, mcp.PAIR_HINT);
      assert.strictEqual(listed.result.tools.length, 1);
      assert.strictEqual(listed.result.tools[0].name, 'marust_not_paired');
      assert.strictEqual(listed.result.tools[0].description, mcp.PAIR_HINT);
      const names = listed.result.tools.map(function (tool) { return tool.name; });
      assert.ok(names.indexOf('marust_hub_getState') === -1);
      assert.ok(names.indexOf('marust_engine_emergencyStop') === -1);
      const called = await session.request('tools/call', { name: 'marust_hub_getState', arguments: {} });
      assert.ok(resultText(called).includes(mcp.PAIR_HINT));
      assert.strictEqual(called.result.isError, true);
      await delay(150);
      assert.strictEqual(hits.n, 0);
      for (let i = 0; i < session.lines.length; i += 1) JSON.parse(session.lines[i]);
    } finally {
      await session.close();
      await new Promise(function (resolve) { probe.close(function () { resolve(); }); });
      rimraf(state);
    }
  });

  const stack = await startStack();
  const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w15-token-'));
  const tokenPath = path.join(mcpDir, 'services', 'marust-mcp.json');
  let session = null;
  let native = null;
  try {
    await test('pair stores the token without printing it, and a bad code does not', async function () {
      const opened = await stack.api.call('clients.beginPairing', {
        name: 'AI（MCP）',
        kind: 'browser',
        requiresApproval: false,
        permissions: ['read', 'write', 'emergency'],
        mcp: true
      }, windowCtx);
      assert.strictEqual(opened.ok, true);
      const env = { SCRIPTS_STATE: mcpDir, MARUST_MCP_PORT: String(stack.port) };
      const wrong = await runMcp(['pair', '000000', '--port', String(stack.port)], env);
      assert.notStrictEqual(wrong.code, 0);
      assert.ok(wrong.stderr.includes('コードが違います'));
      assert.ok(!fs.existsSync(tokenPath));
      const paired = await runMcp(['pair', opened.code, '--port', String(stack.port)], env);
      assert.strictEqual(paired.code, 0, paired.stderr);
      assert.strictEqual(paired.stdout, 'ペアリングしました\n');
      assert.strictEqual(paired.stderr, '');
      const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      assert.ok(saved.token.length >= 32);
      assertNoToken(paired.stdout, saved.token, 'pair stdout');
      assertNoToken(paired.stderr, saved.token, 'pair stderr');
      const row = stack.clients.list().find(function (item) { return item.kind === 'native'; });
      assert.ok(row);
      assert.strictEqual(row.name, 'AI（MCP）');
      assert.strictEqual(row.requiresApproval, true);
      assert.deepStrictEqual(row.permissions, ['read', 'write']);
      assert.ok(row.permissions.indexOf('emergency') === -1);
    });

    const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const token = saved.token;
    session = openMcp(['--port', String(stack.port)], {
      SCRIPTS_STATE: mcpDir,
      MARUST_MCP_PORT: String(stack.port),
      MARUST_MCP_DESCRIBE_MS: '200',
      MARUST_MCP_APPROVAL_MS: '120000'
    });

    await test('tools/list omits the exclusion list and read tools return results', async function () {
      const init = await session.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'w15-fake', version: '0' }
      });
      assert.strictEqual(init.result.protocolVersion, '2025-06-18');
      session.notify('notifications/initialized', {});
      const listed = await session.request('tools/list', {});
      assert.ok(listed.result && Array.isArray(listed.result.tools));
      assert.ok(!listed.result.guidance);
      const names = listed.result.tools.map(function (tool) { return tool.name; });
      const described = await stack.api.call('api.describe', {}, windowCtx);
      for (let i = 0; i < described.methods.length; i += 1) {
        const row = described.methods[i];
        const tool = 'marust_' + row.method.replace(/\./g, '_');
        if (shouldHide(row)) assert.ok(names.indexOf(tool) === -1, row.method);
        else assert.ok(names.indexOf(tool) !== -1, row.method);
      }
      assert.ok(names.indexOf('marust_engine_emergencyStop') === -1);
      assert.ok(names.indexOf('marust_secrets_list') === -1);
      assert.ok(names.indexOf('marust_clients_list') === -1);
      assert.ok(names.indexOf('marust_approval_approve') === -1);
      assert.ok(names.indexOf('marust_engine_setKey') === -1);
      assert.ok(names.indexOf('marust_engine_create') === -1);
      assert.ok(names.indexOf('marust_engine_link') === -1);
      assert.ok(names.indexOf('marust_chat_publish') === -1);
      assert.ok(names.indexOf('marust_destination_start') !== -1);
      assert.ok(names.indexOf('marust_layout_save') !== -1);
      assert.ok(names.indexOf('marust_plugin_w15probe_ping') !== -1);
      const start = listed.result.tools.find(function (tool) { return tool.name === 'marust_destination_start'; });
      assert.ok(start.description.includes('承認待ちになります'));
      assert.ok(start.description.includes(' / '));
      assert.ok(start.description.includes('Waits for approval'));
      assert.strictEqual(start.description.indexOf('\n'), -1);
      assert.strictEqual(start.inputSchema.properties.id.type, 'string');
      assert.strictEqual(start.inputSchema.properties.id.maxLength, 80);
      assert.ok(start.inputSchema.required.indexOf('id') !== -1);
      const stateTool = listed.result.tools.find(function (tool) { return tool.name === 'marust_hub_getState'; });
      assert.strictEqual(stateTool.description.indexOf('承認待ちになります'), -1);
      const state = await session.request('tools/call', { name: 'marust_hub_getState', arguments: {} });
      assert.strictEqual(state.result.isError, false);
      assert.ok(resultText(state).includes('"mode":"legacy"'));
      const ping = await session.request('tools/call', { name: 'marust_plugin_w15probe_ping', arguments: {} });
      assert.ok(resultText(ping).includes('"pong":true'));
      assertNoToken(session.stdout(), token, 'tools stdout');
      assertNoToken(resultText(state) + resultText(ping), token, 'read results');
    });

    await test('an MCP client cannot call emergency', async function () {
      const refused = await session.request('tools/call', {
        name: 'marust_engine_emergencyStop',
        arguments: {}
      });
      assert.strictEqual(refused.result.isError, true);
      assert.ok(resultText(refused).includes('この操作は AI の道具にしていません'));
      assert.strictEqual(stack.stopped(), 0);
      native = await connectNative(stack.port, token);
      assert.strictEqual(native.open, true);
      const emerg = await rpc(native.ws, 'engine.emergencyStop', {});
      assert.strictEqual(emerg.result.error, 'forbidden');
      assert.strictEqual(stack.stopped(), 0);
      assertNoToken(JSON.stringify(emerg), token, 'emergency rpc');
    });

    await test('write waits for approval, deny, and approve', async function () {
      assert.strictEqual(stack.calls.length, 0);
      const deniedCall = session.request('tools/call', {
        name: 'marust_destination_start',
        arguments: { id: 'yt' }
      }, 10000);
      const deniedId = await waitApprovalId(stack.api);
      const denied = await stack.api.call('approval.deny', { id: deniedId }, windowCtx);
      assert.strictEqual(denied.ok, true);
      const deniedMsg = await deniedCall;
      const deniedText = resultText(deniedMsg);
      assert.ok(deniedText.includes('marust のウィンドウで承認待ち'));
      assert.ok(deniedText.includes('却下された'));
      assert.strictEqual(deniedMsg.result.isError, true);
      assert.strictEqual(stack.calls.length, 0);
      assertNoToken(deniedText, token, 'deny result');

      const approvedCall = session.request('tools/call', {
        name: 'marust_destination_start',
        arguments: { id: 'yt' }
      }, 10000);
      const approvedId = await waitApprovalId(stack.api);
      const approved = await stack.api.call('approval.approve', { id: approvedId }, windowCtx);
      assert.strictEqual(approved.ok, true);
      const approvedMsg = await approvedCall;
      const approvedText = resultText(approvedMsg);
      assert.ok(approvedText.includes('marust のウィンドウで承認待ち'));
      assert.ok(approvedText.includes('承認された'));
      assert.ok(approvedText.includes('target-9'));
      assert.strictEqual(approvedMsg.result.isError, false);
      assert.deepStrictEqual(stack.calls, [{ op: 'start', id: 'target-9' }]);
      assertNoToken(approvedText, token, 'approve result');
    });

    await test('describe refresh picks up a new plugin tool', async function () {
      stack.api.registerPluginAction('w15probe', 'later', 'write', function () { return { ok: true, later: true }; });
      let found = null;
      const started = Date.now();
      while (Date.now() - started < 3000) {
        const listed = await session.request('tools/list', {});
        found = listed.result.tools.find(function (tool) { return tool.name === 'marust_plugin_w15probe_later'; });
        if (found) break;
        await delay(100);
      }
      assert.ok(found, 'plugin tool did not appear');
      assert.ok(found.description.includes('承認待ちになります'));
      assert.ok(session.lines.some(function (line) { return line.includes('notifications/tools/list_changed'); }));
    });

    assertNoToken(session.stdout(), token, 'session stdout');
    assertNoToken(session.stderr(), token, 'session stderr');
    assertNoToken(readAudit(stack.dir), token, 'audit');
    for (let i = 0; i < session.lines.length; i += 1) JSON.parse(session.lines[i]);
  } finally {
    if (native && native.ws) {
      try { native.ws.close(); } catch (_) { /* gone */ }
    }
    if (session) await session.close();
    await stack.stop();
    rimraf(mcpDir);
  }

  await test('a write that expires reports 期限切れ and does not run', async function () {
    const slow = await startStack(300);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w15-expire-'));
    let child = null;
    try {
      const opened = await slow.api.call('clients.beginPairing', {
        name: 'AI（MCP）',
        mcp: true,
        permissions: ['read', 'write', 'emergency']
      }, windowCtx);
      assert.strictEqual(opened.ok, true);
      const env = {
        SCRIPTS_STATE: dir,
        MARUST_MCP_PORT: String(slow.port),
        MARUST_MCP_DESCRIBE_MS: '60000',
        MARUST_MCP_APPROVAL_MS: '8000'
      };
      const paired = await runMcp(['pair', opened.code, '--port', String(slow.port)], env);
      assert.strictEqual(paired.code, 0, paired.stderr);
      const token = JSON.parse(fs.readFileSync(path.join(dir, 'services', 'marust-mcp.json'), 'utf8')).token;
      assertNoToken(paired.stdout + paired.stderr, token, 'expire pair');
      child = openMcp(['--port', String(slow.port)], env);
      const init = await child.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'w15-fake', version: '0' }
      });
      assert.strictEqual(init.result.serverInfo.name, 'marust');
      child.notify('notifications/initialized', {});
      const started = Date.now();
      const msg = await child.request('tools/call', {
        name: 'marust_destination_start',
        arguments: { id: 'yt' }
      }, 12000);
      const elapsed = Date.now() - started;
      const text = resultText(msg);
      assert.ok(text.includes('marust のウィンドウで承認待ち'));
      assert.ok(text.includes('期限切れ'));
      assert.ok(text.includes('expired'));
      assert.strictEqual(msg.result.isError, true);
      assert.ok(elapsed < 6000, 'elapsed ' + elapsed);
      assert.strictEqual(slow.calls.length, 0);
      assert.strictEqual(slow.stopped(), 0);
      assertNoToken(text + child.stdout() + child.stderr(), token, 'expire session');
    } finally {
      if (child) await child.close();
      await slow.stop();
      rimraf(dir);
    }
  });

  console.log('[marust] w15 tests passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
