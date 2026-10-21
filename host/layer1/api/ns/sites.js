'use strict';

/**
 * api の名前空間 sites（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'sites.setSend': {
    permission: 'write',
    windowOnly: true,
    description: 'サイトの「送る／送らない」を切り替える。一般向け。ウィンドウだけ。返す形 { ok, id, on }',
    params: {
      id: { type: 'string', required: true, max: 32, emptyError: 'bad-id' },
      send: { type: 'boolean', required: true, typeError: 'bad-value' },
      confirmName: { type: 'string', required: false, max: 80 }
    }
  },
  'sites.setCommentSend': {
    permission: 'write',
    windowOnly: true,
    description: 'サイトへのコメントの書き込み（sink-<サイト>）をオン・オフする。一般向け（R25）。条件: そのサイトの「題名を送る」（site-<サイト>）がオン・コメントの送信の役目がある・ログイン済み。ウィンドウだけ。返す形 { ok, id, on }',
    params: {
      site: { type: 'string', required: true, max: 32, emptyError: 'bad-id' },
      on: { type: 'boolean', required: true, typeError: 'bad-value' },
      confirmName: { type: 'string', required: false, max: 80 }
    }
  },
  'sites.setReceive': {
    permission: 'write',
    windowOnly: true,
    description: 'サイトのコメントを丸ストが直接受け取る／受け取らないを切り替える。対象は manifest に chatSource を持つ chat-*。一般向け。ウィンドウだけ。返す形 { ok, id, on }',
    params: {
      site: { type: 'string', required: true, max: 32, emptyError: 'bad-id' },
      receive: { type: 'boolean', required: true, typeError: 'bad-value' }
    }
  },
  'sites.setAutoSlot': {
    permission: 'write',
    windowOnly: true,
    description: 'サイトの「自動枠取り」を使う／使わないを切り替える。対象は自動枠取りの部品を持つサイト。配信の枠を丸ストが自動で作る機能。ウィンドウだけ。返す形 { ok, id, on }',
    params: {
      site: { type: 'string', required: true, max: 32, error: 'bad-id', typeError: 'bad-id' }, // 自動枠取りの部品（slot-<サイト>）を持つサイトだけが通る（setAutoSlot が一覧で確かめる）
      enabled: { type: 'boolean', required: true, typeError: 'bad-value' }
    }
  },
  'sites.loginFacts': {
    permission: 'read',
    description: 'サイトごとのログイン方式と、金庫に鍵があるかの有無だけを返す。値は返さない',
    params: {}
  },
  'sites.loginStates': {
    permission: 'read',
    description: 'サイトごとのログイン状態だけ { <サイト>: none / keys-only / logged-in / expired / incomplete } を返す。プラグイン（tips など）も呼べる。値は返さない',
    params: {}
  },
  'sites.setConfig': {
    permission: 'write',
    windowOnly: true,
    description: 'サイトの設定欄（manifest の configSchema にある項目だけ）を金庫に保存する。値は返さない。ウィンドウだけ',
    params: {
      site: { type: 'string', required: true, max: 32, typeError: 'unknown-site', lengthError: 'unknown-site' },
      fields: { type: 'object', required: true, error: 'bad-field' }
    }
  }
};

function runs(S) {
  const { callInternal, loginReadAllowed, setAutoSlot, setCommentSend, setReceive, setSend, src } = S;
  return {
    'sites.setSend': function (params, ctx) { return setSend(params, ctx); },
    'sites.setCommentSend': function (params, ctx) { return setCommentSend(params, ctx); },
    'sites.setReceive': function (params, ctx) { return setReceive(params, ctx); },
    'sites.setAutoSlot': function (params, ctx) { return setAutoSlot(params, ctx); },
    'sites.loginFacts': function (_params, ctx) {
      // 窓と内蔵プラグイン（site-login）だけ。ログインの有無は読み取りの端末（ブラウザ・CLI・MCP）には出さない（K3）
      if (!loginReadAllowed(ctx)) return { ok: false, error: 'forbidden' };
      if (!src.siteConfig || typeof src.siteConfig.loginFacts !== 'function') return { ok: false, error: 'unavailable' };
      return src.siteConfig.loginFacts();
    },
    'sites.loginStates': async function (_params, ctx) {
      if (!loginReadAllowed(ctx)) return { ok: false, error: 'forbidden' };
      const got = await callInternal('sites.loginStatus', {});
      if (!got || got.ok !== true || !Array.isArray(got.sites)) return { ok: false, error: 'unavailable' };
      const states = {};
      got.sites.forEach(function (r) { if (r && typeof r.id === 'string' && typeof r.state === 'string') states[r.id] = r.state; });
      return { ok: true, states: states };
    },
    'sites.setConfig': function (params) {
      if (!src.siteConfig || typeof src.siteConfig.setConfig !== 'function') return { ok: false, error: 'unavailable' };
      return src.siteConfig.setConfig(params);
    }
  };
}

module.exports = { specs, runs };
