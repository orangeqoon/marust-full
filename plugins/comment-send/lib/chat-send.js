'use strict';

/**
 * コメント送信の受け口。V2 で host/chat-send.js から移した（ctx.peers 経由）。
 * 各サイトの sink-<site>（起動中で legacy 以外）へ並行に送り、サイトごとの結果を返す。
 * chat.sent にはサイトと成否と、本文の先頭 20 文字だけを載せる。本文全体は出さない。
 * 自分の chat.message には入れない。
 * モード（legacy は送らない・shadow は dryRun）は本体の peers.run が守る。ここは結果の言葉をそろえるだけ。
 */

const TEXT_MAX = 200;
const SITES_MAX = 10;
const PREVIEW_MAX = 20;
const SITE_RE = /^[a-z0-9][a-z0-9-]{0,26}$/;
const ERROR_RE = /^[a-z0-9-]{1,40}$/;
const CHAT_SENT = 'chat.sent';

function createChatSend(options) {
  const opts = options || {};
  const peers = opts.peers || null;
  const bus = opts.bus || null;
  const logger = typeof opts.logger === 'function' ? opts.logger : function () {};

  function note(message) {
    try { logger('info', message); } catch (_) { /* ログが落ちても送信結果は返す */ }
  }

  function safeError(value) {
    if (typeof value === 'string' && ERROR_RE.test(value)) return value;
    return 'failed';
  }

  function preview(text) {
    return text.slice(0, PREVIEW_MAX);
  }

  function findSink(site) {
    let rows = [];
    try { rows = peers && typeof peers.list === 'function' ? (peers.list() || []) : []; } catch (_) { return null; }
    const id = 'sink-' + site;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.id !== id) continue;
      if (!Array.isArray(row.provides) || row.provides.indexOf('chat.sink@1') === -1) continue;
      return row;
    }
    return null;
  }

  function publishSent(site, ok, text) {
    if (!bus || typeof bus.publish !== 'function') return;
    const payload = {
      site: site,
      ok: ok === true,
      text: preview(text)
    };
    try {
      bus.publish(CHAT_SENT, payload);
    } catch (_) { /* イベントが落ちてもサイト別の戻りは返す */ }
  }

  // L9b: ログイン切れ（unauthorized / login-expired）を site.trouble で知らせる。同じサイトは直る（送れる）まで 1 回だけ。
  // そのサイトだけ失敗にして、ほかのサイトへは送る。dryRun（shadow）は実際に送っていないので出さない
  const troubled = new Set();
  function reportTrouble(site, mode, row) {
    if (!bus || typeof bus.publish !== 'function' || mode !== 'live') return;
    if (row.ok === true) { troubled.delete(site); return; }
    if (row.error !== 'unauthorized' && row.error !== 'login-expired') return;
    if (troubled.has(site)) return;
    troubled.add(site);
    try {
      bus.publish('site.trouble', { site: site, job: 'comment', kind: 'login-expired', code: 'login-expired', at: new Date().toISOString() });
    } catch (_) { /* 通知が落ちても結果は返す */ }
  }

  async function deliver(site, text, clientId) {
    const sink = findSink(site);
    if (!sink) {
      publishSent(site, false, text);
      return { site: site, ok: false, error: 'no-sink' };
    }
    if (sink.mode === 'legacy') {
      publishSent(site, false, text);
      return { site: site, ok: false, error: 'legacy' };
    }
    let ran;
    try {
      ran = await peers.run(sink.id, 'sendComment', [
        { text: text, site: site, account: '' },
        { clientId: clientId, dryRun: sink.mode === 'shadow' }
      ]);
    } catch (_) {
      ran = null;
    }
    if (ran && ran.result === 'skip' && ran.message === 'legacy-mode') {
      publishSent(site, false, text);
      return { site: site, ok: false, error: 'legacy' };
    }
    if (ran && ran.result === 'timeout') {
      publishSent(site, false, text);
      return { site: site, ok: false, error: 'timeout' };
    }
    const result = ran && ran.result === 'ok' ? ran.value : null;
    const ok = !!(result && result.ok === true);
    const row = { site: site, ok: ok };
    if (!ok) row.error = safeError(result ? result.error : (ran && ran.result === 'error' ? ran.message : undefined));
    else if (result.dryRun === true) row.dryRun = true;
    publishSent(site, ok, text);
    reportTrouble(site, sink.mode, row);
    return row;
  }

  function check(input) {
    const text = input && input.text;
    const sites = input && input.sites;
    if (typeof text !== 'string' || text.length < 1 || text.indexOf('\0') !== -1) {
      return { ok: false, error: 'bad-text' };
    }
    if (text.length > TEXT_MAX) return { ok: false, error: 'text-length' };
    if (!Array.isArray(sites) || sites.length < 1 || sites.length > SITES_MAX) {
      return { ok: false, error: 'sites-length' };
    }
    const seen = new Set();
    for (let i = 0; i < sites.length; i += 1) {
      const site = sites[i];
      if (typeof site !== 'string' || !SITE_RE.test(site) || seen.has(site)) {
        return { ok: false, error: 'bad-site' };
      }
      seen.add(site);
    }
    return { ok: true, text: text, sites: sites.slice() };
  }

  async function send(input, info) {
    const built = check(input);
    if (!built.ok) return built;
    const clientId = info && typeof info.clientId === 'string' ? info.clientId : '';
    const results = await Promise.all(built.sites.map(function (site) {
      return deliver(site, built.text, clientId);
    }));
    let okCount = 0;
    for (let i = 0; i < results.length; i += 1) {
      if (results[i].ok === true) okCount += 1;
    }
    note('chat send count=' + results.length + ' ok=' + okCount);
    return { ok: true, results: results };
  }

  return { send: send };
}

module.exports = {
  createChatSend,
  TEXT_MAX,
  SITES_MAX,
  PREVIEW_MAX,
  SITE_RE
};
