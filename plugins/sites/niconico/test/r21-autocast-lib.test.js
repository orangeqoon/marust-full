'use strict';

/**
 * R21: lib/autocast（rollover / niconico / youtube）。偽の HTTP だけ。本物のニコ・Google につながない。
 */

const assert = require('assert');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const rollover = require('../lib/rollover');
const { createNiconico } = require('../lib/niconico');
const { createYoutube, QUOTA_COST } = require('../../youtube/lib/youtube');

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
  return { status: status, ok: status >= 200 && status < 300, async text() { return text; } };
}

const T0 = Date.parse('2026-10-07T03:00:00.000Z');
const noSleep = async function () {};

// ---------- rollover ----------

test('shouldRollover: 閾値ちょうどで true、設定値で変えられる', () => {
  assert.strictEqual(rollover.shouldRollover({ elapsedSec: 42599 }), false);
  assert.strictEqual(rollover.shouldRollover({ elapsedSec: 42600 }), true);
  assert.strictEqual(rollover.shouldRollover({ elapsedSec: 100, thresholdSec: 60 }), true);
  assert.strictEqual(rollover.shouldRollover({ elapsedSec: 'x' }), false);
});

test('writeGuard: 作成 20 回・切替 4 回・5 分・7000 単位', () => {
  const ok = { units: 0, creates: 0, switches: 0, lastCreateAt: 0 };
  assert.deepStrictEqual(rollover.writeGuard({ kind: 'create', usage: ok, now: T0 }), { ok: true });
  assert.strictEqual(rollover.writeGuard({ kind: 'create', usage: Object.assign({}, ok, { creates: 20 }), now: T0 }).reason, 'create-limit');
  assert.strictEqual(rollover.writeGuard({ kind: 'switch', usage: Object.assign({}, ok, { switches: 4 }), now: T0 }).reason, 'switch-limit');
  assert.strictEqual(rollover.writeGuard({ kind: 'create', usage: Object.assign({}, ok, { lastCreateAt: T0 - 4 * 60000 }), now: T0 }).reason, 'too-soon');
  assert.strictEqual(rollover.writeGuard({ kind: 'create', usage: Object.assign({}, ok, { lastCreateAt: T0 - 6 * 60000 }), now: T0 }).ok, true);
  assert.strictEqual(rollover.writeGuard({ kind: 'switch', usage: Object.assign({}, ok, { units: 7000 }), now: T0 }).reason, 'quota-guard');
});

test('classifyProgram: テスト中に先出しされた未来の onAirSchedule を ON_AIR と取り違えない', () => {
  const future = { onAirSchedule: { beginTime: '2026-10-07T04:00:00+00:00', endTime: '2026-10-07T05:00:00+00:00' }, testSchedule: { a: 1 } };
  assert.strictEqual(rollover.classifyProgram(future, T0), 'TEST');
  const live = { onAirSchedule: { beginTime: '2026-10-07T02:00:00+00:00', endTime: '2026-10-07T05:00:00+00:00' } };
  assert.strictEqual(rollover.classifyProgram(live, T0), 'ON_AIR');
  const past = { onAirSchedule: { beginTime: '2026-10-07T01:00:00+00:00', endTime: '2026-10-07T02:00:00+00:00' } };
  assert.strictEqual(rollover.classifyProgram(past, T0), 'ENDED');
  assert.strictEqual(rollover.classifyProgram({}, T0), 'ENDED');
  assert.strictEqual(rollover.classifyProgram({ onAirSchedule: { beginTime: 'x', endTime: 'y' } }, T0), 'ON_AIR');
});

test('disconnectStep: 切断→待ち→タイムアウト、復帰でリセット、接続不可も停止扱い', () => {
  let r = rollover.disconnectStep({ since: 0 }, false, T0, 300);
  assert.strictEqual(r.event, 'wait-start');
  assert.strictEqual(r.expired, false);
  r = rollover.disconnectStep(r.state, false, T0 + 299000, 300);
  assert.strictEqual(r.expired, false);
  r = rollover.disconnectStep(r.state, null, T0 + 300000, 300);
  assert.strictEqual(r.expired, true);
  assert.strictEqual(r.event, 'timeout');
  r = rollover.disconnectStep({ since: 0 }, null, T0, 300);
  assert.strictEqual(r.event, 'wait-start-unreachable');
  r = rollover.disconnectStep(r.state, true, T0 + 1000, 300);
  assert.strictEqual(r.event, 'recovered');
  assert.deepStrictEqual(r.state, { since: 0 });
});

