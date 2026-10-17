'use strict';
const { k2 } = require('../../../../test/_k2-ctx');

/**
 * R23: plugins/slot-niconico。偽の OBS・偽のニコ生・偽の金庫だけ。本物のどれにもつながない。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createRegistry } = require('../../../../host/layer1/plugin-registry');
const P = require('../../../../test/_plugins');
const { createSlotNiconico } = P.requirePlugin('slot-niconico');
const slotManifest = () => require('../../../../host/layer1/plugin-registry').createRegistry({ appRoot: path.join(__dirname, '..', '..', '..', '..'), core: { STATE_DIR: require('os').tmpdir() }, logger() {} }).discover().find((rec) => rec.id === 'slot-niconico').manifest;

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const SESSION = 'SENTINEL-NICO-SESSION';
const OTHER_COOKIE = 'SENTINEL-OTHER-COOKIE';
const COOKIES = JSON.stringify({ cookies: { user_session: SESSION, other: OTHER_COOKIE } });
const WATCH_HTML = '<div data-props="{&quot;site&quot;:{&quot;relive&quot;:{&quot;csrfToken&quot;:&quot;CSRF-1&quot;}}}"></div>';

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

function onAir(hoursLeft) {
  return { onAirSchedule: { beginTime: new Date(T0 - 3600000).toISOString(), endTime: new Date(T0 + (hoursLeft || 5) * 3600000).toISOString() } };
}

/** 偽のニコ生。programs: lv 番号 → data（null なら 404）。latest: 最新の番組 id。 */
function boot(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-slot-nico-'));
  const clock = { t: T0 };
  const calls = [];
  const logs = [];
  const events = [];
  const secretGets = [];
  const state = {
    mode: o.mode || 'live',
    obs: Object.prototype.hasOwnProperty.call(o, 'obs') ? o.obs : { outputActive: true, outputDuration: 5000 },
    secret: Object.prototype.hasOwnProperty.call(o, 'secret') ? o.secret : COOKIES,
    latest: o.latest || '',
    programs: o.programs || {},
    createStatus: o.createStatus || 201,
    createdId: o.createdId || 'lv500',
    extensionOk: o.extensionOk != null ? o.extensionOk : 2,
    endStatus: o.endStatus || 200,
    status401: false
  };
  const handler = function (c) {
    if (state.status401 && c.host === 'live2.nicovideo.jp') return res(401, '');
    if (c.path === '/unama/api/v2/programs/latest') {
      if (!state.latest) return res(404, '');
      return res(200, { data: { id: state.latest, title: '前の題名' } });
    }
    let m = /^\/unama\/api\/v2\/programs\/(lv\d+)$/.exec(c.path);
    if (m && c.method === 'GET') {
      const data = state.programs[m[1]];
      return data ? res(200, { data: data }) : res(404, '');
    }
    if (c.method === 'POST' && c.path === '/unama/api/v2/programs') {
      if (state.createStatus === 409) return res(409, '');
      if (state.createStatus >= 300) return res(state.createStatus, '');
      state.latest = state.createdId;
      state.programs[state.createdId] = onAir(5);
      return res(state.createStatus, { data: { id: state.createdId } });
    }
    if (c.path.indexOf('/watch/') === 0) return res(200, WATCH_HTML);
    m = /^\/unama\/api\/v3\/programs\/(lv\d+)\/segment\?state=(\w+)$/.exec(c.path);
    if (m && c.method === 'PUT') {
      if (m[2] === 'end') {
        if (state.endStatus === 200) delete state.programs[m[1]];
        return res(state.endStatus, '');
      }
      state.programs[m[1]] = onAir(5);
      return res(204, '');
    }
    if (c.method === 'POST' && /\/extension$/.test(c.path)) {
      if (state.extensionOk > 0) { state.extensionOk -= 1; return res(200, { data: { end_time: 1 } }); }
      return res(400, '');
    }
    if (c.host === 'public-api.commons.nicovideo.jp') return res(200, {});
    return res(500, '');
  };
  const fetchFn = async function (url, init) {
    const u = new URL(url);
    const call = { method: init.method, host: u.hostname, path: u.pathname + u.search, headers: init.headers || {}, body: init.body || '' };
    calls.push(call);
    return handler(call);
  };
  const ctx = {
    id: 'slot-niconico',
    dataDir: dir, ...k2(dir),
    mode() { return state.mode; },
    logger(level, message) { logs.push(level + ' ' + message); },
    secrets: { async get(name) { secretGets.push(name); return state.secret == null ? { ok: false, error: 'no-secret' } : { ok: true, value: state.secret }; } },
    bus: { publish(name, payload) { events.push({ name, payload }); return 1; } },
    obs: { async getStreamStatus() { return state.obs; }, async isStreaming() { return !!(state.obs && state.obs.outputActive); } }
  };
  const plugin = createSlotNiconico({
    fetch: fetchFn,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    setInterval: () => ({ unref() {} }),
    clearInterval() {}
  });
  plugin.load(ctx);
  return { plugin, ctx, dir, clock, calls, logs, events, secretGets, state };
}

