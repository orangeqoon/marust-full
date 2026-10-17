'use strict';

/**
 * サイトのログイン（K3 で host/site-login.js・host/oauth-reauth.js から出した）。
 *  - 状態（none / keys-only / logged-in / expired）・アプリの鍵の保存（client_id・client_secret・戻り先）・ブラウザでの結び直し。
 *  - 読み書きできる秘密は manifest で宣言した 4 つの OAuth（youtube・google・twitch・kick の .oauth）だけ。サイトの設定欄（<site>.config）と cookie・config の有無は核（host/core/site-config.js）。
 *  - ブラウザを開くのは核の口 ctx.external.open（https・manifest の external.hosts だけ）。戻りの待ち受けは自分の中（127.0.0.1 / localhost の一時的な待ち受け）。
 *  - API sites.loginStatus（read・ウィンドウだけ）・sites.setOAuthApp・auth.reauth（write・ウィンドウだけ）。名前・引数・権限は移す前と同じ。値は返さない。
 */

const { createSiteLogin } = require('./lib/login');
const { createOauthReauth, SITES: OAUTH_APP_SITES } = require('./lib/oauth-reauth');

function token(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? value : 'failed';
}

// 金庫の読み書きは宣言した 4 つの名前だけ。名前は書いたとおりに呼ぶ（試験が静的に見張る）
function readOauth(ctx, name) {
  if (name === 'youtube.oauth') return ctx.secrets.get('youtube.oauth');
  if (name === 'google.oauth') return ctx.secrets.get('google.oauth');
  if (name === 'twitch.oauth') return ctx.secrets.get('twitch.oauth');
  if (name === 'kick.oauth') return ctx.secrets.get('kick.oauth');
  return Promise.resolve({ ok: false, error: 'not-declared' });
}

function writeOauth(ctx, name, value) {
  if (name === 'youtube.oauth') return ctx.secrets.set('youtube.oauth', value);
  if (name === 'google.oauth') return ctx.secrets.set('google.oauth', value);
  if (name === 'twitch.oauth') return ctx.secrets.set('twitch.oauth', value);
  if (name === 'kick.oauth') return ctx.secrets.set('kick.oauth', value);
  return Promise.resolve({ ok: false, error: 'not-declared' });
}

module.exports = {
  load(ctx) {
    const login = createSiteLogin({
      secrets: {
        get: (name) => readOauth(ctx, name),
        set: (name, value) => writeOauth(ctx, name, value)
      },
      loginFacts: () => ctx.api.call('sites.loginFacts', {})
    });
    // oauth-reauth は金庫を { get({ name }), set(name, value) } の形で受ける。ここでは宣言した名前だけの ctx.secrets へつなぐ
    const reauth = createOauthReauth({
      secrets: {
        get: (request) => readOauth(ctx, request && request.name),
        set: (name, value) => writeOauth(ctx, name, value)
      },
      openExternal: (url) => ctx.external.open(url)
    });
    ctx.api.register('sites.loginStatus', () => login.status(), {
      access: 'read',
      windowOnly: true,
      description: 'サイトごとのログイン状態（none / keys-only / logged-in / expired）を返す。値は返さない',
      params: {}
    });
    ctx.api.register('sites.setOAuthApp', (params) => login.setOAuthApp(params), {
      access: 'write',
      windowOnly: true,
      description: 'YouTube・Twitch・Kick のログイン用の鍵（client_id・client_secret・戻り先）を金庫に保存する。値は返さない。ウィンドウだけ',
      params: {
        site: { type: 'string', required: true, max: 16, enum: ['youtube', 'twitch', 'kick', 'google'], error: 'unknown-site' },
        clientId: { type: 'string', required: true, max: 2000, typeError: 'bad-client-id', lengthError: 'bad-client-id' },
        clientSecret: { type: 'string', required: true, max: 2000, typeError: 'bad-client-secret', lengthError: 'bad-client-secret' },
        redirectUri: { type: 'string', required: false, max: 200, typeError: 'bad-redirect', lengthError: 'bad-redirect' }
      }
    });
    ctx.api.register('auth.reauth', (params) => reauth.reauth(params.site).then(
      () => ({ ok: true, site: params.site }),
      (err) => {
        const code = token(err && err.code);
        try { ctx.logger.warn('auth.reauth ' + params.site + ' failed: ' + code); } catch (_) { /* 記録できなくても答えは返す */ }
        return { ok: false, error: code };
      }
    ), {
      access: 'write',
      windowOnly: true,
      description: 'YouTube・Twitch・Kickの認証をブラウザで結び直す。値は返さない',
      params: {
        site: { type: 'string', required: true, max: 16, enum: Object.keys(OAUTH_APP_SITES), error: 'unknown-site' }
      }
    });
  },
  start() {},
  stop() {},
  destroy() {},
  health() { return { ok: true }; }
};
