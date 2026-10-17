'use strict';

// 旧い Cookie・キャプチャの経路（平文で書く）は作者の PC（scripts_core）だけで受ける。
// 配る版（local・dev-state）では 404。Q-2026-10-07-cookie-vault の答え。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createCaptureReceiver, COOKIE_ROUTES } = require('../host/layer1/capture-receiver');

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
  if (via === 'scripts_core') core.legacyRoutes = true; // 作者の印（保存場所の差し込みが付ける）
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

const legacy = Object.keys(COOKIE_ROUTES)
  .map((u) => ['POST', u, { cookies: { a: 'not-a-secret' } }])
  .concat([
    ['POST', '/api/rumble_capture', { url: 'https://example.invalid/', cookies: 'a=b' }],
    ['POST', '/api/soop_capture', { url: 'https://example.invalid/', cookies: 'a=b' }],
    ['OPTIONS', '/niconico_auth', null]
  ]);

(async () => {
  // 作者の印（core.legacyRoutes）が無い・知らない値は閉じる（M7 Must 1）: COOKIES_DIR があっても 404
  for (const via of ['local', null, 'portable', 'unknown']) {
    // via 無しで COOKIES_DIR 無し = dev-state
    const { dir, core } = mkCore(via);
    const target = via === null ? { STATE_DIR: dir, COOKIES_DIR: core.COOKIES_DIR, SERVICES_DIR: core.SERVICES_DIR, atomicWriteJsonSync: core.atomicWriteJsonSync } : core;
    const receiver = createCaptureReceiver({ core: target });
    assert.notStrictEqual(receiver.roots.via, 'author');
    for (const [m, u, b] of legacy) {
      const r = await call(receiver, m, u, b);
      assert.strictEqual(r.handled, false, 'not handled (404): ' + m + ' ' + u + ' via=' + receiver.roots.via);
      assert.strictEqual(r.res.ended, false);
    }
    assert.deepStrictEqual(listFiles(dir), [], 'no files written via=' + receiver.roots.via);
  }

  {
    const { core } = mkCore('scripts_core');
    const receiver = createCaptureReceiver({ core });
    assert.strictEqual(receiver.roots.via, 'author');
    const r = await call(receiver, 'POST', '/niconico_auth', { cookies: { a: 'not-a-secret' } });
    assert.strictEqual(r.handled, true);
    assert.strictEqual(r.res.status, 200);
    assert.ok(fs.existsSync(path.join(core.COOKIES_DIR, 'marust', 'niconico-cookies.json')));
    const c = await call(receiver, 'POST', '/api/soop_capture', { url: 'https://example.invalid/', cookies: 'a=b' });
    assert.strictEqual(c.res.status, 200);
  }
  console.log('r26-legacy-cookie-routes: ok');
})().catch((e) => { console.error(e); process.exit(1); });
