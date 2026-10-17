'use strict';

/**
 * YouTube の OAuth の共通部品（site.js・sink.js が使う）。ネットワークも金庫も持たない（純粋な関数だけ）。
 * 役目（site・sink）の間で直接呼び合わない代わりに、金庫の `youtube.oauth` を唯一の控えにする:
 * refresh の直前に金庫を読み直し、他の役目が先に更新していればそれを使う（refresh token は入れ替わるため）。
 * 値（トークン・シークレット）はログにも戻り値の文にも出さない。
 */

const SECRET = 'youtube.oauth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_SKEW_MS = 60 * 1000;
const MAX_SECRET = 20000;

function clean(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 4096) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function expiryMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1e12) return n * 1000;
  return n;
}

function parseOauth(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_SECRET) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return {
    client_id: clean(parsed.client_id),
    client_secret: clean(parsed.client_secret),
    refresh_token: clean(parsed.refresh_token),
    access_token: clean(parsed.access_token),
    expiry_date: expiryMs(parsed.expiry_date)
  };
}

function configured(parsed) {
  return !!(parsed && parsed.client_id && parsed.client_secret && parsed.refresh_token);
}

function needsRefresh(box, nowMs) {
  if (!box || !box.access_token) return true;
  if (box.expiry_date == null) return false;
  return box.expiry_date <= nowMs + REFRESH_SKEW_MS;
}

function refreshBody(memory) {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', memory.refresh_token);
  body.set('client_id', memory.client_id);
  body.set('client_secret', memory.client_secret);
  return body.toString();
}

// token エンドポイントの答えを memory に反映する。戻り: 新しく見えた値（ログの伏せ字用）。
// 注意: memory.vaultKey（金庫を最後に読んだときの鍵）はここで変えない。書き戻しに失敗して金庫が古いままでも、次に読んだ金庫の
// 鍵が vaultKey と同じなので adopt は memory を取り替えず、新しい token を使い続ける（古い token に戻らない）。他の役目が金庫を
// 書いたときだけ鍵が変わり、adopt が取り替える。
function applyRefresh(memory, json, nowMs) {
  const access = json && clean(json.access_token);
  if (!access) return null;
  const fresh = [access];
  memory.access_token = access;
  const rotated = clean(json.refresh_token);
  if (rotated) {
    memory.refresh_token = rotated;
    fresh.push(rotated);
  }
  const seconds = Number(json.expires_in);
  memory.expiry_date = nowMs + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
  return fresh;
}

function vaultBody(memory) {
  const fields = {};
  const put = (key, value) => {
    if (typeof value === 'string' && value) fields[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
  };
  put('access_token', memory.access_token);
  put('client_id', memory.client_id);
  put('client_secret', memory.client_secret);
  put('expiry_date', memory.expiry_date);
  put('refresh_token', memory.refresh_token);
  const keys = Object.keys(fields).sort();
  const body = {};
  for (let i = 0; i < keys.length; i += 1) body[keys[i]] = fields[keys[i]];
  return JSON.stringify(body);
}

module.exports = {
  SECRET,
  TOKEN_URL,
  REFRESH_SKEW_MS,
  clean,
  expiryMs,
  parseOauth,
  configured,
  needsRefresh,
  refreshBody,
  applyRefresh,
  vaultBody
};
