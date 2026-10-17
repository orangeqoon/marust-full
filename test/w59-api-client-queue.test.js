'use strict';
// W59: つながる前の call は、つながるまで待つ（起動直後の 1 回読みが空振りしない）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function boot() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.l = {};
      sockets.push(this);
    }
    addEventListener(name, fn) { (this.l[name] = this.l[name] || []).push(fn); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.fire('close', {}); }
    fire(name, ev) { (this.l[name] || []).forEach((fn) => fn(ev)); }
    open() { this.readyState = 1; this.fire('open', {}); }
    reply(id, result) { this.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', id: id, result: result }) }); }
  }
  const window = { location: { protocol: 'http:', host: '127.0.0.1:18770' } };
  const ctx = {
    window: window,
    document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
    WebSocket: FakeWS,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    JSON: JSON,
    Map: Map,
    Error: Error,
    Promise: Promise,
    Math: Math
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'core-strings.js'), 'utf8').replace('window.CORE_STR', 'var CORE_STR'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'api-client.js'), 'utf8'), ctx);
  return { api: window.marustApi, sockets: sockets };
}

async function main() {
  const { api, sockets } = boot();
  assert.strictEqual(sockets.length, 1);
  // 接続前に呼ぶ → まだ送られない
  const early = api.call('hub.getState', {});
  assert.strictEqual(sockets[0].sent.length, 0);
  // 開いた瞬間に送られ、答えが返る
  sockets[0].open();
  assert.strictEqual(sockets[0].sent.length, 1);
  assert.strictEqual(sockets[0].sent[0].method, 'hub.getState');
  sockets[0].reply(sockets[0].sent[0].id, { clientId: 'local-window' });
  assert.deepStrictEqual(await early, { clientId: 'local-window' });
  // 開いたあとは従来どおり即送る
  const late = api.call('engine.status', {});
  assert.strictEqual(sockets[0].sent.length, 2);
  sockets[0].reply(sockets[0].sent[1].id, { connected: true });
  assert.deepStrictEqual(await late, { connected: true });
  console.log('ok w59-api-client-queue');
}

main().catch((err) => { console.error(err); process.exit(1); });
