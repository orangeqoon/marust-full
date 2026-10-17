'use strict';
// K4: OBS 側 DLL（obs-multi-rtmp の vendor API）との契約の試験。
// test/fixtures/obs-vendor-contract.json に、名前・引数・答えの形を 1 枚置く。
// 偽の OBS（試験の websocket）はこの 1 枚だけから答えを作り、本物の丸ストのエンジンと list_capabilities を比べる。
// DLL のソース（streaming/obs-multi-rtmp）が隣にあれば、kRequests とも突き合わせる（無ければ飛ばす）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createObsLocalEngine, REQUIRED } = require('../host/core/engine/obs-local');
const { EVENTS } = require('../host/core/events');
const { READ_VENDOR, WRITE_VENDOR, EMERGENCY_VENDOR, classifyRequest } = require('../host/core/engine/obs-connection');

const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'obs-vendor-contract.json'), 'utf8'));

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

function sortedSet(set) {
  return Array.from(set).sort();
}

function hasKeys(obj, keys, label) {
  for (const key of keys) assert.ok(Object.prototype.hasOwnProperty.call(obj, key), label + ' に ' + key + ' が無い');
}

// 偽の OBS。答えは契約の 1 枚だけから作る（答えの形が足りなければここで落ちる）。
function fakeObs(options) {
  const opt = options || {};
  const targets = new Map();
  const calls = [];
  const handlers = {};
  let seq = 0;

  function targetRow(row) {
    return { id: row.id, name: row.name, protocol: row.protocol, state: row.state, enabled: row.enabled, sync_start: false, sync_stop: false };
  }
  function answer(type, data) {
    const spec = contract.requests[type];
    assert.ok(spec, '契約に無い要求: ' + type);
    for (const key of Object.keys(data || {})) {
      assert.ok(spec.params.includes(key), type + ' の引数に契約に無い ' + key);
    }
    let out;
    if (type === 'list_capabilities') {
      let names = Object.keys(contract.requests).filter((name) => name !== opt.hide);
      out = { vendor: contract.vendor, docs: 'x', apiVersion: contract.apiVersion, pluginVersion: '0.0.0', events: contract.events.slice(), requests: names.map((name) => ({ name: name, description: contract.requests[name].description })) };
    } else if (type === 'get_api_version') {
      out = { apiVersion: opt.apiVersion == null ? contract.apiVersion : opt.apiVersion, pluginVersion: '0.0.0' };
    } else if (type === 'get_snapshot') {
      out = {
        apiVersion: contract.apiVersion,
        pluginVersion: '0.0.0',
        observedAt: new Date().toISOString(),
        headless: false,
        targets: Array.from(targets.values()).map((row) => ({ id: row.id, name: row.name, enabled: row.enabled, state: row.state, reconnects: 0, lastError: null, service: { type: row.protocol, server: 'rtmp://127.0.0.1:1/x' } }))
      };
    } else if (type === 'list_targets') {
      out = { targets: Array.from(targets.values()).map(targetRow) };
    } else if (type === 'get_target_status' || type === 'get_target_config') {
      const row = targets.get(String(data.id));
      if (!row) return { error: 'target_not_found' };
      out = Object.assign(targetRow(row), { last_error_code: 0, duration_ms: 0, bitrate_bps: 0, fps: 0 });
      if (type === 'get_target_config') out = Object.assign(targetRow(row), { service_settings: { server: 'rtmp://127.0.0.1:1/x', key: '***' }, output_settings: {} });
    } else if (type === 'create_target') {
      if (data.dry_run) return { success: true, dry_run: true };
      seq += 1;
      const id = 'fake-' + seq;
      targets.set(id, { id: id, name: data.name, protocol: data.protocol || 'RTMP', state: 'stopped', enabled: data.enabled === true });
      out = { success: true, id: id };
    } else if (type === 'set_target_service_settings') {
      if (data.dry_run) return { success: true, dry_run: true, would_restart: false };
      out = { success: true, restarted: false };
    } else if (type === 'delete_target') {
      if (data.confirm !== true) return { success: false, error: 'confirmation_required' };
      targets.delete(String(data.id));
      out = { success: true };
    } else {
      const row = targets.get(String(data.id));
      if (type === 'stop_all_targets') {
        for (const each of targets.values()) each.state = 'stopped';
        out = { success: true, count: targets.size };
      } else if (!row) {
        return { success: false, error: 'target_not_found' };
      } else {
        if (type === 'set_target_enabled') row.enabled = data.enabled;
        if (type === 'start_target' && row.enabled) row.state = 'live';
        if (type === 'stop_target') row.state = 'stopped';
        out = { success: true };
      }
    }
    hasKeys(out, spec.answer.filter((key) => !(type === 'create_target' && key === 'id' && !out.id)), type + ' の答え');
    return out;
  }

  const client = {
    calls,
    on(name, fn) { handlers[name] = fn; },
    async connect() {},
    async disconnect() {},
    async call(name, body) {
      if (name === 'GetVersion') return { obsVersion: '0' };
      assert.strictEqual(name, 'CallVendorRequest');
      assert.strictEqual(body.vendorName, contract.vendor);
      const data = body.requestData || {};
      calls.push({ type: body.requestType, data: JSON.parse(JSON.stringify(data)) });
      return { vendorName: contract.vendor, requestType: body.requestType, responseData: answer(body.requestType, data) };
    },
    emit(name, payload) { handlers[name](payload); },
    targets
  };
  return client;
}

