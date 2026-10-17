'use strict';
// W62: live への切り替えで id の入力を求めない（confirmLive:false）。既定は従来どおり求める。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');

async function run(confirmLive) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w62-'));
  const c = createCore();
  const core = { STATE_DIR: dir, COOKIES_DIR: path.join(dir, 'cookies'), SERVICES_DIR: path.join(dir, 'services'), DATA_DIR: path.join(dir, 'data'), atomicWriteJsonSync: c.atomicWriteJsonSync };
  const opts = {
    core: core,
    getState() { return { product: 'marust', plugins: [{ id: 'alpha', name: 'alpha', kind: 'site', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [] }] }; }
  };
  if (confirmLive !== undefined) opts.confirmLive = confirmLive;
  const api = createApi(opts);
  const ctx = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const set = await api.call('modes.set', { id: 'alpha', mode: 'live' }, ctx);
  const state = await api.call('hub.getState', {}, ctx);
  fs.rmSync(dir, { recursive: true, force: true });
  return { set: set, confirmLive: state.confirmLive };
}

async function main() {
  const defaults = await run();
  assert.strictEqual(defaults.set.error, 'confirm-name');
  assert.strictEqual(defaults.confirmLive, true);
  const frozen = await run(false);
  assert.strictEqual(frozen.set.ok, true);
  assert.strictEqual(frozen.set.mode, 'live');
  assert.strictEqual(frozen.confirmLive, false);
  console.log('ok w62-live-confirm-frozen');
}

main().catch((err) => { console.error(err); process.exit(1); });
