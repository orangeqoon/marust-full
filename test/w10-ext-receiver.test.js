'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const { createCore } = require('../host/core/core-bridge');
const { createCaptureReceiver } = require('../host/layer1/capture-receiver');
const { createGateway } = require('../host/layer1/gateway');
const { createClients, sha256, WINDOW_ID } = require('../host/layer1/clients');
const { createApi, IPC_PERMISSIONS, EXT_WRITE, PERMISSIONS } = require('../host/layer1/api');
const { createEventBus } = require('../host/core/event-bus');
const { EVENTS } = require('../host/core/events');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { siteIdsFromRows, MAX_BODY_BYTES, MAX_COOKIE_BYTES } = require('../host/layer1/ext-receiver');

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_ID = 'bacdefghijklmnopbacdefghijklmnop';
const NEVER_ID = 'cdefghijklmnopabcdefghijklmnop';
const SECRET = 'CookieValue/9f3c1a7e+qq';
const CAPTURE = 'CaptureValue/9f3c1a7e+qq';

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 拡張が受け取るサイトは、サイトのプラグインの manifest.site.id（核の直書きではない）。
function sitePluginSource() {
  const root = path.join(__dirname, '..', 'plugins', 'sites');
  const rows = [];
  fs.readdirSync(root, { withFileTypes: true }).forEach(function (entry) {
    if (!entry.isDirectory()) return;
    const file = path.join(root, entry.name, 'manifest.json');
    if (!fs.existsSync(file)) return;
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { manifest = null; }
    if (!manifest || !manifest.site) return;
    rows.push({ id: entry.name, manifest: manifest });
  });
  return { snapshot: function () { return rows; } };
}
const sitePlugins = sitePluginSource();

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
  return new Promise(function (resolve, reject) {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: urlPath,
      method: method,
      headers: Object.assign({ Host: '127.0.0.1:18770' }, headers || {}, payload == null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
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

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name);
    throw err;
  }
}

