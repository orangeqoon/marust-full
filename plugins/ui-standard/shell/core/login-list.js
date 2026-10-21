'use strict';
/**
 * 「サイトのログイン」一覧の中身を作る（N3）と、金庫の鍵が変わったときの「入れ直しが要るサイト」（N4）。
 * DOM を使わない部品。入力は sites.loginStatus の答え（行の state / need / how と extension.paired）だけ。
 * 値（Cookie・トークン・鍵・チャンネル ID）はここに来ない。ここは種類の言葉を日本語にするだけ。
 */
(function (root) {
  var CODE_RE = /^[a-z0-9-]{1,40}$/;

  function code(v) { return typeof v === 'string' && CODE_RE.test(v) ? v : ''; }

  /**
   * rows: sites.loginStatus の sites。opts: { names: { <id>: 表示名 }, pasteSites: { <id>: true }（貼る欄があるサイト）, paired: boolean, STR }
   * 戻り: { items: [{ id, name, state, stateText, needText, action }], pairNotice: boolean }
   *   action: 'reauth'（結び直し）| 'sites'（サイトの画面へ）| 'none'（案内の先が無い。文言だけ）
   */
  function buildLoginList(rows, opts) {
    var o = opts || {};
    var S = o.STR;
    var names = o.names || {};
    var paste = o.pasteSites || {};
    var items = [];
    var needsExtension = false;
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || typeof r.id !== 'string') return;
      var state = typeof r.state === 'string' ? r.state : 'none';
      var need = code(r.need);
      var how = code(r.how);
      var item = { id: r.id, name: names[r.id] || r.id, state: state, stateText: S.loginState(state), needText: '', action: 'none' };
      if (need === 'mode' || how === 'toggle') {
        item.needText = S.siteLoginOff;
      } else if (state !== 'logged-in' && need) {
        item.needText = S.siteLoginNeed(need, how);
        if (how === 'extension') needsExtension = true;
        else if (how === 'oauth') item.action = 'reauth';
        else if (how === 'keys') item.action = 'sites';
        else if (how === 'paste' && paste[r.id] === true) item.action = 'sites';
      }
      items.push(item);
    });
    return { items: items, pairNotice: needsExtension && o.paired !== true };
  }

  /** 金庫の鍵が変わったとき。ログイン済みでないサイトの名前（読めなくなった可能性があるもの）。まだ入れていないサイトも含む */
  function reloginSites(rows, names) {
    var nm = names || {};
    var out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || typeof r.id !== 'string' || r.state === 'logged-in') return;
      out.push(nm[r.id] || r.id);
    });
    return out;
  }

  var api = { buildLoginList: buildLoginList, reloginSites: reloginSites };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.buildLoginList = buildLoginList;
  root.reloginSites = reloginSites;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
