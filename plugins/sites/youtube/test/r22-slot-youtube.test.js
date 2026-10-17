'use strict';
const { k2 } = require('../../../../test/_k2-ctx');

/**
 * R22: plugins/slot-youtube。偽の OBS・偽の YouTube・偽の金庫だけ。本物のどれにもつながない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createRegistry } = require('../../../../host/layer1/plugin-registry');
const { createSlotYoutube } = require('../../../../test/_plugins').requirePlugin('slot-youtube');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const ACCESS = 'SENTINEL-ACCESS-TOKEN';
const REFRESH = 'SENTINEL-REFRESH-TOKEN';
const CLIENT_SECRET = 'SENTINEL-CLIENT-SECRET';
const NEW_ACCESS = 'SENTINEL-NEW-ACCESS';

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

function res(status, body) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return { status: status, ok: status < 300, async text() { return text; } };
}

function oauth(over) {
  return JSON.stringify(Object.assign({
    client_id: 'cid', client_secret: CLIENT_SECRET, refresh_token: REFRESH, access_token: ACCESS, expiry_date: T0 + 3600 * 1000
  }, over || {}));
}

/** 偽の YouTube。handler が無い経路は 500。 */
function boot(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r22-slot-yt-'));
  const clock = { t: o.t0 || T0 };
  const calls = [];
  const logs = [];
  const events = [];
  const obsCalls = [];
  const secretGets = [];
  const secretSets = [];
  const state = {
    mode: o.mode || 'live',
    obs: o.obs || { outputActive: true, outputDuration: 5000 },
    secret: Object.prototype.hasOwnProperty.call(o, 'secret') ? o.secret : oauth(),
    active: o.active || [],
    transitionFails: o.transitionFails || 0,
    insertCode: o.insertCode || 200,
    stopOk: o.stopOk !== false
  };
  const handler = o.handler || function (c) {
    if (c.host === 'oauth2.googleapis.com') return res(200, { access_token: NEW_ACCESS, expires_in: 3600 });
    if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'active') return res(200, { items: state.active });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1', contentDetails: { isReusable: true } }] });
    if (c.path === 'liveBroadcasts' && c.method === 'GET') return res(200, { items: [{ snippet: { title: '前の題名', description: '前の説明' } }] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') {
      if (state.insertCode !== 200) return res(state.insertCode, { error: { errors: [{ reason: state.insertCode === 403 ? 'quotaExceeded' : 'x' }] } });
      return res(200, { id: 'NEW-' + c.n, snippet: { liveChatId: 'CHAT-' + c.n } });
    }
    if (c.path === 'liveBroadcasts/bind') return res(200, {});
    if (c.path === 'liveBroadcasts/transition') {
      if (c.query.broadcastStatus === 'live' && state.transitionFails > 0) {
        state.transitionFails -= 1;
        return res(403, { error: { errors: [{ reason: 'errorStreamInactive' }] } });
      }
      return res(200, {});
    }
    if (c.path === 'liveChat/messages') return res(200, {});
    return res(500, '');
  };
  const fetchFn = async function (url, init) {
    const u = new URL(url);
    const call = {
      n: calls.length + 1,
      method: init.method,
      host: u.hostname,
      path: u.pathname.replace('/youtube/v3/', ''),
      query: Object.fromEntries(u.searchParams.entries()),
      body: init.body && u.hostname === 'youtube.googleapis.com' ? JSON.parse(init.body) : null,
      auth: (init.headers || {}).Authorization
    };
    calls.push(call);
    return handler(call);
  };
  const ctx = {
    id: 'slot-youtube',
    dataDir: dir, ...k2(dir),
    mode() { return state.mode; },
    logger(level, message) { logs.push(level + ' ' + message); },
    secrets: {
      async get(name) { secretGets.push(name); return state.secret == null ? { ok: false, error: 'no-secret' } : { ok: true, value: state.secret }; },
      async set(name, value) { secretSets.push({ name, value }); state.secret = value; return { ok: true }; }
    },
    bus: { publish(name, payload) { events.push({ name, payload }); return 1; } },
    destinations: {
      list() { return { ok: true, destinations: o.noMainRow ? [] : [Object.assign({ id: 'obs-main', site: 'youtube', accountId: '', enabled: true, engine: { id: 'main' }, actual: { engineState: '', siteLive: false } }, o.mainRow || {})] }; }
    },
    obs: {
      async getStreamStatus() { obsCalls.push('status'); return state.obs; },
      async isStreaming() { return !!(state.obs && state.obs.outputActive); },
      async streamControl(input) {
        obsCalls.push(input.action);
        if (input.action === 'stop') {
          if (!state.stopOk) return { ok: false, error: 'obs-control-off' };
          state.obs = Object.assign({}, state.obs, { outputActive: false, outputDuration: 0 });
        }
        if (input.action === 'start') state.obs = Object.assign({}, state.obs, { outputActive: true, outputDuration: 1000 });
        return { ok: true };
      }
    }
  };
  if (o.noObs) delete ctx.obs;
  const plugin = createSlotYoutube({
    fetch: fetchFn,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    setInterval: () => ({ unref() {} }),
    clearInterval() {}
  });
  plugin.load(ctx);
  return { plugin, ctx, dir, clock, calls, logs, events, obsCalls, secretGets, secretSets, state };
}