function cleanup(bag) {
  bag.plugin.destroy();
  fs.rmSync(bag.dir, { recursive: true, force: true });
}

function writes(bag) {
  return bag.calls.filter((c) => c.method !== 'GET');
}

const status = (bag) => bag.plugin.actions.getStatus({}, bag.ctx);

(async () => {
  await test('legacy: 何も見ない・何もしない', async () => {
    const bag = boot({ mode: 'legacy' });
    try {
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, 0);
      assert.strictEqual(bag.secretGets.length, 0);
    } finally { cleanup(bag); }
  });

  await test('shadow: 読むだけ。枠が無くても作らず「作るはずだった」と記録。動いている枠があれば見つけるだけ', async () => {
    const bag = boot({ mode: 'shadow' });
    try {
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).length, 0);
      assert.strictEqual((await status(bag)).lastOp, 'shadow-would-create');
      bag.state.latest = 'lv77';
      bag.state.programs.lv77 = onAir(3);
      bag.clock.t += 61000;
      await bag.plugin.tick();
      const s = await status(bag);
      assert.strictEqual(s.liveId, 'lv77');
      assert.strictEqual(s.lastOp, 'reused');
      assert.strictEqual(writes(bag).length, 0);
      assert.strictEqual(bag.events.length, 0);
    } finally { cleanup(bag); }
  });

  await test('live: OBS 配信中で枠が無ければ 作る→ON AIR→延長。番号のファイルを書き、イベントに番号だけ載せる', async () => {
    const bag = boot({ latest: 'lv499' }); // 終わった前の枠（題名を引き継ぐ）
    try {
      await bag.plugin.tick();
      const s = await status(bag);
      assert.strictEqual(s.liveId, 'lv500');
      assert.strictEqual(s.lastOp, 'created');
      const post = bag.calls.find((c) => c.method === 'POST' && c.path === '/unama/api/v2/programs');
      const body = JSON.parse(post.body);
      assert.strictEqual(body.title, '前の題名', '前の枠の題名を引き継ぐ');
      assert.strictEqual(body.category, '一般(その他)');
      assert.deepStrictEqual(body.optionalCategories, [], 'クルーズ待ちは既定でオフ');
      assert.strictEqual(body.isQuotable, undefined);
      assert.strictEqual(body.isGiftEnabled, undefined, 'monetize が false なら収益化は入れない');
      assert.strictEqual(post.headers['X-niconico-session'], SESSION);
      assert.strictEqual(bag.calls.filter((c) => /\/extension$/.test(c.path)).length, 3, '2 回成功＋上限で 1 回失敗');
      assert.ok(bag.calls.some((c) => c.method === 'PUT' && /state=on_air/.test(c.path)));
      assert.strictEqual(fs.readFileSync(path.join(bag.dir, 'current_lv.txt'), 'utf8'), 'lv500');
      assert.strictEqual(fs.readFileSync(path.join(bag.dir, 'watch_url.txt'), 'utf8'), 'https://live.nicovideo.jp/watch/lv500');
      assert.strictEqual(bag.events.length, 1);
      assert.deepStrictEqual(Object.keys(bag.events[0].payload).sort(), ['at', 'liveId', 'reason', 'site']);
      assert.ok(bag.calls.every((c) => /\.nicovideo\.jp$/.test(c.host)));
    } finally { cleanup(bag); }
  });

  await test('live: すでに動いている枠があれば作らず引き継ぐ。準備中なら開始して延長する', async () => {
    const running = boot({ latest: 'lv10', programs: { lv10: onAir(4) } });
    try {
      await running.plugin.tick();
      assert.strictEqual((await status(running)).liveId, 'lv10');
      assert.strictEqual((await status(running)).lastOp, 'reused');
      assert.ok(!running.calls.some((c) => c.method === 'POST' && c.path === '/unama/api/v2/programs'), '作らない');
      assert.ok(!running.calls.some((c) => c.method === 'PUT'), '開始し直さない');
      assert.strictEqual(running.calls.filter((c) => /\/extension$/.test(c.path)).length, 3, '引き継いだ枠も上限まで延長する');
      assert.deepStrictEqual(running.events.map((e) => e.payload.reason), ['reused']);
    } finally { cleanup(running); }
    const testing = boot({ latest: 'lv11', programs: { lv11: { testSchedule: { x: 1 }, onAirSchedule: { beginTime: new Date(T0 + 3600000).toISOString(), endTime: new Date(T0 + 7200000).toISOString() } } } });
    try {
      await testing.plugin.tick();
      assert.strictEqual((await status(testing)).liveId, 'lv11');
      assert.ok(testing.calls.some((c) => c.method === 'PUT' && /lv11\/segment\?state=on_air/.test(c.path)));
      assert.ok(testing.calls.some((c) => /lv11\/extension$/.test(c.path)));
      assert.ok(!testing.calls.some((c) => c.method === 'POST' && c.path === '/unama/api/v2/programs'));
    } finally { cleanup(testing); }
  });

  await test('live: OBS が止まっていれば枠を作らない。接続できなくても作らない', async () => {
    const bag = boot({ obs: { outputActive: false } });
    try {
      await bag.plugin.tick();
      bag.state.obs = null;
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, 0);
      assert.strictEqual((await status(bag)).obs.reachable, false);
    } finally { cleanup(bag); }
  });

  await test('live: OBS が止まって N 分で枠を終了。5 分経つ前は終了しない。復帰で数え直す', async () => {
    const bag = boot({ latest: 'lv20', programs: { lv20: onAir(4) } });
    try {
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).liveId, 'lv20');
      bag.state.obs = { outputActive: false };
      await bag.plugin.tick();
      bag.clock.t += 4 * 60000;
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).filter((c) => /state=end/.test(c.path)).length, 0);
      bag.state.obs = { outputActive: true };
      bag.clock.t += 60000;
      await bag.plugin.tick();
      bag.state.obs = { outputActive: false };
      bag.clock.t += 10000;
      await bag.plugin.tick();
      bag.clock.t += 4 * 60000;
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).filter((c) => /state=end/.test(c.path)).length, 0, '復帰で数え直した');
      bag.clock.t += 61000;
      await bag.plugin.tick();
      assert.strictEqual(writes(bag).filter((c) => /state=end/.test(c.path)).length, 1);
      const s = await status(bag);
      assert.strictEqual(s.liveId, '');
      assert.strictEqual(s.lastOp, 'ended-disconnect');
      assert.ok(!bag.calls.some((c) => c.host === 'public-api.commons.nicovideo.jp'), 'monetize が false なら作品収入申請はしない');
    } finally { cleanup(bag); }
  });

  await test('live: OBS に接続できない状態が N 分続いても終了する（Python と同じ）', async () => {
    const bag = boot({ latest: 'lv21', programs: { lv21: onAir(4) } });
    try {
      await bag.plugin.tick();
      bag.state.obs = null;
      await bag.plugin.tick();
      bag.clock.t += 5 * 60000 + 1000;
      await bag.plugin.tick();
      assert.notStrictEqual((await status(bag)).lastOp, 'ended-disconnect', '接続不可は止まっているより長く待つ（3 倍）');
      bag.clock.t += 10 * 60000;
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).lastOp, 'ended-disconnect');
    } finally { cleanup(bag); }
  });

  await test('live: 自然終了して OBS が配信中なら次の枠（通し番号が進む）。OBS が止まっていれば待機', async () => {
    const bag = boot({ latest: 'lv30', programs: { lv30: onAir(4) }, createdId: 'lv31' });
    try {
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).liveId, 'lv30');
      delete bag.state.programs.lv30;
      await bag.plugin.tick();
      const s = await status(bag);
      assert.strictEqual(s.liveId, 'lv31');
      assert.strictEqual(s.lastOp, 'created');
    } finally { cleanup(bag); }
    const idle = boot({ latest: 'lv40', programs: { lv40: onAir(4) } });
    try {
      await idle.plugin.tick();
      delete idle.state.programs.lv40;
      idle.state.obs = { outputActive: false };
      await idle.plugin.tick();
      const s = await status(idle);
      assert.strictEqual(s.liveId, '');
      assert.strictEqual(s.lastOp, 'ended');
    } finally { cleanup(idle); }
  });

  await test('live: createNextOnNaturalEnd が false なら次の枠を作らない', async () => {
    const bag = boot({ latest: 'lv50', programs: { lv50: onAir(4) } });
    try {
      bag.plugin.actions.setConfig({ createNextOnNaturalEnd: false }, bag.ctx);
      await bag.plugin.tick();
      delete bag.state.programs.lv50;
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).liveId, '');
      assert.strictEqual(writes(bag).filter((c) => c.path === '/unama/api/v2/programs').length, 0);
    } finally { cleanup(bag); }
  });

  await test('ログインが無い・切れたときは止めて画面に出す。枠を終わらせない。5 分は呼び直さない', async () => {
    const none = boot({ secret: null });
    try {
      await none.plugin.tick();
      const s = await status(none);
      assert.strictEqual(s.needsLogin, true);
      assert.strictEqual(s.credentials, false);
      assert.strictEqual(none.calls.length, 0);
    } finally { cleanup(none); }
    const bag = boot({ latest: 'lv60', programs: { lv60: onAir(4) } });
    try {
      await bag.plugin.tick();
      const writesBefore = writes(bag).length;
      bag.state.status401 = true;
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).needsLogin, true);
      assert.strictEqual(writes(bag).length, writesBefore, '終了も作成もしない');
      assert.strictEqual((await status(bag)).liveId, 'lv60');
      const before = bag.calls.length;
      bag.clock.t += 60000;
      await bag.plugin.tick();
      assert.strictEqual(bag.calls.length, before);
      bag.state.status401 = false;
      bag.clock.t += 5 * 60000;
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).needsLogin, false);
    } finally { cleanup(bag); }
  });

  await test('金庫は 5 分に 1 回しか読まない。値は状態・ログ・イベントに出ない', async () => {
    const bag = boot({ latest: 'lv70', programs: { lv70: onAir(4) } });
    try {
      for (let i = 0; i < 5; i += 1) {
        bag.clock.t += 10000;
        await bag.plugin.tick();
      }
      assert.strictEqual(bag.secretGets.length, 1);
      bag.clock.t += 5 * 60000;
      await bag.plugin.tick();
      assert.strictEqual(bag.secretGets.length, 2);
      const everything = JSON.stringify(await status(bag)) + bag.logs.join('\n') + JSON.stringify(bag.events);
      assert.strictEqual(everything.indexOf(SESSION), -1);
      assert.strictEqual(everything.indexOf(OTHER_COOKIE), -1);
      await bag.plugin.actions.getStatus({}, bag.ctx);
      assert.strictEqual(bag.secretGets.length, 2, '画面の更新は金庫を読まない');
      await bag.plugin.actions.getStatus({ check: true }, bag.ctx);
      assert.strictEqual(bag.secretGets.length, 3);
    } finally { cleanup(bag); }
  });

  await test('monetize が true なら収益化の指定と終了時の作品収入申請を行う', async () => {
    const bag = boot({ latest: 'lv80', programs: { lv80: onAir(4) }, createdId: 'lv81' });
    try {
      bag.plugin.actions.setConfig({ monetize: true }, bag.ctx);
      await bag.plugin.tick();
      bag.state.obs = { outputActive: false };
      await bag.plugin.tick();
      bag.clock.t += 5 * 60000 + 1000;
      await bag.plugin.tick();
      assert.ok(bag.calls.some((c) => c.host === 'public-api.commons.nicovideo.jp'));
    } finally { cleanup(bag); }
    const make = boot({ createdId: 'lv82' });
    try {
      make.plugin.actions.setConfig({ monetize: true, title: 'T {part}' }, make.ctx);
      make.state.latest = '';
      await make.plugin.tick();
      const post = make.calls.find((c) => c.method === 'POST' && c.path === '/unama/api/v2/programs');
      const body = JSON.parse(post.body);
      assert.strictEqual(body.isGiftEnabled, true);
      assert.strictEqual(body.isCppAutoRegistration, true);
      assert.strictEqual(body.title, 'T 1');
    } finally { cleanup(make); }
  });

  await test('createTestSlot: 確認なし・live 以外は拒否。live で確認ありなら作るだけ（開始も延長もしない）。すでにあれば作らない', async () => {
    const shadow = boot({ mode: 'shadow' });
    try {
      assert.deepStrictEqual(await shadow.plugin.actions.createTestSlot({ confirmed: true }, shadow.ctx), { ok: false, error: 'not-live' });
      assert.strictEqual(shadow.calls.length, 0);
    } finally { cleanup(shadow); }
    const bag = boot({ createdId: 'lv90' });
    try {
      assert.deepStrictEqual(await bag.plugin.actions.createTestSlot({}, bag.ctx), { ok: false, error: 'confirm' });
      assert.strictEqual(bag.calls.length, 0);
      const out = await bag.plugin.actions.createTestSlot({ confirmed: true }, bag.ctx);
      assert.deepStrictEqual(out, { ok: true, liveId: 'lv90' });
      assert.strictEqual(writes(bag).length, 1);
      const again = await bag.plugin.actions.createTestSlot({ confirmed: true }, bag.ctx);
      assert.strictEqual(again.error, 'already-exists');
      assert.strictEqual(writes(bag).length, 1);
    } finally { cleanup(bag); }
  });

  await test('setConfig は範囲を直して保存。作者の説明文は既定に入っていない', async () => {
    const bag = boot({});
    try {
      assert.strictEqual((await status(bag)).config.description, '');
      const out = bag.plugin.actions.setConfig({ autoCloseMin: 0, nextDelaySec: 999, tags: 'a, b', title: '  ', category: ' 雑談 ' }, bag.ctx);
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.config.autoCloseMin, 5);
      assert.strictEqual(out.config.nextDelaySec, 5);
      assert.strictEqual(out.config.title, 'ライブ配信 第{part}枠');
      assert.strictEqual(out.config.category, '雑談');
      bag.plugin.load(bag.ctx);
      assert.strictEqual((await status(bag)).config.tags, 'a, b');
    } finally { cleanup(bag); }
  });

  await test('stream.slot@1: legacy/shadow は何もしない。live の verifyLive は番組の状態を見る。キーは出さない', async () => {
    const legacy = boot({ mode: 'legacy' });
    try {
      assert.deepStrictEqual(await legacy.plugin.verifyLive({}, {}), { ok: true });
      assert.strictEqual(legacy.calls.length, 0);
    } finally { cleanup(legacy); }
    const shadow = boot({ mode: 'shadow' });
    try {
      assert.deepStrictEqual(await shadow.plugin.verifyLive({}, {}), { ok: true, dryRun: true });
      assert.deepStrictEqual(shadow.plugin.prepareBroadcast({}, {}, {}), { ok: true, dryRun: true });
      assert.strictEqual(shadow.calls.length, 0);
    } finally { cleanup(shadow); }
    const live = boot({ latest: 'lv95', programs: { lv95: onAir(2) } });
    try {
      assert.deepStrictEqual(await live.plugin.verifyLive({}, {}), { ok: true, live: true });
      assert.deepStrictEqual(live.plugin.prepareBroadcast({}, {}, {}), { ok: true });
      assert.ok(!('key' in live.plugin.prepareBroadcast({}, {}, {})));
      delete live.state.programs.lv95;
      assert.deepStrictEqual(await live.plugin.verifyLive({}, {}), { ok: true, live: false });
      assert.strictEqual(writes(live).length, 0);
    } finally { cleanup(live); }
  });

  await test('manifest: stream.slot@1・slotFor niconico・needs は obs.read から・秘密 1 つ。レジストリが受け付ける', async () => {
    // plugins/sites/niconico/（R16）の slot の役目。パネルは site の役目が持つので ui.panel は持たない。
    const manifest = slotManifest();
    assert.deepStrictEqual(manifest.provides, ['stream.slot@1']);
    assert.deepStrictEqual(manifest.slotFor, ['niconico']);
    assert.deepStrictEqual(manifest.needs, ['obs.read', 'events.emit', 'secrets', 'storage']);
    assert.deepStrictEqual(manifest.secrets, ['cookies.niconico-main']);
    assert.strictEqual(manifest.defaultMode, 'legacy');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-reg-'));
    try {
      const registry = createRegistry({ appRoot: ROOT, core: { STATE_DIR: stateDir }, logger() {} });
      const found = registry.discover().filter((rec) => rec.id === 'slot-niconico');
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].status, 'accepted', found[0].reason);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    const src = fs.readFileSync(P.mainFileOf('slot-niconico'), 'utf8');
    assert.strictEqual(/setKey/.test(src), false, 'キーは扱わない');
    assert.strictEqual(/orangeqoon|amzn\.to/.test(src + JSON.stringify(manifest)), false, '作者の説明文を入れない');
  });

  await test('Should: 次の枠は reason switched・previousId つきで知らせる。クルーズ待ちは設定でオンにできる', async () => {
    const bag = boot({ latest: 'lv30', programs: { lv30: onAir(4) }, createdId: 'lv31' });
    try {
      bag.plugin.actions.setConfig({ cruiseWait: true }, bag.ctx);
      await bag.plugin.tick();
      delete bag.state.programs.lv30;
      await bag.plugin.tick();
      assert.deepStrictEqual(bag.events.map((e) => [e.payload.liveId, e.payload.reason, e.payload.previousId || '']), [['lv30', 'reused', ''], ['lv31', 'switched', 'lv30']]);
      const post = bag.calls.find((c) => c.method === 'POST' && c.path === '/unama/api/v2/programs');
      const body = JSON.parse(post.body);
      assert.ok(body.optionalCategories.indexOf('クルーズ待ち') !== -1);
      assert.strictEqual(body.isQuotable, true);
    } finally { cleanup(bag); }
  });

  await test('Should: OBS が配信中のときテスト枠は作らない（次の見回りで本番として開始してしまうため）', async () => {
    const bag = boot({ latest: '' });
    try {
      await bag.plugin.tick(); // OBS 配信中 → 枠ができる
      const out = await bag.plugin.actions.createTestSlot({ confirmed: true }, bag.ctx);
      assert.deepStrictEqual(out, { ok: false, error: 'obs-streaming' });
    } finally { cleanup(bag); }
  });

  // ----- R20: 公開向けに整える（slot.alert・番組テンプレートの入力欄・作者の値を既定にしない） -----

  const alertsOf = (bag) => bag.events.filter((e) => e.name === 'site.trouble');
  const TOKEN = /^[a-z0-9][a-z0-9-]{0,31}$/;

  await test('R20 site.trouble: ログイン切れは 1 回だけ（直るまで繰り返さない）・直ったあとの切れでまた 1 回。code はホームの token の形。shadow では出さない', async () => {
    const bag = boot({ latest: 'lv60', programs: { lv60: onAir(4) } });
    try {
      await bag.plugin.tick();
      assert.strictEqual(alertsOf(bag).length, 0);
      bag.state.status401 = true;
      await bag.plugin.tick();
      assert.deepStrictEqual(alertsOf(bag).map((e) => [e.payload.site, e.payload.code]), [['niconico', 'login-expired']]);
      assert.deepStrictEqual(alertsOf(bag).map((e) => [e.payload.job, e.payload.kind]), [['slot', 'login-expired']]);
      bag.clock.t += 5 * 60000 + 1000;
      await bag.plugin.tick(); // まだ 401: 再確認で失敗しても同じ警告は出さない
      assert.strictEqual(alertsOf(bag).length, 1);
      bag.state.status401 = false;
      bag.clock.t += 5 * 60000 + 1000;
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).needsLogin, false);
      bag.state.status401 = true;
      bag.clock.t += 5 * 60000 + 1000;
      await bag.plugin.tick();
      await bag.plugin.tick();
      assert.strictEqual(alertsOf(bag).length, 2, '直ってからの切れは新しい警告');
      for (const e of alertsOf(bag)) assert.ok(TOKEN.test(e.payload.code), e.payload.code);
      assert.ok(!JSON.stringify(bag.events).includes(SESSION), '秘密は出ない');
    } finally { cleanup(bag); }
    const shadow = boot({ mode: 'shadow', secret: null });
    try {
      shadow.clock.t += 61000;
      await shadow.plugin.tick();
      assert.strictEqual(alertsOf(shadow).length, 0, 'live 以外は警告を出さない');
    } finally { cleanup(shadow); }
  });

  await test('R20 site.trouble: OBS が止まったのに枠を終了できないとき end-failed を 1 回（30 秒ごとの再試行では繰り返さない）。終了できれば取り下げる', async () => {
    const bag = boot({ latest: 'lv80', programs: { lv80: onAir(4) }, endStatus: 500 });
    try {
      await bag.plugin.tick();
      bag.state.obs = { outputActive: false };
      await bag.plugin.tick(); // 待ち始め
      bag.clock.t += 6 * 60000;
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).lastOp, 'end-failed');
      assert.deepStrictEqual(alertsOf(bag).map((e) => e.payload.code), ['end-failed']);
      bag.clock.t += 31000;
      await bag.plugin.tick();
      assert.strictEqual(alertsOf(bag).length, 1);
      bag.state.endStatus = 200;
      bag.clock.t += 31000;
      await bag.plugin.tick();
      assert.strictEqual((await status(bag)).lastOp, 'ended-disconnect');
    } finally { cleanup(bag); }
  });

  await test('R20 番組テンプレート: 既定は作者の値を含まず、画面で入れた値がそのまま枠の作成に使われる', async () => {
    const fresh = boot({ latest: '' });
    try {
      const c = (await status(fresh)).config;
      assert.deepStrictEqual([c.description, c.tags], ['', '']);
      assert.strictEqual(c.title, 'ライブ配信 第{part}枠');
      await fresh.plugin.tick();
      const post = fresh.calls.find((x) => x.method === 'POST' && x.path === '/unama/api/v2/programs');
      assert.ok(post, '枠を作った');
      assert.ok(!/NeonTimer|config\.yaml/.test(post.body), '作者の設定は入らない');
      assert.strictEqual(JSON.parse(post.body).description, '');
    } finally { cleanup(fresh); }
    const set = boot({ latest: '' });
    try {
      const saved = set.plugin.actions.setConfig({ title: 'テスト番組 第{part}枠', description: 'これは説明文 SENTINEL-DESC', tags: 'ゲーム, 雑談', category: 'ゲーム' }, set.ctx);
      assert.strictEqual(saved.ok, true);
      await set.plugin.tick();
      const post = set.calls.find((x) => x.method === 'POST' && x.path === '/unama/api/v2/programs');
      const body = JSON.parse(post.body);
      assert.strictEqual(body.description, 'これは説明文 SENTINEL-DESC');
      assert.strictEqual(body.category, 'ゲーム');
      assert.deepStrictEqual(body.tags.map((t) => t.label), ['ゲーム', '雑談']);
      assert.ok(body.title.indexOf('テスト番組') === 0, body.title);
    } finally { cleanup(set); }
  });

  await test('R20 公開向け: manifest は public/stable・パネルに番組の設定の説明・モードの英語を出さない・ホームから枠の設定を開ける', () => {
    const manifest = slotManifest();
    assert.deepStrictEqual([manifest.audience, manifest.stability], ['public', 'stable']);
    const html = fs.readFileSync(path.join(P.uiDirOf('slot-niconico'), 'panel.html'), 'utf8');
    const js = fs.readFileSync(P.panelFileOf('slot-niconico'), 'utf8');
    assert.ok(html.includes('番組の設定') && html.includes('ほかの人の設定は入っていません'));
    assert.ok(!/live モード|shadow/.test(html));
    assert.ok(js.includes('MODE_LABEL') && !/r\.mode === 'legacy'/.test(js));
    const home = fs.readFileSync(path.join(ROOT, 'plugins', 'ui-standard', 'shell', 'panels', 'home.js'), 'utf8');
    assert.ok(/data-home-slot-settings/.test(home) && /plugin:slot-/.test(home));
    const STR = require('../../../../plugins/ui-standard/shell/strings');
    assert.ok(STR.homeAlert('ニコ生', 'login-expired').includes('ログイン'));
    assert.ok(STR.homeAlert('ニコ生', 'end-failed').includes('end-failed'));
  });

  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
})();
