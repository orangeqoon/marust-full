'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const { createCore } = require('../host/core/core-bridge');
const { createCaptureReceiver } = require('../host/layer1/capture-receiver');
const { createGateway, CSP } = require('../host/layer1/gateway');
const { createClients, sha256, WINDOW_ID } = require('../host/layer1/clients');
const { createLayouts } = require('../host/layer1/layouts');
const { createApi } = require('../host/layer1/api');
const { createEventBus } = require('../host/core/event-bus');
const { EVENTS } = require('../host/core/events');

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function fakeCore(dir) {
  const core = createCore();
  return {
    via: 'scripts_core',
    legacyRoutes: true, // 旧い Cookie の経路は作者の印があるときだけ開く（M7 Must 1）
    STATE_DIR: dir,
    COOKIES_DIR: path.join(dir, 'cookies'),
    SERVICES_DIR: path.join(dir, 'services'),
    DATA_DIR: path.join(dir, 'data'),
    atomicWriteJsonSync: core.atomicWriteJsonSync
  };
}

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: urlPath,
      method: method,
      headers: Object.assign({ Host: '127.0.0.1:18770' }, headers || {}, payload == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      })
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (payload == null) req.end();
    else req.end(payload);
  });
}

function rawHttp(port, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
    const chunks = [];
    sock.on('data', (chunk) => chunks.push(chunk));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

function tryWs(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: headers || {} });
    let settled = false;
    const finish = (row) => {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ws: ws }, row));
    };
    ws.once('open', () => finish({ open: true }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      finish({ open: false, status: res.statusCode });
    });
    ws.on('error', () => {});
    setTimeout(() => finish({ open: false, status: 0 }), 1500);
  });
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

function rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000000);
    const timer = setTimeout(() => reject(new Error('rpc-timeout ' + method)), 2000);
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

