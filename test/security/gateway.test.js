'use strict';

const assert = require('assert');
const http = require('http');
const { createGateway, CSP } = require('../../host/layer1/gateway');
const WebSocket = require('ws');

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

function request(port, method, urlPath, headers) {
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: urlPath,
      method: method,
      headers: Object.assign({ Host: '127.0.0.1:18770' }, headers || {})
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function tryWs(port, headers) {
  return new Promise(function (resolve) {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: headers || {} });
    let settled = false;
    const finish = function (row) {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) { /* already closed */ }
      resolve(row);
    };
    ws.once('open', function () { finish({ open: true, status: 101 }); });
    ws.once('unexpected-response', function (_req, res) {
      res.resume();
      finish({ open: false, status: res.statusCode });
    });
    ws.on('error', function () {});
    setTimeout(function () { finish({ open: false, status: 0 }); }, 1500);
  });
}

async function main() {
  const gateway = createGateway({
    receiver: { handle: function () { return false; } },
    clients: {
      setOnRevoke: function () {},
      authenticate: function () { return null; },
      list: function () { return []; },
      redeem: function () { return { ok: false, error: 'bad-code' }; }
    }
  });
  const server = await gateway.listen(0);
  const port = server.address().port;
  try {
    await test('gateway rejects a foreign Host', async function () {
      const evil = await request(port, 'GET', '/health', { Host: 'evil.example:18770' });
      assert.strictEqual(evil.status, 421);
      const body = JSON.parse(evil.body);
      assert.strictEqual(body.error, 'bad-host');
    });

    await test('gateway sends a CSP header on the hub document', async function () {
      const home = await request(port, 'GET', '/', { Host: '127.0.0.1:18770' });
      assert.strictEqual(home.status, 200);
      assert.strictEqual(home.headers['content-security-policy'], CSP);
      assert.ok(CSP.indexOf("default-src 'self'") !== -1);
    });

    await test('websocket upgrade checks Origin', async function () {
      const bad = await tryWs(port, { Host: '127.0.0.1:18770', Origin: 'http://evil.example' });
      assert.strictEqual(bad.open, false);
      assert.strictEqual(bad.status, 403);
      const good = await tryWs(port, { Host: '127.0.0.1:18770', Origin: 'http://127.0.0.1:18770' });
      assert.strictEqual(good.open, false);
      assert.strictEqual(good.status, 401);
    });
  } finally {
    await new Promise(function (resolve) { server.close(function () { resolve(); }); });
  }

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w36 gateway ok');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});