function extHeaders(token, id) {
  const headers = { Origin: 'chrome-extension://' + (id || EXT_ID) };
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

function assertNoValues(text, label) {
  const raw = text == null ? '' : String(text);
  assert.ok(!raw.includes(SECRET), label || 'secret');
  assert.ok(!raw.includes(CAPTURE), label || 'capture');
}

function readLogs(dir) {
  const folder = path.join(dir, 'logs', 'marust');
  if (!fs.existsSync(folder)) return '';
  return fs.readdirSync(folder).filter(function (name) {
    return name.endsWith('.jsonl');
  }).map(function (name) {
    return fs.readFileSync(path.join(folder, name), 'utf8');
  }).join('\n');
}

function originOf(res) {
  return res.headers['access-control-allow-origin'];
}

async function main() {
  let clock = 5000000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w10-'));
  const core = fakeCore(dir);
  const events = [];
  const bus = createEventBus({ logger: function () {} });
  bus.subscribe(EVENTS.AUTH_UPDATED, function (_name, payload) { events.push(payload); });
  const clients = createClients({ core: core });
  const secrets = createSecretProvider({
    core: core,
    allowFake: true,
    backend: createFakeBackend()
  });
  const store = {
    snapshot: function () {
      return {
        destinations: [
          {
            id: 'youtube-main',
            site: 'youtube',
            enabled: true,
            desired: { title: SECRET, live: true },
            engine: { id: 'obs-local', targetId: 't1', key: SECRET },
            actual: {
              siteLive: true,
              engineState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
              lastError: 'connect-failed',
              title: SECRET,
              updatedAt: '2026-10-04T00:00:00.000Z'
            }
          },
          {
            id: 'twitch-main',
            site: 'twitch',
            enabled: true,
            actual: {
              siteLive: false,
              engineState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
              lastError: 'not a code',
              updatedAt: '2026-10-04T00:00:01.000Z'
            }
          },
          {
            id: 'kick-main',
            site: 'kick',
            enabled: true,
            actual: {
              siteLive: false,
              engineState: '',
              lastError: SECRET,
              updatedAt: '2026-10-04T00:00:02.000Z'
            }
          },
          {
            id: 'siteonly-main',
            site: 'rumble',
            enabled: true,
            actual: { siteLive: true, engineState: '', updatedAt: '2026-10-04T00:00:04.000Z' }
          },
          {
            id: 'fc2-main',
            site: 'fc2',
            enabled: true,
            actual: {
              siteLive: false,
              engineState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
              lastError: 'server-refused',
              updatedAt: '2026-10-04T00:00:03.000Z'
            }
          }
        ]
      };
    }
  };
  const engine = {
    status: function () {
      return { connected: true, key: SECRET, detail: SECRET, streamKey: SECRET };
    }
  };
  const api = createApi({
    getState: function () { return { product: 'marust', mode: 'legacy' }; },
    fanout: function () { return { ok: true }; },
    forceLegacy: function () { return { mode: 'legacy' }; },
    engine: engine,
    clients: clients,
    store: store,
    bus: bus,
    core: core,
    secrets: secrets
  });
  const receiver = createCaptureReceiver({ core: core, onStatus: async function () { return { name: 'marust' }; } });
  const gateway = createGateway({
    core: core,
    receiver: receiver,
    clients: clients,
    api: api,
    bus: bus,
    secrets: secrets,
    store: store,
    engine: engine,
    now: function () { return clock; },
    plugins: sitePlugins,
    uiRoot: path.join(__dirname, '..', 'ui'),
    vendorRoot: path.join(__dirname, '..', 'node_modules', 'dockview')
  });
  const server = await gateway.listen(0);
  const port = server.address().port;
  const logs = [];
  const origLog = console.log;
  console.log = function () {
    const line = Array.prototype.join.call(arguments, ' ');
    logs.push(line);
    origLog(line);
  };
  const sockets = [];
  let token = '';
  let clientId = '';

  async function sendExt(method, urlPath, body, headers, options) {
    const opts = options || {};
    if (opts.gap !== false) clock += 1000;
    return request(port, method, urlPath, body, headers);
  }

  try {
    await test('ext-write is not a websocket method permission', async function () {
      assert.ok(PERMISSIONS.indexOf(EXT_WRITE) !== -1);
      assert.ok(IPC_PERMISSIONS.indexOf(EXT_WRITE) === -1);
      const described = await api.call('api.describe', {});
      assert.strictEqual(described.ok, true);
      described.methods.forEach(function (row) {
        assert.notStrictEqual(row.permission, EXT_WRITE);
      });
      const denied = await api.call('engine.start', { id: 'yt' }, {
        permissions: ['read', EXT_WRITE],
        clientId: 'ext-1',
        kind: 'extension'
      });
      assert.strictEqual(denied.error, 'forbidden');
      const windowOnly = await api.call('clients.beginPairing', { name: '拡張', kind: 'extension' }, {
        permissions: ['read', 'write'],
        clientId: 'browser-1',
        kind: 'browser'
      });
      assert.strictEqual(windowOnly.error, 'forbidden');
      assert.strictEqual(clients.beginPairing({ name: 'ダメ', kind: 'widget' }).error, 'kind');
    });

    await test('extension pairing rejects a foreign origin and keeps fixed permissions', async function () {
      const started = clients.beginPairing({
        name: '拡張',
        kind: 'extension',
        permissions: ['read', 'write', 'emergency'],
        requiresApproval: true
      });
      assert.strictEqual(started.ok, true);
      assert.strictEqual(started.code.length, 6);
      const browserOrigin = await request(port, 'POST', '/pair/extension', {
        code: started.code,
        name: 'Marust'
      }, { Origin: 'http://127.0.0.1:18770' });
      assert.strictEqual(browserOrigin.status, 403);
      assert.strictEqual(JSON.parse(browserOrigin.body).error, 'origin');
      assert.ok(!browserOrigin.headers['set-cookie']);
      const missingOrigin = await request(port, 'POST', '/pair/extension', { code: started.code, name: 'Marust' });
      assert.strictEqual(missingOrigin.status, 403);
      const badId = await request(port, 'POST', '/pair/extension', { code: started.code, name: 'Marust' }, {
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnox'
      });
      assert.strictEqual(badId.status, 403);
      const badName = await request(port, 'POST', '/pair/extension', { code: started.code }, extHeaders('', EXT_ID));
      assert.strictEqual(badName.status, 400);
      assert.strictEqual(JSON.parse(badName.body).error, 'name');
      const asBrowser = await request(port, 'POST', '/pair', { code: started.code }, { Origin: 'http://127.0.0.1:18770' });
      assert.strictEqual(asBrowser.status, 401);
      assert.ok(!asBrowser.headers['set-cookie']);
      const asNative = await request(port, 'POST', '/pair/native', { code: started.code, name: 'CLI' });
      assert.strictEqual(asNative.status, 401);
      const paired = await request(port, 'POST', '/pair/extension', { code: started.code, name: 'Marust' }, extHeaders('', EXT_ID));
      assert.strictEqual(paired.status, 200, paired.body);
      assert.ok(!paired.headers['set-cookie']);
      assert.strictEqual(originOf(paired), undefined);
      const body = JSON.parse(paired.body);
      assert.deepStrictEqual(Object.keys(body).sort(), ['clientId', 'ok', 'token']);
      assert.strictEqual(body.ok, true);
      assert.ok(body.token.length >= 32);
      token = body.token;
      clientId = body.clientId;
      const raw = JSON.parse(fs.readFileSync(clients.file, 'utf8'));
      const row = raw.clients.find(function (item) { return item.id === clientId; });
      assert.strictEqual(row.kind, 'extension');
      assert.strictEqual(row.extensionId, EXT_ID);
      assert.strictEqual(row.requiresApproval, false);
      assert.deepStrictEqual(row.permissions, ['read', 'ext-write']);
      assert.strictEqual(row.tokenHash, sha256(token));
      assert.ok(!JSON.stringify(raw).includes(token));
      assert.ok(!JSON.stringify(raw).includes(started.code));
      const listed = clients.list().find(function (item) { return item.id === clientId; });
      assert.strictEqual(listed.name, 'Marust');
      assert.strictEqual(listed.kind, 'extension');
      assert.strictEqual(listed.extensionId, EXT_ID);
      const reuse = await request(port, 'POST', '/pair/extension', { code: started.code, name: 'Marust' }, extHeaders('', EXT_ID));
      assert.strictEqual(reuse.status, 401);
    });

    await test('status lists live destinations and drops secrets', async function () {
      const res = await request(port, 'GET', '/ext/status', null, extHeaders(token, EXT_ID));
      assert.strictEqual(res.status, 200, res.body);
      assert.strictEqual(originOf(res), 'chrome-extension://' + EXT_ID);
      assertNoValues(res.body, 'status');
      assert.ok(!res.body.includes(token));
      assert.ok(!res.body.includes('streamKey'));
      assert.ok(!res.body.includes('local-window'));
      assert.deepStrictEqual(JSON.parse(res.body), {
        ok: true,
        running: true,
        engine: { connected: true },
        destinations: [
          { name: 'youtube-main', site: 'youtube', status: 'OBS_WEBSOCKET_OUTPUT_STARTED', siteLive: true }
        ],
        errors: [
          { name: 'fc2-main', code: 'server-refused' },
          { name: 'youtube-main', code: 'connect-failed' }
        ]
      });
    });

    await test('cookies and capture are stored without echoing values', async function () {
      const old = await request(port, 'POST', '/soop_auth', { cookies: { example: 'not-a-secret' } });
      assert.strictEqual(old.status, 200);
      const soopFile = path.join(core.COOKIES_DIR, 'marust', 'soop-cookies.json');
      const before = fs.readFileSync(soopFile, 'utf8');
      assert.strictEqual(JSON.parse(before).cookies.example, 'not-a-secret');
      const beforeEvents = events.length;
      const posted = await sendExt('POST', '/ext/cookies', {
        site: 'twitcasting',
        account: 'main',
        cookies: { session: SECRET },
        capturedAt: SECRET
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(posted.status, 200, posted.body);
      assert.deepStrictEqual(JSON.parse(posted.body), { ok: true, count: 1 });
      assertNoValues(posted.body, 'cookies-response');
      assert.strictEqual(originOf(posted), 'chrome-extension://' + EXT_ID);
      assert.notStrictEqual(originOf(posted), '*');
      await bus.flush();
      assert.strictEqual(events.length, beforeEvents + 1);
      const payload = events[events.length - 1];
      assert.deepStrictEqual(Object.keys(payload).sort(), ['account', 'at', 'count', 'site']);
      assert.strictEqual(payload.site, 'twitcasting');
      assert.strictEqual(payload.account, 'main');
      assert.strictEqual(payload.count, 1);
      assert.ok(payload.at !== SECRET);
      assertNoValues(JSON.stringify(payload), 'event');
      const got = await secrets.coreReader('twitcasting', () => true).get('cookies.twitcasting-main');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(JSON.parse(got.value).session, SECRET);
      const captured = await sendExt('POST', '/ext/capture', {
        site: 'twitcasting',
        account: 'main',
        kind: 'user-id',
        data: { user_id: CAPTURE },
        capturedAt: '2026-10-04T00:00:00.000Z'
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(captured.status, 200, captured.body);
      assert.deepStrictEqual(JSON.parse(captured.body), { ok: true });
      assertNoValues(captured.body, 'capture-response');
      await bus.flush();
      assert.strictEqual(events.length, beforeEvents + 1);
      const cap = await secrets.coreReader('twitcasting', () => true).get('capture.twitcasting-main.user-id');
      assert.strictEqual(cap.ok, true);
      assert.strictEqual(JSON.parse(cap.value).user_id, CAPTURE);
      assert.strictEqual(fs.readFileSync(soopFile, 'utf8'), before);
      assert.ok(!fs.existsSync(path.join(core.COOKIES_DIR, 'marust', 'twitcasting-cookies.json')));
      const text = readLogs(dir);
      assert.ok(text.includes('cookies.twitcasting-main'));
      assert.ok(text.includes('count:1'));
      assert.ok(text.includes('capture.twitcasting-main.user-id'));
      assert.ok(text.includes('extension:' + clientId));
      assertNoValues(text, 'audit');
      assertNoValues(fs.readFileSync(secrets.file, 'utf8'), 'vault-file');
      const again = await request(port, 'GET', '/ext/status?view=1', null, extHeaders(token, EXT_ID));
      assert.strictEqual(again.status, 200);
      assertNoValues(again.body, 'status-after');
    });

    await test('another extension, a missing token, and other kinds are rejected', async function () {
      const other = await sendExt('POST', '/ext/cookies', {
        site: 'kick',
        account: 'nope',
        cookies: { session: SECRET }
      }, extHeaders(token, NEVER_ID));
      assert.strictEqual(other.status, 403);
      assert.strictEqual(JSON.parse(other.body).error, 'origin');
      assert.strictEqual(originOf(other), undefined);
      assertNoValues(other.body, 'other-origin');
      const missing = await request(port, 'POST', '/ext/cookies', {
        site: 'kick',
        account: 'nope',
        cookies: { session: SECRET }
      }, { Origin: 'chrome-extension://' + EXT_ID });
      assert.strictEqual(missing.status, 401);
      assert.strictEqual(JSON.parse(missing.body).error, 'unauthorized');
      assert.strictEqual(originOf(missing), 'chrome-extension://' + EXT_ID);
      assertNoValues(missing.body, 'no-token');
      const browserPair = clients.beginPairing({ name: 'ブラウザ', permissions: ['read', 'write'] });
      const browserRedeem = clients.redeem(browserPair.code);
      assert.strictEqual(browserRedeem.client.kind, 'browser');
      const browserToken = browserRedeem.token;
      const asBrowser = await sendExt('POST', '/ext/capture', {
        site: 'kick',
        account: 'nope',
        kind: 'user-id',
        data: { user_id: CAPTURE }
      }, {
        Origin: 'chrome-extension://' + EXT_ID,
        Authorization: 'Bearer ' + browserToken
      });
      assert.strictEqual(asBrowser.status, 401);
      const nativePair = clients.beginPairing({ name: 'CLI', kind: 'native', permissions: ['read'] });
      const nativeRedeem = clients.redeem(nativePair.code, { kind: 'native', name: 'CLI' });
      const asNative = await sendExt('POST', '/ext/cookies', {
        site: 'kick',
        account: 'nope',
        cookies: { session: SECRET }
      }, {
        Origin: 'chrome-extension://' + EXT_ID,
        Authorization: 'Bearer ' + nativeRedeem.token
      });
      assert.strictEqual(asNative.status, 401);
      const windowed = clients.ensureWindowClient();
      const asWindow = await sendExt('GET', '/ext/status', null, {
        Origin: 'chrome-extension://' + EXT_ID,
        Authorization: 'Bearer ' + windowed.token
      });
      assert.strictEqual(asWindow.status, 401);
      const absent = await secrets.coreReader('kick', () => true).get('cookies.kick-nope');
      assert.strictEqual(absent.ok, false);
      const capAbsent = await secrets.coreReader('kick', () => true).get('capture.kick-nope.user-id');
      assert.strictEqual(capAbsent.ok, false);

      function rewritePerms(permissions) {
        const raw = JSON.parse(fs.readFileSync(clients.file, 'utf8'));
        const row = raw.clients.find(function (item) { return item.id === clientId; });
        row.permissions = permissions;
        fs.writeFileSync(clients.file, JSON.stringify(raw));
      }
      rewritePerms(['read']);
      const noWrite = await sendExt('POST', '/ext/cookies', {
        site: 'kick',
        account: 'nope',
        cookies: { session: SECRET }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(noWrite.status, 403);
      assert.strictEqual(JSON.parse(noWrite.body).error, 'forbidden');
      const stillRead = await request(port, 'GET', '/ext/status', null, extHeaders(token, EXT_ID));
      assert.strictEqual(stillRead.status, 200);
      rewritePerms(['ext-write']);
      const noRead = await request(port, 'GET', '/ext/status', null, extHeaders(token, EXT_ID));
      assert.strictEqual(noRead.status, 403);
      const stillWrite = await sendExt('POST', '/ext/cookies', {
        site: 'youtube',
        account: 'alt',
        cookies: { session: 'plain' }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(stillWrite.status, 200);
      rewritePerms(['read', 'ext-write']);
    });

    await test('site, account, kind, and size are validated', async function () {
      const badSite = await sendExt('POST', '/ext/cookies', {
        site: 'facebook',
        cookies: { session: SECRET }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(badSite.status, 400);
      assert.strictEqual(JSON.parse(badSite.body).error, 'site');
      assertNoValues(badSite.body, 'bad-site');
      const badAccount = await sendExt('POST', '/ext/cookies', {
        site: 'twitch',
        account: 'MAIN',
        cookies: { session: SECRET }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(badAccount.status, 400);
      assert.strictEqual(JSON.parse(badAccount.body).error, 'account');
      const omitted = await sendExt('POST', '/ext/cookies', {
        site: 'kick',
        cookies: { a: '1' }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(omitted.status, 200, omitted.body);
      const omittedGot = await secrets.coreReader('kick', () => true).get('cookies.kick-main');
      assert.strictEqual(omittedGot.ok, true);
      const badKind = await sendExt('POST', '/ext/capture', {
        site: 'twitch',
        kind: 'User_Id',
        data: { user_id: CAPTURE }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(badKind.status, 400);
      assert.strictEqual(JSON.parse(badKind.body).error, 'kind');
      const noData = await sendExt('POST', '/ext/capture', {
        site: 'twitch',
        kind: 'user-id'
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(noData.status, 400);
      assert.strictEqual(JSON.parse(noData.body).error, 'data');
      const many = {};
      for (let i = 0; i < 301; i += 1) many['c' + i] = 'x';
      const tooMany = await sendExt('POST', '/ext/cookies', {
        site: 'rumble',
        cookies: many
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(tooMany.status, 400);
      assert.strictEqual(JSON.parse(tooMany.body).error, 'too-many');
      const fat = await sendExt('POST', '/ext/cookies', {
        site: 'rumble',
        cookies: { session: 'x'.repeat(MAX_COOKIE_BYTES + 1) }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(fat.status, 400);
      assert.strictEqual(JSON.parse(fat.body).error, 'too-large');
      const wide = {};
      for (let i = 0; i < 100; i += 1) wide['k' + i] = 'v'.repeat(700);
      const wideJson = JSON.stringify({ site: 'twitch', account: 'wide', cookies: wide });
      assert.ok(Buffer.byteLength(wideJson) > 64 * 1024);
      assert.ok(Buffer.byteLength(wideJson) <= MAX_BODY_BYTES);
      const tooWide = await sendExt('POST', '/ext/cookies', {
        site: 'twitch',
        account: 'wide',
        cookies: wide
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(tooWide.status, 400);
      assert.strictEqual(JSON.parse(tooWide.body).error, 'too-large');
      const wideMissing = await secrets.coreReader('twitch', () => true).get('cookies.twitch-wide');
      assert.strictEqual(wideMissing.ok, false);
      const longName = await sendExt('POST', '/ext/capture', {
        site: 'twitcasting',
        account: 'a'.repeat(32),
        kind: 'b'.repeat(32),
        data: { user_id: '1' }
      }, extHeaders(token, EXT_ID));
      assert.strictEqual(longName.status, 400);
      assert.strictEqual(JSON.parse(longName.body).error, 'bad-name');
      const huge = await sendExt('POST', '/ext/cookies', 'x'.repeat(MAX_BODY_BYTES + 1), extHeaders(token, EXT_ID));
      assert.strictEqual(huge.status, 413);
      assert.strictEqual(JSON.parse(huge.body).error, 'too-large');
      const siteIds = siteIdsFromRows(sitePlugins.snapshot());
      assert.ok(siteIds.indexOf('youtube') !== -1 && siteIds.indexOf('twitch') !== -1 && siteIds.indexOf('niconico') !== -1);
      for (let i = 0; i < siteIds.length; i += 1) {
        const site = siteIds[i];
        const res = await sendExt('POST', '/ext/cookies', {
          site: site,
          account: 'sites',
          cookies: { a: '1' }
        }, extHeaders(token, EXT_ID));
        assert.strictEqual(res.status, 200, site + ' ' + res.body);
      }
      assert.ok(siteIds.length >= 1);
    });

    await test('the sixth post in one second is 429', async function () {
      clock += 1000;
      for (let i = 0; i < 6; i += 1) {
        const viewed = await request(port, 'GET', '/ext/status', null, extHeaders(token, EXT_ID));
        assert.strictEqual(viewed.status, 200);
      }
      for (let i = 1; i <= 5; i += 1) {
        const res = await sendExt('POST', '/ext/cookies', {
          site: 'niconico',
          account: 'rate',
          cookies: { n: String(i) }
        }, extHeaders(token, EXT_ID), { gap: false });
        assert.strictEqual(res.status, 200, res.body);
      }
      const blocked = await sendExt('POST', '/ext/cookies', {
        site: 'niconico',
        account: 'rate',
        cookies: { n: '6' }
      }, extHeaders(token, EXT_ID), { gap: false });
      assert.strictEqual(blocked.status, 429);
      assert.strictEqual(JSON.parse(blocked.body).error, 'rate');
      assert.strictEqual(originOf(blocked), 'chrome-extension://' + EXT_ID);
      assertNoValues(blocked.body, 'rate');
      const mid = await secrets.coreReader('niconico', () => true).get('cookies.niconico-rate');
      assert.strictEqual(JSON.parse(mid.value).n, '5');
      clock += 1000;
      const again = await sendExt('POST', '/ext/cookies', {
        site: 'niconico',
        account: 'rate',
        cookies: { n: '7' }
      }, extHeaders(token, EXT_ID), { gap: false });
      assert.strictEqual(again.status, 200, again.body);
      const got = await secrets.coreReader('niconico', () => true).get('cookies.niconico-rate');
      assert.strictEqual(JSON.parse(got.value).n, '7');
    });

    await test('CORS is only returned to a paired extension origin', async function () {
      const paths = ['/ext/cookies', '/ext/capture', '/ext/status'];
      for (let i = 0; i < paths.length; i += 1) {
        const ok = await request(port, 'OPTIONS', paths[i], null, extHeaders('', EXT_ID));
        assert.strictEqual(ok.status, 204, paths[i]);
        assert.strictEqual(ok.body, '');
        assert.strictEqual(originOf(ok), 'chrome-extension://' + EXT_ID);
        assert.ok(String(ok.headers['access-control-allow-headers']).toLowerCase().includes('authorization'));
        assert.notStrictEqual(originOf(ok), '*');
      }
      const evil = await request(port, 'OPTIONS', '/ext/status', null, { Origin: 'https://evil.example' });
      assert.strictEqual(evil.status, 403);
      assert.strictEqual(originOf(evil), undefined);
      const loopback = await request(port, 'OPTIONS', '/ext/cookies', null, { Origin: 'http://127.0.0.1:18770' });
      assert.strictEqual(loopback.status, 403);
      assert.strictEqual(originOf(loopback), undefined);
      const stranger = await request(port, 'OPTIONS', '/ext/capture', null, extHeaders('', NEVER_ID));
      assert.strictEqual(stranger.status, 403);
      assert.strictEqual(originOf(stranger), undefined);
      const posted = await sendExt('POST', '/ext/cookies', {
        site: 'picarto',
        account: 'cors',
        cookies: { a: '1' }
      }, {
        Origin: 'https://evil.example',
        Authorization: 'Bearer ' + token
      });
      assert.strictEqual(posted.status, 403);
      assert.strictEqual(originOf(posted), undefined);
    });

    await test('an unavailable vault returns 503', async function () {
      async function bootDown(useVault) {
        const downDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w10-down-'));
        const downCore = fakeCore(downDir);
        const secretsImpl = useVault ? createSecretProvider({
          core: downCore,
          backend: {
            id: 'down',
            production: true,
            available: function () { return false; },
            encrypt: async function () { throw new Error('no'); },
            decrypt: async function () { throw new Error('no'); }
          }
        }) : null;
        const downClients = createClients({ core: downCore });
        const downReceiver = createCaptureReceiver({ core: downCore, onStatus: async function () { return { name: 'marust' }; } });
        const downGateway = createGateway({
          core: downCore,
          receiver: downReceiver,
          clients: downClients,
          secrets: secretsImpl,
          now: function () { return clock; },
          plugins: sitePlugins,
          uiRoot: path.join(__dirname, '..', 'ui'),
          vendorRoot: path.join(__dirname, '..', 'node_modules', 'dockview')
        });
        const downServer = await downGateway.listen(0);
        return { dir: downDir, clients: downClients, server: downServer, port: downServer.address().port };
      }
      async function expect503(box) {
        const started = box.clients.beginPairing({ name: '拡張', kind: 'extension' });
        const paired = await request(box.port, 'POST', '/pair/extension', {
          code: started.code,
          name: 'Marust'
        }, extHeaders('', EXT_ID));
        assert.strictEqual(paired.status, 200, paired.body);
        const downToken = JSON.parse(paired.body).token;
        const res = await request(box.port, 'POST', '/ext/cookies', {
          site: 'soop',
          account: 'down',
          cookies: { session: SECRET }
        }, extHeaders(downToken, EXT_ID));
        assert.strictEqual(res.status, 503, res.body);
        assert.deepStrictEqual(JSON.parse(res.body), { ok: false, error: 'vault-unavailable' });
        assertNoValues(res.body, '503');
        assertNoValues(readLogs(box.dir), '503-audit');
        const captured = await request(box.port, 'POST', '/ext/capture', {
          site: 'soop',
          kind: 'user-id',
          data: { user_id: CAPTURE }
        }, extHeaders(downToken, EXT_ID));
        assert.strictEqual(captured.status, 503);
        assertNoValues(captured.body, '503-capture');
        const viewed = await request(box.port, 'GET', '/ext/status', null, extHeaders(downToken, EXT_ID));
        assert.strictEqual(viewed.status, 200);
        assert.strictEqual(JSON.parse(viewed.body).running, true);
        assertNoValues(viewed.body, '503-status');
      }
      const closed = await bootDown(true);
      try {
        await expect503(closed);
      } finally {
        await new Promise(function (resolve) { closed.server.close(function () { resolve(); }); });
        rimraf(closed.dir);
      }
      const missing = await bootDown(false);
      try {
        await expect503(missing);
      } finally {
        await new Promise(function (resolve) { missing.server.close(function () { resolve(); }); });
        rimraf(missing.dir);
      }
    });

    await test('browser cookies and native bearer sockets still work', async function () {
      const browserPair = clients.beginPairing({ name: 'ブラウザ', permissions: ['read', 'write'] });
      const browserPosted = await request(port, 'POST', '/pair', { code: browserPair.code }, { Origin: 'http://127.0.0.1:18770' });
      assert.strictEqual(browserPosted.status, 200);
      const setCookie = String(browserPosted.headers['set-cookie']);
      assert.ok(setCookie.includes('HttpOnly'));
      assert.ok(setCookie.includes('SameSite=Strict'));
      const browserToken = decodeURIComponent(/marust_session=([^;]+)/.exec(setCookie)[1]);
      const browserWs = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Origin: 'http://127.0.0.1:18770',
        Cookie: 'marust_session=' + browserToken
      });
      assert.strictEqual(browserWs.open, true);
      sockets.push(browserWs.ws);
      const state = await rpc(browserWs.ws, 'hub.getState', {});
      assert.strictEqual(state.result.mode, 'legacy');
      const nativePair = clients.beginPairing({ name: 'CLI', kind: 'native', permissions: ['read', 'write'] });
      const nativePosted = await request(port, 'POST', '/pair/native', { code: nativePair.code, name: 'CLI' });
      assert.strictEqual(nativePosted.status, 200);
      assert.ok(!nativePosted.headers['set-cookie']);
      const nativeBody = JSON.parse(nativePosted.body);
      assert.strictEqual(nativeBody.client.kind, 'native');
      const nativeWs = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Authorization: 'Bearer ' + nativeBody.token
      });
      assert.strictEqual(nativeWs.open, true);
      sockets.push(nativeWs.ws);
      const nativeState = await rpc(nativeWs.ws, 'hub.getState', {});
      assert.strictEqual(nativeState.result.product, 'marust');
      const withOrigin = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Origin: 'http://127.0.0.1:18770',
        Authorization: 'Bearer ' + nativeBody.token
      });
      assert.strictEqual(withOrigin.open, false);
      if (withOrigin.ws) withOrigin.ws.close();

      const extOrigin = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Origin: 'chrome-extension://' + EXT_ID,
        Authorization: 'Bearer ' + token
      });
      assert.strictEqual(extOrigin.open, false);
      if (extOrigin.ws) extOrigin.ws.close();
      const extNative = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Authorization: 'Bearer ' + token
      });
      assert.strictEqual(extNative.open, false);
      if (extNative.ws) extNative.ws.close();
      const extCookie = await tryWs(port, {
        Host: '127.0.0.1:18770',
        Origin: 'http://127.0.0.1:18770',
        Cookie: 'marust_session=' + token
      });
      assert.strictEqual(extCookie.open, false);
      if (extCookie.ws) extCookie.ws.close();

      const opened = await api.call('clients.beginPairing', {
        name: '拡張',
        kind: 'extension',
        permissions: ['read', 'write', 'emergency'],
        requiresApproval: true
      }, {
        permissions: ['read', 'write', 'emergency'],
        clientId: WINDOW_ID,
        kind: 'window'
      });
      assert.strictEqual(opened.ok, true);
      const second = clients.redeem(opened.code, { kind: 'extension', name: '二台目', extensionId: OTHER_ID });
      assert.strictEqual(second.ok, true);
      assert.deepStrictEqual(second.client.permissions, ['read', 'ext-write']);
      assert.strictEqual(second.client.requiresApproval, false);
      assert.strictEqual(second.client.kind, 'extension');
      assert.strictEqual(second.client.extensionId, OTHER_ID);
    });

    await test('the connection panel offers extension pairing to the window', async function () {
      const hub = hubSource();
      assert.ok(hub.includes('拡張をつなぐ'));
      assert.ok(hub.includes("kind: 'extension'"));
      assert.ok(hub.includes('row.kind'));
      assert.ok(hub.includes("state.clientId === 'local-window'"));
      const html = require('./_ui-source').shellDocument();
      assert.ok(html.includes('id="client-admin" hidden'));
    });

    events.forEach(function (payload) { assertNoValues(JSON.stringify(payload), 'events'); });
    assertNoValues(readLogs(dir), 'logs');
    assertNoValues(fs.readFileSync(secrets.file, 'utf8'), 'vault');
    const joined = logs.join('\n');
    assert.ok(!joined.includes(token));
    assert.ok(!joined.includes(SECRET));
    assert.ok(!joined.includes(CAPTURE));
  } finally {
    console.log = origLog;
    for (let i = 0; i < sockets.length; i += 1) {
      try { sockets[i].close(); } catch (_) { /* gone */ }
    }
    await new Promise(function (resolve) { server.close(function () { resolve(); }); });
    rimraf(dir);
  }
  console.log('[marust] w10 tests passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
