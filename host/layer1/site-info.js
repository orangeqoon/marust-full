'use strict';

/**
 * manifest.site（サイトの説明。PLAN R4）を、画面に渡してよい形だけに整える。
 * URL は https（送り先は rtmp / rtmps / srt）だけ。文字は長さを切る。値（秘密）は持たない。
 */

function textOrEmpty(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
function httpsOrEmpty(value) {
  return typeof value === 'string' && /^https:\/\/[^\s]{1,300}$/.test(value) ? value : '';
}
// manifest.site（サイトの説明）を、画面に渡してよい形だけに整える。URL は https のものだけ。
function summarizeSite(site, pluginId, mode, secretNames) {
  if (!site || typeof site !== 'object' || Array.isArray(site) || !/^site-/.test(String(pluginId))) return null;
  const login = site.login && typeof site.login === 'object' ? site.login : {};
  return {
    id: textOrEmpty(site.id, 40),
    name: textOrEmpty(site.name, 60),
    tier: site.tier === 'core' ? 'core' : 'extra',
    // 並べる順（小さいほど先。無ければ後ろ）と、自動枠取りの部品を持つか（計画 X・P1。画面はサイトの id を決め打ちしない）
    order: Number.isInteger(site.order) && site.order >= 0 && site.order <= 999 ? site.order : 999,
    autoSlot: site.autoSlot === true,
    ingest: (Array.isArray(site.ingest) ? site.ingest : []).slice(0, 10).map((row) => ({
      label: textOrEmpty(row && row.label, 80),
      url: typeof (row && row.url) === 'string' && /^(rtmps?|srt):\/\/[^\s]{1,300}$/.test(row.url) ? row.url : '',
      helpUrl: httpsOrEmpty(row && row.helpUrl)
    })),
    keyHelpUrl: httpsOrEmpty(site.keyHelpUrl),
    tosUrl: httpsOrEmpty(site.tosUrl),
    // サイトを足す画面の案内に 1 行足す文字（短い文字だけ。例: YouTube の自動停止）
    addHint: textOrEmpty(site.addHint, 200),
    login: {
      type: ['oauth', 'cookie', 'config'].indexOf(login.type) !== -1 ? login.type : 'none',
      needed: login.needed === 'required' ? 'required' : 'optional',
      for: (Array.isArray(login.for) ? login.for : []).slice(0, 8).map((x) => textOrEmpty(x, 40))
    },
    // 金庫の「名前」だけ（値ではない）。ログインの状態を調べる口が、どの名前を見るかに使う。
    secretNames: (Array.isArray(secretNames) ? secretNames : []).filter((n) => typeof n === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(n)).slice(0, 12),
    // ログインの設定欄（金庫の <site>.config に入れる項目）。値は持たない。
    configSchema: (Array.isArray(site.configSchema) ? site.configSchema : []).slice(0, 8)
      .filter((f) => f && typeof f.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(f.name))
      .map((f) => ({ name: f.name, label: textOrEmpty(f.label, 40) || f.name, secret: f.secret === true, required: f.required === true })),
    send: mode === 'live'
  };
}

module.exports = { summarizeSite };
