'use strict';

/**
 * Google カレンダー連携のログイン状態（V4。host/site-login.js の oauthState と同じ規則の写し）。
 * 状態は none / keys-only / logged-in / expired だけ。トークンなどの値は返さない。
 * プラグインは host/ を読まないので、純粋な関数をここに持つ。
 */

// 金庫の google.oauth に redirect_uri が無いときの既定の戻り先（host/oauth-reauth.js の google と同じ値。秘密ではない）
const DEFAULT_REDIRECT = 'http://localhost:3000/oauth2callback';

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

function oauthState(parsed, nowMs) {
  const doc = asObject(parsed);
  if (!doc) return 'none';
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

module.exports = { oauthState, DEFAULT_REDIRECT };