test('niconicoNextAction: Python の run() の分岐', () => {
  const a = rollover.niconicoNextAction;
  assert.strictEqual(a({ liveId: '', obsActive: true }), 'create');
  assert.strictEqual(a({ liveId: '', obsActive: false }), 'wait');
  assert.strictEqual(a({ liveId: '', obsActive: null }), 'wait');
  assert.strictEqual(a({ liveId: 'lv1', forceEnd: true, obsActive: true }), 'end-forced');
  assert.strictEqual(a({ liveId: 'lv1', disconnectExpired: true, obsActive: false }), 'end-disconnect');
  assert.strictEqual(a({ liveId: 'lv1', status: 'TEST', obsActive: true }), 'start-on-air');
  assert.strictEqual(a({ liveId: 'lv1', status: 'ENDED', obsActive: true, createNextOnNaturalEnd: true }), 'next-after-end');
  assert.strictEqual(a({ liveId: 'lv1', status: 'ENDED', obsActive: true, createNextOnNaturalEnd: false }), 'idle-after-end');
  assert.strictEqual(a({ liveId: 'lv1', status: 'ENDED', obsActive: false }), 'idle-after-end');
  assert.strictEqual(a({ liveId: 'lv1', status: 'UNKNOWN', obsActive: true }), 'keep');
  assert.strictEqual(a({ liveId: 'lv1', status: 'ON_AIR', obsActive: true }), 'keep');
});

// ---------- niconico ----------

const AUTH = { session: 'SENTINEL-SESSION', cookie: 'user_session=SENTINEL-SESSION; other=1' };
const WATCH_HTML = '<div data-props="{&quot;site&quot;:{&quot;relive&quot;:{&quot;csrfToken&quot;:&quot;CSRF-1&quot;}}}"></div>';

function nicoFake(handler) {
  const calls = [];
  const fetchFn = async function (url, init) {
    const u = new URL(url);
    const call = { method: init.method, host: u.hostname, path: u.pathname + u.search, headers: init.headers || {}, body: init.body || '' };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchFn };
}

function nico(handler, extra) {
  const fake = nicoFake(handler);
  const api = createNiconico(Object.assign({
    fetch: fake.fetchFn,
    getAuth: async () => AUTH,
    now: () => T0,
    sleep: noSleep
  }, extra || {}));
  return { api, calls: fake.calls };
}

test('niconico: ログインが無いとき通信せず login-expired', async () => {
  const bag = nico(() => res(200, {}), { getAuth: async () => null });
  assert.deepStrictEqual(await bag.api.getLatestProgram(), { ok: false, code: 'login-expired' });
  const created = await bag.api.createProgram({ template: { title: 'x' } });
  assert.strictEqual(created.ok, false);
  assert.strictEqual(created.code, 'login-expired');
  assert.strictEqual(bag.calls.length, 0);
});

test('niconico: getProgram / checkStatus は 404=終了、401=ログイン切れ、通信失敗=不明（終了とみなさない）', async () => {
  let mode = 404;
  const bag = nico(() => (mode === 'net' ? Promise.reject(new Error('x')) : res(mode, mode === 200 ? { data: { onAirSchedule: { beginTime: '2026-10-07T02:00:00+00:00', endTime: '2026-10-07T09:00:00+00:00' } } } : '')));
  assert.strictEqual((await bag.api.checkStatus('lv1')).status, 'ENDED');
  mode = 401;
  const lost = await bag.api.checkStatus('lv1');
  assert.strictEqual(lost.status, 'UNKNOWN');
  assert.strictEqual(lost.code, 'login-expired');
  mode = 500;
  assert.strictEqual((await bag.api.checkStatus('lv1')).status, 'UNKNOWN');
  mode = 'net';
  assert.strictEqual((await bag.api.checkStatus('lv1')).status, 'UNKNOWN');
  mode = 200;
  assert.strictEqual((await bag.api.checkStatus('lv1')).status, 'ON_AIR');
  assert.strictEqual((await bag.api.getProgram('../evil')).code, 'no-program');
});

