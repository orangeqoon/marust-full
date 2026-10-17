'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createSecretMask } = require('../host/core/secret-mask');
const mod = { exports: {} };
const mask = createSecretMask();
const sentinel = 'synthetic-secret-for-p3-test';
mask.remember(sentinel);
let visits = 0;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../host/layer1/gateway/sockets.js'), 'utf8'), {
  module: mod, exports: mod.exports, require(name) {
    assert.strictEqual(name, '../../core');
    return { secretMask: { maskDeep(value) { visits++; return mask.maskDeep(value); } } };
  }
});
const sockets = new Map(), grants = new WeakMap();
let revoke, subscriber;
const component = mod.exports.createSockets({ sockets, socketGrants: grants,
  clients: { setOnRevoke(fn) { revoke = fn; } }, bus: { subscribe(name, fn) { assert.strictEqual(name, '*'); subscriber = fn; } } });
function socket(state, send) {
  const ws = new EventEmitter(); ws.readyState = state; ws.send = send;
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}
const payload = { nested: { text: sentinel }, rows: ['safe', sentinel] };
component.broadcast('chat.message', payload, { detail: sentinel });
assert.strictEqual(visits, 0, 'no recipients means no masking or serialization');
component.track('writer', socket(1, () => assert.fail('write-only recipient')), ['write']);
component.track('closed', socket(3, () => assert.fail('closed recipient')), ['read']);
component.broadcast('chat.message', payload, {});
assert.strictEqual(visits, 0, 'closed or unreadable recipients do not materialize payload');
const sent = [];
component.track('reader-a', socket(1, text => sent.push(text)), ['read']);
component.track('reader-b', socket(1, text => sent.push(text)), ['read']);
subscriber('chat.message', payload, { detail: sentinel });
assert.strictEqual(visits, 2, 'mask payload and metadata just once for both readers');
assert.strictEqual(sent.length, 2);
assert.strictEqual(sent[0], sent[1]);
const message = JSON.parse(sent[0]);
assert.strictEqual(message.method, 'event');
assert.strictEqual(message.params.payload.nested.text, '***');
assert.strictEqual(message.params.meta.detail, '***');
assert.ok(!sent[0].includes(sentinel));
assert.strictEqual(payload.nested.text, sentinel, 'source data remains unchanged');
revoke('reader-a'); revoke('reader-b');
visits = 0;
component.broadcast('chat.message', payload, {});
assert.strictEqual(visits, 0);
const baseSize = sockets.size;
for (let i = 0; i < 30; i++) {
  const ws = socket(1, () => {});
  component.track('cycle-' + i, ws, ['read']);
  ws.close();
  assert.strictEqual(sockets.size, baseSize, 'disconnect returns sockets to baseline');
}
console.log('P3 sockets: no-reader skip, permissions, one masked envelope, revoke and 30 disconnect cycles PASS');
