'use strict';

const http = require('http');
const crypto = require('crypto');

const SITES = Object.freeze({
  youtube: {
    secret: 'youtube.oauth',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
    // Google の web タイプの鍵に登録済みの戻り先。取り込んだログインは redirect_uri を運ばないので既定にする。
    defaultRedirect: 'http://localhost:3000/oauth2callback'
  },
  // タイマーの記録を残す Google カレンダー（サイトではない）。YouTube とは別の鍵・別のトークンで持つ。
  google: {
    secret: 'google.oauth',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    defaultRedirect: 'http://localhost:3000/oauth2callback'
  },
  twitch: {
    secret: 'twitch.oauth',
    authorize: 'https://id.twitch.tv/oauth2/authorize',
    token: 'https://id.twitch.tv/oauth2/token',
    // user:read:chat（コメントの受信）は今は使わない。将来の受信のために、キーを作るときだけ含めておく（2026-10-07 ユーザー決定）。
    scope: 'channel:manage:broadcast user:write:chat user:read:chat channel:manage:raids user:read:follows moderator:read:followers',
    // 金庫に redirect_uri が無いときの既定値。
    defaultRedirect: 'http://localhost:3000'
  },
  kick: {
    secret: 'kick.oauth',
    authorize: 'https://id.kick.com/oauth/authorize',
    token: 'https://id.kick.com/oauth/token',
    scope: 'channel:write chat:write user:read channel:read',
    // 取り込んだログインは redirect_uri を運ばないので、金庫に無いときの既定にする。
    defaultRedirect: 'http://localhost:3000/oauth2callback'
  }
});
const SITE_NAMES = Object.freeze({ youtube: 'YouTube', google: 'Google カレンダー', twitch: 'Twitch', kick: 'Kick' });
const MAX_SECRET = 20000;
// 取り消した結び直しの state を覚えておく時間。古いタブの戻りに「何が起きたか」を答えるため。
const CANCELLED_KEEP_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 3 * 60 * 1000;
// 戻り先のホスト。`localhost` はブラウザが IPv6 で開くことがあるので両方 listening する。
const HOSTS_IPV4 = Object.freeze(['127.0.0.1']);
const HOSTS_LOCALHOST = Object.freeze(['127.0.0.1', '::1']);

function fail(error) {
  const err = new Error(error);
  err.code = error;
  return err;
}

function safeText(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= (max || 4096) ? value.trim() : '';
}

function loopbackHosts(hostname) {
  if (hostname === '127.0.0.1') return HOSTS_IPV4;
  if (hostname === 'localhost') return HOSTS_LOCALHOST;
  return null;
}

function redirectInfo(value) {
  let uri;
  try { uri = new URL(value); } catch (_) { return null; }
  const hosts = loopbackHosts(uri.hostname);
  if (!hosts || uri.protocol !== 'http:' || uri.username || uri.password) return null;
  const port = Number(uri.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { uri: uri, host: uri.hostname, hosts: hosts, port: port, path: uri.pathname || '/' };
}

function pkce(randomBytes, createHash) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier: verifier, challenge: challenge };
}

