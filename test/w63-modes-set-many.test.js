'use strict';
// W63: modes.setMany — 題名送信のサイト（site-*）をまとめて切り替える（開発者用・ウィンドウだけ）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');

function row(id) {
  return { id: id, name: id, kind: 'site', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [] };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w63-'));
  const c = createCore();
  const core = { STATE_DIR: dir, COOKIES_DIR: path.join(dir, 'cookies'), SERVICES_DIR: path.join(dir, 'services'), DATA_DIR: path.join(dir, 'data'), atomicWriteJsonSync: c.atomicWriteJsonSync };
  const api = createApi({
    core: core,
    confirmLive: false,
    getState() { return { product: 'marust', plugins: [row('site-a'), row('site-b'), row('youtube'), row('chat-x')] }; }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };

  assert.strictEqual((await api.call('modes.setMany', { mode: 'shadow' }, browser)).error, 'forbidden');
  assert.strictEqual((await api.call('modes.setMany', { mode: 'bogus' }, win)).error, 'bad-mode');

  const shadow = await api.call('modes.setMany', { mode: 'shadow' }, win);
  assert.strictEqual(shadow.ok, true);
  assert.deepStrictEqual(shadow.results.map((r) => r.id).sort(), ['site-a', 'site-b']);
  assert.ok(shadow.results.every((r) => r.ok === true));
  const file = JSON.parse(fs.readFileSync(path.join(core.SERVICES_DIR, 'marust-modes.json'), 'utf8'));
  assert.deepStrictEqual(file.plugins, { 'site-a': 'shadow', 'site-b': 'shadow' });

  const live = await api.call('modes.setMany', { mode: 'live', ids: ['site-a'] }, win);
  assert.deepStrictEqual(live.results, [{ id: 'site-a', ok: true, mode: 'live' }]);
  const after = JSON.parse(fs.readFileSync(path.join(core.SERVICES_DIR, 'marust-modes.json'), 'utf8'));
  assert.strictEqual(after.plugins['site-a'], 'live');
  assert.strictEqual(after.plugins['site-b'], 'shadow');
  assert.ok(!('youtube' in after.plugins) && !('chat-x' in after.plugins));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok w63-modes-set-many');
}

main().catch((err) => { console.error(err); process.exit(1); });
