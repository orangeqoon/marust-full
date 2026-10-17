'use strict';
// R3: OBS の接続画面の裏側。金庫 → ファイル → NeonTimer（開発者モードだけ）の順に読む。
// 偽の OBS で、パスワードが答え・ログ・監査・ファイルのどこにも平文で出ないことを確かめる。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createObsSetup, failureCode } = require('../host/layer1/obs-setup');
const { createObsConnection, readObsConfigFile } = require('../host/core/engine/obs-connection');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');
const { REQUIRED } = require('../host/core/engine/obs-local');

const PASS = 'obs-pass-SHOULD-NOT-LEAK-91ab';
const OTHER = 'file-pass-NOT-THE-VAULT-77cd';

function tempBag() {
  const real = createCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-r3-'));
  const services = path.join(dir, 'services');
  fs.mkdirSync(services, { recursive: true });
  return {
    dir: dir,
    core: {
      STATE_DIR: dir,
      SERVICES_DIR: services,
      atomicWriteJsonSync: real.atomicWriteJsonSync,
      resolveNewestPath: real.resolveNewestPath
    }
  };
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) walk(file, out);
    else out.push(file);
  }
  return out;
}

// 偽の OBS。state: 'ok' | 'bad-password' | 'refused' | 'no-plugin' | 'old-plugin'
function fakeObsClass(behavior, record) {
  return class FakeObs {
    on() {}
    async connect(url, password) {
      record.push({ url: url, password: password });
      if (behavior.state === 'refused') {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:4455');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      if (behavior.state === 'bad-password' || (behavior.expect != null && password !== behavior.expect)) {
        const err = new Error('Authentication failed.');
        err.code = 4009;
        throw err;
      }
    }
    async call(name, data) {
      record.push({ call: name, type: data && data.requestType });
      if (name === 'GetVersion') return { obsVersion: '30.2.0' };
      const type = data && data.requestType;
      if (behavior.state === 'no-plugin') throw new Error('unknown vendor');
      if (type === 'get_api_version') return { vendorName: 'obs-multi-rtmp', requestType: type, responseData: { apiVersion: 3 } };
      if (type === 'list_capabilities') {
        const names = behavior.state === 'old-plugin' ? REQUIRED.slice(1) : REQUIRED;
        return { vendorName: 'obs-multi-rtmp', requestType: type, responseData: { requests: names.map((n) => ({ name: n })) } };
      }
      throw new Error('unexpected ' + name);
    }
    async disconnect() { record.push({ disconnect: true }); }
  };
}