test('niconico: buildPayload は題名の引き継ぎ・予約タグの振り替え・収益化の指定を行う', () => {
  const api = createNiconico({});
  const p = api.buildPayload({
    title: '第{part}回', tags: [{ label: '凸待ち' }, { label: 'ふつう' }, 'VTuber'], optionalCategories: ['A']
  }, { prevTitle: ' 前の題名 ', part: 2 });
  assert.strictEqual(p.title, '前の題名');
  assert.deepStrictEqual(p.tags, [{ label: 'ふつう' }]);
  assert.deepStrictEqual(p.optionalCategories, ['A', 'クルーズ待ち', '凸待ち', 'VTuber']);
  assert.strictEqual(p.isQuotable, true);
  assert.strictEqual(p.isCppAutoRegistration, true);
  assert.strictEqual(p.isUadEnabled, true);
  const q = api.buildPayload({ title: '第{part}回' }, { part: 3 });
  assert.strictEqual(q.title, '第3回');
  const src = { title: 'T', tags: [{ label: '凸待ち' }] };
  api.buildPayload(src, {});
  assert.strictEqual(src.tags.length, 1, '元のテンプレートは変えない');
});

test('niconico: createProgram は 作成→ON AIR→延長（上限まで）。キーは扱わない', async () => {
  let extensions = 0;
  const bag = nico((c) => {
    if (c.path === '/unama/api/v2/programs/latest') return res(200, { data: { id: 'lv100', title: '前の題名' } });
    if (c.method === 'POST' && c.path === '/unama/api/v2/programs') return res(201, { data: { id: 'lv200' } });
    if (c.path === '/watch/lv200') return res(200, WATCH_HTML);
    if (c.method === 'PUT' && c.path === '/unama/api/v3/programs/lv200/segment?state=on_air') return res(204);
    if (c.method === 'POST' && c.path === '/unama/api/v3/programs/lv200/extension') {
      extensions += 1;
      return extensions <= 3 ? res(200, { data: { end_time: 1 } }) : res(400, 'limit');
    }
    return res(500);
  });
  const out = await bag.api.createProgram({ template: { title: 'T', category: '描いてみた' } });
  assert.deepStrictEqual(out, { ok: true, liveId: 'lv200', reused: false });
  assert.strictEqual(extensions, 4);
  const post = bag.calls.find((c) => c.method === 'POST' && c.path === '/unama/api/v2/programs');
  const body = JSON.parse(post.body);
  assert.strictEqual(body.title, '前の題名');
  assert.strictEqual(post.headers['X-niconico-session'], 'SENTINEL-SESSION');
  assert.ok(/user_session=SENTINEL-SESSION/.test(post.headers.Cookie));
  const put = bag.calls.find((c) => c.method === 'PUT');
  assert.strictEqual(put.headers['X-Public-Api-Token'], 'CSRF-1');
  assert.ok(bag.calls.every((c) => /\.nicovideo\.jp$/.test(c.host)));
  assert.ok(!bag.calls.some((c) => /rtmp|stream.?key/i.test(c.path)));
});

test('niconico: testOnly は作るだけ（開始も延長もしない）', async () => {
  const bag = nico((c) => {
    if (c.path === '/unama/api/v2/programs/latest') return res(404);
    if (c.method === 'POST' && c.path === '/unama/api/v2/programs') return res(200, { data: { id: 'lv5' } });
    return res(500);
  });
  const out = await bag.api.createProgram({ template: { title: 'T' }, testOnly: true });
  assert.strictEqual(out.liveId, 'lv5');
  assert.strictEqual(bag.calls.filter((c) => c.method !== 'GET').length, 1);
});

test('niconico: 409（既存枠と重複）は最新枠を引き継ぐ。ログイン切れ 401 は再試行せず止まる', async () => {
  const dup = nico((c) => {
    if (c.path === '/unama/api/v2/programs/latest') return res(200, { data: { id: 'lv300', title: 'x' } });
    if (c.method === 'POST' && c.path === '/unama/api/v2/programs') return res(409, '');
    if (c.path === '/unama/api/v2/programs/lv300') return res(200, { data: { onAirSchedule: { beginTime: '2026-10-07T02:00:00+00:00', endTime: '2026-10-07T09:00:00+00:00' } } });
    return res(500);
  });
  assert.deepStrictEqual(await dup.api.createProgram({ template: {} }), { ok: true, liveId: 'lv300', reused: true });
  let posts = 0;
  const lost = nico((c) => {
    if (c.path === '/unama/api/v2/programs/latest') return res(200, { data: null });
    if (c.method === 'POST') { posts += 1; return res(401, ''); }
    return res(500);
  });
  assert.deepStrictEqual(await lost.api.createProgram({ template: {} }), { ok: false, code: 'login-expired' });
  assert.strictEqual(posts, 1);
});