function cleanup(bag) {
  bag.plugin.destroy();
  fs.rmSync(bag.dir, { recursive: true, force: true });
}

function writes(bag) {
  return bag.calls.filter((c) => c.host === 'youtube.googleapis.com' && c.method !== 'GET');
}

function usageOf(bag) {
  return JSON.parse(fs.readFileSync(path.join(bag.dir, 'usage.json'), 'utf8'));
}

(async () => {
  await test('legacy: OBS も YouTube も見ない', async () => {
    const bag = boot({ mode: 'legacy' });
    try {
      await bag.plugin.tick();
      assert.deepStrictEqual(bag.obsCalls, []);
      assert.strictEqual(bag.calls.length, 0);
      assert.strictEqual(bag.secretGets.length, 0);
    } finally { cleanup(bag); }
  });

  await test('shadow: 読むだけ。枠を作るはずでも切り替えるはずでも書き込まず OBS も止めない', async () => {
    const bag = boot({ mode: 'shadow', obs: { outputActive: true, outputDuration: 43000 * 1000 } });
    try {
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).length, 0);
      assert.ok(bag.calls.every((c) => c.method === 'GET'));
      assert.deepStrictEqual(bag.obsCalls, ['status'], 'OBS は状態を読むだけ');
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.lastOp, 'shadow-would-switch');
      assert.strictEqual(s.broadcastId, '');
      assert.strictEqual(bag.events.length, 0);
    } finally { cleanup(bag); }
  });

  await test('live: OBS 配信中で枠が無ければ 作る→bind→live。キーは触らない。使用量を残す', async () => {
    const bag = boot({ transitionFails: 1 });
    try {
      await bag.plugin.tick();
      const w = writes(bag).map((c) => c.path + (c.query.broadcastStatus ? ':' + c.query.broadcastStatus : ''));
      assert.deepStrictEqual(w, ['liveBroadcasts', 'liveBroadcasts/bind', 'liveBroadcasts/transition:live', 'liveBroadcasts/transition:live']);
      const insert = writes(bag)[0];
      assert.strictEqual(insert.body.snippet.title, '前の題名');
      assert.strictEqual(insert.body.contentDetails.enableAutoStart, false);
      assert.strictEqual(bag.calls.find((c) => c.path === 'liveBroadcasts/bind').query.streamId, 'S1');
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.broadcastId, 'NEW-' + insert.n);
      assert.strictEqual(s.liveChatId, 'CHAT-' + insert.n);
      assert.strictEqual(s.lastOp, 'created');
      assert.strictEqual(s.usage.creates, 1);
      assert.ok(s.usage.units >= 150);
      assert.strictEqual(usageOf(bag).creates, 1);
      assert.strictEqual(bag.events.length, 1);
      assert.strictEqual(bag.events[0].name, 'slot.acquired');
      assert.strictEqual(bag.events[0].payload.site, 'youtube');
      assert.strictEqual(bag.events[0].payload.liveChatId, 'CHAT-' + insert.n);
    } finally { cleanup(bag); }
  });

  await test('live: 10 分以内は YouTube を見ない。10 分後に動いている枠があれば作らない', async () => {
    const bag = boot({ active: [{ id: 'ACT-1', snippet: { liveChatId: 'CHAT-ACT' } }] });
    try {
      await bag.plugin.tick();
      const first = bag.calls.length;
      assert.strictEqual(writes(bag).length, 0);
      bag.clock.t += 2 * 60 * 1000;
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, first, '3 分たつまでは見ない');
      bag.clock.t += 61 * 1000;
      await bag.plugin.tick();
      const afterExtra = bag.calls.length;
      assert.ok(afterExtra > first, '3 分後にもう 1 回確かめる');
      bag.clock.t += 9 * 60 * 1000;
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, afterExtra, 'そのあと 10 分は見ない');
      bag.clock.t += 61 * 1000;
      await bag.plugin.tick();
      assert.ok(bag.calls.length > afterExtra);
      assert.strictEqual(writes(bag).length, 0);
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.broadcastId, 'ACT-1');
      assert.strictEqual(s.lastOp, 'reused');
    } finally { cleanup(bag); }
  });

  await test('live: OBS が止まっていれば何もしない。つながらないときも書かない', async () => {
    const bag = boot({ obs: { outputActive: false, outputDuration: 0 } });
    try {
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, 0);
      bag.state.obs = null;
      await bag.plugin.tick();
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.obs.reachable, false);
      assert.strictEqual(bag.calls.length, 0);
    } finally { cleanup(bag); }
  });

  await test('live: 直前に作ってから 5 分以内は作らない（再接続の繰り返し対策）', async () => {
    const bag = boot();
    try {
      await bag.plugin.tick();
      assert.strictEqual(usageOf(bag).creates, 1);
      bag.state.obs = { outputActive: false, outputDuration: 0 };
      await bag.plugin.tick();
      bag.state.obs = { outputActive: true, outputDuration: 2000 };
      bag.clock.t += 2 * 60 * 1000;
      const before = writes(bag).length;
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).length, before);
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.lastOp, 'blocked-too-soon');
    } finally { cleanup(bag); }
  });

  await test('live: 閾値で 新枠の用意→OBS 停止→旧枠 complete→OBS 再開。切り替えを数える', async () => {
    const bag = boot({ active: [{ id: 'OLD', snippet: { title: '題名', description: '説明', liveChatId: 'CHAT-OLD' } }], obs: { outputActive: true, outputDuration: 42700 * 1000 } });
    try {
      await bag.plugin.tick();
      assert.deepStrictEqual(bag.obsCalls, ['status', 'check', 'status', 'stop', 'start', 'status']);
      const order = writes(bag).map((c) => c.path + (c.query.broadcastStatus ? ':' + c.query.broadcastStatus : ''));
      assert.deepStrictEqual(order, ['liveBroadcasts', 'liveBroadcasts/bind', 'liveChat/messages', 'liveBroadcasts/transition:complete']);
      assert.strictEqual(writes(bag)[0].body.contentDetails.enableAutoStart, true);
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.lastOp, 'switched');
      assert.ok(/^NEW-/.test(s.broadcastId));
      assert.strictEqual(s.usage.switches, 1);
      assert.strictEqual(s.usage.creates, 1);
      assert.deepStrictEqual(bag.events.filter((e) => e.name === 'slot.acquired').map((e) => e.payload.reason), ['reused', 'switched']);
      assert.strictEqual(bag.events.filter((e) => e.name === 'slot.acquired')[1].payload.previousId, 'OLD');
      assert.deepStrictEqual(bag.events.filter((e) => e.name === 'slot.switching').map((e) => e.payload.phase), ['start', 'end'], '暗転の前後を知らせる（回線の見張りが警告しないように）');
    } finally { cleanup(bag); }
  });

  await test('live: OBS を止められない（OBS 操作オフ）なら枠を作らない', async () => {
    const bag = boot({ active: [{ id: 'OLD', snippet: { title: 'T' } }], obs: { outputActive: true, outputDuration: 43000 * 1000 }, stopOk: false });
    bag.ctx.obs.streamControl = async (input) => {
      bag.obsCalls.push(input.action);
      return { ok: false, error: 'obs-control-off' };
    };
    try {
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).length, 0);
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.error, 'obs-control-off');
      const before = bag.calls.length;
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, before, '5 分は再試行しない');
    } finally { cleanup(bag); }
  });

  await test('live: 切り替えが 1 日 4 回に達していたら書かない。使用量 7000 でも止める', async () => {
    const bag = boot({ active: [{ id: 'OLD', snippet: {} }], obs: { outputActive: true, outputDuration: 43000 * 1000 } });
    try {
      fs.writeFileSync(path.join(bag.dir, 'usage.json'), JSON.stringify({ day: '2026-10-07', units: 10, creates: 4, switches: 4, lastCreateAt: 0 }));
      bag.plugin.load(bag.ctx);
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).length, 0);
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).lastOp, 'blocked-switch-limit');
    } finally { cleanup(bag); }
    const heavy = boot({ obs: { outputActive: true, outputDuration: 5000 } });
    try {
      fs.writeFileSync(path.join(heavy.dir, 'usage.json'), JSON.stringify({ day: '2026-10-07', units: 7000, creates: 0, switches: 0, lastCreateAt: 0 }));
      heavy.plugin.load(heavy.ctx);
      await heavy.plugin.tick();
      assert.strictEqual(writes(heavy).length, 0);
      assert.strictEqual((await heavy.plugin.actions.getStatus({}, heavy.ctx)).lastOp, 'blocked-quota-guard');
    } finally { cleanup(heavy); }
  });

  await test('live: quotaExceeded が返ったらその日は止める。翌日（太平洋時間）に戻る', async () => {
    const bag = boot({ insertCode: 403 });
    try {
      await bag.plugin.tick();
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.quotaStopped, true);
      assert.strictEqual(s.error, 'quota');
      const before = bag.calls.length;
      bag.clock.t += 20 * 60 * 1000;
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, before, '止めている日は何も呼ばない');
      bag.clock.t += 24 * 3600 * 1000;
      bag.state.insertCode = 200;
      await bag.plugin.tick();
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).quotaStopped, false);
      assert.ok(bag.calls.length > before);
    } finally { cleanup(bag); }
  });

  await test('ログインが無い・切れたときは止めて画面に出す（勝手にやり直さない）', async () => {
    const none = boot({ secret: null });
    try {
      await none.plugin.tick();
      const s = await none.plugin.actions.getStatus({}, none.ctx);
      assert.strictEqual(s.needsLogin, true);
      assert.strictEqual(s.credentials, false);
      assert.strictEqual(none.calls.length, 0);
    } finally { cleanup(none); }
    const dead = boot({ handler: (c) => (c.host === 'oauth2.googleapis.com' ? res(400, '') : res(401, '')) });
    try {
      await dead.plugin.tick();
      assert.strictEqual((await dead.plugin.actions.getStatus({}, dead.ctx)).needsLogin, true);
      const troubles = () => dead.events.filter((e) => e.name === 'site.trouble');
      assert.deepStrictEqual(troubles().map((e) => [e.payload.site, e.payload.job, e.payload.kind]), [['youtube', 'slot', 'login-expired']], 'L9b: ログイン切れの合図');
      dead.clock.t += 6 * 60 * 1000;
      await dead.plugin.tick();
      assert.strictEqual(troubles().length, 1, '直るまで 1 回だけ');
    } finally { cleanup(dead); }
  });

  await test('期限切れのトークンは更新して金庫へ書き戻す。値はログ・状態・イベントに出ない', async () => {
    const bag = boot({ secret: oauth({ expiry_date: T0 - 1000 }), active: [{ id: 'A', snippet: {} }] });
    try {
      await bag.plugin.tick();
      assert.ok(bag.calls.some((c) => c.host === 'oauth2.googleapis.com'));
      const yt = bag.calls.filter((c) => c.host === 'youtube.googleapis.com');
      assert.ok(yt.every((c) => c.auth === 'Bearer ' + NEW_ACCESS));
      assert.strictEqual(bag.secretSets.length, 1);
      assert.strictEqual(bag.secretSets[0].name, 'youtube.oauth');
      assert.strictEqual(JSON.parse(bag.secretSets[0].value).access_token, NEW_ACCESS);
      const s = JSON.stringify(await bag.plugin.actions.getStatus({}, bag.ctx));
      const everything = s + bag.logs.join('\n') + JSON.stringify(bag.events);
      for (const secret of [ACCESS, REFRESH, CLIENT_SECRET, NEW_ACCESS]) {
        assert.strictEqual(everything.indexOf(secret), -1, secret + ' が漏れている');
      }
    } finally { cleanup(bag); }
  });

  await test('getStatus は金庫を読まない（check:true のときだけ 1 回）', async () => {
    const bag = boot();
    try {
      await bag.plugin.actions.getStatus({}, bag.ctx);
      await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(bag.secretGets.length, 0);
      const s = await bag.plugin.actions.getStatus({ check: true }, bag.ctx);
      assert.strictEqual(bag.secretGets.length, 1);
      assert.strictEqual(s.credentials, true);
    } finally { cleanup(bag); }
  });

  await test('createTestSlot: 確認なし・live 以外は拒否。live で確認ありなら非公開の枠を作って結ぶだけ（live にしない）', async () => {
    const shadow = boot({ mode: 'shadow' });
    try {
      assert.deepStrictEqual(await shadow.plugin.actions.createTestSlot({ confirmed: true }, shadow.ctx), { ok: false, error: 'not-live' });
      assert.strictEqual(shadow.calls.length, 0);
    } finally { cleanup(shadow); }
    const bag = boot();
    try {
      assert.deepStrictEqual(await bag.plugin.actions.createTestSlot({}, bag.ctx), { ok: false, error: 'confirm' });
      assert.strictEqual(bag.calls.length, 0);
      const out = await bag.plugin.actions.createTestSlot({ confirmed: true }, bag.ctx);
      assert.strictEqual(out.ok, true);
      const w = writes(bag);
      assert.deepStrictEqual(w.map((c) => c.path), ['liveBroadcasts', 'liveBroadcasts/bind']);
      assert.strictEqual(w[0].body.status.privacyStatus, 'private');
      assert.strictEqual(w[0].body.snippet.title, '丸スト テスト枠');
    } finally { cleanup(bag); }
  });

  await test('setConfig は範囲を直して保存し、題名の先頭が次の枠に使われる', async () => {
    const bag = boot({ active: [], handler: null });
    try {
      const out = await bag.plugin.actions.setConfig({ thresholdSec: 5, streamId: 'S 1!', titlePrefix: ' 夜の配信 ', defaultDescription: 'D' }, bag.ctx);
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.config.thresholdSec, 42600, '範囲外は既定に戻す');
      assert.strictEqual(out.config.streamId, '');
      assert.strictEqual(out.config.titlePrefix, '夜の配信');
      bag.plugin.load(bag.ctx);
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).config.titlePrefix, '夜の配信');
    } finally { cleanup(bag); }
  });

  await test('stream.slot@1: legacy/shadow は何もしない・live の verifyLive は動いている枠を見る', async () => {
    const legacy = boot({ mode: 'legacy' });
    try {
      assert.deepStrictEqual(await legacy.plugin.verifyLive({}, {}), { ok: true });
      assert.deepStrictEqual(legacy.plugin.prepareBroadcast({}, {}, {}), { ok: true });
      assert.strictEqual(legacy.calls.length, 0);
    } finally { cleanup(legacy); }
    const shadow = boot({ mode: 'shadow' });
    try {
      assert.deepStrictEqual(await shadow.plugin.verifyLive({}, {}), { ok: true, dryRun: true });
      assert.deepStrictEqual(shadow.plugin.endBroadcast({}, {}), { ok: true, dryRun: true });
      assert.strictEqual(shadow.calls.length, 0);
    } finally { cleanup(shadow); }
    const live = boot({ active: [{ id: 'A', snippet: {} }] });
    try {
      assert.deepStrictEqual(await live.plugin.verifyLive({}, {}), { ok: true, live: true });
      live.state.active = [];
      assert.deepStrictEqual(await live.plugin.verifyLive({}, {}), { ok: true, live: false });
      assert.deepStrictEqual(live.plugin.prepareBroadcast({}, {}, {}), { ok: true });
      assert.strictEqual(writes(live).length, 0);
    } finally { cleanup(live); }
  });

  await test('manifest: stream.slot@1・slotFor youtube・needs・秘密 1 つ。レジストリが受け付ける', async () => {
    // plugins/sites/youtube/（R16）の slot の役目。パネルは site の役目が持つので ui.panel は持たない。
    const manifest = createRegistry({ appRoot: ROOT, core: { STATE_DIR: os.tmpdir() }, logger() {} }).discover().find((rec) => rec.id === 'slot-youtube').manifest;
    assert.deepStrictEqual(manifest.provides, ['stream.slot@1']);
    assert.deepStrictEqual(manifest.slotFor, ['youtube']);
    assert.deepStrictEqual(manifest.needs, ['obs.read', 'obs.streamControl', 'destinations', 'events.emit', 'secrets', 'storage']);
    assert.deepStrictEqual(manifest.secrets, ['youtube.oauth']);
    assert.strictEqual(manifest.defaultMode, 'legacy');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r22-reg-'));
    try {
      const registry = createRegistry({ appRoot: ROOT, core: { STATE_DIR: stateDir }, logger() {} });
      const found = registry.discover().filter((rec) => rec.id === 'slot-youtube');
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].status, 'accepted', found[0].reason);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    const src = fs.readFileSync(require('../../../../test/_plugins').mainFileOf('slot-youtube'), 'utf8');
    assert.strictEqual(/state[\\/]+services/.test(src), false);
    assert.strictEqual(/setKey/.test(src), false, 'キーは扱わない');
  });

  // ----- M2.5 評価の Must 1〜4・Should 2・5 -----

  /** 作る→結ぶ→live を細かく制御できる偽の YouTube。 */
  function scripted(over) {
    const st = Object.assign({ bindFails: 0, transitionFails: 99, inserts: 0, boundTo: {}, active: [] }, over || {});
    const handler = function (c) {
      if (c.host === 'oauth2.googleapis.com') return res(200, { access_token: NEW_ACCESS, expires_in: 3600 });
      if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1', contentDetails: { isReusable: true } }] });
      if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'active') return res(200, { items: st.active });
      if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'upcoming') {
        return res(200, { items: Object.keys(st.boundTo).map((id) => ({ id: id, snippet: { liveChatId: 'CH-' + id }, contentDetails: { boundStreamId: st.boundTo[id] } })) });
      }
      if (c.path === 'liveBroadcasts' && c.method === 'GET') return res(200, { items: [{ snippet: { title: '題名' } }] });
      if (c.path === 'liveBroadcasts' && c.method === 'POST') {
        st.inserts += 1;
        const id = 'MADE-' + st.inserts;
        st.boundTo[id] = '';
        return res(200, { id: id, snippet: { liveChatId: 'CH-' + id } });
      }
      if (c.path === 'liveBroadcasts/bind') {
        if (st.bindFails > 0) { st.bindFails -= 1; return res(500, ''); }
        st.boundTo[c.query.id] = c.query.streamId;
        return res(200, {});
      }
      if (c.path === 'liveBroadcasts/transition') {
        if (c.query.broadcastStatus === 'live') {
          if (st.transitionFails > 0) { st.transitionFails -= 1; return res(403, { error: { errors: [{ reason: 'errorStreamInactive' }] } }); }
          delete st.boundTo[c.query.id];
          st.active.push({ id: c.query.id, snippet: { liveChatId: 'CH-' + c.query.id } });
          return res(200, {});
        }
        return res(200, {});
      }
      return res(200, {});
    };
    return { st, handler };
  }

  await test('Must 1: 作った直後に bind が失敗しても数える。10 分後は同じ枠を使い、2 枠目を作らない', async () => {
    const sc = scripted({ bindFails: 1, transitionFails: 0 });
    const bag = boot({ handler: sc.handler });
    try {
      await bag.plugin.tick();
      assert.strictEqual(sc.st.inserts, 1);
      assert.strictEqual(usageOf(bag).creates, 1, '失敗でも作成を数える');
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).error, 'http-500');
      bag.clock.t += 11 * 60 * 1000;
      await bag.plugin.tick();
      assert.strictEqual(sc.st.inserts, 1, '作り直さない');
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.broadcastId, 'MADE-1');
      assert.strictEqual(s.error, '');
      assert.strictEqual(usageOf(bag).creates, 1);
    } finally { cleanup(bag); }
  });

  await test('Must 2: live にならない枠があっても 30 分のあいだ 2 枠目を作らない。手で作った予約枠（同じストリーム）は使う', async () => {
    const sc = scripted({ transitionFails: 999 });
    const bag = boot({ handler: sc.handler });
    try {
      await bag.plugin.tick();
      assert.strictEqual(sc.st.inserts, 1);
      for (let i = 0; i < 4; i += 1) {
        bag.clock.t += 10 * 60 * 1000 + 1000;
        await bag.plugin.tick();
      }
      assert.strictEqual(sc.st.inserts, 1, 'live にならなくても作り直さない');
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).waitingLive, true);
      sc.st.transitionFails = 0;
      bag.clock.t += 10 * 60 * 1000 + 1000;
      await bag.plugin.tick();
      assert.strictEqual(sc.st.inserts, 1);
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).lastOp, 'reused');
    } finally { cleanup(bag); }
    const hand = scripted({ transitionFails: 0, boundTo: { HAND: 'S1' } });
    const mine = boot({ handler: hand.handler });
    try {
      await mine.plugin.tick();
      assert.strictEqual(hand.st.inserts, 0, '手で作った予約枠があれば作らない');
      assert.strictEqual((await mine.plugin.actions.getStatus({}, mine.ctx)).broadcastId, 'HAND');
    } finally { cleanup(mine); }
  });

  await test('Must 3: 切り替えの失敗（OBS を止められない）は試行を数え、用意した新枠を 5 分後も使い回す', async () => {
    const sc = scripted({ active: [{ id: 'OLD', snippet: { title: 'T', liveChatId: 'CH-OLD' } }] });
    const bag = boot({ handler: sc.handler, obs: { outputActive: true, outputDuration: 43000 * 1000 } });
    let stopFails = true;
    const baseControl = bag.ctx.obs.streamControl;
    bag.ctx.obs.streamControl = async (input) => {
      if (input.action === 'stop' && stopFails) { bag.obsCalls.push('stop'); return { ok: false, error: 'failed' }; }
      return baseControl(input);
    };
    try {
      await bag.plugin.tick();
      assert.strictEqual(sc.st.inserts, 1);
      let u = usageOf(bag);
      assert.strictEqual(u.switches, 1, '試行を数える');
      assert.strictEqual(u.creates, 1);
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).error, 'obs-stop-failed');
      assert.ok(!bag.calls.some((c) => c.path === 'liveBroadcasts/transition' && c.query.broadcastStatus === 'complete'), '旧枠は閉じない');
      bag.clock.t += 5 * 60 * 1000 + 1000;
      stopFails = false;
      await bag.plugin.tick();
      assert.strictEqual(sc.st.inserts, 1, '用意した新枠を使い回す');
      u = usageOf(bag);
      assert.strictEqual(u.switches, 2);
      assert.strictEqual(u.creates, 1);
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).lastOp, 'switched');
      assert.deepStrictEqual(bag.events.filter((e) => e.name === 'slot.acquired').map((e) => e.payload.reason), ['reused', 'switched']);
    } finally { cleanup(bag); }
  });

  await test('Must 4: 再開の前に人が止めていたら OBS を再開しない。画面に出すが致命的な警報（site.trouble）は出さない', async () => {
    const sc = scripted({ active: [{ id: 'OLD', snippet: { title: 'T' } }] });
    const bag = boot({ handler: sc.handler, obs: { outputActive: true, outputDuration: 43000 * 1000 } });
    const baseControl = bag.ctx.obs.streamControl;
    let starts = 0;
    bag.ctx.obs.streamControl = async (input) => {
      if (input.action === 'start') { starts += 1; return { ok: false, error: 'human-stopped' }; }
      return baseControl(input);
    };
    try {
      await bag.plugin.tick();
      assert.strictEqual(starts, 1, '再試行しない');
      const s = await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(s.lastOp, 'restart-skipped');
      assert.strictEqual(s.error, '');
      assert.strictEqual(bag.events.filter((e) => e.name === 'site.trouble').length, 0);
      assert.ok(/^MADE-/.test(s.broadcastId), '新枠が今の枠');
    } finally { cleanup(bag); }
  });

  await test('Should 1: OBS の状態が取れないときは「止まっている」とみなして旧枠を閉じない', async () => {
    const sc = scripted({ active: [{ id: 'OLD', snippet: { title: 'T' } }] });
    const bag = boot({ handler: sc.handler, obs: { outputActive: true, outputDuration: 43000 * 1000 } });
    let reads = 0;
    bag.ctx.obs.getStreamStatus = async () => {
      reads += 1;
      return reads === 1 ? { outputActive: true, outputDuration: 43000 * 1000 } : null;
    };
    try {
      await bag.plugin.tick();
      assert.ok(!bag.calls.some((c) => c.path === 'liveBroadcasts/transition' && c.query.broadcastStatus === 'complete'));
      assert.ok(!bag.obsCalls.includes('stop'));
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).error, 'obs-stop-failed');
    } finally { cleanup(bag); }
  });

  await test('Should 2: Google のトークン更新が 503・通信失敗でもログイン切れにしない。400 だけがログイン切れ', async () => {
    const mk = (status) => (c) => {
      if (c.host === 'oauth2.googleapis.com') return status === 'net' ? Promise.reject(new Error('down')) : res(status, '');
      return c.auth === 'Bearer ' + ACCESS ? res(401, '') : res(200, { items: [{ id: 'A', snippet: {} }] });
    };
    for (const status of [503, 'net', 429]) {
      const bag = boot({ secret: oauth({ expiry_date: T0 - 1000 }), handler: mk(status) });
      try {
        await bag.plugin.tick();
        const s = await bag.plugin.actions.getStatus({}, bag.ctx);
        assert.strictEqual(s.needsLogin, false, String(status));
        assert.strictEqual(s.error, 'network', String(status));
      } finally { cleanup(bag); }
    }
    const bad = boot({ secret: oauth({ expiry_date: T0 - 1000 }), handler: mk(400) });
    try {
      await bad.plugin.tick();
      assert.strictEqual((await bad.plugin.actions.getStatus({}, bad.ctx)).needsLogin, true);
    } finally { cleanup(bad); }
  });

  await test('Should 5: 引き継いだ枠でも slot.acquired を出す（reason reused）。同じ枠では出し直さない', async () => {
    const bag = boot({ active: [{ id: 'ACT-9', snippet: { liveChatId: 'CH-9' } }] });
    try {
      await bag.plugin.tick();
      assert.strictEqual(bag.events.length, 1);
      assert.deepStrictEqual(Object.keys(bag.events[0].payload).sort(), ['at', 'broadcastId', 'liveChatId', 'reason', 'site']);
      assert.strictEqual(bag.events[0].payload.reason, 'reused');
      bag.clock.t += 11 * 60 * 1000;
      await bag.plugin.tick();
      assert.strictEqual(bag.events.length, 1);
    } finally { cleanup(bag); }
  });

  await test('Should 3: OBS が短く再接続して経過が 0 に戻っても、YouTube の枠の開始時刻（actualStartTime）から 12 時間で切り替える', async () => {
    const started = new Date(T0 - 43000 * 1000).toISOString();
    const sc = scripted({ active: [{ id: 'OLD', snippet: { title: 'T', liveChatId: 'CH-OLD', actualStartTime: started } }] });
    const bag = boot({ handler: sc.handler, obs: { outputActive: true, outputDuration: 5000 } });
    try {
      await bag.plugin.tick();
      assert.ok(bag.obsCalls.includes('stop') && bag.obsCalls.includes('start'), 'OBS は 5 秒でも、枠は 11 時間 56 分なので切り替える');
      assert.strictEqual((await bag.plugin.actions.getStatus({}, bag.ctx)).lastOp, 'switched');
    } finally { cleanup(bag); }
    const young = scripted({ active: [{ id: 'NEW', snippet: { actualStartTime: new Date(T0 - 3600 * 1000).toISOString() } }] });
    const calm = boot({ handler: young.handler, obs: { outputActive: true, outputDuration: 5000 } });
    try {
      await calm.plugin.tick();
      assert.ok(!calm.obsCalls.includes('stop'), '1 時間の枠は切り替えない');
    } finally { cleanup(calm); }
  });

  await test('Should 4: 配信開始の 3 分後にもう 1 回確かめる（閉じかけの旧枠を見ていた場合）', async () => {
    const bag = boot({ active: [{ id: 'CLOSING', snippet: {} }] });
    try {
      await bag.plugin.tick();
      const first = bag.calls.length;
      bag.clock.t += 2 * 60 * 1000;
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, first);
      bag.state.active = [];
      bag.clock.t += 61 * 1000;
      await bag.plugin.tick();
      assert.ok(bag.calls.length > first, '3 分後に確かめた');
    } finally { cleanup(bag); }
  });

  await test('L3d: メイン出力 obs-main が無い・無効・youtube でないなら切り替えない。合図は 1 回だけ。youtube なら今どおり', async () => {
    const cases = [
      { noMainRow: true },
      { mainRow: { enabled: false } },
      { mainRow: { site: '' } },
      { mainRow: { site: 'twitch' } }
    ];
    for (const c of cases) {
      const bag = boot(Object.assign({ active: [{ id: 'OLD', snippet: {} }], obs: { outputActive: true, outputDuration: 43000 * 1000 } }, c));
      try {
        await bag.plugin.tick();
        assert.strictEqual(writes(bag).length, 0);
        assert.ok(!bag.obsCalls.includes('stop'), 'OBS を止めない');
        const s = await bag.plugin.actions.getStatus({}, bag.ctx);
        assert.strictEqual(s.lastOp, 'main-not-youtube');
        bag.clock.t += 6 * 60 * 1000;
        await bag.plugin.tick();
        const alerts = bag.events.filter((e) => e.name === 'site.trouble' && e.payload.code === 'main-not-youtube');
        assert.strictEqual(alerts.length, 1, '同じ状態のあいだ合図は 1 回');
        assert.strictEqual(alerts[0].payload.site, 'youtube');
      } finally { cleanup(bag); }
    }
    const noApi = boot({ active: [{ id: 'OLD', snippet: {} }], obs: { outputActive: true, outputDuration: 43000 * 1000 } });
    try {
      delete noApi.ctx.destinations;
      await noApi.plugin.tick();
      assert.strictEqual(writes(noApi).length, 0);
      assert.ok(!noApi.obsCalls.includes('stop'));
    } finally { cleanup(noApi); }
    const ok = boot({ active: [{ id: 'OLD', snippet: {} }], obs: { outputActive: true, outputDuration: 43000 * 1000 } });
    try {
      await ok.plugin.tick();
      assert.ok(ok.obsCalls.includes('stop'), 'youtube なら切り替える');
    } finally { cleanup(ok); }
  });

  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
})();
