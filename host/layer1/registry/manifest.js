'use strict';

/**
 * 登録簿の manifest まわり（計画 X・S8b。host/core/plugin-registry.js から機械的に移した。動きは変えていない）。
 * 役割の名前・段階・機能の説明・名乗り・サイトの展開・外から入れるものの守り。状態を持たない関数だけ。
 */

const fs = require('fs');
const path = require('path');
const owners = require('../../core');
const { normalizeClaims } = require('../manifest-claims');
const { CORE_NAMESPACES, API_CALLS_MAX, PEER_METHODS, checkPluginCall } = require('../plugin-api-check');
const { validSubscribe, normalizePanels, normalizeUi, normalizeOverlays, normalizeActions } = require('../plugin-surface');

// つなぎ口の版（計画 C・D2・C5）。整数。今の口を壊す変更のときだけ上げる（足すだけなら上げない）。
// PLUGIN_API_MIN より古い整数は読み込まない。書いていなければ 1。
const PLUGIN_API_VERSION = 2;
const PLUGIN_API_MIN = 1;

// 返すのは skip の理由。'' なら合う。
// 整数でない・1 未満は 'bad-core-api'。MIN より小さい整数は 'core-api-too-old'。核より新しいものは 'core-api-too-new'。
function judgeCoreApi(want, version, min) {
  if (typeof want !== 'number' || !Number.isInteger(want) || want < 1) return 'bad-core-api';
  if (want < min) return 'core-api-too-old';
  if (want > version) return 'core-api-too-new';
  return '';
}

function coreApiProblem(manifest) {
  if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, 'coreApi') || manifest.coreApi == null) return '';
  return judgeCoreApi(manifest.coreApi, PLUGIN_API_VERSION, PLUGIN_API_MIN);
}

const LOG_BOX_LINES = 200;
const LOG_LINE_CHARS = 500;
const KNOWN_CAPS = new Set(['title', 'category', 'obs-start', 'obs-stop']);
const FANOUT_REQUIRES = new Set(['title', 'title-or-category']);
const FANOUT_METHODS = new Set(['updateTitle', 'updateCategory', 'updateStream']);

const MAX_MANIFEST_TIMEOUT_MS = 120000;

const KNOWN_PROVIDES = new Set([
  'stream.site@1',
  'stream.slot@1',
  'stream.engine@1',
  'session.controller@1',
  'session.store@1',
  'session.recorder@1',
  'chat.source@1',
  'chat.inlet@1',
  'vault-store@1',
  'chat.sink@1',
  'notify.sink@1',
  'auth.provider@1',
  'stream.lifecycle@1',
  'ui.panel@1',
  'title.fanout@1',
  'site.login@1',
  'tips.source@1',
  'storage.locator@1'
]);
const PLUGIN_MODES = new Set(['legacy', 'shadow', 'live']);
const RUNTIMES = new Set(['inproc', 'child', 'external']);
// 段階（v3 §5）。manifest の tier: basic＝どの段階でも読む／standard＝中級から／advanced＝上級から。
// 無いときの既定: サイトのプラグイン・feature.level が standard のものは standard、それ以外は advanced。外から入れたものは必ず advanced（上級の機能）。
const TIER_RANK = Object.freeze({ basic: 0, standard: 1, advanced: 2 });

function mapV1Provides(manifest) {
  if (!manifest || manifest.manifestVersion === 2) return;
  const provides = [];
  const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (caps.includes('title') || caps.includes('category')) provides.push('stream.site@1');
  if (caps.includes('obs-start') || caps.includes('obs-stop')) provides.push('stream.lifecycle@1');
  const existing = Array.isArray(manifest.provides) ? manifest.provides : [];
  for (const item of existing) {
    if (KNOWN_PROVIDES.has(item) && provides.indexOf(item) === -1) provides.push(item);
  }
  manifest.provides = provides;
}

function keepStrings(list, id, log, label) {
  if (!Array.isArray(list)) {
    if (list != null) log('warn', 'ignore ' + label + ' on ' + id);
    return [];
  }
  const clean = [];
  let bad = 0;
  for (const item of list) {
    const ok = label === 'provides'
      ? KNOWN_PROVIDES.has(item)
      : (label === 'subscribes' ? validSubscribe(item) : (typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(item)));
    if (ok && clean.indexOf(item) === -1) clean.push(item);
    else bad += 1;
  }
  if (bad) log('warn', 'ignore ' + label + ' count=' + bad);
  return clean;
}

