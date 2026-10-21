'use strict';

/**
 * Grok で操作（grok-control）。
 * 使う人の AI（Grok Bot）が声や文字で受けた頼み（「タイトルを〇〇にして」「配信開始」「ステータス教えて」）を、
 * 決まりだけで丸ストの API の名前と引数に直す（lib/intents.js）。
 *
 * 守ること:
 * - 実行するのは「読むだけ」の API だけ（manifest の api.calls にある名前。live のときだけ）。
 * - 書き込み（題名を送る）と危ないもの（配信の開始・停止・全部止める）は、このプラグインからは実行しない。
 *   名前と引数を返し、Grok が CLI（node cli/marust.js call …）か MCP で呼ぶ。そこで丸ストの窓の承認と確認の門を通る。
 *   ctx.api.call は承認を通らない（requiresApproval: false）ので、書き込みには使わない。
 * - 危ないものは confirm: true が無いと「使う人に確かめて」と返すだけ。緊急停止は AI に任せない（refused）。
 * - 秘密は扱わない。履歴は ctx.dataDir/history.json に、伏せて・切り詰めて残す。外へは通信しない。
 */

const fs = require('fs');
const path = require('path');
const intents = require('./lib/intents');

const HISTORY_MAX = 50;
const CALL_TIMEOUT_MS = 5000;
const SECRETISH = /key|token|secret|password|passwd|cookie|auth|credential/i;
const RUNNING_STATES = ['live', 'connecting', 'reconnecting', 'streaming', 'starting'];

function modeOf(ctx) {
  try { return ctx && typeof ctx.mode === 'function' ? ctx.mode() : 'legacy'; } catch (_) { return 'legacy'; }
}

function redactText(ctx, text) {
  const s = String(text == null ? '' : text);
  try { return ctx && typeof ctx.redact === 'function' ? String(ctx.redact(s)) : s; } catch (_) { return s; }
}

/** 答えを画面・Grok へ返せる形にする。秘密らしい名前の欄は落とす・深さと長さを切る・文字は伏せる。 */
function sanitize(ctx, value, depth) {
  const d = depth || 0;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(ctx, value).slice(0, 300);
  if (d >= 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(ctx, v, d + 1));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, 40).forEach((k) => {
      if (SECRETISH.test(k)) return;
      out[k] = sanitize(ctx, value[k], d + 1);
    });
    return out;
  }
  return undefined;
}

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), ms); })
  ]);
}