async function main() {
  const bag = tempBag();
  const logs = [];
  const vault = createSecretProvider({
    core: bag.core,
    backend: createFakeBackend(),
    allowFake: true,
    logger(level, message) { logs.push(String(message)); }
  });
  let dev = false;
  let engine = null;
  const record = [];
  const behavior = { state: 'ok', expect: null };
  const setup = createObsSetup({
    core: bag.core,
    secrets: vault,
    reader: vault.coreReader('host', ['obs.websocket']),
    getEngine: () => engine,
    devModeOn: () => dev,
    ObsWebSocket: fakeObsClass(behavior, record),
    timeoutMs: 500
  });

  // 1. 何も無いとき: 既定。パスワードなし
  let got = await setup.getConnection();
  assert.deepStrictEqual([got.host, got.port, got.hasPassword, got.source], ['localhost', 4455, false, 'default']);

  // 2. ファイル（丸スト用の場所）が読まれる。答えにパスワードの値は無い
  fs.writeFileSync(path.join(bag.core.SERVICES_DIR, 'obs-config.json'), JSON.stringify({ host: '127.0.0.1', port: 4466, password: OTHER }));
  got = await setup.getConnection();
  assert.deepStrictEqual([got.host, got.port, got.hasPassword, got.source], ['127.0.0.1', 4466, true, 'file']);
  assert.ok(!JSON.stringify(got).includes(OTHER));

  // 3. 検査: ホスト・ポート・パスワードの形
  assert.strictEqual((await setup.setConnection({ host: 'bad host!' })).error, 'bad-host');
  assert.strictEqual((await setup.setConnection({ host: 'a/b' })).error, 'bad-host');
  assert.strictEqual((await setup.setConnection({ port: 0 })).error, 'bad-port');
  assert.strictEqual((await setup.setConnection({ port: 70000 })).error, 'bad-port');
  assert.strictEqual((await setup.setConnection({ port: 44.5 })).error, 'bad-port');
  assert.strictEqual((await setup.setConnection({ password: 'x'.repeat(300) })).error, 'bad-password');

  // 4. 保存すると金庫が先に読まれる（ファイルより強い）。パスワードを省くと、今のものを引き継ぐ
  const saved = await setup.setConnection({ host: 'localhost', port: 4455, password: PASS });
  assert.deepStrictEqual(saved, { ok: true, connected: false });
  got = await setup.getConnection();
  assert.deepStrictEqual([got.host, got.port, got.hasPassword, got.source], ['localhost', 4455, true, 'vault']);
  assert.ok(!JSON.stringify(got).includes(PASS));
  await setup.setConnection({ port: 4456 }); // password 省略
  const stored = await setup.readStored();
  assert.deepStrictEqual([stored.host, stored.port, stored.password], ['localhost', 4456, PASS]);
  await setup.setConnection({ port: 4455 });

  // 5. 金庫の中身が平文でディスクに無い（ファイルは丸ごと探す。obs-config.json は元からの平文なので除く）
  for (const file of walk(bag.dir, [])) {
    if (path.basename(file) === 'obs-config.json') continue;
    assert.ok(!fs.readFileSync(file, 'utf8').includes(PASS), 'plaintext in ' + path.basename(file));
  }

  // 6. つないでみる: 成功 → OBS の版とプラグインの状態だけ返る。パスワードは相手には送るが、答えには無い
  behavior.expect = PASS;
  record.length = 0;
  let res = await setup.testConnection({});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.obsVersion, '30.2.0');
  assert.deepStrictEqual(res.plugin, { state: 'ok', apiVersion: 3, missing: [] });
  assert.ok(!JSON.stringify(res).includes(PASS));
  assert.strictEqual(record[0].password, PASS);
  assert.strictEqual(record[0].url, 'ws://localhost:4455');
  assert.ok(record.some((r) => r.disconnect), '使い捨ての接続は必ず切る');
  // 呼んだのは読み取りだけ（配信の開始・停止は呼ばない）
  const called = record.filter((r) => r.call).map((r) => r.call + ':' + (r.type || ''));
  assert.deepStrictEqual(called, ['GetVersion:', 'CallVendorRequest:get_api_version', 'CallVendorRequest:list_capabilities']);

  // 7. 別の場所へのテストには、保存済みのパスワードを使わない
  record.length = 0;
  behavior.expect = null;
  await setup.testConnection({ host: 'other.example' });
  assert.strictEqual(record[0].password, '');

  // 8. 失敗の理由（短いコードだけ）
  behavior.expect = null;
  behavior.state = 'bad-password';
  res = await setup.testConnection({ password: PASS });
  assert.deepStrictEqual(res, { ok: false, error: 'wrong-password' });
  behavior.state = 'refused';
  res = await setup.testConnection({});
  assert.deepStrictEqual(res, { ok: false, error: 'unreachable' });
  assert.strictEqual(failureCode(new Error('whatever ' + PASS)), 'failed');
  assert.ok(!JSON.stringify(res).includes(PASS));

  // 9. 改造プラグインが無い・古い
  behavior.state = 'no-plugin';
  res = await setup.testConnection({ password: PASS });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.plugin.state, 'missing');
  behavior.state = 'old-plugin';
  res = await setup.testConnection({ password: PASS });
  assert.strictEqual(res.plugin.state, 'old');
  assert.deepStrictEqual(res.plugin.missing, [REQUIRED[0]]);

  // 10. 時間切れ
  const slow = createObsSetup({
    core: bag.core,
    secrets: vault,
    reader: vault.coreReader('host', ['obs.websocket']),
    devModeOn: () => false,
    ObsWebSocket: class { async connect() { await new Promise((r) => setTimeout(r, 2000)); } async disconnect() {} },
    timeoutMs: 50
  });
  assert.deepStrictEqual(await slow.testConnection({}), { ok: false, error: 'timeout' });

  // 11. NeonTimer の場所はもう読まない（V6。引き継ぎは開発者プラグイン dev-legacy-import で金庫へ取り込む）。丸スト用の場所が無ければ既定
  const bag2 = tempBag();
  assert.strictEqual(readObsConfigFile(bag2.core).source, 'default');
  assert.strictEqual(readObsConfigFile(bag2.core, { allowLegacy: true }).source, 'default', '古い指定を渡しても NeonTimer の場所は見ない');

  // 12. 接続（obs-connection）が金庫を先に読む。設定を変えると reconnect でつなぎ直す
  const connects = [];
  class Spy {
    on() {}
    async connect(url, password) { connects.push({ url: url, password: password }); }
    async disconnect() { connects.push({ disconnect: true }); }
  }
  const conn = createObsConnection({
    core: bag.core,
    client: new Spy(),
    getStored: setup.readStored,
    logger() {}
  });
  await conn.start();
  assert.deepStrictEqual(connects[0], { url: 'ws://localhost:4455', password: PASS });
  await setup.setConnection({ port: 4470, password: 'second-pass' });
  await conn.reconnect();
  const last = connects[connects.length - 1];
  assert.deepStrictEqual(last, { url: 'ws://localhost:4470', password: 'second-pass' });
  assert.ok(connects.some((c) => c.disconnect), '古い接続を切ってからつなぎ直す');
  conn.stop();
  // 金庫が読めないとき（getStored が投げる）は、ファイルへ戻る
  const conn2 = createObsConnection({
    core: bag.core,
    client: new Spy(),
    getStored: async () => { throw new Error('vault down'); },
    logger() {}
  });
  await new Promise((r) => setTimeout(r, 20)); // conn.stop() の切断が先に済むのを待つ
  connects.length = 0;
  await conn2.start();
  const dialed = connects.filter((c) => c.url);
  assert.strictEqual(dialed[0].url, 'ws://127.0.0.1:4466');
  assert.strictEqual(dialed[0].password, OTHER);
  conn2.stop();

  // 12b. ホストを変えて password を省くと、保存済みのパスワードは引き継がない（別の場所へ渡さない）
  await setup.setConnection({ host: 'localhost', port: 4455, password: PASS });
  const moved = await setup.setConnection({ host: 'other-pc.local' });
  assert.strictEqual(moved.ok, true);
  const afterMove = await setup.readStored();
  assert.deepStrictEqual([afterMove.host, afterMove.password], ['other-pc.local', '']);
  await setup.setConnection({ host: 'localhost', port: 4455, password: PASS });

  // 12c. getConnection は金庫を毎回読まない（読むたびに金庫の監査が 1 行増えるため）
  let gets = 0;
  const countingVault = {
    set: (...a) => vault.set(...a),
    list: () => vault.list()
  };
  const countedReader = { get: (...a) => { gets += 1; return vault.coreReader('host', ['obs.websocket']).get(...a); } };
  const counted = createObsSetup({ core: bag.core, secrets: countingVault, reader: countedReader, devModeOn: () => false });
  await counted.getConnection();
  const afterFirst = gets;
  for (let i = 0; i < 5; i += 1) await counted.getConnection();
  assert.strictEqual(gets, afterFirst, 'getConnection must not read the vault again');
  await counted.setConnection({ port: 4458 });
  assert.strictEqual((await counted.getConnection()).port, 4458);
  await counted.setConnection({ port: 4455 });

  // 12d. つなぎ中に設定を変えて reconnect すると、古い試みが終わったあと新しい設定でつなぎ直す
  const dials = [];
  let releaseFirst = null;
  class Slow {
    on() {}
    async connect(url, password) {
      dials.push(url);
      if (dials.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    }
    async disconnect() {}
  }
  let current = { host: 'old-host', port: 4455, password: 'a' };
  const connSlow = createObsConnection({ core: bag.core, client: new Slow(), getStored: async () => current, logger() {} });
  const first = connSlow.start();
  await new Promise((r) => setTimeout(r, 20));
  current = { host: 'new-host', port: 4456, password: 'b' };
  const second = connSlow.reconnect();
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepStrictEqual(dials, ['ws://old-host:4455', 'ws://new-host:4456']);
  connSlow.stop();

  // 13. API: 開発者モードがオフでも使える。ウィンドウだけ。値は返さない。監査には名前だけ
  const auditRows = [];
  const api = createApi({
    core: bag.core,
    secrets: vault,
    obsSetup: setup,
    devMode: { get: () => ({ devMode: false, source: 'default' }) },
    audit: { write(row) { auditRows.push(row); } },
    getState() { return { product: 'marust', plugins: [] }; }
  });
  const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };
  const browser = { clientId: 'b1', kind: 'browser', permissions: ['read', 'write'] };
  for (const method of ['obs.getConnection', 'obs.setConnection', 'obs.testConnection']) {
    assert.strictEqual((await api.call(method, {}, browser)).error, 'forbidden', method);
  }
  assert.strictEqual((await api.call('obs.setConnection', { port: 'abc' }, win)).error, 'bad-port');
  assert.strictEqual((await api.call('obs.setConnection', { host: 5 }, win)).error, 'bad-host');
  const viaApi = await api.call('obs.getConnection', {}, win);
  assert.strictEqual(viaApi.ok, true);
  assert.strictEqual(viaApi.hasPassword, true);
  assert.ok(!JSON.stringify(viaApi).includes('second-pass'));
  const setRes = await api.call('obs.setConnection', { password: PASS }, win);
  assert.strictEqual(setRes.ok, true);
  assert.ok(!JSON.stringify(setRes).includes(PASS));

  // 14. ログ・監査にパスワードが出ていない
  const everything = JSON.stringify(auditRows) + logs.join('\n');
  assert.ok(!everything.includes(PASS) && !everything.includes('second-pass'));
  for (const file of walk(path.join(bag.dir), [])) {
    if (!/logs/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(PASS) && !text.includes('second-pass'), 'password in log ' + path.basename(file));
  }

  fs.rmSync(bag.dir, { recursive: true, force: true });
  fs.rmSync(bag2.dir, { recursive: true, force: true });
  console.log('ok r3-obs-connect');
}

main().catch((err) => { console.error(err); process.exit(1); });