const ROLE_RE = /^[a-z][a-z0-9.-]*@[1-9][0-9]{0,2}$/;

function normalizeRequires(raw, id, log) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    log('warn', 'ignore requires on ' + id);
    return [];
  }
  const clean = [];
  let bad = 0;
  for (const item of raw) {
    if (typeof item === 'string' && ROLE_RE.test(item) && clean.indexOf(item) === -1) clean.push(item);
    else bad += 1;
  }
  if (bad) log('warn', 'ignore requires count=' + bad);
  return clean;
}

// 中級の「機能」一覧に出す説明（PLAN-plugin-core §3.1）。壊れた欄は捨てる（feature ごと捨てる場合もある）。プラグインは起動する。
const FEATURE_NEEDS_RE = /^(login:[a-z0-9-]{1,32}|site:[a-z0-9-]{1,32}|obs)$/;
const FEATURE_PANEL_RE = /^[a-z][a-z0-9:_-]{0,80}$/;
const FEATURE_ACTIVATIONS = new Set(['live', 'shadow', 'guide']);

function normalizeFeature(raw, id, log) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log('warn', 'ignore feature on ' + id);
    return null;
  }
  if (typeof raw.label !== 'string' || raw.label.trim() === '' || raw.label.length > 40) {
    log('warn', 'ignore feature on ' + id + ' (label)');
    return null;
  }
  const out = { label: raw.label.trim() };
  out.hint = typeof raw.hint === 'string' && raw.hint.length <= 120 ? raw.hint : '';
  out.level = raw.level === 'advanced' ? 'advanced' : 'standard';
  out.activation = FEATURE_ACTIVATIONS.has(raw.activation) ? raw.activation : 'live';
  out.group = typeof raw.group === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(raw.group) ? raw.group : '';
  out.order = Number.isInteger(raw.order) && raw.order >= 0 && raw.order <= 9999 ? raw.order : 9999;
  const needs = Array.isArray(raw.needs) ? raw.needs.filter((n) => typeof n === 'string' && FEATURE_NEEDS_RE.test(n)) : [];
  out.needs = needs.filter((n, i) => needs.indexOf(n) === i);
  if (raw.needs != null && (!Array.isArray(raw.needs) || out.needs.length !== raw.needs.length)) log('warn', 'ignore feature.needs count on ' + id);
  out.openPanel = typeof raw.openPanel === 'string' && FEATURE_PANEL_RE.test(raw.openPanel) ? raw.openPanel : '';
  // 3 回配信したあとの紹介（tips プラグイン）の文と、昔の紹介 id の別名。文はプラグインが持つ（本体は機能の名前を知らない。計画 X・P1）
  out.tip = typeof raw.tip === 'string' && raw.tip.length <= 200 ? raw.tip : '';
  out.tipAliases = (Array.isArray(raw.tipAliases) ? raw.tipAliases : []).filter((x) => typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x)).slice(0, 3);
  return out;
}

// owns（イベント・親の操作の持ち主の名乗り）は内蔵だけ（host/core/owners.js）。外から入れたものの名乗りは捨てる。
function claimOwns(manifest, id, source, log) {
  if (!Object.prototype.hasOwnProperty.call(manifest, 'owns')) return;
  if (source !== 'set') {
    log('warn', 'ignore owns on ' + id + ' (not set)');
    delete manifest.owns;
    return;
  }
  manifest.owns = owners.cleanOwns(manifest.owns);
  const refused = owners.claim(id, manifest.owns);
  if (refused.length) log('warn', 'owns refused count=' + refused.length + ' on ' + id);
}

