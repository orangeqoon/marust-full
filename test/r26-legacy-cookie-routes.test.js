'use strict';

// 旧い Cookie・キャプチャの経路（平文で書く）は本体に無い（計画 M・決め 1）。どの保存場所でも 404 で、何も書かない。
// 拡張は /ext/*（ペアリングと金庫）だけを使う。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createCaptureReceiver } = require('../host/layer1/capture-receiver');

function mkCore(via) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-r26-'));
  const core = {
    STATE_DIR: dir,
    COOKIES_DIR: path.join(dir, 'cookies'),
    SERVICES_DIR: path.join(dir, 'services'),
    DATA_DIR: path.join(dir, 'data'),
    atomicWriteJsonSync(file, data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    }
  };
  if (via) core.via = via;
  return { dir, core };
}

function call(receiver, method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroy = () => {};
  const res = {
    status: 0,
    ended: false,
    writableEnded: false,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s) { this.status = s; },
    end() { this.ended = true; this.writableEnded = true; }
  };
  const handled = receiver.handle(req, res);
  if (handled === true && body != null) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }
  return new Promise((resolve) => setImmediate(() => resolve({ handled, res })));
}

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  })(dir);
  return out;
}

const legacy = ['/twitcasting_auth', '/niconico_auth', '/fc2_auth', '/rumble_auth', '/api/rumble_cookies', '/soop_auth']
  .map((u) => ['POST', u, { cookies: { a: 'not-a-secret' } }])
  .concat([
    ['POST', '/api/rumble_capture', { url: 'https://example.invalid/', cookies: 'a=b' }],
    ['POST', '/api/soop_capture', { url: 'https://example.invalid/', cookies: 'a=b' }],
    ['OPTIONS', '/niconico_auth', null]
  ]);

(async () => {
  // 保存場所の種類（旧い作者の印 legacyRoutes を付けたものも含む）に関わらず閉じる: COOKIES_DIR があっても 404
  for (const via of ['local', null, 'portable', 'unknown', 'scripts_core']) {
    const { dir, core } = mkCore(via);
    if (via === 'scripts_core') core.legacyRoutes = true; // 古い差し込みが付けても、もう何も開かない
    const target = via === null ? { STATE_DIR: dir, COOKIES_DIR: core.COOKIES_DIR, SERVICES_DIR: core.SERVICES_DIR, atomicWriteJsonSync: core.atomicWriteJsonSync } : core;
    const receiver = createCaptureReceiver({ core: target });
    for (const [m, u, b] of legacy) {
      const r = await call(receiver, m, u, b);
      assert.strictEqual(r.handled, false, 'not handled (404): ' + m + ' ' + u + ' via=' + via);
      assert.strictEqual(r.res.ended, false);
    }
    assert.deepStrictEqual(listFiles(dir), [], 'no files written via=' + via);
  }

  console.log('r26-legacy-cookie-routes: ok');
})().catch((e) => { console.error(e); process.exit(1); });