function makeEngine(client, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-k4-'));
  const published = [];
  const engine = createObsLocalEngine(Object.assign({
    core: { STATE_DIR: dir, SERVICES_DIR: dir },
    client: client,
    orchestrator: { modeFor: () => 'live' },
    bus: { publish(name, payload) { published.push({ name: name, payload: payload }); } },
    getStored: async () => ({ host: '127.0.0.1', port: 4455, password: '' }),
    reconnectMs: 3600000,
    pollMs: 0,
    logger() {}
  }, extra || {}));
  return { engine, published, dir };
}

async function main() {
  await test('契約の 1 枚: 段・名前が丸ストの使う名前と一致する', () => {
    assert.strictEqual(contract.apiVersion, 3);
    assert.deepStrictEqual(contract.tiers.read.slice().sort(), sortedSet(READ_VENDOR));
    assert.deepStrictEqual(contract.tiers.write.slice().sort(), sortedSet(WRITE_VENDOR));
    assert.deepStrictEqual(contract.tiers.emergency.slice().sort(), sortedSet(EMERGENCY_VENDOR));
    const all = [].concat(contract.tiers.read, contract.tiers.write, contract.tiers.emergency, contract.tiers.neverFromMarust);
    assert.deepStrictEqual(all.slice().sort(), Object.keys(contract.requests).sort());
    assert.deepStrictEqual(REQUIRED.slice().sort(), contract.tiers.read.concat(contract.tiers.write).sort());
    for (const tier of ['read', 'write', 'emergency']) {
      for (const name of contract.tiers[tier]) {
        const got = classifyRequest('CallVendorRequest', { vendorName: contract.vendor, requestType: name, requestData: {} });
        assert.strictEqual(got, tier, name);
      }
    }
    for (const name of contract.tiers.neverFromMarust) {
      assert.strictEqual(classifyRequest('CallVendorRequest', { vendorName: contract.vendor, requestType: name, requestData: {} }), 'forbidden');
    }
  });

  await test('DLL のソースが隣にあれば kRequests・apiVersion と一致する（無ければ飛ばす）', () => {
    const src = path.join(__dirname, '..', '..', 'obs-multi-rtmp', 'src');
    const api = path.join(src, 'websocket-api.cpp');
    const snap = path.join(src, 'marust-snapshot.cpp');
    const json = path.join(src, 'websocket-api-json.hpp');
    if (!fs.existsSync(api) || !fs.existsSync(snap) || !fs.existsSync(json)) {
      assert.ok(process.env.MARUST_REQUIRE_OBS_SRC !== '1', 'MARUST_REQUIRE_OBS_SRC=1 なのに DLL のソースが無い');
      console.log('   SKIP: DLL のソースが無いので名前・event・状態・答えの鍵の照合を飛ばした');
      return;
    }
    const names = [];
    const apiText = fs.readFileSync(api, 'utf8');
    const table = apiText.slice(apiText.indexOf('const VendorRequest kRequests[]'));
    const rowRe = /\{\s*"([a-z_]+)",\s*"((?:[^"\\]|\\.)*)",\s*&On/g;
    let m;
    const desc = {};
    while ((m = rowRe.exec(table))) { names.push(m[1]); desc[m[1]] = m[2]; }
    const snapText = fs.readFileSync(snap, 'utf8');
    const snapRe = /\{\s*"(get_snapshot)",\s*"((?:[^"\\]|\\.)*)",\s*&On/g;
    while ((m = snapRe.exec(snapText))) { names.push(m[1]); desc[m[1]] = m[2]; }
    assert.deepStrictEqual(names.slice().sort(), Object.keys(contract.requests).sort());
    for (const name of names) assert.strictEqual(desc[name], contract.requests[name].description, name + ' の説明');
    const all = [apiText, snapText, fs.readFileSync(json, 'utf8'), fs.readFileSync(path.join(src, 'marust-snapshot-json.hpp'), 'utf8')].join(String.fromCharCode(10));
    for (const ev of contract.events) assert.ok(all.includes('"' + ev + '"'), 'event ' + ev + ' が DLL に無い');
    for (const st of contract.states) assert.ok(all.includes('"' + st + '"'), '状態 ' + st + ' が DLL に無い');
    for (const name of Object.keys(contract.requests)) {
      const spec = contract.requests[name];
      for (const key of spec.answer.concat(spec.targetAnswer || [])) {
        assert.ok(all.includes('"' + key + '"'), name + ' の答えの鍵 ' + key + ' が DLL に無い');
      }
    }
    const ver = /kObsMultiRtmpApiVersion\s*=\s*(\d+)/.exec(fs.readFileSync(json, 'utf8'));
    assert.strictEqual(Number(ver[1]), contract.apiVersion);
  });

  await test('偽の OBS と本物のエンジン: list_capabilities で対応と見て、apiVersion 3 の snapshot で同期する', async () => {
    const client = fakeObs();
    client.targets.set('t1', { id: 't1', name: 'one', protocol: 'RTMP', state: 'live', enabled: true });
    const { engine } = makeEngine(client);
    await engine.connect();
    await engine.whenReady();
    const status = engine.status();
    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.supported, true);
    assert.deepStrictEqual(status.missing, []);
    assert.strictEqual(status.apiVersion, 3);
    const order = client.calls.map((c) => c.type);
    assert.deepStrictEqual(order.slice(0, 3), ['list_capabilities', 'get_api_version', 'get_snapshot']);
    const rows = engine.listTargets().filter((r) => !r.main);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.state, r.enabled]), [['t1', 'live', true]]);
    engine.shutdown();
  });

  await test('契約の名前が 1 つ欠けた OBS は非対応で、足りない名前を言う（書き込みは送らない）', async () => {
    for (const hide of contract.tiers.write.concat(contract.tiers.read.filter((n) => n !== 'list_capabilities'))) {
      const client = fakeObs({ hide: hide });
      const { engine } = makeEngine(client);
      await engine.connect();
      await engine.whenReady();
      const status = engine.status();
      assert.strictEqual(status.supported, false, hide);
      assert.deepStrictEqual(status.missing, [hide]);
      const before = client.calls.length;
      const res = await engine.start('t1');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, 'unsupported');
      assert.strictEqual(client.calls.length, before);
      engine.shutdown();
    }
  });

  await test('エンジンの操作が送る名前・引数は契約の中だけ。作る→有効→開始→停止→消す', async () => {
    const client = fakeObs();
    const { engine } = makeEngine(client);
    await engine.connect();
    await engine.whenReady();
    client.calls.length = 0;
    const made = await engine.create({ name: 'dummy', protocol: 'RTMP', server: 'rtmp://127.0.0.1:1/live', key: 'k' });
    assert.deepStrictEqual(made, { ok: true });
    // create は dry_run を先に 1 回、そのあと本番（hasDryRun の形）
    assert.deepStrictEqual(client.calls.map((c) => [c.type, c.data.dry_run === true]), [['create_target', true], ['create_target', false]]);
    assert.strictEqual(client.calls[1].data.enabled, false);
    await engine.syncNow('test');
    const id = engine.listTargets().filter((r) => !r.main)[0].id;
    assert.strictEqual((await engine.setEnabled(id, true)).ok, true);
    assert.strictEqual((await engine.start(id)).ok, true);
    await engine.syncNow('test');
    assert.strictEqual(engine.listTargets().filter((r) => !r.main)[0].state, 'live');
    const key = await engine.setKey(id, { key: 'new' }, { restartIfActive: true });
    assert.strictEqual(key.ok, true);
    assert.strictEqual((await engine.stop(id)).ok, true);
    assert.strictEqual((await engine.remove(id)).ok, true);
    const all = await engine.stopAll();
    assert.strictEqual(all.ok, true);
    const used = new Set(client.calls.map((c) => c.type));
    for (const type of used) assert.ok(contract.requests[type], type);
    for (const type of ['create_target', 'set_target_enabled', 'start_target', 'set_target_service_settings', 'stop_target', 'delete_target', 'stop_all_targets']) {
      assert.ok(used.has(type), type + ' を送っていない');
    }
    assert.ok(!used.has('start_all_targets'));
    engine.shutdown();
  });

  await test('vendor event（契約の形）: target_state_changed と emergency_stop を受ける', async () => {
    const client = fakeObs();
    client.targets.set('t1', { id: 't1', name: 'one', protocol: 'RTMP', state: 'stopped', enabled: true });
    const { engine, published } = makeEngine(client);
    await engine.connect();
    await engine.whenReady();
    client.emit('VendorEvent', { vendorName: contract.vendor, eventType: 'target_state_changed', eventData: { id: 't1', name: 'one', state: 'live', last_error_code: 0, reconnect_count: 0 } });
    assert.strictEqual(engine.listTargets().filter((r) => !r.main)[0].state, 'live');
    client.emit('VendorEvent', { vendorName: contract.vendor, eventType: 'emergency_stop', eventData: { time: '2026-10-10T00:00:00Z', stopped_ids: ['t1'], count: 1 } });
    assert.ok(published.some((row) => row.name === EVENTS.ENGINE_EMERGENCY_STOP));
    engine.shutdown();
  });

  await test('答えが返らない要求があっても、直列キューは期限で先へ進む（応答待ちのまま止まらない）', async () => {
    const client = fakeObs();
    client.targets.set('t1', { id: 't1', name: 'one', protocol: 'RTMP', state: 'stopped', enabled: false });
    const { engine } = makeEngine(client, { vendorTimeoutMs: 60 });
    await engine.connect();
    await engine.whenReady();
    const real = client.call.bind(client);
    client.call = (name, body) => (body.requestType === 'set_target_enabled' ? new Promise(() => {}) : real(name, body));
    const t0 = Date.now();
    const hung = await engine.setEnabled('t1', true);
    assert.deepStrictEqual(hung, { ok: false, error: 'timeout' });
    assert.ok(Date.now() - t0 < 2000);
    client.targets.get('t1').enabled = true;
    const next = await engine.start('t1');
    assert.strictEqual(next.ok, true);
    engine.shutdown();
  });

  await test('期限切れのあと遅れて届いた答えで cache・キューは壊れない', async () => {
    const client = fakeObs();
    client.targets.set('t1', { id: 't1', name: 'one', protocol: 'RTMP', state: 'stopped', enabled: true });
    const { engine } = makeEngine(client, { vendorTimeoutMs: 60 });
    await engine.connect();
    await engine.whenReady();
    const real = client.call.bind(client);
    let release = null;
    client.call = (name, body) => (body.requestType === 'start_target' ? new Promise((resolve) => { release = () => resolve(real(name, body)); }) : real(name, body));
    assert.deepStrictEqual(await engine.start('t1'), { ok: false, error: 'timeout' });
    release();
    await new Promise((r) => setTimeout(r, 30));
    await engine.syncNow('test');
    assert.strictEqual(engine.listTargets().filter((r) => !r.main).length, 1);
    assert.strictEqual((await engine.stop('t1')).ok, true);
    engine.shutdown();
  });

  await test('stopAll の期限切れは timeout と記録に残り、キューは動く', async () => {
    const client = fakeObs();
    const { engine, dir } = makeEngine(client, { vendorTimeoutMs: 60 });
    await engine.connect();
    await engine.whenReady();
    const real = client.call.bind(client);
    client.call = (name, body) => (body.requestType === 'stop_all_targets' ? new Promise(() => {}) : real(name, body));
    engine.connection.call = async (name) => {
      if (name === 'GetStreamStatus') return { outputActive: false };
      throw new Error('unexpected call ' + name);
    };
    engine.connection.controlStream = async () => {};
    const expected = {
      ok: true,
      error: 'timeout',
      count: 0,
      targetsStillActive: [],
      mainStillActive: false,
      mainStopped: false
    };
    assert.deepStrictEqual(await engine.stopAll(), expected);
    const logs = path.join(dir, 'logs', 'marust');
    const rows = fs.readdirSync(logs).filter((n) => n.startsWith('emergency')).map((n) => fs.readFileSync(path.join(logs, n), 'utf8')).join('');
    assert.ok(/"error":"timeout"/.test(rows));
    engine.shutdown();
  });

  await test('capabilities・apiVersion の読みが期限切れでも、次の poll で回復する', async () => {
    const client = fakeObs();
    client.targets.set('t1', { id: 't1', name: 'one', protocol: 'RTMP', state: 'stopped', enabled: false });
    const real = client.call.bind(client);
    let slow = true;
    client.call = (name, body) => (slow && (body.requestType === 'list_capabilities' || body.requestType === 'get_api_version') ? new Promise(() => {}) : real(name, body));
    const { engine } = makeEngine(client, { vendorTimeoutMs: 60, readTimeoutMs: 40, pollMs: 50 });
    await engine.connect();
    await engine.whenReady();
    assert.strictEqual(engine.status().supported, false);
    slow = false;
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(engine.status().supported, true);
    assert.strictEqual(engine.status().apiVersion, 3);
    engine.shutdown();
  });

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