function createOauthReauth(options) {
  const opts = options || {};
  const vault = opts.secrets;
  const httpImpl = opts.http || http;
  const fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : (...args) => globalThis.fetch(...args);
  const openExternal = typeof opts.openExternal === 'function' ? opts.openExternal : () => Promise.resolve();
  const randomBytes = typeof opts.randomBytes === 'function' ? opts.randomBytes : crypto.randomBytes;
  const createHash = typeof opts.createHash === 'function' ? opts.createHash : crypto.createHash;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
  const clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;

  async function readSecret(site) {
    if (!vault || typeof vault.get !== 'function') throw fail('unavailable');
    const row = await vault.get({ name: site.secret });
    if (!row || row.ok !== true || typeof row.value !== 'string' || row.value.length > MAX_SECRET) throw fail('not-configured');
    let parsed;
    try { parsed = JSON.parse(row.value); } catch (_) { throw fail('not-configured'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('not-configured');
    const stored = typeof parsed.redirect_uri === 'string' ? parsed.redirect_uri.trim() : '';
    const redirectUri = stored || site.defaultRedirect || '';
    const redirect = redirectInfo(redirectUri);
    if (!redirect) throw fail('redirect-uri-unsupported');
    if (!safeText(parsed.client_id) || !safeText(parsed.client_secret)) throw fail('not-configured');
    parsed.redirect_uri = redirectUri;
    return { value: parsed, redirect: redirect };
  }

  function callbackResponse(res, status, text) {
    try {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
    } catch (_) { /* browser callback may already be closed */ }
  }

  async function exchange(site, config, code, verifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: config.redirect_uri,
      code_verifier: verifier
    });
    let response;
    try {
      response = await fetchImpl(site.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        redirect: 'manual'
      });
    } catch (_) { throw fail('network'); }
    if (!response || response.status < 200 || response.status >= 300) {
      // サイトが返したエラー名（invalid_client など。決まった形の名前だけ）で原因を分ける。値は読まない
      let name = '';
      try { const err = await response.json(); name = err && typeof err.error === 'string' ? err.error : ''; } catch (_) { name = ''; }
      if (name === 'invalid_client') throw fail('invalid-client');
      if (name === 'invalid_grant') throw fail('invalid-grant');
      if (name === 'redirect_uri_mismatch') throw fail('redirect-mismatch');
      throw fail('unauthorized');
    }
    let json;
    try { json = await response.json(); } catch (_) { throw fail('unauthorized'); }
    const access = safeText(json && json.access_token);
    const refresh = safeText(json && json.refresh_token);
    if (!access || !refresh) throw fail('unauthorized');
    return { access_token: access, refresh_token: refresh, expires_in: Number(json.expires_in) };
  }

  // 同時に待つのは 1 つだけ。前の待ち受け（3 分間開いたまま）が残っていると、別の結び直しのブラウザがそこに当たって 404 になる。
  let cancelActive = null;
  // 取り消した結び直しの state → サイト。同じポートの次の待ち受けに古いタブが戻ってきたとき、ただの Not found にしない。
  const cancelledStates = new Map();
  function rememberCancelled(state, siteName) {
    const at = now();
    for (const [key, row] of cancelledStates) if (at - row.at > CANCELLED_KEEP_MS) cancelledStates.delete(key);
    cancelledStates.set(state, { site: siteName, at: at });
  }

  async function reauth(siteName) {
    const site = SITES[siteName];
    if (!site) throw fail('unknown-site');
    if (cancelActive) { cancelActive(); cancelActive = null; }
    const loaded = await readSecret(site);
    const config = loaded.value;
    const code = pkce(randomBytes, createHash);
    const state = randomBytes(32).toString('hex');
    const auth = new URL(site.authorize);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', config.client_id);
    auth.searchParams.set('redirect_uri', config.redirect_uri);
    auth.searchParams.set('scope', site.scope);
    auth.searchParams.set('state', state);
    auth.searchParams.set('code_challenge', code.challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    if (siteName === 'youtube' || siteName === 'google') {
      auth.searchParams.set('access_type', 'offline');
      auth.searchParams.set('prompt', 'consent');
    }

    return new Promise((resolve, reject) => {
      const hosts = loaded.redirect.hosts;
      const servers = [];
      let settled = false;
      let listening = 0;
      let pending = hosts.length;
      let opened = false;
      let timer;
      function cancel() {
        if (!settled) rememberCancelled(state, siteName);
        finish(fail('cancelled'));
      }
      function closeAll() {
        for (const server of servers) {
          try { server.close(); } catch (_) { /* already closed */ }
        }
      }
      function finish(error, result) {
        if (settled) return;
        settled = true;
        if (timer) clearTimer(timer);
        closeAll();
        if (cancelActive === cancel) cancelActive = null;
        if (error) reject(error); else resolve(result);
      }
      function onListening() {
        listening += 1;
        pending -= 1;
        if (opened) return;
        opened = true;
        Promise.resolve(openExternal(auth.toString())).catch(() => finish(fail('unavailable')));
      }
      function onError(err) {
        if (settled) return;
        pending -= 1;
        // 使用中（別のアプリがいる）なら、ブラウザがそちらに当たって Not found になりうるので続けない。
        if (err && err.code === 'EADDRINUSE') { finish(fail('port-in-use')); return; }
        // IPv6 が無いなど、それ以外の理由で片方が開けないだけなら、開けた方で続ける。
        if (pending > 0 || listening > 0) return;
        const inUse = hosts.length > 1 || (err && err.code === 'EADDRINUSE');
        finish(fail(inUse ? 'port-in-use' : 'unavailable'));
      }
      const handler = async (req, res) => {
        let incoming;
        try { incoming = new URL(req.url, 'http://127.0.0.1'); } catch (_) { callbackResponse(res, 400, '認証に失敗しました。'); return; }
        const old = cancelledStates.get(incoming.searchParams.get('state') || '');
        if (old) {
          const oldName = SITE_NAMES[old.site] || old.site;
          callbackResponse(res, 409, oldName + ' の結び直しは、あとから別のサイト（' + (SITE_NAMES[siteName] || siteName) + '）の結び直しを始めたため取り消されました。\n' +
            '丸ストに戻り、' + oldName + ' の「結び直す」をもう一度押してください。結び直しは 1 つずつ順番に行ってください。');
          return;
        }
        // state は推測できない値なので、合っていればパスの違い（末尾の / など）は問わない。
        const stateMatches = incoming.searchParams.get('state') === state;
        if (!stateMatches && incoming.pathname !== loaded.redirect.path) {
          callbackResponse(res, 404, 'この認証の戻り先は、いま待っていません（Not found）。\n丸ストに戻り、「結び直す」をもう一度押してください。');
          return;
        }
        if (!stateMatches) {
          callbackResponse(res, 400, '認証状態が一致しません。');
          return;
        }
        const oauthError = incoming.searchParams.get('error');
        const authCode = safeText(incoming.searchParams.get('code'), 4096);
        if (oauthError || !authCode) {
          callbackResponse(res, 400, '認証がキャンセルされました。');
          finish(fail('unauthorized'));
          return;
        }
        callbackResponse(res, 200, '認証の応答を受け取りました。丸ストに戻って結果を確かめてください。このタブは閉じて構いません。');
        try {
          const token = await exchange(site, config, authCode, code.verifier);
          const next = Object.assign({}, config, {
            access_token: token.access_token,
            refresh_token: token.refresh_token
          });
          if (Number.isFinite(token.expires_in) && token.expires_in > 0) next.expiry_date = now() + token.expires_in * 1000;
          const saved = await vault.set(site.secret, JSON.stringify(next), 'oauth-reauth');
          if (!saved || saved.ok !== true) throw fail('unavailable');
          finish(null, { ok: true, site: siteName });
        } catch (err) {
          finish(fail(err && err.code ? err.code : 'unauthorized'));
        }
      };
      cancelActive = cancel;
      timer = setTimer(() => finish(fail('timeout')), TIMEOUT_MS);
      for (const host of hosts) {
        const server = httpImpl.createServer(handler);
        servers.push(server);
        server.once('error', onError);
        server.once('listening', onListening);
        try {
          server.listen(loaded.redirect.port, host);
        } catch (_) { finish(fail('port-in-use')); return; }
      }
    });
  }

  return { reauth: reauth };
}

module.exports = { SITES, SITE_NAMES, TIMEOUT_MS, redirectInfo, createOauthReauth };
