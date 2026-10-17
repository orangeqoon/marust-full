'use strict';

/**
 * ニコ生の枠の作成・開始・延長・終了（NicoAutoCaster の auto_caster.py / nico_common.py の移植）。
 * 丸スト本体（host/・plugins/）は読まない。HTTP は fetch 互換の関数、ログインは getAuth()、時計は now()/sleep() で受ける。
 * ストリームキーは扱わない（アカウント固定。docs/research/niconico-stream-key.md）。
 * 戻りは { ok: true, ... } か { ok: false, code }。code: login-expired / network / csrf / conflict / http-<n> / no-program
 */

const { classifyProgram } = require('./rollover');

const V2 = 'https://live2.nicovideo.jp/unama/api/v2';
const V3 = 'https://live2.nicovideo.jp/unama/api/v3';
const CPP = 'https://public-api.commons.nicovideo.jp/v1/my/cpp/creations/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NicoAutoCaster/1.0';
const HOSTS = new Set(['live2.nicovideo.jp', 'live.nicovideo.jp', 'public-api.commons.nicovideo.jp']);
const LIVE_ID_RE = /^lv[0-9]{1,16}$/;
const MAX_BODY = 2 * 1024 * 1024;
const RESERVED_TAGS = ['クルーズ待ち', '凸待ち', 'VTuber'];
const MAX_EXTENSIONS = 24; // 30 分 x 24 = 12 時間

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function codeOfStatus(status) {
  if (status === 401) return 'login-expired';
  if (status === 409) return 'conflict';
  return 'http-' + status;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function createNiconico(deps) {
  const d = deps || {};
  const fetchImpl = typeof d.fetch === 'function' ? d.fetch : function (url, init) { return globalThis.fetch(url, init); };
  const getAuth = typeof d.getAuth === 'function' ? d.getAuth : async function () { return null; };
  const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
  const sleep = typeof d.sleep === 'function' ? d.sleep : function (ms) { return new Promise((r) => setTimeout(r, ms)); };
  const log = typeof d.log === 'function' ? d.log : function () {};
  const timeoutMs = Number.isInteger(d.timeoutMs) ? d.timeoutMs : 15000;

  let csrfCache = '';

  function allowed(url) {
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    return u.protocol === 'https:' && !u.username && !u.password && HOSTS.has(u.hostname.toLowerCase());
  }

  async function authOrThrow() {
    let auth = null;
    try { auth = await getAuth(); } catch (_) { auth = null; }
    if (!auth || typeof auth.session !== 'string' || !auth.session) throw fail('login-expired');
    return auth;
  }

  function headers(auth, extra) {
    const h = {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-niconico-session': auth.session,
      Cookie: auth.cookie || ('user_session=' + auth.session)
    };
    Object.assign(h, extra || {});
    for (const key of Object.keys(h)) {
      if (h[key] === undefined) delete h[key];
    }
    return h;
  }

  /** 1 回のリクエスト。リダイレクトは追わない。戻り {status, text}。通信できなければ network を投げる。 */
  async function send(method, url, init) {
    if (!allowed(url)) throw fail('network');
    const options = Object.assign({ method: method, redirect: 'manual', cache: 'no-store' }, init || {});
    let timer = null;
    if (typeof AbortController === 'function') {
      const ac = new AbortController();
      options.signal = ac.signal;
      timer = setTimeout(() => { try { ac.abort(); } catch (_) { /* done */ } }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    try {
      let res;
      try { res = await fetchImpl(url, options); } catch (_) { throw fail('network'); }
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

  function json(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function wrap(err) {
    const code = err && typeof err.code === 'string' && /^[a-z0-9-]{1,40}$/.test(err.code) ? err.code : 'network';
    return { ok: false, code: code };
  }

  // ----- 読み取り -----

  async function getLatestProgram() {
    try {
      const auth = await authOrThrow();
      const res = await send('GET', V2 + '/programs/latest', { headers: headers(auth) });
      if (res.status === 200) {
        const body = json(res.text);
        return { ok: true, data: body && body.data ? body.data : null };
      }
      if (res.status === 404) return { ok: true, data: null };
      return { ok: false, code: codeOfStatus(res.status) };
    } catch (err) {
      return wrap(err);
    }
  }

  /** 戻り: { ok, data|null, reachable }。404 は終了、401 はログイン切れ、通信できないときは reachable:false。 */
  async function getProgram(liveId) {
    if (!LIVE_ID_RE.test(String(liveId))) return { ok: false, code: 'no-program', reachable: true };
    try {
      const auth = await authOrThrow();
      const res = await send('GET', V2 + '/programs/' + liveId, { headers: headers(auth) });
      if (res.status === 200) {
        const body = json(res.text);
        return { ok: true, data: body && body.data ? body.data : null, reachable: true };
      }
      if (res.status === 404) return { ok: true, data: null, reachable: true };
      return { ok: false, code: codeOfStatus(res.status), reachable: true };
    } catch (err) {
      const r = wrap(err);
      r.reachable = r.code !== 'network';
      return r;
    }
  }

  /** 戻り: { status: 'ON_AIR'|'TEST'|'ENDED'|'UNKNOWN', data, code? }。取れなかったときは終了とみなさず UNKNOWN。 */
  async function checkStatus(liveId) {
    const got = await getProgram(liveId);
    if (!got.ok) return { status: 'UNKNOWN', data: null, code: got.code };
    if (!got.data) return { status: 'ENDED', data: null };
    return { status: classifyProgram(got.data, now()), data: got.data };
  }

  async function getCsrfToken(liveId) {
    try {
      const auth = await authOrThrow();
      const res = await send('GET', 'https://live.nicovideo.jp/watch/' + liveId, { headers: headers(auth, { 'Content-Type': undefined }) });
      if (res.status === 200) {
        const m = /data-props="([^"]+)"/.exec(res.text);
        if (m) {
          const props = json(decodeEntities(m[1]));
          const token = props && props.site && props.site.relive && props.site.relive.csrfToken;
          if (typeof token === 'string' && token) {
            csrfCache = token;
            return token;
          }
        }
      }
    } catch (_) { /* 前回の値を使う */ }
    return csrfCache;
  }

  // ----- 書き込み（取り消せない操作。呼ぶ側が live のときだけ呼ぶ） -----

  async function putSegment(liveId, state) {
    const token = await getCsrfToken(liveId);
    if (!token) return { ok: false, code: 'csrf' };
    try {
      const auth = await authOrThrow();
      const res = await send('PUT', V3 + '/programs/' + liveId + '/segment?state=' + state, {
        headers: headers(auth, { 'X-Public-Api-Token': token })
      });
      if (res.status === 200 || res.status === 204) return { ok: true };
      if (res.status === 409 && state === 'on_air') return { ok: true, already: true };
      return { ok: false, code: codeOfStatus(res.status) };
    } catch (err) {
      return wrap(err);
    }
  }

  function startOnAir(liveId) {
    return putSegment(liveId, 'on_air');
  }

  async function extend(liveId, minutes) {
    const token = await getCsrfToken(liveId);
    if (!token) return { ok: false, code: 'csrf' };
    try {
      const auth = await authOrThrow();
      const res = await send('POST', V3 + '/programs/' + liveId + '/extension', {
        headers: headers(auth, { 'X-Public-Api-Token': token }),
        body: JSON.stringify({ minutes: String(minutes || 30) })
      });
      if (res.status === 200) return { ok: true };
      return { ok: false, code: codeOfStatus(res.status) };
    } catch (err) {
      return wrap(err);
    }
  }

  /** 上限まで 30 分ずつ延長（最大 24 回。1 回ごとに 1 秒あける）。戻り: { ok:true, extended } */
  async function extendToMax(liveId) {
    let extended = 0;
    for (let i = 0; i < MAX_EXTENSIONS; i += 1) {
      await sleep(1000);
      const r = await extend(liveId, 30);
      if (!r.ok) {
        if (r.code === 'login-expired') return { ok: false, code: r.code, extended: extended };
        break;
      }
      extended += 1;
    }
    return { ok: true, extended: extended };
  }

  /** 作品収入申請。配信中は必ず失敗するので、終了後だけ呼ぶ。 */
  async function registerCreatorIncentive(liveId) {
    try {
      const auth = await authOrThrow();
      const res = await send('POST', CPP + liveId, {
        headers: headers(auth, {
          Origin: 'https://commons.nicovideo.jp',
          Referer: 'https://commons.nicovideo.jp/cpp-applications/' + liveId + '/new?site_id=nicolive',
          'X-Requested-With': 'nicommons',
          'X-Frontend-Id': '41',
          'X-Frontend-Version': '1'
        }),
        body: JSON.stringify({ remarks: null })
      });
      if (res.status === 200 || res.status === 409) return { ok: true, already: res.status === 409 };
      return { ok: false, code: codeOfStatus(res.status) };
    } catch (err) {
      return wrap(err);
    }
  }

  /** 番組を終了し、成功したら作品収入申請も行う（opts.cpp が false なら申請しない）。 */
  async function endProgram(liveId, opts) {
    const r = await putSegment(liveId, 'end');
    if (!r.ok) return r;
    if (opts && opts.cpp === false) return { ok: true, cpp: false };
    const cpp = await registerCreatorIncentive(liveId);
    return { ok: true, cpp: cpp.ok === true };
  }

  /** テンプレートから作成用の本文を作る（create_program の整形部分）。 */
  function buildPayload(template, opts) {
    const o = opts || {};
    const payload = JSON.parse(JSON.stringify(template && typeof template === 'object' ? template : {}));
    const prev = typeof o.prevTitle === 'string' ? o.prevTitle.trim() : '';
    if (prev) payload.title = prev;
    else if (typeof payload.title === 'string' && payload.title.indexOf('{part}') !== -1) {
      payload.title = payload.title.split('{part}').join(String(o.part || 1));
    }
    const cats = Array.isArray(payload.optionalCategories) ? payload.optionalCategories.slice() : [];
    // クルーズ待ち・他番組からの引用許可（Python と同じく既定で入れる）。cruise:false なら入れない。
    if (o.cruise !== false) {
      if (cats.indexOf('クルーズ待ち') === -1) cats.push('クルーズ待ち');
      payload.isQuotable = true;
    }
    payload.optionalCategories = cats;
    const tags = [];
    const list = Array.isArray(payload.tags) ? payload.tags : [];
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      const label = String(t && typeof t === 'object' ? (t.label || '') : t).trim();
      if (RESERVED_TAGS.indexOf(label) !== -1) {
        if (payload.optionalCategories.indexOf(label) === -1) payload.optionalCategories.push(label);
        continue;
      }
      tags.push(t);
    }
    payload.tags = tags;
    // 収益化・作品収入申請の指定（Python と同じく既定で入れる）。monetize:false なら入れない（テンプレートの値のまま）。
    if (o.monetize !== false) {
      payload.isCppAutoRegistration = true;
      payload.isCppLinkable = true;
      payload.isGiftEnabled = true;
      payload.isUadEnabled = true;
    }
    return payload;
  }

  /**
   * 枠を作り、開始し、上限まで延長する（create_program の移植）。
   * opts: { template, part, monetize(既定 true), cruise(既定 true), extendToMax(既定 true), startOnAir(既定 true), testOnly(true なら作るだけ) }
   * 既存枠と重複（409）したときは最新枠を引き継ぐ（Python と同じ）。
   * 戻り: { ok: true, liveId, reused } | { ok: false, code }
   */
  async function createProgram(opts) {
    const o = opts || {};
    let prevTitle = '';
    const latest = await getLatestProgram();
    if (latest.ok && latest.data && typeof latest.data.title === 'string') prevTitle = latest.data.title.trim();
    if (!latest.ok && latest.code === 'login-expired') return { ok: false, code: 'login-expired' };
    const payload = buildPayload(o.template, { prevTitle: prevTitle, part: o.part, monetize: o.monetize, cruise: o.cruise });
    let lastCode = 'network';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const auth = await authOrThrow();
        const res = await send('POST', V2 + '/programs', { headers: headers(auth), body: JSON.stringify(payload) });
        if (res.status === 200 || res.status === 201) {
          const body = json(res.text);
          const liveId = body && body.data && body.data.id;
          if (typeof liveId !== 'string' || !LIVE_ID_RE.test(liveId)) return { ok: false, code: 'no-program' };
          log('info', 'program created');
          if (o.testOnly === true) return { ok: true, liveId: liveId, reused: false };
          if (o.startOnAir !== false) {
            await sleep(2000);
            const started = await startOnAir(liveId);
            if (!started.ok && started.code === 'login-expired') return { ok: false, code: 'login-expired', liveId: liveId };
          }
          if (o.extendToMax !== false) await extendToMax(liveId);
          return { ok: true, liveId: liveId, reused: false };
        }
        if (res.status === 409) {
          const again = await getLatestProgram();
          if (again.ok && again.data && typeof again.data.id === 'string') {
            const st = await checkStatus(again.data.id);
            if (st.status === 'ON_AIR' || st.status === 'TEST') {
              if (st.status === 'TEST' && o.testOnly !== true) await startOnAir(again.data.id);
              if (o.testOnly !== true && o.extendToMax !== false) await extendToMax(again.data.id);
              return { ok: true, liveId: again.data.id, reused: true };
            }
          }
          lastCode = 'conflict';
        } else {
          lastCode = codeOfStatus(res.status);
          if (lastCode === 'login-expired') return { ok: false, code: lastCode };
        }
      } catch (err) {
        lastCode = wrap(err).code;
        if (lastCode === 'login-expired') return { ok: false, code: lastCode };
      }
      await sleep(3000);
    }
    return { ok: false, code: lastCode };
  }

  return {
    getLatestProgram,
    getProgram,
    checkStatus,
    getCsrfToken,
    startOnAir,
    extend,
    extendToMax,
    registerCreatorIncentive,
    endProgram,
    buildPayload,
    createProgram
  };
}

module.exports = { createNiconico, V2, V3, MAX_EXTENSIONS };