test('niconico: endProgram は終了のあとに作品収入申請。csrf が取れないと書き込まない', async () => {
  const bag = nico((c) => {
    if (c.path === '/watch/lv9') return res(200, WATCH_HTML);
    if (c.method === 'PUT' && c.path === '/unama/api/v3/programs/lv9/segment?state=end') return res(200);
    if (c.host === 'public-api.commons.nicovideo.jp') return res(200, {});
    return res(500);
  });
  assert.deepStrictEqual(await bag.api.endProgram('lv9'), { ok: true, cpp: true });
  assert.deepStrictEqual(bag.calls.map((c) => c.method + ' ' + c.host), [
    'GET live.nicovideo.jp', 'PUT live2.nicovideo.jp', 'POST public-api.commons.nicovideo.jp'
  ]);
  const noCsrf = nico((c) => (c.path.indexOf('/watch/') === 0 ? res(500, '') : res(200, {})));
  assert.deepStrictEqual(await noCsrf.api.endProgram('lv9'), { ok: false, code: 'csrf' });
  assert.strictEqual(noCsrf.calls.filter((c) => c.method !== 'GET').length, 0);
});

// ---------- youtube ----------

function ytFake(handler) {
  const calls = [];
  const fetchFn = async function (url, init) {
    const u = new URL(url);
    const call = {
      method: init.method,
      host: u.hostname,
      path: u.pathname.replace('/youtube/v3/', ''),
      query: Object.fromEntries(u.searchParams.entries()),
      body: init.body ? JSON.parse(init.body) : null,
      auth: (init.headers || {}).Authorization
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchFn };
}

function yt(handler, extra) {
  const fake = ytFake(handler);
  const costs = [];
  const tokens = [];
  const api = createYoutube(Object.assign({
    fetch: fake.fetchFn,
    getAccessToken: async (o) => { tokens.push(o && o.refresh); return o && o.refresh ? 'TOKEN-2' : 'TOKEN-1'; },
    now: () => T0,
    sleep: noSleep,
    onCost: (n) => costs.push(n)
  }, extra || {}));
  return { api, calls: fake.calls, costs, tokens };
}

test('youtube: ensure は動いている枠があれば何も作らない（クォータ 1）', async () => {
  const bag = yt((c) => res(200, { items: [{ id: 'B1', snippet: { liveChatId: 'CHAT1' } }] }));
  const out = await bag.api.ensureBroadcast({});
  assert.deepStrictEqual(out, { ok: true, created: false, broadcastId: 'B1', liveChatId: 'CHAT1', actualStartMs: 0 });
  assert.deepStrictEqual(bag.calls.map((c) => c.method), ['GET']);
  assert.deepStrictEqual(bag.costs, [QUOTA_COST.list]);
});

test('youtube: ensure は枠が無ければ 題名を引き継いで作り→bind→live。秘密は Authorization だけ', async () => {
  let transitions = 0;
  const bag = yt((c) => {
    if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'active') return res(200, { items: [] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S-other' }, { id: 'S-reuse', contentDetails: { isReusable: true } }] });
    if (c.path === 'liveBroadcasts' && c.method === 'GET') return res(200, { items: [{ snippet: { title: '前の題名', description: 'OBSからの自動配信開始' } }] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') return res(200, { id: 'NEW1', snippet: { liveChatId: 'CHAT-N' } });
    if (c.path === 'liveBroadcasts/bind') return res(200, {});
    if (c.path === 'liveBroadcasts/transition') {
      transitions += 1;
      return transitions < 2 ? res(403, { error: { errors: [{ reason: 'errorStreamInactive' }] } }) : res(200, {});
    }
    return res(500);
  }, { defaultDescription: '既定の説明' });
  const out = await bag.api.ensureBroadcast({});
  assert.deepStrictEqual(out, { ok: true, created: true, broadcastId: 'NEW1', liveChatId: 'CHAT-N', live: true });
  const insert = bag.calls.find((c) => c.path === 'liveBroadcasts' && c.method === 'POST');
  assert.strictEqual(insert.body.snippet.title, '前の題名');
  assert.strictEqual(insert.body.snippet.description, '既定の説明', 'プレースホルダの説明は引き継がず既定を使う');
  assert.strictEqual(insert.body.contentDetails.enableAutoStart, false);
  assert.strictEqual(insert.body.status.privacyStatus, 'public');
  assert.strictEqual(insert.body.snippet.scheduledStartTime, '2026-10-07T02:59:00Z');
  const bind = bag.calls.find((c) => c.path === 'liveBroadcasts/bind');
  assert.strictEqual(bind.query.streamId, 'S-reuse');
  assert.strictEqual(transitions, 2);
  assert.ok(bag.calls.every((c) => c.host === 'youtube.googleapis.com' && c.auth === 'Bearer TOKEN-1'));
  const total = bag.costs.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 1 + 1 + 1 + 1 + 50 + 50 + 50 + 50, '一覧 4（active・liveStreams・upcoming・latest）+ insert + bind + transition 2 回');
});

test('youtube: 設定の streamId があれば liveStreams を引かない。transition を使い切っても作り直さず live:false', async () => {
  const bag = yt((c) => {
    if (c.method === 'GET') return res(200, { items: [] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') return res(200, { id: 'NEW2' });
    if (c.path === 'liveBroadcasts/bind') return res(200, {});
    return res(400, { error: { errors: [{ reason: 'invalidTransition' }] } });
  });
  const out = await bag.api.ensureBroadcast({ streamId: ' S-fixed ', transitionTries: 2 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.live, false);
  assert.strictEqual(out.broadcastId, 'NEW2');
  assert.ok(!bag.calls.some((c) => c.path === 'liveStreams'));
  assert.strictEqual(bag.calls.find((c) => c.path === 'liveBroadcasts/bind').query.streamId, 'S-fixed');
  assert.strictEqual((await bag.api.goLive('NEW2')).code, 'invalid-transition');
});

test('youtube: 401 は 1 回だけ更新して再送。それでも 401 なら login-expired、quotaExceeded は quota', async () => {
  let n = 0;
  const refresh = yt((c) => {
    n += 1;
    return n === 1 ? res(401, '') : res(200, { items: [{ id: 'B', snippet: {} }] });
  });
  const ok = await refresh.api.listActive();
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(refresh.tokens, [false, true]);
  assert.strictEqual(refresh.calls[1].auth, 'Bearer TOKEN-2');
  const dead = yt(() => res(401, ''));
  assert.deepStrictEqual(await dead.api.listActive(), { ok: false, code: 'login-expired' });
  assert.strictEqual(dead.calls.length, 2);
  const quota = yt(() => res(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }));
  assert.deepStrictEqual(await quota.api.listActive(), { ok: false, code: 'quota' });
  const none = yt(() => res(200, {}), { getAccessToken: async () => '' });
  assert.deepStrictEqual(await none.api.listActive(), { ok: false, code: 'login-expired' });
  assert.strictEqual(none.calls.length, 0);
  const dup = yt(() => res(409, ''));
  assert.strictEqual((await dup.api.listActive()).code, 'conflict');
});

test('youtube: 通信失敗は network。リダイレクトは追わない', async () => {
  const bag = yt(() => Promise.reject(new Error('down')));
  assert.deepStrictEqual(await bag.api.listActive(), { ok: false, code: 'network' });
  const redirect = yt(() => res(302, ''));
  assert.deepStrictEqual(await redirect.api.listActive(), { ok: false, code: 'network' });
});

test('youtube: switchStream は 新枠の用意→OBS 停止→旧枠 complete→OBS 再開 の順', async () => {
  const order = [];
  const bag = yt((c) => {
    order.push(c.method + ' ' + c.path + (c.query.broadcastStatus ? ':' + c.query.broadcastStatus : ''));
    if (c.method === 'GET' && c.path === 'liveBroadcasts') return res(200, { items: [{ id: 'OLD', snippet: { title: '題名', description: '説明', liveChatId: 'CHAT-OLD' } }] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') return res(200, { id: 'NEW', snippet: { liveChatId: 'CHAT-NEW' } });
    return res(200, {});
  });
  let streaming = true;
  const obs = {
    isStreaming: async () => streaming,
    stop: async () => { order.push('OBS stop'); streaming = false; return { ok: true }; },
    start: async () => { order.push('OBS start'); streaming = true; return { ok: true }; }
  };
  const out = await bag.api.switchStream({ obs: obs });
  assert.deepStrictEqual(out, { ok: true, oldId: 'OLD', newId: 'NEW', liveChatId: 'CHAT-NEW' });
  assert.deepStrictEqual(order, [
    'GET liveBroadcasts:active', 'GET liveStreams', 'POST liveBroadcasts', 'POST liveBroadcasts/bind', 'POST liveChat/messages',
    'OBS stop', 'POST liveBroadcasts/transition:complete', 'OBS start'
  ]);
  const insert = bag.calls.find((c) => c.path === 'liveBroadcasts' && c.method === 'POST');
  assert.strictEqual(insert.body.contentDetails.enableAutoStart, true);
  assert.strictEqual(insert.body.snippet.title, '題名');
  const chat = bag.calls.find((c) => c.path === 'liveChat/messages');
  assert.strictEqual(chat.body.snippet.liveChatId, 'CHAT-OLD');
  assert.strictEqual(bag.calls.find((c) => c.path === 'liveBroadcasts/transition').query.broadcastStatus, 'complete');
});

test('youtube: switchStream は OBS の再開に 3 回失敗したら obs-restart-failed。OBS 操作口が無ければ書き込まない', async () => {
  let starts = 0;
  const bag = yt((c) => {
    if (c.method === 'GET' && c.path === 'liveBroadcasts') return res(200, { items: [] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') return res(200, { id: 'NEW' });
    return res(200, {});
  });
  const obs = { isStreaming: async () => false, stop: async () => ({ ok: true }), start: async () => { starts += 1; return { ok: true }; } };
  const out = await bag.api.switchStream({ obs: obs });
  assert.deepStrictEqual(out, { ok: false, code: 'obs-restart-failed', newId: 'NEW', liveChatId: '', bound: true });
  assert.strictEqual(starts, 3);
  const bare = yt(() => res(200, {}));
  assert.deepStrictEqual(await bare.api.switchStream({}), { ok: false, code: 'no-obs-control' });
  assert.strictEqual(bare.calls.length, 0);
});

test('youtube: allowCreate が止めたら作らない。getAccessToken の通信失敗は network（ログイン切れにしない）', async () => {
  const bag = yt((c) => (c.path === 'liveStreams' ? res(200, { items: [{ id: 'S1' }] }) : (c.method === 'GET' ? res(200, { items: [] }) : res(500))));
  const out = await bag.api.ensureBroadcast({ allowCreate: () => ({ ok: false, reason: 'too-soon' }) });
  assert.deepStrictEqual(out, { ok: false, code: 'blocked', reason: 'too-soon' });
  assert.strictEqual(bag.calls.filter((c) => c.method !== 'GET').length, 0);
  const net = yt(() => res(200, {}), { getAccessToken: async () => { throw Object.assign(new Error('n'), { code: 'network' }); } });
  assert.deepStrictEqual(await net.api.listActive(), { ok: false, code: 'network' });
});

test('youtube: switchStream は OBS を止められるか先に確かめ、止められなければ何も作らない。止めに失敗したら旧枠を閉じない', async () => {
  const bag = yt(() => res(200, { items: [] }));
  const off = { check: async () => ({ ok: false }), isStreaming: async () => true, stop: async () => ({ ok: true }), start: async () => ({ ok: true }) };
  assert.deepStrictEqual(await bag.api.switchStream({ obs: off }), { ok: false, code: 'obs-control-off' });
  assert.strictEqual(bag.calls.length, 0);
  const order = [];
  const stuck = yt((c) => {
    order.push(c.method + ' ' + c.path + (c.query.broadcastStatus ? ':' + c.query.broadcastStatus : ''));
    if (c.method === 'GET' && c.path === 'liveBroadcasts') return res(200, { items: [{ id: 'OLD', snippet: {} }] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') return res(200, { id: 'NEW' });
    return res(200, {});
  });
  const cantStop = { check: async () => ({ ok: true }), isStreaming: async () => true, stop: async () => ({ ok: false }), start: async () => ({ ok: true }) };
  const out = await stuck.api.switchStream({ obs: cantStop });
  assert.deepStrictEqual(out, { ok: false, code: 'obs-stop-failed', newId: 'NEW', liveChatId: '', bound: true });
  assert.ok(!order.some((x) => x.indexOf('transition:complete') !== -1), '止められないのに旧枠を閉じない');
});

test('niconico: monetize:false なら収益化の指定を入れず、endProgram(cpp:false) は作品収入申請をしない', async () => {
  const api = createNiconico({});
  const p = api.buildPayload({ title: 'T' }, { monetize: false });
  assert.strictEqual(p.isGiftEnabled, undefined);
  assert.strictEqual(p.isCppAutoRegistration, undefined);
  const bag = nico((c) => {
    if (c.path === '/watch/lv9') return res(200, WATCH_HTML);
    if (c.method === 'PUT') return res(200);
    return res(500);
  });
  assert.deepStrictEqual(await bag.api.endProgram('lv9', { cpp: false }), { ok: true, cpp: false });
  assert.ok(!bag.calls.some((c) => c.host === 'public-api.commons.nicovideo.jp'));
});

test('youtube: 枠を作ったあとの失敗（bind 失敗）は newId を返し、insert 成功の瞬間に onCreated を呼ぶ', async () => {
  const created = [];
  const bag = yt((c) => {
    if (c.path === 'liveBroadcasts' && c.method === 'GET') return res(200, { items: [] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') return res(200, { id: 'MADE', snippet: { liveChatId: 'CH' } });
    if (c.path === 'liveBroadcasts/bind') return res(500, '');
    return res(500, '');
  });
  const out = await bag.api.ensureBroadcast({ onCreated: (x) => created.push(x) });
  assert.deepStrictEqual(out, { ok: false, code: 'http-500', newId: 'MADE', bound: false });
  assert.deepStrictEqual(created, [{ id: 'MADE', liveChatId: 'CH' }]);
});

test('youtube: 自分のストリームに結ばれた予約枠（upcoming）があれば作らずそれを live にする。resume の枠は結び直す', async () => {
  const bound = yt((c) => {
    if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'active') return res(200, { items: [] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'upcoming') {
      return res(200, { items: [{ id: 'OTHER', contentDetails: { boundStreamId: 'S9' } }, { id: 'HAND', snippet: { liveChatId: 'CH-H' }, contentDetails: { boundStreamId: 'S1' } }] });
    }
    return res(200, {});
  });
  const out = await bound.api.ensureBroadcast({});
  assert.deepStrictEqual(out, { ok: true, created: false, adopted: 'upcoming', broadcastId: 'HAND', liveChatId: 'CH-H', live: true });
  assert.ok(!bound.calls.some((c) => c.method === 'POST' && c.path === 'liveBroadcasts'), '2 枠目を作らない');
  const resumed = yt((c) => {
    if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'active') return res(200, { items: [] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'GET') return res(200, { items: [{ id: 'MINE', contentDetails: {} }] });
    return res(200, {});
  });
  const again = await resumed.api.ensureBroadcast({ resume: { id: 'MINE' } });
  assert.strictEqual(again.broadcastId, 'MINE');
  assert.ok(resumed.calls.some((c) => c.path === 'liveBroadcasts/bind' && c.query.id === 'MINE'));
  assert.ok(!resumed.calls.some((c) => c.method === 'POST' && c.path === 'liveBroadcasts'));
  const failing = yt((c) => {
    if (c.path === 'liveBroadcasts' && c.method === 'GET' && c.query.broadcastStatus === 'active') return res(200, { items: [] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'GET') return res(200, { items: [{ id: 'HAND', contentDetails: { boundStreamId: 'S1' } }] });
    return res(403, { error: { errors: [{ reason: 'errorStreamInactive' }] } });
  });
  const stuck = await failing.api.ensureBroadcast({ transitionTries: 2 });
  assert.strictEqual(stuck.live, false);
  assert.strictEqual(stuck.broadcastId, 'HAND');
  assert.ok(!failing.calls.some((c) => c.method === 'POST' && c.path === 'liveBroadcasts'), 'live にならなくても作り直さない');
});

test('youtube: switchStream は用意済みの新枠を作り直さず、onAttempt を数え、OBS の状態が分からなければ旧枠を閉じない', async () => {
  const order = [];
  const attempts = [];
  const bag = yt((c) => {
    order.push(c.method + ' ' + c.path + (c.query.broadcastStatus ? ':' + c.query.broadcastStatus : ''));
    if (c.method === 'GET' && c.path === 'liveBroadcasts') return res(200, { items: [{ id: 'OLD', snippet: {} }] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    return res(200, {});
  });
  const unknown = { check: async () => ({ ok: true }), isStreaming: async () => { throw new Error('unreachable'); }, stop: async () => ({ ok: true }), start: async () => ({ ok: true }) };
  const out = await bag.api.switchStream({ obs: unknown, prepared: { id: 'PREP', liveChatId: 'CH', bound: true }, onAttempt: () => attempts.push(1) });
  assert.deepStrictEqual(out, { ok: false, code: 'obs-stop-failed', newId: 'PREP', liveChatId: 'CH', bound: true });
  assert.deepStrictEqual(attempts, [1]);
  assert.ok(!order.some((x) => x === 'POST liveBroadcasts' || x === 'POST liveBroadcasts/bind' || x.indexOf('transition') !== -1), '作り直さない・結び直さない・旧枠を閉じない');
  const off = yt(() => res(200, {}));
  await off.api.switchStream({ obs: { check: async () => ({ ok: false }), stop: async () => ({}), start: async () => ({}) }, onAttempt: () => attempts.push(2) });
  assert.deepStrictEqual(attempts, [1], 'check で断られたら試行に数えない');
});

test('youtube: 再開の前に人が止めていた（human-stopped）なら OBS を再開せず obs-restart-skipped', async () => {
  let starts = 0;
  const bag = yt((c) => {
    if (c.method === 'GET' && c.path === 'liveBroadcasts') return res(200, { items: [{ id: 'OLD', snippet: {} }] });
    if (c.path === 'liveStreams') return res(200, { items: [{ id: 'S1' }] });
    if (c.path === 'liveBroadcasts' && c.method === 'POST') return res(200, { id: 'NEW' });
    return res(200, {});
  });
  const obs = {
    check: async () => ({ ok: true }),
    isStreaming: async () => true,
    stop: async () => ({ ok: true }),
    start: async () => { starts += 1; return { ok: false, error: 'human-stopped' }; }
  };
  const out = await bag.api.switchStream({ obs: obs });
  assert.strictEqual(out.code, 'obs-restart-skipped');
  assert.strictEqual(out.newId, 'NEW');
  assert.strictEqual(starts, 1, '再試行しない');
});

test('niconico: 409 で引き継いだ枠・動いている枠も上限まで延長する（opts.extendToMax）', async () => {
  let extensions = 0;
  const bag = nico((c) => {
    if (c.path === '/unama/api/v2/programs/latest') return res(200, { data: { id: 'lv300', title: 'x' } });
    if (c.method === 'POST' && c.path === '/unama/api/v2/programs') return res(409, '');
    if (c.path === '/unama/api/v2/programs/lv300') return res(200, { data: { onAirSchedule: { beginTime: '2026-10-07T02:00:00+00:00', endTime: '2026-10-07T09:00:00+00:00' } } });
    if (c.path === '/watch/lv300') return res(200, WATCH_HTML);
    if (/lv300\/extension$/.test(c.path)) { extensions += 1; return extensions <= 2 ? res(200, {}) : res(400, ''); }
    return res(500);
  });
  const out = await bag.api.createProgram({ template: {} });
  assert.deepStrictEqual(out, { ok: true, liveId: 'lv300', reused: true });
  assert.strictEqual(extensions, 3);
  const p = createNiconico({}).buildPayload({ title: 'T' }, { cruise: false });
  assert.deepStrictEqual(p.optionalCategories, []);
  assert.strictEqual(p.isQuotable, undefined);
});

process.on('beforeExit', () => {
  if (failed) {
    console.error(failed + ' test(s) failed');
    process.exit(1);
  }
});

// rollover.js は youtube と niconico の両方のプラグインに置く（K2。プラグインが本体のファイルを require しないため）。中身が同じであることを見張る。
{
  const fsx = require('fs');
  const pathx = require('path');
  const a = fsx.readFileSync(pathx.join(__dirname, '..', '..', '..', '..', 'plugins', 'sites', 'youtube', 'lib', 'rollover.js'), 'utf8');
  const b = fsx.readFileSync(pathx.join(__dirname, '..', '..', '..', '..', 'plugins', 'sites', 'niconico', 'lib', 'rollover.js'), 'utf8');
  require('assert').strictEqual(a, b, 'plugins/sites/youtube/lib/rollover.js と niconico/lib/rollover.js は同じ中身にしてください');
  console.log('ok rollover.js の 2 つのコピーが同じ中身');
}
