'use strict';

/**
 * 機能ごとの解禁とポップアップ（R24）。中級の機能を、使い込んだ人にだけ 1 つずつ紹介する。
 * - 配信が終わった回数（`stream.stopped`）を `ui-settings.json` の completedStreams に数える（画面の localStorage にしない）。
 * - 3 回目の終了から、1 回の終了につき 1 つだけ、次の順で紹介する: ① ニコ生の自動枠取り ② YouTube の自動枠取り ③ 題名の一括変更
 *   ④ コメント送信 ⑤ 一括送信。使っていないサイトの紹介は出さない（判定は「送る」がオンのサイトだけ）。
 * - 返事は 3 つ: 「設定する」（その機能をオンにして紹介を済みにする）・「あとで」（次の終了でまた出す）・「もう出さない」。
 * - 機能のオン・オフ（features）は紹介とは別にいつでも切り替えられる（ホームの「中級機能」）。
 * 外へは何も書かない。秘密は扱わない。値はプラグイン自身の dataDir（lib/store.js）にだけ置く（K3 で ui-settings.json から移した）。
 */

const TIPS = Object.freeze(['slot-niconico', 'slot-youtube', 'bulk-title', 'comment-send', 'bulk-send']);
const START_AFTER = 3;
const MIN_GAP_MS = 30 * 1000; // 同じ終わりを二重に数えない
const MIN_STREAM_MS = 5 * 60 * 1000; // 開始から 5 分未満の終わりは数えない（試し配信・すぐ止めた配信で紹介が早まらないように）

function isTip(id) {
  return TIPS.indexOf(id) !== -1;
}

function addTo(list, id) {
  return list.indexOf(id) === -1 ? list.concat([id]) : list.slice();
}

function join(list) {
  return list.filter(isTip).join(',');
}

