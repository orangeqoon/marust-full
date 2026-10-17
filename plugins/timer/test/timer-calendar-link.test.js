'use strict';

const M = require('../../../_marust');

/**
 * タイマー → セッション → イベントバス → gcal → （偽の）Google カレンダー の通し確認。
 * 本物の Google にはつながない（fetch は偽物、秘密も偽物）。
 * NeonTimer の startCalendarSession / stopCalendarSession に当たる流れ:
 *   開始で予定を作る → 停止で終了時刻を確定 → 10 分以内に同じ題名で始め直すと同じ予定を延ばす → 認証が無ければ溜めて、入れたら送る。
 */

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEventBus } = require(M.at('host/core/event-bus'));
const { createSessions } = require(M.at('test/_k3-parts'));
const { createTimer } = require(path.join(__dirname, '..', '..', 'timer'));
const { createGcal } = require(path.join(__dirname, '..', '..', 'gcal'));

const T0 = Date.parse('2026-10-08T01:00:00.000Z');
const MIN = 60 * 1000;

function fakeGoogle() {
  const events = new Map();
  const calls = [];
  let seq = 1;
  function resp(status, body) {
    return { ok: status >= 200 && status < 300, status: status, async json() { return body; } };
  }
  async function fetch(url, init) {
    const method = init && init.method ? init.method : 'GET';
    calls.push({ url: String(url), method: method });
    const u = new URL(String(url));
    if (u.origin !== 'https://www.googleapis.com') throw Object.assign(new Error('blocked'), { code: 'bad-url' });
    const m = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!m) throw Object.assign(new Error('blocked'), { code: 'bad-url' });
    const id = m[2] ? decodeURIComponent(m[2]) : '';
    if (!id && method === 'POST') {
      const body = JSON.parse(init.body);
      const newId = body.id || 'evt-' + seq++;
      events.set(newId, body);
      return resp(200, { id: newId });
    }
    const cur = events.get(id);
    if (!cur) return resp(404, {});
    if (method === 'GET') return resp(200, Object.assign({ id: id }, JSON.parse(JSON.stringify(cur))));
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      if (body.end) cur.end = body.end;
      return resp(200, Object.assign({ id: id }, cur));
    }
    throw Object.assign(new Error('blocked'), { code: 'bad-url' });
  }
  return { fetch: fetch, calls: calls, events: events };
}

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-link-'));
  let now = T0;
  const bus = createEventBus();
  let session = null;
  const store = { snapshot: () => ({ session: session }), setSession: (s) => { session = JSON.parse(JSON.stringify(s)); } };
  const sessions = createSessions({ store: store, bus: bus, recover: false, now: () => new Date(now), setIntervalFn: () => 0, clearIntervalFn: () => {} });
  const google = fakeGoogle();
  let secret = { ok: true, value: JSON.stringify({ access_token: 'access-LINK', refresh_token: 'r', expiry_date: T0 + 3600 * 1000, client_id: 'c', client_secret: 's' }) };
  const gcal = createGcal({
    fetch: google.fetch,
    now: () => new Date(now),
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {}
  });
  const timer = createTimer({ now: () => now, setInterval: () => 1, clearInterval: () => {} });
  const mkCtx = (id, extra) => Object.assign({
    id: id, manifest: { id: id }, dataDir: path.join(dir, id), core: {}, logger() {},
    mode: () => 'live', emit() {}, overlay: { publish: () => ({ ok: true }) }
  }, extra);
  fs.mkdirSync(path.join(dir, 'gcal'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'timer'), { recursive: true });
  gcal.load(mkCtx('gcal', {
    pluginDir: path.join(__dirname, '..', '..', 'gcal'),
    secrets: { get: async () => secret },
    sessions: { view: () => sessions.view() }
  }));
  timer.load(mkCtx('timer', { sessions: sessions }));
  bus.subscribe('session.*', (name, payload, meta) => gcal.onEvent(name, payload, meta));
  return {
    dir: dir, bus: bus, sessions: sessions, google: google, gcal: gcal, timer: timer,
    advance: (ms) => { now += ms; },
    setSecret: (s) => { secret = s; }
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function posts(g) { return g.calls.filter((c) => c.method === 'POST'); }
function patches(g) { return g.calls.filter((c) => c.method === 'PATCH'); }

async function main() {
  // 1) 開始で予定ができ、停止で終了時刻が確定する
  {
    const t = build();
    try {
      t.timer.actions.setDuration({ seconds: 1800 });
      t.timer.actions.start({ title: '作業配信', category: 'Art' });
      await settle();
      assert.strictEqual(posts(t.google).length, 1);
      const [event] = Array.from(t.google.events.values());
      assert.strictEqual(event.summary, '作業配信');
      assert.strictEqual(Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime), 1800 * 1000);
      t.advance(20 * MIN);
      t.timer.actions.stop({});
      await settle();
      const [after] = Array.from(t.google.events.values());
      assert.strictEqual(Date.parse(after.end.dateTime) - Date.parse(after.start.dateTime), 20 * MIN);
      assert.strictEqual(t.gcal.actions.getStatus({}).queueCount, 0);

      // 2) 10 分以内に同じ題名で始め直す → 新しい予定は作らず延ばす
      t.advance(5 * MIN);
      t.timer.actions.start({ title: '作業配信' });
      await settle();
      assert.strictEqual(posts(t.google).length, 1, 'merged, no second create');
      assert.ok(patches(t.google).length >= 2);
      t.advance(10 * MIN);
      t.timer.actions.stop({});
      await settle();
      const [merged] = Array.from(t.google.events.values());
      assert.strictEqual(Date.parse(merged.end.dateTime) - Date.parse(merged.start.dateTime), 35 * MIN);

      // 3) 題名が違えば別の予定
      t.advance(1 * MIN);
      t.timer.actions.start({ title: '別の題名' });
      await settle();
      assert.strictEqual(posts(t.google).length, 2);
      t.timer.actions.stop({});
      await settle();

      // 4) 10 分より空けたら別の予定
      t.advance(30 * MIN);
      t.timer.actions.start({ title: '別の題名' });
      await settle();
      assert.strictEqual(posts(t.google).length, 3);
      t.timer.actions.stop({});
      await settle();
    } finally {
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  }

  // 5) 認証が無い（金庫に google.oauth が無い）→ 通信せずキューに溜まり、状態に失敗が出る。入れて流すと送られる
  {
    const t = build();
    try {
      t.setSecret({ ok: false, error: 'not-found' });
      t.timer.actions.start({ title: '認証なし' });
      await settle();
      const status = t.gcal.actions.getStatus({});
      assert.strictEqual(t.google.calls.length, 0);
      assert.ok(status.queueCount >= 1);
      assert.ok(status.lastError, 'lastError is set');
      t.advance(4 * MIN);
      t.timer.actions.stop({});
      await settle();
      t.setSecret({ ok: true, value: JSON.stringify({ access_token: 'access-LINK', refresh_token: 'r', expiry_date: T0 + 3600 * 1000, client_id: 'c', client_secret: 's' }) });
      await t.gcal.actions.flushQueue({});
      await settle();
      assert.strictEqual(posts(t.google).length, 1);
      assert.strictEqual(t.gcal.actions.getStatus({}).queueCount, 0);
    } finally {
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  }

  // 6) カウントダウンが終わってカウントアップへ移っても、予定は続けて延びる（同じ題名なので結合）
  {
    const t = build();
    try {
      t.timer.actions.setDuration({ seconds: 60 });
      t.timer.actions.start({ title: '時間切れ' });
      await settle();
      t.advance(61 * 1000);
      t.timer.actions.getState({});
      await settle();
      assert.strictEqual(t.timer.actions.getState({}).mode, 'countup');
      assert.strictEqual(posts(t.google).length, 1, "countup continues the same event");
    } finally {
      fs.rmSync(t.dir, { recursive: true, force: true });
    }
  }
  console.log('[marust] timer calendar link tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
