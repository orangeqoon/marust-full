'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createApi } = require('../host/layer1/api');
const { createUiSettings } = require('../host/layer1/ui-settings');
const { WINDOW_ID } = require('../host/layer1/clients');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); }
  catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

function tempBag() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l2b-'));
  return {
    dir,
    core: {
      STATE_DIR: dir,
      SERVICES_DIR: path.join(dir, 'services'),
      COOKIES_DIR: path.join(dir, 'cookies'),
      DATA_DIR: path.join(dir, 'data'),
      atomicWriteJsonSync: real.atomicWriteJsonSync
    }
  };
}

function modesFile(core) {
  return JSON.parse(fs.readFileSync(path.join(core.SERVICES_DIR, 'marust-modes.json'), 'utf8'));
}

(async () => {
  const bag = tempBag();
  const ui = createUiSettings({ stateDir: bag.dir, atomicWriteJsonSync: bag.core.atomicWriteJsonSync });
  const auditRows = [];
  const rows = [
    { id: 'site-twitch', name: 'x', kind: 'site', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: [], audience: 'public', stability: 'stable', site: { id: 'twitch', name: 'site-twitch', tier: 'core' } },
    { id: 'chat-twitch', name: 'x', kind: 'integration', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: ['chat.source@1'], audience: 'public', stability: 'experimental', chatSource: 'twitch' },
    { id: 'slot-youtube', name: 'x', kind: 'integration', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: ['stream.slot@1'], audience: 'public', stability: 'stable' },
    { id: 'slot-niconico', name: 'x', kind: 'integration', status: 'running', mode: 'legacy', source: 'set', requires: [], provides: ['stream.slot@1'], audience: 'public', stability: 'stable' },
    { id: 'ext-site', name: 'x', kind: 'site', status: 'running', mode: 'legacy', source: 'user', requires: [], provides: [], audience: 'public', stability: 'stable', site: { id: 'ext', name: 'ext', tier: 'extra' } }
  ];
  let orchestratorModesPluginOn = true;
  const api = createApi({
    core: bag.core,
    confirmLive: true,
    receiveEnabled: true,
    uiSettings: ui,
    audit: { write(row) { auditRows.push(row); } },
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    orchestrator: { modesPluginOn: () => orchestratorModesPluginOn },
    getState() { return { product: 'marust', plugins: rows }; }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };

  try {
    await test('setSend: send:true は { ok:true, id, on:true } を返し、モードを含まず保存は live。監査は on:1', async () => {
      const res = await api.call('sites.setSend', { id: 'site-twitch', send: true, confirmName: 'site-twitch' }, win);
      assert.deepStrictEqual(res, { ok: true, id: 'site-twitch', on: true });
      assert.strictEqual('mode' in res, false);
      assert.strictEqual(modesFile(bag.core).plugins['site-twitch'], 'live');
      const audit = auditRows.find((r) => r.method === 'sites.setSend');
      assert.ok(audit);
      assert.deepStrictEqual(audit.paramNames, ['id:site-twitch', 'on:1']);
    });

    await test('setSend: send:false は { ok:true, id, on:false } を返し、保存は legacy。監査は on:0', async () => {
      await api.call('sites.setSend', { id: 'site-twitch', send: true, confirmName: 'site-twitch' }, win);
      const res = await api.call('sites.setSend', { id: 'site-twitch', send: false }, win);
      assert.deepStrictEqual(res, { ok: true, id: 'site-twitch', on: false });
      assert.strictEqual('mode' in res, false);
      assert.strictEqual(modesFile(bag.core).plugins['site-twitch'], 'legacy');
      const audit = auditRows.filter((r) => r.method === 'sites.setSend').pop();
      assert.deepStrictEqual(audit.paramNames, ['id:site-twitch', 'on:0']);
    });

    await test('setSend: source === external の id は bad-id', async () => {
      const res = await api.call('sites.setSend', { id: 'ext-site', send: true, confirmName: 'ext-site' }, win);
      assert.deepStrictEqual(res, { ok: false, error: 'bad-id' });
    });

    await test('setReceive: chatSource を持つ chat-* に on を返す（試験中も表示をオンにする）', async () => {
      ui.set({ showExperimental: true });
      const res = await api.call('sites.setReceive', { site: 'twitch', receive: true }, win);
      assert.deepStrictEqual(res, { ok: true, id: 'chat-twitch', on: true });
      assert.strictEqual('mode' in res, false);
      assert.strictEqual(modesFile(bag.core).plugins['chat-twitch'], 'live');
      const off = await api.call('sites.setReceive', { site: 'twitch', receive: false }, win);
      assert.deepStrictEqual(off, { ok: true, id: 'chat-twitch', on: false });
      assert.strictEqual(modesFile(bag.core).plugins['chat-twitch'], 'legacy');
      ui.set({ showExperimental: false });
    });

    await test('setAutoSlot: slot-<サイト> に on を返す', async () => {
      const res = await api.call('sites.setAutoSlot', { site: 'youtube', enabled: true }, win);
      assert.deepStrictEqual(res, { ok: true, id: 'slot-youtube', on: true });
      assert.strictEqual('mode' in res, false);
      assert.strictEqual(modesFile(bag.core).plugins['slot-youtube'], 'live');
      const off = await api.call('sites.setAutoSlot', { site: 'youtube', enabled: false }, win);
      assert.deepStrictEqual(off, { ok: true, id: 'slot-youtube', on: false });
      assert.strictEqual(modesFile(bag.core).plugins['slot-youtube'], 'legacy');
    });

    await test('modes.setDefault: orchestrator.modesPluginOn() が false のときは unavailable', async () => {
      orchestratorModesPluginOn = false;
      const res = await api.call('modes.setDefault', { id: 'site-twitch', mode: 'legacy' }, win);
      assert.deepStrictEqual(res, { ok: false, error: 'unavailable' });
      orchestratorModesPluginOn = true;
    });
  } finally {
    fs.rmSync(bag.dir, { recursive: true, force: true });
  }

  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
  console.log('l2b switches tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