function createTips(deps) {
  const d = deps || {};
  const settings = d.uiSettings;
  const nowFn = typeof d.now === 'function' ? d.now : function defaultNow() { return Date.now(); };
  // 同期でも非同期でもよい（プラグインは ctx.api.call で hub.getState を読む）
  const getPlugins = typeof d.getPlugins === 'function' ? d.getPlugins : function () { return []; };
  // サイトごとのログイン状態 { <サイト>: 'logged-in' | ... }。コメントの送信の紹介（④⑤）の判定だけに使う（配信の終わりのときだけ読む）
  const getLogin = typeof d.getLogin === 'function' ? d.getLogin : function () { return {}; };
  const unsubs = [];
  let lastEndAt = 0;
  let startedAt = 0;

  function view() {
    const v = settings && typeof settings.getView === 'function' ? settings.getView() : {};
    return {
      completedStreams: Number.isInteger(v.completedStreams) ? v.completedStreams : 0,
      done: Array.isArray(v.tipsDone) ? v.tipsDone.filter(isTip) : [],
      pending: isTip(v.tipPending) ? v.tipPending : '',
      features: Array.isArray(v.features) ? v.features.filter(isTip) : []
    };
  }

  function save(patch) {
    if (!settings || typeof settings.set !== 'function') return { ok: false, error: 'unavailable' };
    return settings.set(patch);
  }

  // 「使っている」サイト = 「送る」がオン（site-<サイト> が live）の、公開のサイト。
  // コメントを書き込めるサイト = 使っているサイトのうち、コメントの送信の役目（sink-<サイト>）があり、ログイン済みのもの。
  function usage(login, plugins) {
    const rows = Array.isArray(plugins) ? plugins : [];
    const usedSites = [];
    const sinkSites = [];
    const slots = {};
    rows.forEach(function (row) {
      if (!row || typeof row.id !== 'string' || row.status === 'skip' || row.audience !== 'public') return;
      let m = /^site-([a-z0-9-]+)$/.exec(row.id);
      if (m && row.site && row.mode === 'live') usedSites.push(m[1]);
      m = /^sink-([a-z0-9-]+)$/.exec(row.id);
      if (m) sinkSites.push(m[1]);
      m = /^slot-([a-z0-9-]+)$/.exec(row.id);
      if (m) slots[m[1]] = row.mode;
    });
    const writable = usedSites.filter(function (s) { return sinkSites.indexOf(s) !== -1 && login && login[s] === 'logged-in'; });
    return { usedSites: usedSites, writable: writable, slots: slots };
  }

  function eligible(id, u, features) {
    if (features.indexOf(id) !== -1) return false;
    if (id === 'slot-niconico' || id === 'slot-youtube') {
      const site = id.slice(5);
      return u.usedSites.indexOf(site) !== -1 && Object.prototype.hasOwnProperty.call(u.slots, site) && u.slots[site] !== 'live';
    }
    if (id === 'bulk-title') return u.usedSites.length >= 2;
    if (id === 'comment-send') return u.writable.length >= 1;
    if (id === 'bulk-send') return u.writable.length >= 2;
    return false;
  }

  /** 配信が 1 回終わった。数えて、紹介が出せるなら次の 1 つを決める（返事が済んでいない紹介があれば新しくは決めない）。 */
  function onStreamStarted() {
    startedAt = nowFn();
  }

  // 数えたあとで紹介を決める（ログインの状態を読むので非同期。配信が終わったときだけ読む）。
  async function onStreamEnded() {
    const at = nowFn();
    if (lastEndAt && at - lastEndAt < MIN_GAP_MS) return { ok: true, counted: false };
    // 丸ストが開始を見ていない配信（丸ストを起動する前から続いていた配信）は、長さが分からないので数える。
    if (startedAt && at - startedAt < MIN_STREAM_MS) { startedAt = 0; return { ok: true, counted: false, short: true }; }
    startedAt = 0;
    lastEndAt = at;
    const now = view();
    const count = now.completedStreams + 1;
    const patch = { completedStreams: count };
    if (count >= START_AFTER && !now.pending) {
      let login = {};
      try { login = await getLogin(); } catch (_) { login = {}; }
      let plugins = [];
      try { plugins = await getPlugins(); } catch (_) { plugins = []; }
      const u = usage(login, plugins);
      const next = TIPS.filter(function (id) { return now.done.indexOf(id) === -1 && eligible(id, u, now.features); })[0];
      if (next) patch.tipPending = next;
    }
    const wrote = save(patch);
    return wrote && wrote.ok === false ? wrote : { ok: true, counted: true, completedStreams: count, pending: patch.tipPending || now.pending };
  }

  function get() {
    const now = view();
    return {
      completedStreams: now.completedStreams,
      tipPending: now.pending,
      tipsDone: now.done,
      features: now.features,
      tips: TIPS.slice()
    };
  }

  /** 紹介への返事。setup=機能をオンにして済みに / later=次の終了でまた / never=もう出さない。 */
  function respond(id, action) {
    if (!isTip(id)) return { ok: false, error: 'bad-id' };
    if (['setup', 'later', 'never'].indexOf(action) === -1) return { ok: false, error: 'bad-action' };
    const now = view();
    const patch = {};
    if (now.pending === id) patch.tipPending = '';
    if (action === 'setup') {
      patch.features = join(addTo(now.features, id));
      patch.tipsDone = join(addTo(now.done, id));
    } else if (action === 'never') {
      patch.tipsDone = join(addTo(now.done, id));
    }
    const wrote = save(patch);
    if (wrote && wrote.ok === false) return wrote;
    return Object.assign({ ok: true }, get());
  }

  /** 機能のオン・オフ（ホームの「中級機能」）。オンにした機能の紹介は済みにする。 */
  function setFeature(id, on) {
    if (!isTip(id)) return { ok: false, error: 'bad-id' };
    if (typeof on !== 'boolean') return { ok: false, error: 'bad-value' };
    const now = view();
    const features = on ? addTo(now.features, id) : now.features.filter(function (x) { return x !== id; });
    const patch = { features: join(features) };
    if (on) {
      patch.tipsDone = join(addTo(now.done, id));
      if (now.pending === id) patch.tipPending = '';
    }
    const wrote = save(patch);
    if (wrote && wrote.ok === false) return wrote;
    return Object.assign({ ok: true }, get());
  }

  /** ヘルプの「中級機能の紹介を見る」: 紹介の済みをすべて戻し、次の終了からまた出す（機能のオン・オフは変えない）。 */
  function reset() {
    const wrote = save({ tipsDone: '', tipPending: '' });
    if (wrote && wrote.ok === false) return wrote;
    return Object.assign({ ok: true }, get());
  }

  if (d.bus && typeof d.bus.subscribe === 'function') {
    unsubs.push(d.bus.subscribe('stream.started', function () { onStreamStarted(); }));
    unsubs.push(d.bus.subscribe('stream.stopped', function () { onStreamEnded().catch(function () { /* 数えられなくても配信は止めない */ }); }));
  }

  return {
    TIPS: TIPS,
    get: get,
    respond: respond,
    setFeature: setFeature,
    reset: reset,
    onStreamEnded: onStreamEnded,
    onStreamStarted: onStreamStarted,
    stop: function () { while (unsubs.length) { try { unsubs.pop()(); } catch (_) { /* 無視 */ } } }
  };
}

module.exports = { createTips, TIPS, START_AFTER };