function normalizeV2(manifest, id, log) {
  normalizeClaims(manifest, id, log);
  const feature = normalizeFeature(manifest.feature, id, log);
  if (feature) manifest.feature = feature;
  else delete manifest.feature;
  manifest.provides = keepStrings(manifest.provides, id, log, 'provides');
  manifest.subscribes = keepStrings(manifest.subscribes, id, log, 'subscribes');
  manifest.requires = normalizeRequires(manifest.requires, id, log);
  manifest.secrets = keepStrings(manifest.secrets, id, log, 'secrets');
  if (Object.prototype.hasOwnProperty.call(manifest, 'timeouts')) {
    manifest.timeouts = normalizeTimeouts(manifest.timeouts, id, log);
  }
  if (!Object.prototype.hasOwnProperty.call(manifest, 'runtime') || manifest.runtime == null || !RUNTIMES.has(manifest.runtime)) {
    if (Object.prototype.hasOwnProperty.call(manifest, 'runtime')) log('warn', 'ignore runtime on ' + id);
    else log('warn', 'ignore runtime on ' + id);
    delete manifest.runtime;
  }
  if (manifest.defaultMode != null && !PLUGIN_MODES.has(manifest.defaultMode)) {
    log('warn', 'ignore defaultMode on ' + id);
    delete manifest.defaultMode;
  }
  if (manifest.configSchema != null) {
    const schema = manifest.configSchema;
    const bad = typeof schema !== 'string' || schema === '' || path.isAbsolute(schema) || schema.split(/[\\/]/).indexOf('..') !== -1;
    if (bad) {
      log('warn', 'ignore configSchema on ' + id);
      delete manifest.configSchema;
    }
  }
  const warn = (message) => log('warn', message.indexOf(' on ') === -1 && message.indexOf('count=') === -1
    ? message + ' on ' + id
    : message);
  manifest.panels = normalizePanels(manifest.panels, warn);
  if (Object.prototype.hasOwnProperty.call(manifest, 'ui')) {
    // ui.panels は panels の別名（同じ名前は panels が先）。残りの口（popup・settings・menu・slots・relay）は ui に残す。
    const ui = normalizeUi(manifest.ui, warn);
    ui.panels.forEach((panel) => {
      if (!manifest.panels.some((p) => p.name === panel.name)) manifest.panels.push(panel);
    });
    delete ui.panels;
    manifest.ui = ui;
  }
  const overlays = normalizeOverlays(manifest.overlays, warn);
  if (overlays.error) return overlays.error;
  manifest.overlays = overlays.overlays;
  manifest.actions = normalizeActions(manifest.actions, warn);
  return '';
}

