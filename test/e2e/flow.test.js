'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createHarness } = require('./harness');
const { WINDOW_ID } = require('../../host/layer1/clients');

let failed = 0;
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function freshHits(h) {
  return h.hits.slice(h.hitMark);
}

function count(h, method, pathPrefix) {
  const rows = freshHits(h);
  let n = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].method === method && rows[i].path.indexOf(pathPrefix) === 0) n += 1;
  }
  return n;
}

function writes(h) {
  return freshHits(h).filter(function (row) {
    return row.method === 'POST' || row.method === 'PUT' || row.method === 'PATCH' || row.method === 'DELETE';
  });
}

function shadowText(dir) {
  const folder = path.join(dir, 'logs', 'marust');
  const names = fs.readdirSync(folder).filter(function (name) {
    return name.indexOf('shadow-') === 0 && name.endsWith('.jsonl');
  });
  assert.ok(names.length > 0, 'shadow jsonl missing');
  return names.map(function (name) {
    return fs.readFileSync(path.join(folder, name), 'utf8');
  }).join('\n');
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  return null;
}

function windowCtx() {
  return {
    permissions: ['read', 'write', 'emergency'],
    clientId: WINDOW_ID,
    kind: 'window'
  };
}

async function runFlow(h) {
  assert.notStrictEqual(path.resolve(h.dir), path.resolve(h.realStateDir));
  assert.ok(h.dir.indexOf('marust-w33-') !== -1, h.dir);
  const pre = await h.preflight.run(['rumble-main']);
  assert.strictEqual(pre.ok, true, 'preflight ' + JSON.stringify(pre.items));
  const started = await h.broadcast.start({
    destinationIds: ['rumble-main'],
    title: 'E2E Title',
    category: 'Just Chatting',
    confirmed: true
  });
  assert.strictEqual(started.ok, true, 'start ' + JSON.stringify(started));
  const rows = await h.orchestrator.fanout({
    title: 'E2E Title',
    category: 'Just Chatting',
    source: 'hub-ui'
  });
  const byId = {};
  for (let i = 0; i < rows.length; i += 1) byId[rows[i].id] = rows[i];
  assert.ok(byId['site-twitch'], 'site-twitch missing ' + JSON.stringify(rows));
  assert.strictEqual(byId['site-twitch'].result, 'ok', JSON.stringify(byId['site-twitch']));
  assert.ok(byId.twitch, 'v1 twitch missing');
  assert.strictEqual(byId.twitch.message, 'superseded-by-v2', JSON.stringify(byId.twitch));
  const got = await waitFor(async function () {
    const recent = h.chat.recent(20);
    if (!recent || recent.ok !== true) return null;
    for (let i = 0; i < recent.messages.length; i += 1) {
      if (recent.messages[i].text === 'hello e2e' && recent.messages[i].site === 'kukulu') return recent.messages[i];
    }
    return null;
  }, 8000);
  assert.ok(got, 'comment was not received');
  const sent = await h.api.call('chat.send', { text: 'hello from hub', sites: ['twitch'] }, { clientId: 'e2e', kind: 'window', permissions: ['read', 'write'] });
  assert.strictEqual(sent.ok, true, JSON.stringify(sent));
  assert.strictEqual(sent.results[0].ok, true, JSON.stringify(sent.results));
  if (h.mode === 'shadow') assert.strictEqual(sent.results[0].dryRun, true);
  const stopped = await h.broadcast.stop({ destinationIds: ['rumble-main'] });
  assert.strictEqual(stopped.ok, true, 'stop ' + JSON.stringify(stopped));
  await h.bus.flush();
  const log = shadowText(h.dir);
  assert.ok(log.indexOf('"kind":"fanout"') !== -1, 'fanout jsonl missing');
  assert.strictEqual(h.violations.length, 0, 'network ' + JSON.stringify(h.violations));
}

function rpc(ws, method, params) {
  return new Promise(function (resolve, reject) {
    const id = 'e2e-' + Math.random().toString(16).slice(2);
    const timer = setTimeout(function () { reject(new Error('ws timeout ' + method)); }, 5000);
    function onMessage(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (err) { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg.result);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }));
  });
}

function connect(token) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket('ws://127.0.0.1:18770/ws', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const timer = setTimeout(function () { reject(new Error('ws open timeout')); }, 5000);
    ws.once('open', function () { clearTimeout(timer); resolve(ws); });
    ws.once('error', function (err) { clearTimeout(timer); reject(err); });
  });
}

async function pair(h, input) {
  const begun = await h.api.call('clients.beginPairing', input, windowCtx());
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  const redeemed = h.clients.redeem(begun.code, { kind: 'native' });
  assert.strictEqual(redeemed.ok, true, JSON.stringify(redeemed));
  return redeemed.token;
}

