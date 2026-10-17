'use strict';

/**
 * サイトのログイン状態と、ログインの準備（R5）。
 * 2 段: ① キーだけ（ログインなし）／② ログインする（題名・カテゴリの一斉反映、コメント送信）。
 * 状態は none / keys-only（アプリの鍵はあるが、まだログインしていない）/ logged-in / expired だけ返す。
 * 値（client_secret・トークン・Cookie・パスワード）は、画面にも答えにもログにも出さない。
 * 保存先は金庫。名前は manifest の secrets に宣言した 4 つ（youtube・google・twitch・kick の .oauth）だけ。
 * （K3 で host/site-login.js から出した。サイトの設定欄 <site>.config と、cookie・config の有無は核の host/core/site-config.js）
 */

const { SITES: OAUTH_APPS } = require('./oauth-reauth');

const OAUTH_SITES = Object.freeze(['youtube', 'twitch', 'kick']);
const GOOGLE = 'google';
const GOOGLE_SECRET = 'google.oauth';
const LOOPBACK_RE = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}(\/[^\s]{0,100})?$/;
const MAX_FIELD = 2000;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** トークン一式（金庫の JSON）の状態。値は返さない。 */
function oauthState(parsed, nowMs) {
  const doc = asObject(parsed);
  if (!doc) return 'none';
  // NeonTimer から取り込んだ Twitch は client_secret が無いことがある。トークンがあれば鍵の有無より先に見る。
  if (nonEmpty(doc.refresh_token)) return 'logged-in'; // 期限が切れても自動で更新できる
  if (!nonEmpty(doc.access_token)) return nonEmpty(doc.client_id) && nonEmpty(doc.client_secret) ? 'keys-only' : 'none';
  let expiry = toMs(doc.expiry_date);
  if (expiry == null) expiry = toMs(doc.expires_at);
  if (expiry == null && typeof doc.expires_in === 'number') {
    const since = toMs(doc.obtained_at) != null ? toMs(doc.obtained_at) : toMs(doc.saved_at);
    if (since != null) expiry = since + doc.expires_in * 1000;
  }
  if (expiry != null && expiry < nowMs) return 'expired';
  return 'logged-in';
}

// アプリの鍵を置く金庫の名前（K3: このプラグインが manifest で宣言する固定の 4 つだけ）
const OAUTH_NAMES = Object.freeze({ youtube: 'youtube.oauth', twitch: 'twitch.oauth', kick: 'kick.oauth', google: GOOGLE_SECRET });

function createSiteLogin(options) {
  const opts = options || {};
  // secrets: ctx.secrets と同じ形（get(name) / set(name, value)）。宣言した名前以外は not-declared
  const secrets = opts.secrets || null;
  // loginFacts(): 核の read API sites.loginFacts の答え { ok, sites: [{ id, type, oauthName, present }] }
  const loginFacts = typeof opts.loginFacts === 'function' ? opts.loginFacts : async () => ({ ok: false, error: 'unavailable' });
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  async function readJson(name) {
    if (!secrets || typeof secrets.get !== 'function') return { ok: false, error: 'unavailable' };
    const got = await secrets.get(name);
    if (!got || got.ok !== true || typeof got.value !== 'string') return { ok: false, error: got && got.error ? got.error : 'not-found' };
    try { return { ok: true, doc: JSON.parse(got.value) }; } catch (_) { return { ok: true, doc: null }; }
  }

  async function status() {
    const facts = await loginFacts();
    if (!facts || facts.ok !== true || !Array.isArray(facts.sites)) return { ok: false, error: 'unavailable' };
    const out = [];
    for (const site of facts.sites) {
      if (!site || typeof site.id !== 'string') continue;
      const row = { id: site.id, type: site.type, state: 'none', hasLayer2: site.hasLayer2 === true };
      // 戻り先を省いたときに使う値（秘密ではない。登録する値と 1 文字でも違うと失敗するので画面に出す）
      if (site.type === 'oauth' && OAUTH_APPS[site.id] && OAUTH_APPS[site.id].defaultRedirect) row.defaultRedirect = OAUTH_APPS[site.id].defaultRedirect;
      if (site.type === 'oauth') {
        // 読めるのは宣言した 4 つの名前だけ。それ以外の名前の OAuth は、核が「ある」と言ったときも状態は none のまま
        const name = typeof site.oauthName === 'string' ? site.oauthName : '';
        if (site.present === true && Object.keys(OAUTH_NAMES).some((k) => OAUTH_NAMES[k] === name)) {
          const read = await readJson(name);
          row.state = read.ok ? oauthState(read.doc, now()) : 'none';
        }
      } else if (site.present === true) {
        row.state = 'logged-in';
      }
      out.push(row);
    }
    return { ok: true, sites: out };
  }

  /** アプリの鍵（client_id・client_secret・戻り先）を金庫へ。ほかの項目（トークン）は残す。 */
  async function setOAuthApp(input) {
    const given = asObject(input) || {};
    const id = String(given.site || '');
    if (!Object.prototype.hasOwnProperty.call(OAUTH_NAMES, id)) return { ok: false, error: 'unknown-site' };
    const name = OAUTH_NAMES[id];
    if (!nonEmpty(given.clientId) || given.clientId.length > MAX_FIELD) return { ok: false, error: 'bad-client-id' };
    if (!nonEmpty(given.clientSecret) || given.clientSecret.length > MAX_FIELD) return { ok: false, error: 'bad-client-secret' };
    const redirect = nonEmpty(given.redirectUri) ? given.redirectUri.trim() : '';
    if (redirect && !LOOPBACK_RE.test(redirect)) return { ok: false, error: 'bad-redirect' };
    const read = await readJson(name);
    const base = read.ok && asObject(read.doc) ? Object.assign({}, read.doc) : {};
    base.client_id = given.clientId.trim();
    base.client_secret = given.clientSecret.trim();
    if (redirect) base.redirect_uri = redirect;
    const saved = await secrets.set(name, JSON.stringify(base));
    return saved && saved.ok === true ? { ok: true } : { ok: false, error: saved && saved.error ? saved.error : 'unavailable' };
  }

  return { status, setOAuthApp };
}

module.exports = { createSiteLogin, oauthState, OAUTH_SITES, OAUTH_NAMES };