// manifest の api 欄: { namespaces: [1〜5 個]（V1）, calls: [0〜30 個]（V2-1。ctx.api.call で呼ぶ名前。完全一致） }。内蔵だけ。
// namespaces の違反は警告してその欄ごと捨てる。calls は呼べない名前・重複だけを警告して捨てる（残りは使う）。
function normalizeApiField(manifest, id, source, log) {
  if (!Object.prototype.hasOwnProperty.call(manifest, 'api')) return;
  const raw = manifest.api;
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const has = (key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  const names = has('namespaces') ? obj.namespaces : null;
  const core = CORE_NAMESPACES;
  const namesOk = has('namespaces') && Array.isArray(names) && names.length >= 1 && names.length <= 5
    && names.every((n, i) => typeof n === 'string' && /^[a-z][a-zA-Z0-9]{0,31}$/.test(n) && core.indexOf(n) === -1 && names.indexOf(n) === i);
  const callsGiven = has('calls');
  if (!obj || (!namesOk && !callsGiven) || (has('namespaces') && !namesOk)) {
    log('warn', 'ignore api on ' + id);
    delete manifest.api;
    return;
  }
  const out = {};
  if (namesOk) out.namespaces = names.slice();
  if (callsGiven) {
    const list = Array.isArray(obj.calls) ? obj.calls : null;
    if (!list || list.length > API_CALLS_MAX) {
      log('warn', 'ignore api.calls on ' + id);
    } else {
      const calls = [];
      for (const name of list) {
        if (!checkPluginCall(name).ok || calls.indexOf(name) !== -1) {
          log('warn', 'ignore api.calls entry on ' + id);
          continue;
        }
        calls.push(name);
      }
      out.calls = calls;
    }
  }
  if (!out.namespaces && !(out.calls && out.calls.length)) {
    log('warn', 'ignore api on ' + id);
    delete manifest.api;
    return;
  }
  // 切（legacy）のあいだ、このプラグインが出した API を無いものとして扱う（feature を持たないプラグイン用。K3）
  if (obj.modeGated === true) out.modeGated = true;
  manifest.api = out;
}

// manifest の peers 欄（V2-10）: { methods: [PEER_METHODS の一部。1 個以上・重複なし] }。L8d で出どころ制限解除。違反は警告してその欄ごと捨てる。
function normalizePeersField(manifest, id, source, log) {
  if (!Object.prototype.hasOwnProperty.call(manifest, 'peers')) return;
  const raw = manifest.peers;
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.methods : null;
  const ok = Array.isArray(list) && list.length >= 1 && list.length <= PEER_METHODS.length
    && list.every((m, i) => PEER_METHODS.indexOf(m) !== -1 && list.indexOf(m) === i);
  if (ok) {
    manifest.peers = { methods: list.slice() };
    return;
  }
  log('warn', 'ignore peers on ' + id);
  delete manifest.peers;
}

function normalizeTimeouts(raw, id, log) {
  const clean = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log('warn', 'ignore timeouts on ' + id);
    return clean;
  }
  for (const key of Object.keys(raw)) {
    const ms = raw[key];
    if (typeof ms === 'number' && Number.isInteger(ms) && ms >= 1 && ms <= MAX_MANIFEST_TIMEOUT_MS) {
      clean[key] = ms;
    } else {
      log('warn', 'ignore timeout ' + id + ' ' + key);
    }
  }
  return clean;
}
// サイトのプラグイン（plugins/sites/<site>/manifest.json。R16）。1 つの manifest を、役目（site・sink・slot）ごとの
// 今までと同じ形の manifest に展開する。内部の id は "<役目>-<site>"（site-twitch など。今までと同じ）。
// 役目ごとに持つ欄: main・name・provides・secrets（サイトの secrets の部分集合）・timeouts・actions・needs・subscribes・
// defaultMode・configSchema・panels・overlays・requires・api。サイト全体の欄: id・name・version・runtime・site・secrets・audience・stability・tier。
const ROLE_NAMES = ['site', 'sink', 'slot'];
const ROLE_FIELDS = ['dataDirId', 'feature', 'provides', 'timeouts', 'actions', 'needs', 'subscribes', 'defaultMode', 'configSchema', 'panels', 'ui', 'overlays', 'requires', 'api'];
const SITE_ONLY_FIELDS = ['dataDirId', 'feature', 'main', 'provides', 'timeouts', 'actions', 'needs', 'subscribes', 'defaultMode', 'configSchema', 'panels', 'ui', 'overlays', 'requires'];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function expandSiteManifest(top, dirName, log) {
  if (top.manifestVersion !== 2) return { error: 'missing-field' };
  const roles = top.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return { error: 'missing-field' };
  const names = Object.keys(roles);
  if (!names.length || names.some((name) => ROLE_NAMES.indexOf(name) === -1)) return { error: 'bad-role' };
  SITE_ONLY_FIELDS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(top, key)) log('warn', 'ignore ' + key + ' on site ' + dirName + ' (roles only)');
  });
  const siteSecrets = keepStrings(top.secrets, dirName, log, 'secrets');
  const ids = names.map((name) => name + '-' + dirName);
  const out = [];
  for (let i = 0; i < names.length; i += 1) {
    const role = names[i];
    const spec = roles[role];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: 'bad-role' };
    if (typeof spec.main !== 'string' || spec.main === '') return { error: 'missing-field' };
    const secrets = keepStrings(spec.secrets, ids[i], log, 'secrets');
    if (secrets.some((name) => siteSecrets.indexOf(name) === -1)) return { error: 'secrets-not-in-site' };
    const manifest = {
      id: ids[i],
      name: typeof spec.name === 'string' && spec.name !== '' ? spec.name : top.name,
      version: top.version,
      manifestVersion: 2,
      runtime: top.runtime,
      kind: 'integration',
      main: spec.main,
      siteId: dirName,
      role: role,
      siblings: ids.slice(),
      secrets: secrets
    };
    ROLE_FIELDS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(spec, key)) manifest[key] = cloneJson(spec[key]);
    });
    if (top.audience != null) manifest.audience = top.audience;
    if (top.stability != null) manifest.stability = top.stability;
    if (top.tier != null) manifest.tier = top.tier;
    if (top.coreApi != null) manifest.coreApi = top.coreApi;
    if (role === 'site' && top.site != null) manifest.site = cloneJson(top.site);
    if (role === 'sink') manifest.sinkFor = [dirName];
    if (role === 'slot') manifest.slotFor = [dirName];
    out.push({ role: role, id: ids[i], manifest: manifest });
  }
  return { roles: out };
}