function makeApi(clients, layouts) {
  return createApi({
    getState() { return { product: 'marust', mode: 'legacy' }; },
    fanout() { return { ok: true, sent: true }; },
    forceLegacy() { return { mode: 'legacy' }; },
    timer: { getState() { return { displayMs: 0 }; } },
    timerCommand() { return { ok: true }; },
    engine: {
      status() { return { connected: false }; },
      listTargets() { return []; },
      start(id) { return { ok: true, id: id }; },
      stop() { return { ok: true }; },
      setEnabled() { return { ok: true }; },
      setKey() { return { ok: true }; },
      create() { return { ok: true }; },
      remove() { return { ok: true }; },
      linkDestination() { return { ok: true }; },
      unlinkDestination() { return { ok: true }; }
    },
    registry: { emergencyStop() { return { ok: true, stopped: true }; } },
    clients: clients,
    layouts: layouts
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-1b-'));
  const core = fakeCore(dir);
  const bus = createEventBus({ logger() {} });
  const clients = createClients({ core: core, randomInt: () => 424242 });
  const layouts = createLayouts({ core: core });
  const api = makeApi(clients, layouts);
  const receiver = createCaptureReceiver({ core: core, onStatus: async () => ({ name: 'marust', receiver: true }) });
  const gateway = createGateway({
    core: core,
    receiver: receiver,
    clients: clients,
    layouts: layouts,
    api: api,
    bus: bus,
    onStatus: async () => ({ name: 'marust', receiver: true }),
    uiRoot: path.join(__dirname, '..', 'ui'),
    vendorRoot: path.join(__dirname, '..', 'node_modules', 'dockview')
  });
  const server = await gateway.listen(0);
  const port = server.address().port;
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const evil = await request(port, 'GET', '/health', null, { Host: 'evil.example:18770' });
    assert.strictEqual(evil.status, 421);
    const missingHost = await rawHttp(port, 'GET /health HTTP/1.0\r\n\r\n');
    assert.ok(missingHost.startsWith('HTTP/1.1 421'), missingHost.slice(0, 40));

    const outside = await request(port, 'GET', '/ui/../package.json');
    assert.strictEqual(outside.status, 404);
    const encoded = await rawHttp(port, 'GET /ui/%2e%2e/package.json HTTP/1.1\r\nHost: 127.0.0.1:18770\r\nConnection: close\r\n\r\n');
    assert.ok(encoded.startsWith('HTTP/1.1 404'), encoded.slice(0, 40));
    const vendor = await request(port, 'GET', '/vendor/dockview/package.json');
    assert.strictEqual(vendor.status, 404);

    const home = await request(port, 'GET', '/');
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.headers['content-security-policy'], CSP);
    assert.strictEqual(home.headers['x-content-type-options'], 'nosniff');
    assert.ok(home.body.includes('pair-form'));
    const health = await request(port, 'GET', '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).name, 'marust');
    const overlay = await request(port, 'GET', '/overlay/timer');
    assert.strictEqual(overlay.status, 404);

    // 旧い平文の Cookie 受け口は無い（拡張は /ext/* だけ）。ルートは 404、別の Host は先に 421
    const saved = await request(port, 'POST', '/soop_auth', { cookies: { example: 'not-a-secret' } });
    assert.strictEqual(saved.status, 404);
    assert.ok(!fs.existsSync(path.join(core.COOKIES_DIR, 'marust', 'soop-cookies.json')));
    const blocked = await request(port, 'POST', '/soop_auth', { cookies: { example: 'other-secret' } }, { Host: 'evil.example:18770' });
    assert.strictEqual(blocked.status, 421);

    const noOrigin = await tryWs(port, { Host: '127.0.0.1:18770' });
    assert.strictEqual(noOrigin.open, false);
    const badOrigin = await tryWs(port, { Host: '127.0.0.1:18770', Origin: 'http://evil.example' });
    assert.strictEqual(badOrigin.open, false);
    const noCookie = await tryWs(port, { Host: '127.0.0.1:18770', Origin: 'http://127.0.0.1:18770' });
    assert.strictEqual(noCookie.open, false);

    const readPair = clients.beginPairing({ name: '読むだけ', permissions: ['read'] });
    const readRedeem = clients.redeem(readPair.code);
    assert.strictEqual(readRedeem.ok, true);
    const bothPair = clients.beginPairing({ name: '停止つき' });
    const bothRedeem = clients.redeem(bothPair.code);
    assert.deepStrictEqual(bothRedeem.client.permissions, ['read', 'emergency']);
    const allPair = clients.beginPairing({ name: '全部', permissions: ['read', 'write', 'emergency'] });
    const allRedeem = clients.redeem(allPair.code);
    const again = clients.redeem(allPair.code);
    assert.strictEqual(again.ok, false);

    const wsHeaders = {
      Host: '127.0.0.1:18770',
      Origin: 'http://127.0.0.1:18770'
    };
    const readWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + readRedeem.token }, wsHeaders));
    assert.strictEqual(readWs.open, true);
    const deniedStart = await rpc(readWs.ws, 'engine.start', { id: 't1' });
    assert.strictEqual(deniedStart.result.error, 'forbidden');
    const deniedFanout = await rpc(readWs.ws, 'hub.fanout', { title: 'a' });
    assert.strictEqual(deniedFanout.result.error, 'forbidden');
    const deniedSave = await rpc(readWs.ws, 'layout.save', { name: '標準', data: { version: 1 } });
    assert.strictEqual(deniedSave.result.error, 'forbidden');
    const deniedStop = await rpc(readWs.ws, 'engine.emergencyStop', {});
    assert.strictEqual(deniedStop.result.error, 'forbidden');
    readWs.ws.close();

    const bothWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + bothRedeem.token }, wsHeaders));
    assert.strictEqual(bothWs.open, true);
    const stopped = await rpc(bothWs.ws, 'engine.emergencyStop', {});
    assert.strictEqual(stopped.result.ok, true);
    const stillDenied = await rpc(bothWs.ws, 'engine.start', { id: 't1' });
    assert.strictEqual(stillDenied.result.error, 'forbidden');
    const state = await rpc(bothWs.ws, 'hub.getState', {});
    assert.deepStrictEqual(state.result.permissions, ['read', 'emergency']);
    bothWs.ws.close();

    const allWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + allRedeem.token }, wsHeaders));
    assert.strictEqual(allWs.open, true);
    const started = await rpc(allWs.ws, 'engine.start', { id: 't1' });
    assert.strictEqual(started.result.ok, true);
    const badJson = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no-parse-error')), 1500);
      allWs.ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
      allWs.ws.send('not-json');
    });
    assert.strictEqual(badJson.error.code, -32700);
    assert.strictEqual(allWs.ws.readyState, WebSocket.OPEN);
    const afterBad = await rpc(allWs.ws, 'engine.status', {});
    assert.strictEqual(afterBad.result.connected, false);

    let pushed = null;
    const waitEvent = new Promise((resolve) => {
      function onMessage(data) {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'event' && msg.params && msg.params.name === EVENTS.SESSION_STARTED) {
          allWs.ws.off('message', onMessage);
          pushed = msg.params;
          resolve();
        }
      }
      allWs.ws.on('message', onMessage);
    });
    bus.publish(EVENTS.SESSION_STARTED, { title: 'stage1b' });
    await waitEvent;
    assert.strictEqual(pushed.payload.title, 'stage1b');

    const closed = new Promise((resolve) => allWs.ws.once('close', () => resolve('closed')));
    const revoked = await api.call('clients.revoke', { id: allRedeem.client.id }, {
      permissions: ['read', 'write', 'emergency'],
      via: 'ws',
      clientId: WINDOW_ID
    });
    assert.strictEqual(revoked.ok, true);
    assert.strictEqual(await closed, 'closed');
    const revokedWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + allRedeem.token }, wsHeaders));
    assert.strictEqual(revokedWs.open, false);

    const ratePair = clients.beginPairing({ name: '流量', permissions: ['read', 'write', 'emergency'] });
    const rateRedeem = clients.redeem(ratePair.code);
    const rateWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + rateRedeem.token }, wsHeaders));
    assert.strictEqual(rateWs.open, true);
    const rateClosed = new Promise((resolve) => rateWs.ws.once('close', () => resolve('closed')));
    for (let i = 0; i < 51; i += 1) {
      try { rateWs.ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'engine.status', params: {} })); } catch (_) { break; }
    }
    assert.strictEqual(await rateClosed, 'closed');

    const sizePair = clients.beginPairing({ name: '大きさ', permissions: ['read'] });
    const sizeRedeem = clients.redeem(sizePair.code);
    const sizeWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + sizeRedeem.token }, wsHeaders));
    assert.strictEqual(sizeWs.open, true);
    const sizeClosed = new Promise((resolve) => sizeWs.ws.once('close', () => resolve('closed')));
    try { sizeWs.ws.send(Buffer.alloc(65537, 120)); } catch (_) { /* server may already be closing */ }
    assert.strictEqual(await sizeClosed, 'closed');

    let clock = 1000000;
    let seq = 0;
    const timedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-1b-pair-'));
    try {
      const timed = createClients({
        core: fakeCore(timedDir),
        now: () => clock,
        randomInt: () => {
          seq += 1;
          return 111110 + seq;
        }
      });
      const first = timed.beginPairing({ name: '一時' });
      assert.strictEqual(first.code, '111111');
      const second = timed.beginPairing({ name: '次' });
      assert.strictEqual(timed.redeem(first.code).error, 'bad-code');
      clock += 120001;
      assert.strictEqual(timed.redeem(second.code).error, 'expired');
      clock = 2000000;
      const fresh = timed.beginPairing({ name: '回数', permissions: ['read', 'emergency'] });
      for (let i = 0; i < 4; i += 1) assert.strictEqual(timed.redeem('000000').error, 'bad-code');
      assert.strictEqual(timed.redeem('000000').error, 'locked');
      assert.strictEqual(timed.redeem(fresh.code).error, 'no-code');
      const good = timed.beginPairing({ name: '保存', permissions: ['read', 'emergency'] });
      const redeemed = timed.redeem(good.code);
      assert.strictEqual(redeemed.ok, true);
      const raw = fs.readFileSync(timed.file, 'utf8');
      assert.ok(!raw.includes(redeemed.token));
      assert.ok(raw.includes(sha256(redeemed.token)));
      assert.ok(!raw.includes(good.code));
    } finally {
      rimraf(timedDir);
    }

    const posted = clients.beginPairing({ name: 'ブラウザ', permissions: ['read', 'emergency'] });
    const paired = await request(port, 'POST', '/pair', { code: posted.code }, { Origin: 'http://127.0.0.1:18770' });
    assert.strictEqual(paired.status, 200);
    const cookie = String(paired.headers['set-cookie']);
    assert.ok(cookie.includes('HttpOnly'), cookie);
    assert.ok(cookie.includes('SameSite=Strict'), cookie);
    assert.ok(!logs.join('\n').includes(posted.code));
    const reuse = await request(port, 'POST', '/pair', { code: posted.code }, { Origin: 'http://127.0.0.1:18770' });
    assert.strictEqual(reuse.status, 401);
    const badOriginPair = await request(port, 'POST', '/pair', { code: '000000' }, { Origin: 'http://evil.example' });
    assert.strictEqual(badOriginPair.status, 403);

    const savedLayout = layouts.save('配信中', { version: 1, dockview: { marker: 'same' } });
    assert.strictEqual(savedLayout.ok, true);
    const listed = layouts.list();
    assert.ok(listed.names.includes('標準'));
    assert.ok(listed.names.includes('配信中'));
    const loaded = layouts.get('配信中');
    assert.deepStrictEqual(loaded.data, { version: 1, dockview: { marker: 'same' } });
    assert.strictEqual(layouts.list().last, '配信中');
    const builtin = layouts.get('標準');
    assert.strictEqual(builtin.ok, true);
    assert.strictEqual(builtin.builtin, true);
    assert.strictEqual(layouts.save('../x', { version: 1 }).error, 'layout-name');
    assert.strictEqual(layouts.save('a/b', { version: 1 }).error, 'layout-name');
    const huge = layouts.save('大きい', { blob: 'x'.repeat(300000) });
    assert.strictEqual(huge.error, 'too-large');
    assert.ok(!fs.existsSync(layouts.fileFor('大きい')));
    const viaApi = await api.call('layout.save', { name: 'メモ', data: { version: 1, note: 'ok' } }, { permissions: ['read', 'write', 'emergency'], via: 'ws', clientId: 't' });
    assert.strictEqual(viaApi.ok, true);
    const viaGet = await api.call('layout.get', { name: 'メモ' }, { permissions: ['read'], via: 'ws', clientId: 't' });
    assert.deepStrictEqual(viaGet.data, { version: 1, note: 'ok' });

    const windowCtx = { permissions: ['read', 'write', 'emergency'], via: 'ws', clientId: WINDOW_ID };
    await test('window client alone can pair and revoke', async () => {
      const browserPair = clients.beginPairing({ name: '書ける', permissions: ['read', 'write', 'emergency'] });
      const browserRedeem = clients.redeem(browserPair.code);
      const browserWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + browserRedeem.token }, wsHeaders));
      assert.strictEqual(browserWs.open, true);
      const deniedPair = await rpc(browserWs.ws, 'clients.beginPairing', { name: '増やす', permissions: ['read', 'write'] });
      assert.strictEqual(deniedPair.result.error, 'forbidden');
      const deniedRevoke = await rpc(browserWs.ws, 'clients.revoke', { id: browserRedeem.client.id });
      assert.strictEqual(deniedRevoke.result.error, 'forbidden');
      assert.ok(clients.list().some((row) => row.id === browserRedeem.client.id));
      browserWs.ws.close();
      const opened = await api.call('clients.beginPairing', { name: '窓から', permissions: ['read'] }, windowCtx);
      assert.strictEqual(opened.ok, true);
      const added = clients.redeem(opened.code);
      assert.strictEqual(added.ok, true);
      const removed = await api.call('clients.revoke', { id: added.client.id }, windowCtx);
      assert.strictEqual(removed.ok, true);
      assert.ok(!clients.list().some((row) => row.id === added.client.id));
      const self = await api.call('clients.revoke', { id: WINDOW_ID }, windowCtx);
      assert.strictEqual(self.error, 'cannot-revoke-window');
      assert.strictEqual(clients.revoke(WINDOW_ID).error, 'cannot-revoke-window');
      const missingId = await api.call('clients.beginPairing', { name: '無印' }, {
        permissions: ['read', 'write', 'emergency'],
        via: 'ws'
      });
      assert.strictEqual(missingId.error, 'forbidden');
      const hubJs = hubSource();
      const hubHtml = require('./_ui-source').shellDocument();
      assert.ok(hubJs.includes("state.clientId === 'local-window'"));
      assert.ok(hubHtml.includes('id="client-admin" hidden'));
    });

    await test('event push skips clients without read', async () => {
      const emergPair = clients.beginPairing({ name: '緊急だけ', permissions: ['emergency'] });
      const emergRedeem = clients.redeem(emergPair.code);
      assert.deepStrictEqual(emergRedeem.client.permissions, ['read', 'emergency']);
      const raw = JSON.parse(fs.readFileSync(clients.file, 'utf8'));
      const row = raw.clients.find((item) => item.id === emergRedeem.client.id);
      row.permissions = ['emergency'];
      fs.writeFileSync(clients.file, JSON.stringify(raw));
      const readPair = clients.beginPairing({ name: '読む側', permissions: ['read'] });
      const readRedeem = clients.redeem(readPair.code);
      const emergWs = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + emergRedeem.token }, wsHeaders));
      const readWs2 = await tryWs(port, Object.assign({ Cookie: 'marust_session=' + readRedeem.token }, wsHeaders));
      assert.strictEqual(emergWs.open, true);
      assert.strictEqual(readWs2.open, true);
      let emergCount = 0;
      const got = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('read client got no event')), 1500);
        readWs2.ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'event' && msg.params && msg.params.payload && msg.params.payload.title === 'v2-read') {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
      emergWs.ws.on('message', () => { emergCount += 1; });
      bus.publish(EVENTS.SESSION_STARTED, { title: 'v2-read' });
      await got;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(emergCount, 0);
      emergWs.ws.close();
      readWs2.ws.close();
    });

    await test('authenticate writes lastSeenAt at most once a minute', async () => {
      const seenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-1b-seen-'));
      try {
        let clock = 1700000000000;
        let writes = 0;
        const seenCore = fakeCore(seenDir);
        const writeJson = seenCore.atomicWriteJsonSync;
        seenCore.atomicWriteJsonSync = function (file, data) {
          if (String(file).endsWith('marust-clients.json')) writes += 1;
          return writeJson(file, data);
        };
        const seenClients = createClients({
          core: seenCore,
          now: function () { return clock; },
          randomInt: function () { return 333333; }
        });
        const pairing = seenClients.beginPairing({ name: '短い', permissions: ['read'] });
        const redeemed = seenClients.redeem(pairing.code);
        assert.strictEqual(redeemed.ok, true);
        writes = 0;
        let last = null;
        for (let i = 0; i < 10; i += 1) {
          clock += 1000;
          last = seenClients.authenticate(redeemed.token);
          assert.ok(last);
        }
        assert.strictEqual(writes, 1);
        const stored = JSON.parse(fs.readFileSync(seenClients.file, 'utf8')).clients.find((item) => item.id === redeemed.client.id);
        assert.notStrictEqual(stored.lastSeenAt, last.lastSeenAt);
        const listed = seenClients.list().find((item) => item.id === redeemed.client.id);
        assert.strictEqual(listed.lastSeenAt, last.lastSeenAt);
        clock += 60000;
        const later = seenClients.authenticate(redeemed.token);
        assert.ok(later);
        assert.strictEqual(writes, 2);
      } finally {
        rimraf(seenDir);
      }
    });

    await test('layout names are trimmed and blank names are rejected', async () => {
      assert.strictEqual(layouts.save('   ', { version: 1 }).error, 'layout-name');
      assert.strictEqual(layouts.save(' \u3000\t ', { version: 1 }).error, 'layout-name');
      const saved = layouts.save('  余白あり  ', { version: 1, marker: 'trim' });
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(saved.name, '余白あり');
      assert.deepStrictEqual(layouts.get('  余白あり  ').data, { version: 1, marker: 'trim' });
      const denied = await api.call('layout.save', { name: '   ', data: { version: 1 } }, {
        permissions: ['read', 'write'],
        via: 'ws',
        clientId: 't'
      });
      assert.strictEqual(denied.error, 'layout-name');
      const via = await api.call('layout.save', { name: '  余白二  ', data: { version: 1, marker: 'api' } }, {
        permissions: ['read', 'write'],
        via: 'ws',
        clientId: 't'
      });
      assert.strictEqual(via.ok, true);
      assert.strictEqual(via.name, '余白二');
      assert.deepStrictEqual(layouts.get('余白二').data, { version: 1, marker: 'api' });
    });

    await test('layout names that differ only by case are the same layout', async () => {
      assert.strictEqual(layouts.save('CON', { version: 1, marker: 'upper' }).ok, true);
      assert.strictEqual(layouts.save('con', { version: 1, marker: 'lower' }).ok, true);
      assert.strictEqual(layouts.fileFor('CON'), layouts.fileFor('con'));
      assert.strictEqual(layouts.fileFor('  Con  '), layouts.fileFor('con'));
      const names = layouts.list().names.filter((name) => name.toLowerCase() === 'con');
      assert.deepStrictEqual(names, ['con']);
      const loaded = layouts.get('CON');
      assert.strictEqual(loaded.ok, true);
      assert.deepStrictEqual(loaded.data, { version: 1, marker: 'lower' });
      assert.strictEqual(loaded.name, 'con');
      assert.strictEqual(layouts.remove('CoN').ok, true);
      assert.strictEqual(layouts.get('con').error, 'not-found');
      assert.strictEqual(layouts.list().names.some((name) => name.toLowerCase() === 'con'), false);
      const hubJs = hubSource()
        + fs.readFileSync(path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell', 'menubar.js'), 'utf8');
      assert.ok(hubJs.includes('同じ名前です。上書きしますか？'));
    });

    const dock = hubSource();
    assert.ok(dock.includes('createDockview'));
    assert.ok(dock.includes('tabComponent'));
    assert.ok(dock.includes("id === 'emergency'"));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies.dockview);
    assert.ok(pkg.dependencies.ws);
    assert.ok(pkg.scripts.build.includes('--ignore=/test'));
    assert.ok(pkg.scripts.build.includes('--ignore=/docs'));
    const notice = fs.readFileSync(path.join(__dirname, '..', 'ui', 'THIRD_PARTY.md'), 'utf8');
    assert.ok(notice.includes('MIT'));
    assert.ok(notice.includes('dockview'));
    const joined = logs.join('\n');
    assert.ok(!joined.includes(readRedeem.token));
    assert.ok(!joined.includes(allRedeem.token));
  } finally {
    console.log = orig;
    await new Promise((resolve) => server.close(resolve));
    rimraf(dir);
  }
  console.log('[marust] stage1b tests passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
