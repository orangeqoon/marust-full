'use strict';

/**
 * 本番切り替えの案内。6 項目を返す。秘密の値は読まない、返さない。
 * 事実は deps.facts(site, secretNames, pluginIds)（本体の diagnostics.siteFacts の答え）・deps.preflight(ids)（broadcast.preflight）・
 * deps.shadowReport({ days: 7, site })（{ ok, sites: { <site>: { count } } }）。判定の文面はここ（V6 で host/golive.js から移した）。
 */

const SITES = Object.freeze([
  'youtube',
  'twitch',
  'kick',
  'twitcasting',
  'niconico',
  'fc2',
  'kukulu',
  'picarto',
  'rumble',
  'soop'
]);

const LOGIN = Object.freeze({
  youtube: Object.freeze(['youtube.oauth']),
  twitch: Object.freeze(['twitch.oauth']),
  kick: Object.freeze(['kick.oauth']),
  twitcasting: Object.freeze(['cookies.twitcasting-main', 'twitcasting.config']),
  niconico: Object.freeze(['cookies.niconico-main']),
  fc2: Object.freeze(['cookies.fc2-main', 'fc2.config']),
  kukulu: Object.freeze(['kukulu.config']),
  picarto: Object.freeze(['picarto.config']),
  rumble: Object.freeze(['rumble.livestream-api', 'cookies.rumble-main']),
  soop: Object.freeze(['cookies.soop-main'])
});

const UNKNOWN = '判定できない';
const IMPORT_HINT = 'ログインを金庫に入れてください';

function isSite(site) {
  return typeof site === 'string' && SITES.indexOf(site) !== -1;
}

function loginSecrets(site) {
  const row = LOGIN[site];
  return row ? row.slice() : [];
}

function relatedPlugins(site) {
  const ids = ['site-' + site, 'sink-' + site, 'chat-' + site];
  if (site === 'rumble') ids.push('slot-rumble');
  ids.push('broadcast', 'obs-engine');
  return ids;
}

function step(name, level, code, detail) {
  return {
    step: name,
    level: level,
    code: code,
    detail: detail
  };
}

async function presentSecrets(facts, required) {
  const map = facts && facts.secrets && typeof facts.secrets === 'object' ? facts.secrets : null;
  if (!map) return { ok: false, have: [] };
  return { ok: true, have: required.filter(function (name) { return map[name] === true; }) };
}

async function loginStep(site, facts) {
  const required = loginSecrets(site);
  const found = await presentSecrets(facts, required);
  if (!found.ok) return step('login', 'warn', 'secrets-unavailable', UNKNOWN);
  const missing = required.filter(function (name) { return found.have.indexOf(name) === -1; });
  if (missing.length === 0) {
    return step('login', 'ok', 'secrets-ready', '金庫にあります: ' + required.join('、'));
  }
  if (found.have.length === 0) {
    return step('login', 'todo', 'secrets-missing', IMPORT_HINT);
  }
  return step('login', 'warn', 'secrets-partial', '足りない名前: ' + missing.join('、') + '。' + IMPORT_HINT);
}

function destinationStep(site, facts) {
  const rows = facts && Array.isArray(facts.destinations) ? facts.destinations : null;
  if (!rows) return { item: step('destination', 'warn', 'destination-unavailable', UNKNOWN), ids: [] };
  const ids = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (typeof rows[i].id === 'string' && rows[i].id.trim()) ids.push(rows[i].id.trim());
  }
  if (rows.length === 0) {
    return { item: step('destination', 'todo', 'destination-missing', 'このサイトの配信先がありません'), ids: ids };
  }
  const linked = rows.filter(function (row) { return typeof row.engineId === 'string' && row.engineId; });
  if (linked.length === 0) {
    return {
      item: step('destination', 'todo', 'destination-unlinked', '配信先はエンジンの配信先に紐付いていません'),
      ids: ids
    };
  }
  let pick = linked[0];
  for (let i = 0; i < linked.length; i += 1) {
    if (linked[i].enabled === true) { pick = linked[i]; break; }
  }
  return {
    item: step('destination', 'ok', 'destination-linked', pick.engineId + ' に紐付いています'),
    ids: ids
  };
}

function preflightCodes(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error === 'unavailable' && !Array.isArray(result.items)) return null;
  const source = Array.isArray(result.items) ? result.items : null;
  if (!source) return null;
  const items = [];
  for (let i = 0; i < source.length; i += 1) {
    const row = source[i] && typeof source[i] === 'object' ? source[i] : {};
    const level = row.level === 'error' || row.level === 'warn' || row.level === 'ok' ? row.level : 'warn';
    const code = typeof row.code === 'string' && /^[a-z0-9-]{1,80}$/.test(row.code) ? row.code : 'item';
    items.push({ level: level, code: code });
  }
  return items;
}