async function main() {
  let shadow = null;
  let live = null;
  try {
    await test('network monitor refuses a real domain', async function () {
      shadow = await createHarness('shadow');
      const before = shadow.violations.length;
      let threw = false;
      try {
        await globalThis.fetch('https://example.com/w33-probe');
      } catch (err) {
        threw = true;
      }
      assert.strictEqual(threw, true);
      const added = shadow.violations.slice(before);
      assert.ok(added.some(function (row) { return row.host === 'example.com'; }), JSON.stringify(added));
      shadow.violations.splice(before, shadow.violations.length - before);
    });

    await test('shadow flow keeps writes off the fake servers and keeps jsonl', async function () {
      assert.ok(shadow, 'harness');
      await runFlow(shadow);
      const leaked = writes(shadow);
      assert.strictEqual(leaked.length, 0, JSON.stringify(leaked));
      assert.strictEqual(count(shadow, 'PATCH', '/helix/channels'), 0);
      assert.strictEqual(count(shadow, 'POST', '/helix/chat/messages'), 0);
      assert.strictEqual(count(shadow, 'POST', '/helix/raids'), 0);
    });
  } finally {
    if (shadow) {
      try { await shadow.close(); } catch (err) { console.error(err); }
      shadow = null;
    }
  }

  try {
    live = await createHarness('live');
  } catch (err) {
    failed += 1;
    console.error('FAIL live harness');
    console.error(err && err.stack ? err.stack : err);
  }

  await test('live flow delivers each write once and does not double the title', async function () {
    assert.ok(live, 'harness');
    await runFlow(live);
    assert.strictEqual(count(live, 'PATCH', '/helix/channels'), 1, 'title arrived ' + count(live, 'PATCH', '/helix/channels'));
    assert.strictEqual(count(live, 'POST', '/helix/chat/messages'), 1);
    assert.ok(count(live, 'GET', '/-livestream-api/get-data') >= 1, 'rumble slot was not read');
    assert.strictEqual(count(live, 'POST', '/service.php'), 0, 'slot was claimed instead of reused');
  });

  await test('live non-emergency stop raids exactly once', async function () {
    assert.ok(live, 'harness');
    const n = count(live, 'POST', '/helix/raids');
    assert.strictEqual(
      n,
      1,
      'contract: broadcast.stop must publish stream.stopping without reason emergency so raid-twitch POSTs /helix/raids once. got ' + n + '. Production only publishes stream.stopping from obs emergency stopAll, and raid-twitch skips reason emergency, so a normal stop never raids.'
    );
  });

  await test('engine.emergencyStop alias calls stopAll with non-emergency reason (raid-twitch raids once per non-emergency stopping)', async function () {
    assert.ok(live, 'harness');
    const before = count(live, 'POST', '/helix/raids');
    const events = [];
    const unsub = live.bus.subscribe('stream.stopping', function (name, payload, meta) {
      if (payload) events.push({ reason: payload.reason, source: meta && meta.source });
    });
    try {
      const stopped = await live.api.call('engine.emergencyStop', {}, windowCtx());
      assert.strictEqual(stopped.ok, true, JSON.stringify(stopped));
      await live.bus.flush();
      // 決まったこと 6: 非常停止は stopAll の別名。broadcast.stopAll の stream.stopping の reason は manual で emergency ではない
      assert.ok(events.some(function (e) { return e.source === 'broadcast' && e.reason === 'manual'; }), 'broadcast stopAll emitted manual reason, not emergency');
      // raid-twitch の決まり: reason が emergency でない限り、stream.stopping 1 回につき 1 回レイドする
      assert.strictEqual(count(live, 'POST', '/helix/raids'), before + 1, 'stopAll triggers raid');
      assert.ok(live.engine.calls.some(function (row) { return row.op === 'stopAll'; }), 'engine stopAll was called');
    } finally {
      if (typeof unsub === 'function') unsub();
    }
  });

  await test('stream.stopping without emergency does raid once', async function () {
    assert.ok(live, 'harness');
    const before = count(live, 'POST', '/helix/raids');
    live.bus.publish('stream.stopping', { reason: 'user' }, { source: 'e2e' });
    await live.bus.flush();
    assert.strictEqual(count(live, 'POST', '/helix/raids'), before + 1);
  });

  await test('read websocket client cannot write', async function () {
    assert.ok(live, 'harness');
    const token = await pair(live, { name: 'reader', kind: 'native', permissions: ['read'] });
    const ws = await connect(token);
    try {
      const state = await rpc(ws, 'hub.getState', {});
      assert.strictEqual(state.product, 'marust', JSON.stringify(state));
      assert.ok(Array.isArray(state.permissions) && state.permissions.indexOf('read') !== -1);
      assert.strictEqual(state.error, undefined);
      const denied = await rpc(ws, 'layout.save', { name: 'e2eread', data: { marker: 1 } });
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.error, 'forbidden');
      const names = live.layouts.list().names || [];
      assert.ok(names.indexOf('e2eread') === -1);
    } finally {
      try { ws.close(); } catch (err) { /* closed */ }
    }
  });

  await test('approval-gated client runs only after approval', async function () {
    assert.ok(live, 'harness');
    const token = await pair(live, {
      name: 'needs-ok',
      kind: 'native',
      permissions: ['read', 'write'],
      requiresApproval: true
    });
    const ws = await connect(token);
    try {
      const held = await rpc(ws, 'layout.save', { name: 'e2ehold', data: { marker: 1 } });
      assert.strictEqual(held.ok, false);
      assert.strictEqual(held.pending, true, JSON.stringify(held));
      assert.ok(held.approvalId);
      const before = live.layouts.list().names || [];
      assert.ok(before.indexOf('e2ehold') === -1, 'saved before approval');
      const approved = await live.api.call('approval.approve', { id: held.approvalId }, windowCtx());
      assert.strictEqual(approved.ok, true, JSON.stringify(approved));
      assert.strictEqual(approved.result && approved.result.ok, true, JSON.stringify(approved));
      const after = live.layouts.list().names || [];
      assert.ok(after.indexOf('e2ehold') !== -1, JSON.stringify(after));
    } finally {
      try { ws.close(); } catch (err) { /* closed */ }
    }
  });

  if (live) {
    try { await live.close(); } catch (err) { console.error(err); }
  }

  console.log('passed ' + passed + ' failed ' + failed);
  if (failed) process.exit(1);
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});