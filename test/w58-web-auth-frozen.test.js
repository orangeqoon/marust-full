'use strict';
// W58: Web 操作盤のペアリング認証の凍結（webAuth:false）。docs/FROZEN.md
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createCaptureReceiver } = require('../host/layer1/capture-receiver');
const { createGateway } = require('../host/layer1/gateway');
const { createClients } = require('../host/layer1/clients');

function request(port, method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: urlPath,
      method: method,
      headers: Object.assign({ Host: '127.0.0.1:18770' }, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot(webAuth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w58-'));
  const c = createCore();
  const core = {
    STATE_DIR: dir,
    COOKIES_DIR: path.join(dir, 'cookies'),
    SERVICES_DIR: path.join(dir, 'services'),
    DATA_DIR: path.join(dir, 'data'),
    atomicWriteJsonSync: c.atomicWriteJsonSync
  };
  const clients = createClients({ core: core });
  const opts = {
    core: core,
    receiver: createCaptureReceiver({ core: core, onStatus: async () => ({ name: 'marust', receiver: true }) }),
    clients: clients,
    onStatus: async () => ({ name: 'marust', receiver: true }),
    uiRoot: path.join(__dirname, '..', 'ui'),
    vendorRoot: path.join(__dirname, '..', 'node_modules', 'dockview')
  };
  if (webAuth !== undefined) opts.webAuth = webAuth;
  const gateway = createGateway(opts);
  const server = await gateway.listen(0);
  return { dir, gateway, port: server.address().port };
}

async function main() {
  // 既定は認証あり: 従来どおりペアリング画面
  const on = await boot();
  const locked = await request(on.port, 'GET', '/');
  assert.strictEqual(locked.status, 200);
  assert.ok(locked.body.includes('pair-form'));
  assert.ok(!locked.headers['set-cookie']);
  on.gateway.server.close();

  // 凍結（webAuth:false）: コード無しで入れる
  const off = await boot(false);
  const first = await request(off.port, 'GET', '/');
  assert.strictEqual(first.status, 302);
  assert.strictEqual(first.headers.location, '/');
  const cookie = String(first.headers['set-cookie'] || '').split(';')[0];
  assert.ok(/^marust_session=/.test(cookie));
  const hub = await request(off.port, 'GET', '/', { Cookie: cookie });
  assert.strictEqual(hub.status, 200);
  assert.ok(!hub.body.includes('pair-form'));
  // /pair も同じ
  const viaPair = await request(off.port, 'GET', '/pair');
  assert.strictEqual(viaPair.status, 302);
  // Host 検査は残る
  const evil = await request(off.port, 'GET', '/', { Host: 'evil.example:18770' });
  assert.strictEqual(evil.status, 421);
  off.gateway.server.close();

  for (const x of [on, off]) fs.rmSync(x.dir, { recursive: true, force: true });
  console.log('ok w58-web-auth-frozen');
}

main().catch((err) => { console.error(err); process.exit(1); });