function create() {
  /** @type {any} */
  let ctx = null;
  let history = [];
  let lastOk = null;
  let lastError = '';

  function historyFile() {
    if (!ctx || !ctx.dataDir) return '';
    return path.join(ctx.dataDir, 'history.json');
  }

  function loadHistory() {
    history = [];
    const file = historyFile();
    if (!file) return;
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(rows)) history = rows.filter((r) => r && typeof r === 'object').slice(-HISTORY_MAX);
    } catch (_) { history = []; }
  }

  function saveHistory() {
    const file = historyFile();
    if (!file) return;
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(history), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      if (ctx && typeof ctx.logger === 'function') ctx.logger('warn', 'history-write-failed ' + (err && err.code ? err.code : 'error'));
    }
  }

  function remember(text, res) {
    history.push({
      at: new Date().toISOString(),
      text: redactText(ctx, text).slice(0, 200),
      intent: res.intent || 'unknown',
      kind: res.kind || 'unknown',
      method: res.method || '',
      executed: res.executed === true,
      ok: res.ok === true,
      error: res.error ? String(res.error).slice(0, 60) : ''
    });
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    saveHistory();
  }

  function canCall(method) {
    const calls = ctx && ctx.manifest && ctx.manifest.api && Array.isArray(ctx.manifest.api.calls) ? ctx.manifest.api.calls : [];
    return !!(ctx && ctx.api && typeof ctx.api.call === 'function' && calls.indexOf(method) !== -1);
  }

  async function callRead(method, params) {
    if (!canCall(method)) return { ok: false, error: 'not-declared' };
    try {
      return await withTimeout(ctx.api.call(method, params || {}), CALL_TIMEOUT_MS);
    } catch (_) {
      return { ok: false, error: 'failed' };
    }
  }

  // 配信先の id を、言われたサイトか今の状態から選ぶ（読むだけの destination.list）。選べなければ空のまま返す
  async function fillDestinations(parsed) {
    const got = await callRead('destination.list', {});
    if (!got || got.ok !== true || !Array.isArray(got.destinations)) return { ids: [], why: 'destinations-unknown' };
    const rows = got.destinations.filter((d) => d && typeof d.id === 'string' && d.id);
    let pick = rows;
    if (parsed.sites && parsed.sites.length) pick = rows.filter((d) => parsed.sites.indexOf(String(d.site || '').toLowerCase()) !== -1);
    if (parsed.want === 'running') {
      const running = pick.filter((d) => d.actual && (d.actual.siteLive === true || RUNNING_STATES.indexOf(String(d.actual.engineState || '')) !== -1));
      pick = running.length ? running : pick.filter((d) => d.enabled === true);
    } else {
      pick = pick.filter((d) => d.enabled === true);
    }
    const ids = pick.map((d) => d.id).slice(0, 20);
    return { ids: ids, why: ids.length ? '' : 'no-matching-destination' };
  }

  function nextStep(method, params, intentId) {
    return {
      method: method,
      params: params,
      cliArgs: intents.cliArgsFor(intentId, params),
      mcpTool: 'marust_' + method.replace(/\./g, '_')
    };
  }

  /**
   * command { text, confirm?, dryRun? }
   * 戻り: { ok, intent, kind, method, params, executed, result?, next?, needsConfirm?, note?, error? }
   */
  async function command(params) {
    const p = params && typeof params === 'object' ? params : {};
    if (typeof p.text !== 'string' || !p.text.trim()) return { ok: false, error: 'empty-text' };
    if (p.text.length > 500) return { ok: false, error: 'text-too-long' };
    const confirm = p.confirm === true;
    const mode = modeOf(ctx);
    const dryRun = p.dryRun === true || mode !== 'live';
    const parsed = intents.parse(p.text);
    let res;

    if (!parsed.ok) {
      res = { ok: false, intent: parsed.intent || 'unknown', kind: parsed.kind || 'unknown', error: parsed.error, executed: false, hint: 'intents で使える言い方を見てください' };
    } else if (parsed.kind === 'help') {
      res = { ok: true, intent: 'help', kind: 'help', method: '', executed: false, intents: intents.list() };
    } else if (parsed.kind === 'refused') {
      res = { ok: false, intent: parsed.intent, kind: 'refused', method: parsed.method, executed: false, error: 'not-for-ai', note: parsed.note };
    } else if (parsed.kind === 'read') {
      res = { ok: true, intent: parsed.intent, kind: 'read', method: parsed.method, params: parsed.params, executed: false };
      if (dryRun || !canCall(parsed.method)) {
        res.next = nextStep(parsed.method, parsed.params, parsed.intent);
        if (!dryRun) res.note = 'このプラグインからは呼べない名前です。next の通りに呼んでください';
      } else {
        const main = await callRead(parsed.method, parsed.params);
        const out = { [parsed.method]: sanitize(ctx, main) };
        for (const extra of parsed.also || []) out[extra] = sanitize(ctx, await callRead(extra, {}));
        res.executed = true;
        res.ok = !!(main && main.ok !== false);
        res.result = out;
        if (!res.ok) res.error = main && typeof main.error === 'string' ? main.error : 'failed';
      }
    } else if (parsed.kind === 'resolve' || parsed.kind === 'write') {
      res = {
        ok: true, intent: parsed.intent, kind: parsed.kind, method: parsed.method, params: parsed.params, executed: false,
        next: nextStep(parsed.method, parsed.params, parsed.intent),
        note: parsed.kind === 'write' ? '書き込みはこのプラグインでは実行しません。next の通りに CLI か MCP で呼ぶと、丸ストの窓の承認を通ります' : 'next の通りに呼んでください'
      };
    } else {
      // danger
      const params2 = Object.assign({}, parsed.params);
      let why = '';
      if (parsed.needs === 'destinationIds' && !dryRun) {
        const filled = await fillDestinations(parsed);
        params2.destinationIds = filled.ids;
        why = filled.why;
      } else if (parsed.needs === 'destinationIds') {
        why = 'fill-destination-ids';
      }
      res = { ok: true, intent: parsed.intent, kind: 'danger', method: parsed.method, params: params2, sites: parsed.sites, executed: false };
      if (!confirm) {
        res.needsConfirm = true;
        res.note = '配信に関わる操作です。使う人に確かめてから、confirm: true を付けてもう一度送ってください';
      } else {
        res.next = nextStep(parsed.method, params2, parsed.intent);
        res.note = 'このプラグインは配信を動かしません。next の通りに呼ぶと、丸ストの窓の承認と確認を通ります';
      }
      if (why) res.warning = why;
    }
    res.mode = mode;
    res.dryRun = dryRun;
    lastOk = res.ok === true;
    lastError = res.ok ? '' : String(res.error || '');
    remember(p.text, res);
    return res;
  }

  function load(passed) {
    ctx = passed || null;
    loadHistory();
  }
  function start() {}
  function stop() {}
  function destroy() { ctx = null; history = []; lastOk = null; lastError = ''; }
  function health() { return { ok: true, detail: 'grok-control' }; }

  function getStatus() {
    return {
      ok: true,
      mode: modeOf(ctx),
      lastOk: lastOk,
      lastError: /^[a-z0-9-]{1,40}$/.test(lastError) ? lastError : '',
      canRead: !!(ctx && ctx.api && typeof ctx.api.call === 'function'),
      historyCount: history.length
    };
  }

  function listIntents() { return { ok: true, intents: intents.list() }; }

  function getHistory(params) {
    const n = params && typeof params.n === 'number' && params.n > 0 ? Math.min(Math.floor(params.n), HISTORY_MAX) : 20;
    return { ok: true, history: history.slice(-n).reverse() };
  }

  function clearHistory() {
    history = [];
    saveHistory();
    return { ok: true };
  }

  function ping() { return { ok: true, pong: true, mode: modeOf(ctx) }; }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    getStatus: getStatus,
    command: command,
    actions: {
      getStatus: getStatus,
      command: command,
      intents: listIntents,
      history: getHistory,
      clearHistory: clearHistory,
      ping: ping
    }
  };
}

const singleton = create();
singleton.create = create;
module.exports = singleton;
