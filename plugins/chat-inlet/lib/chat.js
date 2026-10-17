'use strict';

/**
 * コメント 1 件の受け口（K3 で host/chat.js から出した。chat.message を出せるのはプラグイン chat-inlet だけ）。
 * 検証してから、直近 2000 件の site+id で重複を除き、直近 500 件を残して chat.message を出す。
 * 1 秒の受付は 200 件まで。超える分は、その呼び出しの中で古い方から捨てて出さない。
 * warn は捨てた件数だけ（本文は出さない）。すでに出したイベントは取り消さない。
 */

// 本体のファイルは読まない（K3）。イベント名は opts.events（ctx.events.NAMES）、ログは opts.logger。
function defaultLogger() {}

const TEXT_MAX = 500;
const NAME_MAX = 100;
const ID_MAX = 120;
const SITE_MAX = 40;
const ACCOUNT_MAX = 80;
const USER_MAX = 80;
const BADGE_MAX = 40;
const BADGES_MAX = 20;
const CURRENCY_MAX = 12;
const RECENT_MAX = 500;
const DEDUPE_MAX = 2000;
const RATE_MAX = 200;
const RATE_WINDOW_MS = 1000;
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function createChat(options) {
  const opts = options || {};
  const EVENTS = opts.events;
  if (!EVENTS || typeof EVENTS.CHAT_MESSAGE !== 'string') throw new Error('chat requires events');
  const bus = opts.bus || null;
  const logger = typeof opts.logger === 'function' ? opts.logger : defaultLogger;
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  // 入り口の取り決めの安全装置（electron-main が渡す）。
  //  isPluginSource(source): その名前が読み込まれたプラグイン id か（外の呼び出し元が名乗るのを断る）
  //  isOwnerLive(source): 入り口を取っているプラグインが今も live か（落ちて取り残された取り決めを無効にする）
  const isPluginSource = typeof opts.isPluginSource === 'function' ? opts.isPluginSource : function () { return false; };
  const isOwnerLive = typeof opts.isOwnerLive === 'function' ? opts.isOwnerLive : function () { return true; };
  const kept = [];
  const dedupeOrder = [];
  const dedupeSet = new Set();
  const acceptedAt = [];
  // サイトごとの「入り口」の取り決め（R19）。1 つのサイトのコメントの入り口は 1 つだけ。
  // プラグインがそのサイトを受け取っている間（claim）は、ほかの入り口（わんコメの橋など）から来た同じサイトのコメントを取り込まない。
  const claims = new Map();
  const skipped = new Map();
  const lastSeen = new Map(); // site → { source, at }（最後に取り込んだコメントの入り口と時刻。つながっているかの表示用）

  function seenKey(site, id) {
    return String(site.length) + ':' + site + '\0' + id;
  }

  function copyMessage(message) {
    const copy = {
      id: message.id,
      site: message.site,
      account: message.account,
      userId: message.userId,
      name: message.name,
      text: message.text,
      badges: message.badges.slice(),
      isOwner: message.isOwner,
      hasGift: message.hasGift,
      at: message.at,
      source: message.source
    };
    if (Object.prototype.hasOwnProperty.call(message, 'amount')) copy.amount = message.amount;
    if (Object.prototype.hasOwnProperty.call(message, 'currency')) copy.currency = message.currency;
    return copy;
  }

  function remember(key) {
    dedupeSet.add(key);
    dedupeOrder.push(key);
    while (dedupeOrder.length > DEDUPE_MAX) {
      dedupeSet.delete(dedupeOrder.shift());
    }
  }

  function roomAt(at) {
    const cutoff = at - RATE_WINDOW_MS;
    while (acceptedAt.length && acceptedAt[0] <= cutoff) acceptedAt.shift();
    return RATE_MAX - acceptedAt.length;
  }

  // サイト名の大文字・小文字は区別しない（わんコメの橋は service をそのまま送るため）。取り込む値は変えない。
  function siteKey(site) {
    return String(site == null ? '' : site).toLowerCase();
  }

  function blockedByClaim(site, source) {
    const key = siteKey(site);
    const owner = claims.get(key);
    if (!owner || owner === source) return false;
    let live = true;
    try { live = isOwnerLive(owner) !== false; } catch (_) { live = true; }
    if (!live) return false; // 持ち主が live でなくなっている（落ちた・戻された）。取り決めは無効
    skipped.set(key, (skipped.get(key) || 0) + 1);
    return true;
  }

  function claim(site, source) {
    if (typeof site !== 'string' || !site || site.length > SITE_MAX) return { ok: false, error: 'bad-site' };
    if (typeof source !== 'string' || !SOURCE_RE.test(source)) return { ok: false, error: 'bad-source' };
    const key = siteKey(site);
    const owner = claims.get(key);
    if (owner && owner !== source) return { ok: false, error: 'claimed', owner: owner };
    claims.set(key, source);
    return { ok: true };
  }

  function release(site, source) {
    const key = siteKey(site);
    if (claims.get(key) === source) claims.delete(key);
    return { ok: true };
  }

  /** そのプラグインが取っている入り口を全部手放す（プラグインの停止・再読み込みのとき、ホストが呼ぶ）。 */
  function releaseAll(source) {
    claims.forEach(function (owner, key) { if (owner === source) claims.delete(key); });
    return { ok: true };
  }

  function reservedSource(source) {
    if (typeof source !== 'string' || !source) return false;
    let plugin = false;
    try { plugin = isPluginSource(source) === true; } catch (_) { plugin = false; }
    if (plugin) return true;
    let held = false;
    claims.forEach(function (owner) { if (owner === source) held = true; });
    return held;
  }

  /** 画面の表用: サイトごとの今の入り口（claim しているプラグイン id）と、取り込まなかった件数。 */
  function inlets() {
    const sites = new Set();
    claims.forEach(function (_owner, site) { sites.add(site); });
    skipped.forEach(function (_count, site) { sites.add(site); });
    lastSeen.forEach(function (_row, site) { sites.add(site); });
    const out = {};
    sites.forEach(function (site) {
      const seen = lastSeen.get(site);
      out[site] = {
        owner: claims.get(siteKey(site)) || '',
        skipped: skipped.get(siteKey(site)) || 0,
        lastSource: seen ? seen.source : '',
        lastAt: seen ? seen.at : ''
      };
    });
    return out;
  }

  function store(message) {
    lastSeen.set(message.site, { source: message.source, at: message.at });
    kept.push(message);
    while (kept.length > RECENT_MAX) kept.shift();
    if (bus && typeof bus.publish === 'function') {
      // 出どころ（source）は ctx.bus が rec.id（chat-inlet）で付ける。コメントの入り口の名前は本文の source にある
      bus.publish(EVENTS.CHAT_MESSAGE, copyMessage(message), {});
    }
  }

  function flag(input, name, error) {
    if (!Object.prototype.hasOwnProperty.call(input, name) || input[name] == null) {
      return { ok: true, value: false };
    }
    if (typeof input[name] !== 'boolean') return { ok: false, error: error };
    return { ok: true, value: input[name] };
  }

  function normalizeAt(value, atMs) {
    if (value == null) return new Date(atMs).toISOString();
    if (typeof value !== 'string' || value.length > 40 || !ISO_RE.test(value)) return '';
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return '';
    return new Date(parsed).toISOString();
  }

  function normalize(input, source, atMs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'bad-message' };
    if (typeof source !== 'string' || !SOURCE_RE.test(source)) return { ok: false, error: 'bad-source' };
    if (typeof input.id !== 'string' || input.id.length < 1 || /[\u0000\r\n]/.test(input.id)) {
      return { ok: false, error: 'bad-id' };
    }
    if (input.id.length > ID_MAX) return { ok: false, error: 'id-length' };
    if (typeof input.site !== 'string' || input.site.length < 1 || /[\u0000\r\n]/.test(input.site)) {
      return { ok: false, error: 'bad-site' };
    }
    if (input.site.length > SITE_MAX) return { ok: false, error: 'site-length' };
    if (typeof input.name !== 'string' || input.name.indexOf('\0') !== -1) return { ok: false, error: 'bad-name' };
    if (input.name.length > NAME_MAX) return { ok: false, error: 'name-length' };
    if (typeof input.text !== 'string' || input.text.indexOf('\0') !== -1) return { ok: false, error: 'bad-text' };
    if (input.text.length > TEXT_MAX) return { ok: false, error: 'text-length' };

    let account = '';
    if (Object.prototype.hasOwnProperty.call(input, 'account') && input.account != null) {
      if (typeof input.account !== 'string' || input.account.length > ACCOUNT_MAX || /[\u0000\r\n]/.test(input.account)) {
        return { ok: false, error: 'bad-account' };
      }
      account = input.account;
    }
    let userId = '';
    if (Object.prototype.hasOwnProperty.call(input, 'userId') && input.userId != null) {
      if (typeof input.userId !== 'string' || input.userId.length > USER_MAX || /[\u0000\r\n]/.test(input.userId)) {
        return { ok: false, error: 'bad-user' };
      }
      userId = input.userId;
    }

    const badges = [];
    if (Object.prototype.hasOwnProperty.call(input, 'badges') && input.badges != null) {
      if (!Array.isArray(input.badges) || input.badges.length > BADGES_MAX) return { ok: false, error: 'bad-badges' };
      for (let i = 0; i < input.badges.length; i += 1) {
        const badge = input.badges[i];
        if (typeof badge !== 'string' || badge.length < 1 || badge.length > BADGE_MAX || badge.indexOf('\0') !== -1) {
          return { ok: false, error: 'bad-badges' };
        }
        badges.push(badge);
      }
    }

    const owner = flag(input, 'isOwner', 'bad-owner');
    if (!owner.ok) return owner;
    const gift = flag(input, 'hasGift', 'bad-gift');
    if (!gift.ok) return gift;

    const at = normalizeAt(Object.prototype.hasOwnProperty.call(input, 'at') ? input.at : null, atMs);
    if (!at) return { ok: false, error: 'bad-at' };

    const message = {
      id: input.id,
      site: input.site,
      account: account,
      userId: userId,
      name: input.name,
      text: input.text,
      badges: badges,
      isOwner: owner.value,
      hasGift: gift.value,
      at: at,
      source: source
    };

    if (Object.prototype.hasOwnProperty.call(input, 'amount') && input.amount != null) {
      if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0) {
        return { ok: false, error: 'bad-amount' };
      }
      message.amount = input.amount;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'currency') && input.currency != null) {
      if (typeof input.currency !== 'string' || input.currency.length < 1 || input.currency.length > CURRENCY_MAX) {
        return { ok: false, error: 'bad-currency' };
      }
      if (/[\u0000\r\n]/.test(input.currency)) return { ok: false, error: 'bad-currency' };
      message.currency = input.currency;
    }
    return { ok: true, message: message };
  }

  function forcedSource(info) {
    if (!info || !Object.prototype.hasOwnProperty.call(info, 'source')) return { ok: true, source: '' };
    if (typeof info.source !== 'string' || !SOURCE_RE.test(info.source)) return { ok: false, error: 'bad-source' };
    return { ok: true, source: info.source };
  }

  function publish(messages, info) {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 50) {
      return { ok: false, error: 'messages' };
    }
    const forced = forcedSource(info);
    if (!forced.ok) return forced;
    const at = now();
    const candidates = [];
    const batchKeys = new Set();
    let rejected = 0;
    let duplicate = 0;
    let ignored = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const raw = messages[i];
      const source = forced.source || (raw && typeof raw.source === 'string' ? raw.source : '');
      // 外から入れる口（chat.publish）で、プラグイン自身の名前を名乗ることは許さない（入り口の取り決めのすり抜けを防ぐ）
      if (reservedSource(source)) {
        rejected += 1;
        continue;
      }
      const built = normalize(raw, source, at);
      if (!built.ok) {
        rejected += 1;
        continue;
      }
      if (blockedByClaim(built.message.site, built.message.source)) {
        ignored += 1;
        continue;
      }
      const key = seenKey(built.message.site, built.message.id);
      if (dedupeSet.has(key) || batchKeys.has(key)) {
        duplicate += 1;
        continue;
      }
      batchKeys.add(key);
      candidates.push({ key: key, message: built.message });
    }
    const room = roomAt(at);
    const drop = Math.max(0, candidates.length - room);
    if (drop > 0) logger('warn', 'chat drop count=' + drop);
    const chosen = candidates.slice(drop);
    for (let i = 0; i < chosen.length; i += 1) {
      acceptedAt.push(at);
      remember(chosen[i].key);
      store(chosen[i].message);
    }
    return {
      ok: true,
      accepted: chosen.length,
      duplicate: duplicate,
      dropped: drop,
      rejected: rejected,
      ignored: ignored
    };
  }

  function ingest(message, info) {
    const forced = forcedSource(info);
    if (!forced.ok) return forced;
    if (!forced.source) return { ok: false, error: 'bad-source' };
    const at = now();
    const built = normalize(message, forced.source, at);
    if (!built.ok) return built;
    if (blockedByClaim(built.message.site, built.message.source)) return { ok: false, error: 'not-primary' };
    const key = seenKey(built.message.site, built.message.id);
    if (dedupeSet.has(key)) return { ok: false, error: 'duplicate' };
    if (roomAt(at) < 1) {
      logger('warn', 'chat drop count=1');
      return { ok: false, error: 'dropped' };
    }
    acceptedAt.push(at);
    remember(key);
    store(built.message);
    return { ok: true };
  }

  function recent(limit) {
    let n = 50;
    if (limit != null) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > RECENT_MAX) {
        return { ok: false, error: 'limit' };
      }
      n = limit;
    }
    const start = Math.max(0, kept.length - n);
    const messages = [];
    for (let i = kept.length - 1; i >= start; i -= 1) messages.push(copyMessage(kept[i]));
    return { ok: true, messages: messages };
  }

  return {
    ingest: ingest,
    publish: publish,
    recent: recent,
    claim: claim,
    release: release,
    releaseAll: releaseAll,
    inlets: inlets
  };
}

module.exports = {
  createChat,
  TEXT_MAX,
  NAME_MAX,
  RECENT_MAX,
  DEDUPE_MAX,
  RATE_MAX,
  SOURCE_RE
};