// 外から入れたプラグイン（出どころ external）の制限（PLAN-plugin-core §7.3）。手でフォルダに置かれたものにも同じようにかける。
// 秘密の名前は自分の名前空間（ext.<id>.*）だけ。obs.streamControl は渡さない。defaultMode は使わない（モードは本人が決める）。
// 外部の id の規則（installer と registry で共有。★2 M4）。サイトの役目・土台の id と紛らわしいものは使わせない。
const EXT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const EXT_RESERVED_PREFIX_RE = /^(site|sink|slot|chat)-/;
const EXT_RESERVED_IDS = Object.freeze(['default', 'obs-engine', 'sites']);
// 外部には渡さない力（★2 M3）: タイマーの開始・終了と、コメントの入り口の横取り。
const EXT_PROVIDES_NOT_ALLOWED = Object.freeze(['session.controller@1', 'chat.source@1', 'session.store@1', 'chat.inlet@1', 'vault-store@1']);

/** 外部の id として使えなければ 'bad-id'（形が違う）・'reserved-prefix'（site- など）・'reserved-name'（default など）。使えれば ''。 */
function externalIdProblem(id) {
  if (typeof id !== 'string' || !EXT_ID_RE.test(id)) return 'bad-id';
  if (EXT_RESERVED_PREFIX_RE.test(id)) return 'reserved-prefix';
  if (EXT_RESERVED_IDS.indexOf(id) !== -1) return 'reserved-name';
  return '';
}

function externalSecretOk(id, name) {
  if (typeof name !== 'string' || name.length > 80 || typeof id !== 'string') return false;
  // L8g: 名前空間（ext.<id>.）の縛りは外した。名前の形と長さだけ見る（事故の守り）
  return /^[a-z0-9.-]+$/.test(name);
}

function externalGuard(manifest, id) {
  if (manifest.secrets != null) {
    if (!Array.isArray(manifest.secrets) || !manifest.secrets.every((name) => externalSecretOk(id, name))) return 'secret-namespace';
  }
  if (manifest.needs != null) {
    manifest.needs = Array.isArray(manifest.needs)
      ? manifest.needs.filter((n) => typeof n === 'string')
      : [];
  }
  if (manifest.provides != null) {
    manifest.provides = Array.isArray(manifest.provides)
      ? manifest.provides.filter((p) => EXT_PROVIDES_NOT_ALLOWED.indexOf(p) === -1)
      : [];
  }
  delete manifest.dataDirId; // 置き場は必ず自分の id（内蔵の置き場を名乗らせない。★2 M2）
  manifest.defaultMode = 'legacy';
  return '';
}

function realInside(dir, file) {
  try {
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(file);
    const rel = path.relative(root, real);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (_) {
    return true; // 無ければ require が失敗するだけ
  }
}

module.exports = {
  PLUGIN_API_VERSION,
  PLUGIN_API_MIN,
  judgeCoreApi,
  coreApiProblem,
  LOG_BOX_LINES,
  LOG_LINE_CHARS,
  KNOWN_CAPS,
  FANOUT_REQUIRES,
  FANOUT_METHODS,
  MAX_MANIFEST_TIMEOUT_MS,
  KNOWN_PROVIDES,
  PLUGIN_MODES,
  RUNTIMES,
  TIER_RANK,
  mapV1Provides,
  keepStrings,
  ROLE_RE,
  normalizeRequires,
  FEATURE_NEEDS_RE,
  FEATURE_PANEL_RE,
  FEATURE_ACTIVATIONS,
  normalizeFeature,
  claimOwns,
  normalizeV2,
  normalizeApiField,
  normalizePeersField,
  normalizeTimeouts,
  ROLE_NAMES,
  ROLE_FIELDS,
  SITE_ONLY_FIELDS,
  cloneJson,
  expandSiteManifest,
  EXT_ID_RE,
  EXT_RESERVED_PREFIX_RE,
  EXT_RESERVED_IDS,
  EXT_PROVIDES_NOT_ALLOWED,
  externalIdProblem,
  externalSecretOk,
  externalGuard,
  realInside
};
