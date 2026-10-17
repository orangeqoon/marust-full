'use strict';

/**
 * YouTube の枠の作成・開始・切り替え（auto_switch_final.py の ensure_youtube_broadcast / switch_stream の移植）。
 * 丸スト本体（host/・plugins/）は読まない。HTTP は fetch 互換の関数、トークンは getAccessToken({ refresh })、時計は now()/sleep() で受ける。
 * トークンの更新と保存は呼ぶ側（refresh:true で呼ばれたら更新して新しい値を返す）。lib はトークンを持ち続けない。
 * 戻りは { ok: true, ... } か { ok: false, code }。code: login-expired / quota / conflict / forbidden / invalid-transition / no-stream / network / http-<n>
 * 各操作のクォータ単位数は QUOTA_COST と onCost(units) で公開する（数えるのはプラグイン側）。
 */

const ROOT = 'https://youtube.googleapis.com/youtube/v3/';
const PATHS = new Set(['liveBroadcasts', 'liveBroadcasts/bind', 'liveBroadcasts/transition', 'liveStreams', 'liveChat/messages']);
const PLACEHOLDER_DESCRIPTION = 'OBSからの自動配信開始';
const MAX_BODY = 2 * 1024 * 1024;

// Google 公式の単位数（docs/PLAN-autocast.md §4 R22）。
const QUOTA_COST = Object.freeze({ list: 1, write: 50 });

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function formatScheduled(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fallbackTitleAt(ms, prefix) {
  const d = new Date(ms);
  return prefix + ' ' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function createYoutube(deps) {
  const d = deps || {};
  const fetchImpl = typeof d.fetch === 'function' ? d.fetch : function (url, init) { return globalThis.fetch(url, init); };
  const getAccessToken = typeof d.getAccessToken === 'function' ? d.getAccessToken : async function () { return ''; };
  const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
  const sleep = typeof d.sleep === 'function' ? d.sleep : function (ms) { return new Promise((r) => setTimeout(r, ms)); };
  const log = typeof d.log === 'function' ? d.log : function () {};
  const onCost = typeof d.onCost === 'function' ? d.onCost : function () {};
  const timeoutMs = Number.isInteger(d.timeoutMs) ? d.timeoutMs : 15000;
  const titlePrefix = typeof d.titlePrefix === 'string' && d.titlePrefix ? d.titlePrefix : 'ライブ配信';
  const defaultDescription = typeof d.defaultDescription === 'string' ? d.defaultDescription : '';

  function cost(units) {
    try { onCost(units); } catch (_) { /* 数えそこねても本処理は止めない */ }
  }

  function reasonOf(text) {
    try {
      const body = JSON.parse(text);
      const first = body && body.error && Array.isArray(body.error.errors) ? body.error.errors[0] : null;
      return first && typeof first.reason === 'string' ? first.reason : '';
    } catch (_) {
      return '';
    }
  }

  function codeOfResponse(status, text) {
    const reason = reasonOf(text);
    if (status === 401) return 'login-expired';
    if (status === 403 && /quota/i.test(reason)) return 'quota';
    if (status === 403 && /rateLimit/i.test(reason)) return 'quota';
    if (status === 403) return 'forbidden';
    if (status === 409) return 'conflict';
    if (status === 400 && /transition/i.test(reason)) return 'invalid-transition';
    return 'http-' + status;
  }

  async function once(method, path, query, body, token) {
    const url = new URL(ROOT + path);
    const keys = Object.keys(query || {});
    for (let i = 0; i < keys.length; i += 1) url.searchParams.set(keys[i], String(query[keys[i]]));
    const init = {
      method: method,
      redirect: 'manual',
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    };
    if (body != null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let timer = null;
    if (typeof AbortController === 'function') {
      const ac = new AbortController();
      init.signal = ac.signal;
      timer = setTimeout(() => { try { ac.abort(); } catch (_) { /* done */ } }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    try {
      let res;
      try { res = await fetchImpl(url.toString(), init); } catch (_) { throw fail('network'); }
      const status = res && typeof res.status === 'number' ? res.status : 0;
      if (status === 0 || (status >= 300 && status < 400)) throw fail('network');
      let text = '';
      try { if (typeof res.text === 'function') text = await res.text(); } catch (_) { text = ''; }
      if (typeof text !== 'string' || text.length > MAX_BODY) text = '';
      return { status: status, text: text };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 認証つきの呼び出し。401 なら 1 回だけトークンを更新して再送する。 */
  async function api(method, path, query, body) {
    if (!PATHS.has(path)) throw fail('network');
    cost(method === 'GET' ? QUOTA_COST.list : QUOTA_COST.write);
    let token = '';
    try { token = await getAccessToken({ refresh: false }); } catch (err) { if (err && err.code === 'network') throw fail('network'); token = ''; }
    if (!token) throw fail('login-expired');
    let res = await once(method, path, query, body, token);
    if (res.status === 401) {
      try { token = await getAccessToken({ refresh: true }); } catch (err) { if (err && err.code === 'network') throw fail('network'); token = ''; }
      if (!token) throw fail('login-expired');
      res = await once(method, path, query, body, token);
    }
    if (res.status < 200 || res.status >= 300) throw fail(codeOfResponse(res.status, res.text));
    if (!res.text) return {};
    try { return JSON.parse(res.text); } catch (_) { return {}; }
  }

  function wrap(err) {
    const code = err && typeof err.code === 'string' && /^[a-z0-9-]{1,40}$/.test(err.code) ? err.code : 'network';
    return { ok: false, code: code };
  }

  function items(json) {
    return json && Array.isArray(json.items) ? json.items : [];
  }

  // ----- 読み取り -----

  async function listActive() {
    try {
      const json = await api('GET', 'liveBroadcasts', { part: 'snippet,status,contentDetails', broadcastStatus: 'active' });
      return { ok: true, items: items(json) };
    } catch (err) {
      return wrap(err);
    }
  }

  async function listLatest() {
    try {
      const json = await api('GET', 'liveBroadcasts', { part: 'snippet', mine: 'true', maxResults: 1 });
      return { ok: true, items: items(json) };
    } catch (err) {
      return wrap(err);
    }
  }

  /** 再利用ストリームの id。設定があればそれ、なければ API から（isReusable 優先、なければ先頭）。 */
  async function resolveStreamId(configured) {
    if (typeof configured === 'string' && configured.trim()) return { ok: true, streamId: configured.trim() };
    try {
      const json = await api('GET', 'liveStreams', { part: 'id,snippet,contentDetails,status', mine: 'true', maxResults: 50 });
      const list = items(json);
      for (let i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].contentDetails && list[i].contentDetails.isReusable) return { ok: true, streamId: list[i].id };
      }
      if (list.length && list[0].id) return { ok: true, streamId: list[0].id };
      return { ok: false, code: 'no-stream' };
    } catch (err) {
      return wrap(err);
    }
  }

  // ----- 書き込み（取り消せない操作。呼ぶ側が live のときだけ呼ぶ） -----

  function inheritFrom(snippet) {
    const sn = snippet || {};
    const title = typeof sn.title === 'string' && sn.title.trim() ? sn.title : '';
    const desc = typeof sn.description === 'string' ? sn.description.trim() : '';
    return {
      title: title,
      description: desc && desc !== PLACEHOLDER_DESCRIPTION ? desc : ''
    };
  }

  async function insertBroadcast(opts) {
    const o = opts || {};
    const json = await api('POST', 'liveBroadcasts', { part: 'snippet,contentDetails,status' }, {
      snippet: {
        title: o.title,
        scheduledStartTime: formatScheduled(now() - 60000),
        description: o.description
      },
      status: { privacyStatus: o.privacy || 'public', selfDeclaredMadeForKids: false },
      contentDetails: {
        enableAutoStart: o.autoStart === true,
        enableAutoStop: true,
        enableDvr: true,
        recordFromStart: true,
        monitorStream: { enableMonitorStream: false }
      }
    });
    const id = json && typeof json.id === 'string' ? json.id : '';
    if (!id) throw fail('network');
    const liveChatId = json.snippet && typeof json.snippet.liveChatId === 'string' ? json.snippet.liveChatId : '';
    return { id: id, liveChatId: liveChatId };
  }

  async function bind(broadcastId, streamId) {
    await api('POST', 'liveBroadcasts/bind', { id: broadcastId, part: 'id,contentDetails', streamId: streamId });
  }

  async function transition(broadcastId, status) {
    return api('POST', 'liveBroadcasts/transition', { broadcastStatus: status, id: broadcastId, part: 'id,status' });
  }

  async function sendChat(liveChatId, text) {
    await api('POST', 'liveChat/messages', { part: 'snippet' }, {
      snippet: { liveChatId: liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } }
    });
  }

  async function listUpcoming() {
    try {
      const json = await api('GET', 'liveBroadcasts', { part: 'snippet,status,contentDetails', broadcastStatus: 'upcoming', maxResults: 10 });
      return { ok: true, items: items(json) };
    } catch (err) {
      return wrap(err);
    }
  }

  function chatOf(item) {
    return item && item.snippet && typeof item.snippet.liveChatId === 'string' ? item.snippet.liveChatId : '';
  }

  /** 受信が始まるまで数回 live への遷移を試す。成功したら true。ログイン切れ・クォータは投げ直す。 */
  async function tryGoLive(broadcastId, tries) {
    const n = Number.isInteger(tries) ? tries : 3;
    for (let i = 0; i < n; i += 1) {
      await sleep(i === 0 ? 3000 : 10000);
      try {
        await transition(broadcastId, 'live');
        return true;
      } catch (err) {
        if (err && (err.code === 'login-expired' || err.code === 'quota')) throw err;
        log('warn', 'youtube transition retry');
      }
    }
    return false;
  }

  /**
   * 配信が始まったときの枠の用意（ensure_youtube_broadcast の移植）。
   * 動いている枠（active）があれば作らない。無ければ「これから始まる枠（upcoming）」を見て、
   * 自分のストリームに結ばれたもの（前に作って live にならなかった枠・使う人が手で作った予約枠）があればそれを live にする（作り直さない）。
   * それも無ければ、前の題名・説明を引き継いで作り、bind し、live へ（受信が始まるまで数回）。
   * opts: { streamId(設定値), transitionTries(既定 3), resume: { id }（前回作ったが完了しなかった枠）,
   *         allowCreate(): { ok, reason }（作る直前の安全弁）, onCreated({ id, liveChatId })（insert が成功した瞬間に呼ぶ。数えるため） }
   * 戻り: { ok:true, created:false, broadcastId, liveChatId, live? } | { ok:true, created:true, broadcastId, liveChatId, live:boolean }
   *       | { ok:false, code, newId?, bound? }（枠を作ったあとの失敗は newId を必ず返す）
   */
  async function ensureBroadcast(opts) {
    const o = opts || {};
    let createdId = '';
    let bound = false;
    try {
      const active = await listActive();
      if (!active.ok) return active;
      if (active.items.length) {
        const first = active.items[0];
        const startedAt = first.snippet && first.snippet.actualStartTime ? Date.parse(first.snippet.actualStartTime) : NaN;
        return { ok: true, created: false, broadcastId: first.id || '', liveChatId: chatOf(first), actualStartMs: Number.isFinite(startedAt) ? startedAt : 0 };
      }
      const stream = await resolveStreamId(o.streamId);
      if (!stream.ok) return stream;
      const upcoming = await listUpcoming();
      if (!upcoming.ok) return upcoming;
      const resumeId = o.resume && typeof o.resume.id === 'string' ? o.resume.id : '';
      for (let i = 0; i < upcoming.items.length; i += 1) {
        const item = upcoming.items[i];
        const boundTo = item && item.contentDetails && item.contentDetails.boundStreamId;
        if (!item || !item.id || (boundTo !== stream.streamId && item.id !== resumeId)) continue;
        if (boundTo !== stream.streamId) await bind(item.id, stream.streamId);
        const live = await tryGoLive(item.id, o.transitionTries);
        return { ok: true, created: false, adopted: 'upcoming', broadcastId: item.id, liveChatId: chatOf(item), live: live };
      }
      if (typeof o.allowCreate === 'function') {
        const gate = o.allowCreate();
        if (gate && gate.ok === false) return { ok: false, code: 'blocked', reason: String(gate.reason || '') };
      }
      let title = fallbackTitleAt(now(), titlePrefix);
      let description = defaultDescription;
      const last = await listLatest();
      if (last.ok && last.items.length) {
        const inherited = inheritFrom(last.items[0].snippet);
        if (inherited.title) title = inherited.title;
        if (inherited.description) description = inherited.description;
      } else if (!last.ok && (last.code === 'login-expired' || last.code === 'quota')) {
        return last;
      }
      const made = await insertBroadcast({ title: title, description: description, autoStart: false, privacy: o.privacy });
      createdId = made.id;
      if (typeof o.onCreated === 'function') {
        try { o.onCreated({ id: made.id, liveChatId: made.liveChatId }); } catch (_) { /* 数えそこねても止めない */ }
      }
      log('info', 'youtube broadcast created');
      await bind(made.id, stream.streamId);
      bound = true;
      const live = await tryGoLive(made.id, o.transitionTries);
      return { ok: true, created: true, broadcastId: made.id, liveChatId: made.liveChatId, live: live };
    } catch (err) {
      const out = wrap(err);
      if (createdId) {
        out.newId = createdId;
        out.bound = bound;
      }
      return out;
    }
  }

  /** ensure で作ったがまだ live になっていない枠を live にする（作り直さない）。 */
  async function goLive(broadcastId) {
    try {
      await transition(broadcastId, 'live');
      return { ok: true };
    } catch (err) {
      return wrap(err);
    }
  }

  async function complete(broadcastId) {
    try {
      await transition(broadcastId, 'complete');
      return { ok: true };
    } catch (err) {
      return wrap(err);
    }
  }

  /**
   * 枠の切り替え（switch_stream の移植）。OBS を動かしたまま新枠を用意 → OBS 停止 → 旧枠 complete → OBS 再開。
   * opts: { streamId,
   *         obs: { check()?, isStreaming(), stop(), start() }（いずれも Promise。check/start/stop は { ok, error? } を返す。
   *                isStreaming が投げたら OBS の状態が分からないので何も閉じない。check が ok:false なら何も作らない）,
   *         prepared: { id, liveChatId, bound }（前の試みで用意した新枠。あれば作り直さない）,
   *         onAttempt()（check を通って実際に動き始めるとき）, onCreated({ id, liveChatId })（新枠の insert 成功の瞬間） }
   * 戻り: { ok:true, oldId, newId, liveChatId }
   *       | { ok:false, code, newId?, liveChatId?, bound? }。code: 'obs-control-off'（何もしていない）/ 'obs-stop-failed'（新枠を作ったあと止められない・状態が分からない。旧枠は閉じない）
   *         / 'obs-restart-failed'（致命的。呼ぶ側が知らせる）/ 'obs-restart-skipped'（再開の前に人が止めた。再開しない）
   */
  async function switchStream(opts) {
    const o = opts || {};
    const obs = o.obs;
    if (!obs || typeof obs.stop !== 'function' || typeof obs.start !== 'function') return { ok: false, code: 'no-obs-control' };
    // OBS を止められるかを先に確かめる（枠を作ってから止められないと、新しい枠だけが残る）。
    if (typeof obs.check === 'function') {
      let probe = null;
      try { probe = await obs.check(); } catch (_) { probe = { ok: false }; }
      if (probe && probe.ok === false) return { ok: false, code: 'obs-control-off' };
    }
    if (typeof o.onAttempt === 'function') {
      try { o.onAttempt(); } catch (_) { /* 数えそこねても止めない */ }
    }
    let made = o.prepared && typeof o.prepared.id === 'string' && o.prepared.id ? { id: o.prepared.id, liveChatId: o.prepared.liveChatId || '' } : null;
    let bound = !!(made && o.prepared.bound);
    let oldId = '';
    try {
      const active = await listActive();
      if (!active.ok) return Object.assign({}, active, made ? { newId: made.id, liveChatId: made.liveChatId, bound: bound } : {});
      let title = fallbackTitleAt(now(), titlePrefix);
      let description = defaultDescription;
      let oldChat = '';
      if (active.items.length) {
        const cur = active.items[0];
        oldId = cur.id || '';
        oldChat = chatOf(cur);
        const inherited = inheritFrom(cur.snippet);
        if (inherited.title) title = inherited.title;
        if (inherited.description) description = inherited.description;
      }
      const stream = await resolveStreamId(o.streamId);
      if (!stream.ok) return Object.assign({}, stream, made ? { newId: made.id, liveChatId: made.liveChatId, bound: bound } : {});
      const fresh = !made;
      if (!made) {
        made = await insertBroadcast({ title: title, description: description, autoStart: true });
        if (typeof o.onCreated === 'function') {
          try { o.onCreated({ id: made.id, liveChatId: made.liveChatId }); } catch (_) { /* 数えそこねても止めない */ }
        }
      }
      if (!bound) {
        await bind(made.id, stream.streamId);
        bound = true;
      }
      if (fresh && oldChat) {
        try {
          await sendChat(oldChat, 'まもなく枠を切り替えます。次の配信 → https://youtu.be/' + made.id);
        } catch (err) {
          if (err && (err.code === 'login-expired' || err.code === 'quota')) throw err;
          log('warn', 'youtube chat notice failed');
        }
      }
    } catch (err) {
      const out = wrap(err);
      if (made) {
        out.newId = made.id;
        out.liveChatId = made.liveChatId;
        out.bound = bound;
      }
      return out;
    }
    const prep = { newId: made.id, liveChatId: made.liveChatId, bound: true };
    // ここから全サイトの暗転（Python と同じ約 10 秒）
    try {
      const streaming = typeof obs.isStreaming === 'function' ? await obs.isStreaming() : true;
      if (streaming) {
        const stopped = await obs.stop();
        if (stopped && stopped.ok === false) return Object.assign({ ok: false, code: 'obs-stop-failed' }, prep);
      }
    } catch (_) {
      // OBS の状態が分からない（止めたかも分からない）。旧枠は閉じない。
      log('warn', 'obs stop error');
      return Object.assign({ ok: false, code: 'obs-stop-failed' }, prep);
    }
    await sleep(2000);
    if (oldId) {
      const done = await complete(oldId);
      if (!done.ok) log('warn', 'old broadcast complete failed');
    }
    await sleep(5000);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const started = await obs.start();
        if (started && started.ok === false && started.error === 'human-stopped') {
          return Object.assign({ ok: false, code: 'obs-restart-skipped' }, prep);
        }
      } catch (_) { log('warn', 'obs start error'); }
      await sleep(5000);
      let streaming = false;
      try { streaming = typeof obs.isStreaming === 'function' ? await obs.isStreaming() : true; } catch (_) { streaming = false; }
      if (streaming) return { ok: true, oldId: oldId, newId: made.id, liveChatId: made.liveChatId };
      await sleep(3000);
    }
    return Object.assign({ ok: false, code: 'obs-restart-failed' }, prep);
  }

  return {
    listActive,
    listUpcoming,
    listLatest,
    resolveStreamId,
    ensureBroadcast,
    goLive,
    complete,
    switchStream,
    insertBroadcast: async function (opts) {
      try { return Object.assign({ ok: true }, await insertBroadcast(opts)); } catch (err) { return wrap(err); }
    },
    bind: async function (broadcastId, streamId) {
      try { await bind(broadcastId, streamId); return { ok: true }; } catch (err) { return wrap(err); }
    }
  };
}

module.exports = { createYoutube, QUOTA_COST, PLACEHOLDER_DESCRIPTION };