async function preflightStep(deps, ids) {
  if (!deps || typeof deps.preflight !== 'function') {
    return step('preflight', 'warn', 'preflight-unavailable', UNKNOWN);
  }
  if (!ids.length) {
    return step('preflight', 'todo', 'preflight-none', '配信先がないのでチェックできません');
  }
  let result = null;
  try {
    result = await deps.preflight(ids.slice());
  } catch (_) {
    result = null;
  }
  const items = preflightCodes(result);
  if (!items) return step('preflight', 'warn', 'preflight-unavailable', UNKNOWN);
  const errors = [];
  const warns = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].level === 'error' && errors.indexOf(items[i].code) === -1) errors.push(items[i].code);
    if (items[i].level === 'warn' && warns.indexOf(items[i].code) === -1) warns.push(items[i].code);
  }
  if (errors.length) return step('preflight', 'warn', 'preflight-error', 'error: ' + errors.join(', '));
  if (warns.length) return step('preflight', 'warn', 'preflight-warn', 'warn: ' + warns.join(', '));
  return step('preflight', 'ok', 'preflight-ok', '問題はありません');
}

function shadowCount(report, site) {
  if (!report || typeof report !== 'object' || report.ok !== true) return null;
  const sites = report.sites;
  if (!sites || typeof sites !== 'object' || Array.isArray(sites)) return null;
  if (!Object.prototype.hasOwnProperty.call(sites, site)) return 0;
  const row = sites[site];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 0;
  if (!Object.prototype.hasOwnProperty.call(row, 'count')) return 0;
  const count = row.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 1000000) return null;
  return count;
}

async function shadowStep(site, deps) {
  if (!deps || typeof deps.shadowReport !== 'function') {
    return step('shadow', 'warn', 'shadow-unknown', UNKNOWN);
  }
  let report = null;
  try {
    report = await deps.shadowReport({ days: 7, site: site });
  } catch (_) {
    report = null;
  }
  const count = shadowCount(report, site);
  if (count == null) return step('shadow', 'warn', 'shadow-unknown', UNKNOWN);
  if (count < 1) return step('shadow', 'todo', 'shadow-none', '直近 7 日の shadow の記録はありません');
  return step('shadow', 'ok', 'shadow-seen', '直近 7 日に ' + String(count) + ' 件');
}

async function modesStep(site, facts) {
  const ids = relatedPlugins(site);
  const map = facts && facts.plugins && typeof facts.plugins === 'object' ? facts.plugins : null;
  if (!map) return step('modes', 'warn', 'modes-unavailable', UNKNOWN);
  const parts = [];
  let missing = 0;
  let legacy = 0;
  let shadow = 0;
  let live = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const mode = map[id];
    if (mode === 'missing' || mode == null) {
      missing += 1;
      parts.push(id + '=なし');
      continue;
    }
    parts.push(id + '=' + mode);
    if (mode === 'live') live += 1;
    else if (mode === 'shadow') shadow += 1;
    else legacy += 1;
  }
  const detail = parts.join(', ');
  if (missing) return step('modes', 'todo', 'modes-missing', detail);
  if (legacy) return step('modes', 'todo', 'modes-legacy', detail);
  if (live === ids.length) return step('modes', 'ok', 'modes-live', detail);
  if (shadow) return step('modes', 'warn', 'modes-shadow', detail);
  return step('modes', 'todo', 'modes-legacy', detail);
}

async function check(site, deps) {
  if (!isSite(site)) return { ok: false, error: 'unknown-site' };
  const bag = deps && typeof deps === 'object' ? deps : {};
  let facts = null;
  try {
    facts = typeof bag.facts === 'function' ? await bag.facts(site, secretNamesOf(site), relatedPlugins(site)) : null;
  } catch (_) {
    facts = null;
  }
  if (!facts || facts.ok !== true) facts = null;
  const destination = destinationStep(site, facts);
  const steps = [];
  steps.push(await loginStep(site, facts));
  steps.push(destination.item);
  steps.push(await preflightStep(bag, destination.ids));
  steps.push(await shadowStep(site, bag));
  steps.push(await modesStep(site, facts));
  return { ok: true, site: site, steps: steps };
}

function secretNamesOf(site) {
  return loginSecrets(site);
}

module.exports = {
  check: check,
  SITES: SITES,
  loginSecrets: loginSecrets,
  relatedPlugins: relatedPlugins
};
