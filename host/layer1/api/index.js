'use strict';

/**
 * 画面と窓口の入口（本体は host/core/api/index.js。名前空間ごとの定義と実装は host/core/api/ns/<名前空間>.js。計画 X・S8a）。メソッド名は「名前.動作」。
 * 権限は read / write / emergency / ext-write / chat-write。
 * ctx.permissions が無い呼び出しは read / write / emergency を許可する（ext-write と chat-write は含めない）。
 * ext-write は拡張の /ext/cookies と /ext/capture だけ。WebSocket のメソッドには付けない。
 * chat-write を持つクライアントは chat.publish と read だけ。他の write は forbidden。
 * chat.publish は承認待ちにしない。native / browser からの呼び出しは記録だけ残す。
 * clients.list と clients.beginPairing と clients.revoke、secrets.list、
 * approval.approve と approval.deny、
 * modes.set と modes.setDefault、app.settings.set は clientId が local-window のときだけ許す。
 * settings.export と settings.preview と settings.import もウィンドウだけ。配信先の紐付けを含む。
 * 開発者プラグイン dev-legacy-import の legacyImport.scan と legacyImport.run もウィンドウだけ。監査には取り込みの名前だけを残す。
 * 引数の検証は各メソッドの params 定義だけを見る。定義が無いメソッドは拒まない。
 * loose の項目は説明用で、以前から検証していなかった呼び出しを拒まない。
 * プラグインの action は plugin.<id>.<名前> として、起動後にこの表へ入る。
 * requiresApproval の端末の write は実行せず承認待ちにする。emergency は forbidden。
 */

const fs = require('fs');
const path = require('path');
const { WINDOW_ID } = require('../clients');
const { EVENTS, CORE_SOURCE } = require('../../core');
const { ID_RE, ACTION_RE } = require('../plugin-surface');
const { CORE_NAMESPACES, PLUGIN_METHOD_TIMEOUT_MS, checkPluginMethod, checkPluginCall } = require('../plugin-api-check');
const { createApprovals } = require('../approvals');
const { createAudit } = require('../audit');
const { sanitizePreflight } = require('../../core');
const { buildFeatureList, findFeature } = require('../features');
const { resolveUiLevel } = require('../ui-settings');
const { THEME_DEFAULTS } = require('../data-plugins');
const { CHANGED_EVENT, isMode, readModesDocument, explainMode, explainDefault, fileView, setPluginMode, setDefaultMode, missingRequires, auditToken, MODE_KEY_RE, idOfModeKey, idOfLegacyId } = require('../modes');
const { createSettingsExport } = require('../settings-export');
const { createMigrationBundle } = require('../migration-bundle');
const nsList = require('./ns');
const { PROTOCOLS, IPC_PERMISSIONS, EXT_WRITE, INTERNAL_READS, CHAT_WRITE, PERMISSIONS, asObject, withoutSecrets, validateParams } = require('./rules');

const SPECS = Object.assign({}, ...nsList.map((ns) => ns.specs));

function withRun(method, run) {
  const spec = SPECS[method];
  if (!spec) throw new Error('missing spec ' + method);
  if (spec.permission === EXT_WRITE) throw new Error('ext-write is not a websocket permission');
  return {
    permission: spec.permission,
    windowOnly: spec.windowOnly === true,
    devOnly: spec.devOnly === true,
    noApproval: spec.noApproval === true,
    featurePlugin: typeof spec.featurePlugin === 'string' ? spec.featurePlugin : '',
    description: spec.description || '',
    params: spec.params || {},
    run: run
  };
}

function validate(method, params) {
  const spec = SPECS[method];
  if (!spec) return '';
  return validateParams(spec.params, params);
}

function cloneParams(params) {
  const row = asObject(params);
  try {
    return structuredClone(row);
  } catch (_) {
    const copy = {};
    const names = Object.keys(row);
    for (let i = 0; i < names.length; i += 1) copy[names[i]] = row[names[i]];
    return copy;
  }
}

function plainCtx(ctx, granted) {
  return {
    permissions: granted.slice(),
    via: ctx && ctx.via ? ctx.via : '',
    clientId: ctx && typeof ctx.clientId === 'string' ? ctx.clientId : '',
    kind: ctx && typeof ctx.kind === 'string' ? ctx.kind : '',
    requiresApproval: !!(ctx && ctx.requiresApproval),
    // 予約の自動送信（hub.fanoutReserved）を呼んでよいと本体の登録簿が認めた内蔵プラグインの呼び出しだけ true（外の端末は付けられない）
    titleReserved: !!(ctx && ctx.kind === 'plugin' && ctx.titleReserved === true)
  };
}

function auditError(result) {
  if (!result) return 'failed';
  if (typeof result.error === 'string' && result.error) return result.error;
  if (result.pending === true) return 'pending';
  if (typeof result.reason === 'string' && result.reason) return result.reason;
  return 'failed';
}

function safeToken(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value)) return 'failed';
  return value;
}

function shouldRecord(method, row, ctx) {
  if (!ctx || !row) return false;
  // 開発者プラグインのウィンドウだけの口（NeonTimer の取り込みなど）は、読むものも書くものも残す（名前だけ。値は入れない）
  if (row.pluginId && row.windowOnly === true && ctx.clientId === WINDOW_ID) return true;
  if (method === 'approval.approve' || method === 'approval.deny') {
    return ctx.kind === 'window' || ctx.kind === 'browser' || ctx.kind === 'native' || ctx.clientId === WINDOW_ID;
  }
  // プラグインが ctx.api.call で呼んだ書き込みも残す（clientId は plugin:<id>）
  if (ctx.kind === 'plugin') return row.permission === 'write';
  if (ctx.kind !== 'browser' && ctx.kind !== 'native') return false;
  return row.permission === 'write' || row.permission === 'emergency' || row.permission === CHAT_WRITE || row.windowOnly === true;
}

function parsePluginMethod(method) {
  if (typeof method !== 'string' || method.indexOf('plugin.') !== 0) return null;
  const rest = method.slice('plugin.'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const id = rest.slice(0, dot);
  const action = rest.slice(dot + 1);
  if (!ID_RE.test(id) || !ACTION_RE.test(action)) return null;
  return { id: id, action: action };
}

function createApi(deps) {
  const src = deps || {};
  const registry = src.registry;
  const clock = typeof src.now === 'function' ? src.now : function () { return Date.now(); };
  const audit = src.audit || createAudit({ core: src.core || {}, now: clock });

  function publishResolved(payload) {
    if (src.bus && typeof src.bus.publish === 'function') {
      src.bus.publish('approval.resolved', payload, { source: 'approvals' });
    }
    if (payload && payload.settlement === 'expired') {
      audit.write({
        clientId: payload.clientId,
        kind: payload.kind,
        method: 'approval.deny',
        paramNames: ['id'],
        ok: false,
        error: 'expired'
      });
    }
  }

  const approvals = src.approvals || createApprovals({
    now: clock,
    ttlMs: src.approvalTtlMs,
    setTimer: src.setTimer,
    clearTimer: src.clearTimer,
    onResolved: publishResolved
  });

  function engine() {
    if (src.engine) return src.engine;
    if (registry && typeof registry.only === 'function') return registry.only();
    return null;
  }

  function sessionApi() {
    if (!src.sessions || typeof src.sessions.view !== 'function') return null;
    return src.sessions;
  }

  function destinationRows() {
    if (!src.store || typeof src.store.snapshot !== 'function') return null;
    const snap = src.store.snapshot();
    if (!snap || !Array.isArray(snap.destinations)) return [];
    return snap.destinations;
  }

  function publicDestination(row) {
    const bound = row.engine && typeof row.engine === 'object' ? row.engine : null;
    const actual = row.actual && typeof row.actual === 'object' ? row.actual : {};
    // 送信中＝engineState、配信中＝siteLive（GLOSSARY）。別々に返す。
    const status = actual.engineState ? String(actual.engineState) : '';
    let keyTail = null;
    if (typeof row.keyTail === 'string' || row.keyTail === null) {
      keyTail = row.keyTail;
    } else if (bound && bound.id && bound.targetId != null && registry) {
      try {
        const impl = registry.get(bound.id);
        if (impl && typeof impl.listTargets === 'function') {
          const found = impl.listTargets().find(function (item) {
            return item && String(item.id) === String(bound.targetId);
          });
          if (found && (typeof found.keyTail === 'string' || found.keyTail === null)) {
            keyTail = found.keyTail;
          }
        }
      } catch (_) {}
    } else if (!bound) {
      keyTail = '';
    }
    const out = {
      id: row.id,
      site: row.site == null ? '' : String(row.site),
      account: row.accountId == null ? '' : String(row.accountId),
      engineId: bound && bound.id ? String(bound.id) : '',
      status: status,
      siteLive: actual.siteLive === true,
      keyTail: keyTail
    };
    // メイン出力（OBS が自分の設定で持つ出力）の行だけ印を付ける
    if (row.id === 'obs-main') out.main = true;
    return out;
  }

  function destinationControl(params, which) {
    const rows = destinationRows();
    if (!rows) return { ok: false, error: 'unavailable' };
    const row = rows.find(function (item) { return item && item.id === params.id; });
    if (!row) return { ok: false, error: 'unknown-destination' };
    const bound = row.engine && typeof row.engine === 'object' ? row.engine : null;
    const engineId = bound && bound.id ? String(bound.id) : '';
    const targetId = bound && bound.targetId != null ? String(bound.targetId) : '';
    if (!engineId || !targetId) return { ok: false, error: 'no-engine' };
    const impl = registry && typeof registry.get === 'function' ? registry.get(engineId) : null;
    if (!impl || typeof impl[which] !== 'function') return { ok: false, error: 'no-engine' };
    return impl[which](targetId);
  }

  function cleanIds(value) {
    const source = Array.isArray(value) ? value : [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < source.length; i += 1) {
      if (typeof source[i] !== 'string') continue;
      const id = source[i].trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function enabledDestinationIds() {
    const rows = destinationRows();
    if (!rows) return [];
    const ids = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row && row.enabled === true && typeof row.id === 'string' && row.id.trim()) ids.push(row.id.trim());
    }
    return ids;
  }

  async function runPreflight(ids) {
    if (!src.preflight || typeof src.preflight.run !== 'function') return { ok: false, error: 'unavailable' };
    try {
      return sanitizePreflight(await src.preflight.run(ids));
    } catch (_) {
      return sanitizePreflight(null);
    }
  }

  function pluginName(row) {
    if (row && typeof row.name === 'string' && row.name) return row.name;
    const manifest = row && row.manifest;
    if (manifest && typeof manifest.name === 'string' && manifest.name) return manifest.name;
    return row && row.id != null ? String(row.id) : '';
  }

  function visiblePlugins(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (!row || row.status === 'skip' || typeof row.id !== 'string' || !row.id) continue;
      out.push(row);
    }
    return out;
  }

  /** 束（packs/<段階>.json。K5）の id のうち、いまの本体に無いもの（内蔵として見つかり、読み込みに失敗していないものだけ「ある」）。束のファイルが読めなければ null */
  function packMissing(name, hub) {
    let ids;
    try { ids = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'packs', name + '.json'), 'utf8')).plugins; } catch (_) { return null; }
    if (!Array.isArray(ids)) return null;
    const bad = { 'load-failed': 1, 'start-failed': 1, 'invalid-exports': 1 };
    const have = new Set(((hub && hub.plugins) || []).filter(function (row) { return row && row.source === 'set' && !bad[row.status]; }).reduce(function (acc, row) { acc.push(row.id); if (row.siteId) acc.push(row.siteId); return acc; }, []));
    return ids.filter(function (id) { return typeof id === 'string' && !have.has(id); });
  }

  async function readHub() {
    if (typeof src.getState !== 'function') return { plugins: [], forced: false, known: false };
    try {
      const state = await src.getState();
      const body = state && typeof state === 'object' ? state : {};
      const summary = body.modeSummary && typeof body.modeSummary === 'object' ? body.modeSummary : {};
      const dest = body.destinations && typeof body.destinations === 'object' ? body.destinations : {};
      const eng = body.engineStatus && typeof body.engineStatus === 'object' ? body.engineStatus : {};
      return {
        plugins: Array.isArray(body.plugins) ? body.plugins : [],
        forced: summary.forced === true,
        liveCount: Number(dest.liveCount) || 0,
        known: true,
        obsConnected: typeof eng.connected === 'boolean' ? eng.connected : null
      };
    } catch (_) {
      return { plugins: [], forced: false, liveCount: 0, known: false, obsConnected: null };
    }
  }

  function modesReady() {
    return !!(src.core && src.core.STATE_DIR && typeof src.core.atomicWriteJsonSync === 'function');
  }

  function auditModes(ctx, method, paramNames) {
    audit.write({
      clientId: ctx && ctx.clientId ? ctx.clientId : '',
      kind: ctx && ctx.kind ? ctx.kind : '',
      method: method,
      paramNames: paramNames,
      ok: true,
      error: ''
    });
  }

  function publishDev(name, payload, source) {
    if (!src.bus || typeof src.bus.publish !== 'function') return;
    try { src.bus.publish(name, payload, { source: source || 'dev-reload' }); } catch (_) { /* 画面に届かなくても読み直しは済んでいる */ }
  }

  function reloadRow(row) {
    const out = { id: row.id, result: row.result, message: row.message };
    if (row.error) out.error = { message: row.error.message, where: row.error.where };
    return out;
  }

  // OBS を握るか。registry の判定（holdsObs）に任せる。registry に無いときは握る側に倒す（閉じる）
  function holdsObsId(reg, id) {
    return typeof reg.holdsObs === 'function' ? reg.holdsObs(id) === true : true;
  }

  // 1 つのプラグインを読み直す。知らない id で、外の置き場にその名前のフォルダがあれば、新しく置いたものとして拾う。
  async function pluginReload(id) {
    const reg = src.pluginRegistry;
    if (!reg || typeof reg.reload !== 'function') return { ok: false, error: 'unavailable' };
    if (!ID_RE.test(id)) return { ok: false, error: 'bad-id' };
    // 配信中でも読み直せる。例外は OBS の開始・停止を握るプラグイン（自動枠取り）だけ
    // 配信中か分からないときも閉じる（OBS を握るものだけ）
    const hub = await readHub();
    if ((!hub.known || hub.liveCount > 0) && holdsObsId(reg, id)) return { ok: false, error: 'streaming-slot' };
    let row;
    const known = reg.snapshot().some(function (r) { return r.id === id; });
    if (known) {
      row = await reg.reload(id);
    } else {
      const root = reg.paths && reg.paths.externalRoot;
      if (!root || typeof reg.rescanExternal !== 'function' || !fs.existsSync(path.join(root, id))) return { ok: false, error: 'unknown-id' };
      try {
        await reg.rescanExternal(id);
      } catch (err) {
        return { ok: false, error: err && err.message === 'busy' ? 'busy' : 'failed' };
      }
      const hit = reg.snapshot().filter(function (r) { return r.id === id; })[0];
      if (!hit) return { ok: true, id: id, result: 'error', message: 'invalid-manifest' };
      if (hit.reason === 'legacy-not-loaded' || hit.reason === 'tier-not-loaded') row = { id: id, result: 'skip', message: hit.reason };
      else row = { id: id, result: hit.status === 'running' ? 'ok' : 'error', message: hit.status, error: hit.lastError || undefined };
    }
    if (row.message === 'busy') return { ok: false, error: 'busy' };
    if (row.message === 'unknown-id') return { ok: false, error: 'unknown-id' };
    publishDev('plugin.reloaded', { id: id, result: row.result });
    return Object.assign({ ok: true }, reloadRow(row));
  }

  function publishModes(id, mode) {
    if (!src.bus || typeof src.bus.publish !== 'function') return;
    try {
      src.bus.publish(CHANGED_EVENT, { id: id, mode: mode }, { source: 'modes' });
    } catch (_) { /* the file is already written */ }
  }

  function hiddenIds() {
    try {
      const v = src.uiSettings && typeof src.uiSettings.getView === 'function' ? src.uiSettings.getView() : {};
      return Array.isArray(v.hiddenPlugins) ? v.hiddenPlugins : [];
    } catch (_) { return []; }
  }

  async function listModes() {
    const hidden = hiddenIds();
    if (!src.core || !src.core.STATE_DIR) return { ok: false, error: 'unavailable' };
    const hub = await readHub();
    const read = readModesDocument(src.core);
    const view = fileView(read);
    const defaults = explainDefault(read, hub.forced);
    const rows = visiblePlugins(hub.plugins);
    const plugins = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const id = String(row.id);
      let explained = explainMode(id, read, hub.forced, row.mode);
      if (row.source === 'user' && explained.source === 'default') explained = { mode: 'legacy', source: 'defaultMode' }; // 外から入れたものは全体の既定に従わない
      const needs = missingRequires(rows, id);
      plugins.push({
        id: id,
        name: pluginName(row),
        mode: explained.mode,
        source: explained.source,
        requiresMet: needs.met,
        missing: needs.missing,
        audience: row.audience === 'dev' || row.audience === 'author' ? row.audience : 'public',
        stability: row.stability === 'experimental' ? 'experimental' : 'stable',
        visible: rowVisible(row) && hidden.indexOf(id) === -1,
        send: explained.mode === 'live',
        chatSource: typeof row.chatSource === 'string' ? row.chatSource : '',
        feature: row.feature && typeof row.feature === 'object' ? row.feature : null,
        category: typeof row.category === 'string' ? row.category : '',
        for: Array.isArray(row.for) ? row.for.slice() : [],
        tags: Array.isArray(row.tags) ? row.tags.slice() : [],
        site: row.site && typeof row.site === 'object' ? { name: row.site.name, tier: row.site.tier } : null
      });
    }
    return {
      ok: true,
      readable: view.readable,
      error: view.error,
      forced: hub.forced === true,
      defaultMode: defaults.mode,
      defaultSource: defaults.source,
      plugins: plugins
    };
  }

  // 「機能」一覧の材料を集める。all=true なら、見せない行（開発者用など）も含める（features.set 用）。
  async function collectFeatures(all) {
    const listed = await listModes();
    if (!listed || listed.ok !== true) return { ok: false, error: 'unavailable' };
    const hub = await readHub();
    let flags = [];
    const tipsView = await callInternal('tips.get', {}); // tips プラグインが切・無いときは unknown-method（印は無いものとして扱う）
    if (tipsView && tipsView.ok === true && Array.isArray(tipsView.features)) flags = tipsView.features.slice();
    let loginSites = null;
    {
      const st = await callInternal('sites.loginStatus', {}); // site-login が切・無いときは unknown-method（ログインは分からない＝null）
      loginSites = st && st.ok === true && Array.isArray(st.sites) ? st.sites : null;
    }
    // 外から入れたものは「機能」の一覧に出さない（承認なしで入れる道を作らない。上級の「プラグインの管理」だけ）
    const externalIds = hub.plugins.filter(function (r) { return r && r.source === 'user'; }).map(function (r) { return String(r.id); });
    const rows = listed.plugins
      .filter(function (r) { return externalIds.indexOf(r.id) === -1; })
      .map(function (r) { return all ? Object.assign({}, r, { visible: true }) : r; });
    return {
      ok: true,
      liveCount: hub.liveCount,
      features: buildFeatureList({ rows: rows, flags: flags, loginSites: loginSites, obsConnected: hub.obsConnected, installedSites: hub.plugins.filter(function (r) { return r && r.site && r.source !== 'user' && typeof r.site.id === 'string'; }).map(function (r) { return r.site.id; }) })
    };
  }

  async function setFeature(params, ctx) {
    // 一覧（features.list）にある機能だけ。manifest の activation に従う:
    //   live / shadow … そのプラグインのモードを変える（入れる＝その値、切る＝legacy）。外へ書く機能は guide にして、ここでは live にしない。
    //   guide … モードは変えず「使う」の印だけ（本物のサイトへ書く設定は、開いた画面の中で本人が決める）。
    // 切るのは配信中は断る（配信の経路は機能に依存させないが、途中で止まる驚きを避ける）。
    const built = await collectFeatures(true);
    if (!built.ok) return built;
    const feature = findFeature(built.features, params.id);
    if (!feature) return { ok: false, error: 'unknown-feature' };
    if (params.enabled === true && hiddenIds().indexOf(feature.id) !== -1) return { ok: false, error: 'hidden' };
    if (params.enabled !== true && built.liveCount > 0) return { ok: false, error: 'streaming' };
    if (feature.activation === 'guide') {
      // 「使う」の印は tips プラグインが feature.toggled を受けて残す（核は持ち主。印の成否は待たない。tips が切なら印は残らず入／切だけ進む）
      if (src.bus && typeof src.bus.publish === 'function') {
        try { src.bus.publish(EVENTS.FEATURE_TOGGLED, { id: feature.id, on: params.enabled === true }, { source: CORE_SOURCE }); } catch (_) { /* 印が残せなくても入／切は進む */ }
      }
      return { ok: true, id: feature.id, on: params.enabled === true, openPanel: params.enabled === true ? feature.openPanel : '' };
    }
    if (feature.source !== 'plugin') return { ok: false, error: 'unknown-feature' };
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    const mode = params.enabled === true ? (feature.activation === 'shadow' ? 'shadow' : 'live') : 'legacy';
    const done = await setMode({ id: feature.id, mode: mode, skipConfirm: true }, ctx, 'features.set');
    if (!done || done.ok !== true) return done || { ok: false, error: 'failed' };
    return { ok: true, id: feature.id, on: params.enabled === true, mode: mode, openPanel: params.enabled === true ? feature.openPanel : '' };
  }

  // 「セット」（kind: set のデータだけのプラグイン）。中身は機能の id の一覧。入れる＝中の機能を 1 つずつ features.set と同じ道で入れる。
  function setRows() {
    const rows = typeof src.dataPlugins === 'function' ? src.dataPlugins('set') : [];
    return rows.filter(function (r) { return r && r.set && Array.isArray(r.set.members); });
  }

  async function listSets() {
    const built = await collectFeatures(false);
    if (!built.ok) return built;
    const sets = setRows().map(function (r) {
      const members = r.set.members.map(function (id) {
        const f = findFeature(built.features, id);
        return { id: id, present: !!f, label: f ? f.label : '', on: !!(f && f.on) };
      });
      const present = members.filter(function (m) { return m.present; });
      return {
        id: r.id,
        source: r.source,
        label: r.set.label,
        for: Array.isArray(r.for) ? r.for.slice() : [],
        members: members,
        missing: members.filter(function (m) { return !m.present; }).map(function (m) { return m.id; }),
        on: present.length > 0 && present.every(function (m) { return m.on; })
      };
    });
    return { ok: true, sets: sets };
  }

  async function setSet(params, ctx) {
    const row = setRows().filter(function (r) { return r.id === params.id; })[0];
    if (!row) return { ok: false, error: 'unknown-set' };
    const built = await collectFeatures(true);
    if (!built.ok) return built;
    if (params.enabled !== true && built.liveCount > 0) return { ok: false, error: 'streaming' };
    const changed = [];
    const failed = [];
    const missing = [];
    for (let i = 0; i < row.set.members.length; i += 1) {
      const id = row.set.members[i];
      if (!findFeature(built.features, id)) { missing.push(id); continue; }
      const done = await setFeature({ id: id, enabled: params.enabled === true }, ctx);
      if (done && done.ok === true) changed.push(id); else failed.push({ id: id, error: done && done.error ? done.error : 'failed' });
    }
    return { ok: true, id: row.id, enabled: params.enabled === true, changed: changed, failed: failed, missing: missing };
  }

  // ---- 上級の「プラグインの管理」（P3。PLAN-plugin-core §7.2） ----
  const CORE_PLUGIN_IDS = ['obs-engine', 'default'];

  function destinationSites() {
    const rows = destinationRows();
    const out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (d) {
      if (d && d.site != null && out.indexOf(String(d.site)) === -1) out.push(String(d.site));
    });
    return out;
  }

  // 隠せない理由（空なら隠せる）。出どころが内蔵のものだけ。サイトの役目は、そのサイトに配信先が 1 つでもあれば隠せない。
  function hideBlock(row, hub, sites) {
    const id = String(row.id);
    if (row.source !== 'set') return 'not-set';
    if (CORE_PLUGIN_IDS.indexOf(id) !== -1) return 'core';
    if (hub.liveCount > 0) return 'streaming';
    const m = /^(?:site|sink|slot|chat)-([a-z0-9-]+)$/.exec(id);
    if (m && sites.indexOf(m[1]) !== -1) return 'has-destination';
    if (row.site && row.site.id && sites.indexOf(String(row.site.id)) !== -1) return 'has-destination';
    const all = visiblePlugins(hub.plugins);
    // 同じサイトの兄弟の役目が動いているあいだは、片方だけ隠さない（サイトの行ごと止める）
    const sibs = Array.isArray(row.siblings) ? row.siblings : [];
    for (let i = 0; i < all.length; i += 1) {
      const other = all[i];
      if (String(other.id) !== id && sibs.indexOf(String(other.id)) !== -1 && isMode(other.mode) && other.mode !== 'legacy') return 'siblings-on';
    }
    // 頼っているプラグインが動いていて、ほかに提供元が無いときは隠さない
    const gives = nameList(row.provides);
    for (let i = 0; i < gives.length; i += 1) {
      const role = gives[i];
      const dependent = all.some(function (o) { return String(o.id) !== id && isMode(o.mode) && o.mode !== 'legacy' && nameList(o.requires).indexOf(role) !== -1; });
      const another = all.some(function (o) { return String(o.id) !== id && isMode(o.mode) && o.mode !== 'legacy' && nameList(o.provides).indexOf(role) !== -1; });
      if (dependent && !another) return 'required-by';
    }
    // タイマーなどセッションを預かるものは、セッションが進行中は隠さない
    if (gives.indexOf('session.controller@1') !== -1) {
      const s = sessionApi();
      let active = false;
      try { active = !!(s && s.view().active); } catch (_) { active = false; }
      if (active) return 'session-active';
    }
    return '';
  }

  function nameList(value) {
    return (Array.isArray(value) ? value : []).filter(function (x) { return typeof x === 'string' && x.length <= 80; }).slice(0, 40);
  }

  // 使う力（秘密の名前・needs）。hub.getState には載せず、ここ（ウィンドウ専用の plugins.list）だけで登録簿から引く。
  function usesOf(id, row) {
    let manifest = null;
    const reg = src.pluginRegistry;
    if (reg && typeof reg.snapshot === 'function') {
      try {
        const hit = reg.snapshot().filter(function (r) { return String(r.id) === id; })[0];
        manifest = hit && hit.manifest ? hit.manifest : null;
      } catch (_) { manifest = null; }
    }
    const from = manifest || row || {};
    const secrets = manifest ? manifest.secrets : row.secretNames;
    const needs = manifest ? manifest.needs : row.needsCaps;
    return { vaultNames: nameList(secrets), needs: nameList(needs), provides: nameList(from.provides) };
  }

  async function listPlugins() {
    const hub = await readHub();
    const hidden = hiddenIds();
    const sites = destinationSites();
    const rows = (Array.isArray(hub.plugins) ? hub.plugins : []).filter(function (row) {
      if (!row || typeof row.id !== 'string' || !row.id) return false;
      // 読めなかった行は、理由があるときだけ出す（計画 C・C1-1）。理由の無い skip は一覧を汚さない。
      if (row.status === 'skip' && !(typeof row.reason === 'string' && row.reason)) return false;
      return devModeOn() || row.audience === 'public' || row.audience === undefined;
    });
    const plugins = rows.map(function (row) {
      const id = String(row.id);
      const feature = row.feature && typeof row.feature === 'object' ? row.feature : null;
      const state = (row.status === 'running' || row.status === 'data') ? 'running' : (row.status === 'listed-not-started' || row.status === 'accepted' ? 'stopped' : 'error');
      return {
        id: id,
        name: pluginName(row),
        version: typeof row.version === 'string' ? row.version : '',
        origin: row.source === 'user' ? 'user' : 'set',
        state: state,
        reason: state === 'error' && typeof row.reason === 'string' ? row.reason : '',
        mode: isMode(row.mode) ? row.mode : 'legacy',
        feature: feature ? feature.label : '',
        activation: feature ? feature.activation : '',
        category: typeof row.category === 'string' ? row.category : '',
        for: Array.isArray(row.for) ? row.for.slice() : [],
        tags: Array.isArray(row.tags) ? row.tags.slice() : [],
        tier: typeof row.tier === 'string' ? row.tier : '',
        uses: usesOf(id, row),
        hidden: hidden.indexOf(id) !== -1,
        hideBlock: hideBlock(row, hub, sites)
      };
    });
    // 隠したが、いま読み込まれていないものも、戻せるように並べる
    hidden.forEach(function (id) {
      if (!plugins.some(function (p) { return p.id === id; })) {
        plugins.push({ id: id, name: id, version: '', origin: 'set', state: 'stopped', mode: 'legacy', feature: '', activation: '', category: '', for: [], tags: [], tier: '', uses: { vaultNames: [], needs: [], provides: [] }, hidden: true, hideBlock: '' });
      }
    });
    return { ok: true, streaming: hub.liveCount > 0, plugins: plugins };
  }

  async function setHidden(params, ctx) {
    if (!modesReady() || !src.uiSettings || typeof src.uiSettings.set !== 'function') return { ok: false, error: 'unavailable' };
    const id = params.id;
    if (!/^[a-z0-9-]{1,32}$/.test(id)) return { ok: false, error: 'bad-id' };
    const hub = await readHub();
    const hidden = hiddenIds();
    const was = hidden.indexOf(id) !== -1;
    if (params.hidden === was) return { ok: true, id: id, hidden: was };
    if (params.hidden) {
      const row = visiblePlugins(hub.plugins).filter(function (r) { return String(r.id) === id; })[0];
      if (!row) return { ok: false, error: 'unknown-plugin' };
      const block = hideBlock(row, hub, destinationSites());
      if (block) return { ok: false, error: block };
      if (hidden.length >= 100) return { ok: false, error: 'hidden-full' };
      // 既定が legacy でキーが無い場合も、はっきり legacy を書く（あとで既定が変わっても、隠したものがよみがえらない）
      const wrote = setPluginMode(src.core, id, 'legacy');
      if (!wrote.ok) return { ok: false, error: wrote.error || 'failed' };
      publishModes(id, 'legacy');
    }
    // 内蔵に無い id（消えたもの・のちに外部で同じ名前になるもの）は、一覧から自動で外す
    const known = visiblePlugins(hub.plugins).map(function (r) { return String(r.id); });
    const kept = hidden.filter(function (x) { return known.indexOf(x) !== -1 || x === id; });
    const next = params.hidden ? kept.concat(kept.indexOf(id) === -1 ? [id] : []) : kept.filter(function (x) { return x !== id; });
    const saved = src.uiSettings.set({ hiddenPlugins: next.join(',') });
    if (!saved || saved.ok === false) return saved || { ok: false, error: 'failed' };
    auditModes(ctx, 'plugins.setHidden', ['id:' + id, 'hidden:' + (params.hidden ? 'yes' : 'no')]);
    publishModes(id, 'legacy');
    return { ok: true, id: id, hidden: params.hidden };
  }

  // ---- P4b: 外から入れる（zip／フォルダは選択ダイアログで選んだものだけ。画面と API の引数では場所を受けない）
  const PENDING_MS = 10 * 60 * 1000;
  let pendingInstall = null; // { source, sha256, at }: 直前の inspect で見せたもの

  function installerReady() {
    return !!(src.pluginInstaller && typeof src.pluginInstaller.inspect === 'function' && typeof src.pluginInstaller.install === 'function');
  }

  function installPublic(result) {
    // 画面に返すのは検査の要約だけ（場所は含めない）
    const keys = ['ok', 'error', 'id', 'name', 'version', 'uses', 'format', 'sha256', 'fileCount', 'bytes', 'updates', 'previousVersion', 'updated'];
    const out = {};
    keys.forEach(function (k) { if (result && result[k] !== undefined) out[k] = result[k]; });
    return out;
  }

  async function pluginInspect(params) {
    if (!installerReady() || typeof src.pickPluginSource !== 'function') return { ok: false, error: 'unavailable' };
    const kind = params.kind;
    if (kind !== 'zip' && kind !== 'folder') return { ok: false, error: 'bad-kind' };
    pendingInstall = null;
    if ((await readHub()).liveCount > 0) return { ok: false, error: 'streaming' };
    let picked = null;
    try { picked = await src.pickPluginSource(kind); } catch (_) { picked = null; }
    if (typeof picked !== 'string' || picked === '') return { ok: true, canceled: true };
    const inspected = await src.pluginInstaller.inspect(picked);
    if (!inspected || inspected.ok !== true) return installPublic(inspected || { ok: false, error: 'failed' });
    pendingInstall = { source: picked, sha256: inspected.sha256, at: Date.now() };
    return installPublic(inspected);
  }

  async function pluginInstall(params) {
    if (!installerReady()) return { ok: false, error: 'unavailable' };
    const held = pendingInstall;
    pendingInstall = null; // 1 回の下見で入れられるのは 1 回だけ
    if (!held || Date.now() - held.at > PENDING_MS || params.sha256 !== held.sha256) return { ok: false, error: 'not-inspected' };
    const done = await src.pluginInstaller.install(held.source, { expectSha256: held.sha256 });
    return installPublic(done);
  }

  async function setMode(params, ctx, auditName) {
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    // id は内部の id（site-twitch）。モードのキー（twitch:site）で来たら、内部の id に読み替える（R16。別名の入口はここ）。
    let id = params.id;
    let aliasOf = '';
    if (typeof id === 'string' && MODE_KEY_RE.test(id)) {
      aliasOf = id;
      id = idOfModeKey(id);
      if (!id) return { ok: false, error: 'unknown-plugin' };
    }
    const legacyTarget = typeof id === 'string' ? idOfLegacyId(id) : '';
    if (legacyTarget) { aliasOf = id; id = legacyTarget; } // 旧い内部 id（rumble-slot）も 1 版のあいだ受ける
    const mode = params.mode;
    const hub = await readHub();
    const rows = visiblePlugins(hub.plugins);
    let row = null;
    for (let i = 0; i < rows.length; i += 1) {
      if (String(rows[i].id) === id) { row = rows[i]; break; }
    }
    if (!row) return { ok: false, error: 'unknown-plugin' };
    if (mode !== 'legacy' && hiddenIds().indexOf(id) !== -1) return { ok: false, error: 'hidden' };
    const external = row.source === 'user';
    // 開発者モードがオフのとき、内蔵・作者用を legacy 以外にするのは断る。外から入れたものは下の id の入力で守る（上級の画面から動かせる）。
    if (!auditName && !devModeOn() && mode !== 'legacy' && !external) return { ok: false, error: 'dev-only' };
    // 外から入れたものを動かす道は modes.set（auditName なし）だけ。ほかの呼び口は confirmName を自動で入れるので断る（★2 M4）。
    if (external && mode !== 'legacy' && auditName) return { ok: false, error: 'external-needs-modes-set' };
    // 外から入れたものは動かすたびに本人が id を入力する（shadow も live も。コードが動くため）。確認の省略・設定による免除・一括の自動入力は効かない。
    if (external && mode !== 'legacy' && params.confirmName !== id) return { ok: false, error: 'confirm-name' };
    if (mode === 'live') {
      // confirmLive:false（開発中）のときは id の入力を求めない。既定は求める。docs/FROZEN.md
      // confirmLive が有効でも、外へ何も書かない live（コメントを読むだけの受け取り）は、呼ぶ側が skipConfirm で確認を省ける。
      if (!external && src.confirmLive !== false && params.confirmName !== id && params.confirmName !== aliasOf && params.skipConfirm !== true) return { ok: false, error: 'confirm-name' };
      const needs = missingRequires(rows, id);
      if (!needs.met) return { ok: false, error: 'requires-unmet' };
    }
    const wrote = setPluginMode(src.core, id, mode);
    if (!wrote.ok) return { ok: false, error: wrote.error || 'failed' };
    const fromMode = wrote.from || (isMode(row.mode) ? row.mode : '');
    auditModes(ctx, auditName || 'modes.set', ['id:' + id, 'from:' + auditToken(fromMode), 'to:' + mode]);
    publishModes(id, mode);
    // 外から入れたものは、legacy のあいだ読み込まれていない。モードを変えたら読み直す（動かす／止める）。
    if (external && src.pluginRegistry && typeof src.pluginRegistry.reload === 'function') {
      try { await src.pluginRegistry.reload(id); } catch (_) { /* モードは書けている。読み込みの失敗は一覧の状態に出る */ }
    }
    return aliasOf ? { ok: true, id: id, mode: mode, aliasOf: aliasOf } : { ok: true, id: id, mode: mode };
  }

  async function setSwitch(params, ctx, auditName) {
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    const id = params.id;
    const hub = await readHub();
    const rows = visiblePlugins(hub.plugins);
    let row = null;
    for (let i = 0; i < rows.length; i += 1) {
      if (String(rows[i].id) === id) { row = rows[i]; break; }
    }
    if (!row) return { ok: false, error: 'unknown-plugin' };
    const on = params.on === true;
    if (on) {
      // 外から入れたものをオンにする道は modes.set だけ。オフはどの道でも通す
      if (row.source === 'user') return { ok: false, error: 'bad-id' };
      if (hiddenIds().indexOf(id) !== -1) return { ok: false, error: 'hidden' };
      if (src.confirmLive !== false && params.confirmName !== id && params.skipConfirm !== true) return { ok: false, error: 'confirm-name' };
      const needs = missingRequires(rows, id);
      if (!needs.met) return { ok: false, error: 'requires-unmet' };
    }
    const wrote = setPluginMode(src.core, id, on ? 'live' : 'legacy');
    if (!wrote.ok) return { ok: false, error: wrote.error || 'failed' };
    auditModes(ctx, auditName || 'sites.setSwitch', ['id:' + id, 'on:' + (on ? '1' : '0')]);
    publishModes(id, on ? 'live' : 'legacy');
    if (row.source === 'user' && !on && src.pluginRegistry && typeof src.pluginRegistry.reload === 'function') {
      try { await src.pluginRegistry.reload(id); } catch (_) { /* オフは書けている。読み込みの失敗は一覧の状態に出る */ }
    }
    return { ok: true, id: id, on: on };
  }

  // 作者用の配り物か（plugins-author がある exe）。段階が未設定のとき、作者の日常を初級に落とさない。
  function authorBuildOn() {
    try {
      const paths = src.pluginRegistry && src.pluginRegistry.paths;
      if (!paths) return false;
      if (typeof paths.authorBuild === 'boolean') return paths.authorBuild;
      return !!paths.authorRoot && fs.existsSync(paths.authorRoot);
    } catch (_) { return false; }
  }

  // 画面の設定の見せ方。uiLevel が未設定なら、開発者モードか作者用の配り物は advanced（今の画面のまま）、そうでなければ basic。
  // テーマ（V8）。検査を通ったデータだけのプラグイン（kind:theme）が選べる。読めない・消えた・壊れたときは同梱の既定の見た目に戻す（画面を壊さない）。
  function listThemes() {
    const rows = typeof src.dataPlugins === 'function' ? src.dataPlugins('theme') : [];
    return rows.filter((r) => r && r.theme).map((r) => ({ id: r.id, source: r.source, isDefault: r.isDefault === true, label: r.theme.label, colorScheme: r.theme.colorScheme, theme: r.theme }));
  }

  function storedThemeId() {
    try { return src.uiSettings && typeof src.uiSettings.getView === 'function' ? String(src.uiSettings.getView().theme || '') : ''; } catch (_) { return ''; }
  }

  function themeView(wanted) {
    const all = listThemes();
    const hit = all.find((t) => t.id === wanted) || all.find((t) => t.isDefault) || null;
    const t = hit ? hit.theme : { label: '', colorScheme: 'dark', font: 'default', fontScale: 1, vars: Object.assign({}, THEME_DEFAULTS) };
    return {
      id: hit ? hit.id : '',
      label: t.label,
      colorScheme: t.colorScheme,
      font: t.font,
      fontScale: t.fontScale,
      vars: Object.assign({}, t.vars),
      themes: all.map((x) => ({ id: x.id, label: x.label, colorScheme: x.colorScheme, source: x.source }))
    };
  }

  function uiSettingsView(got) {
    const row = got && typeof got === 'object' ? got : {};
    const set = row.uiLevel === 'basic' || row.uiLevel === 'standard' || row.uiLevel === 'advanced';
    return {
      showExperimental: row.showExperimental === true,
      uiLevel: resolveUiLevel(set ? row.uiLevel : '', { devMode: devModeOn(), authorBuild: authorBuildOn() }),
      uiLevelSet: set,
      distribution: src.distribution === 'core' ? 'core' : 'full',
      readable: row.readable !== false,
      setupDone: row.setupDone === true,
      fanoutAck: row.fanoutAck === true,
      // タイマーの自動送信の予約の送り先（K3）。控えが無い（旧い確認）ときは null
      fanoutAckLiveIds: Array.isArray(row.fanoutAckLiveIds) ? row.fanoutAckLiveIds.slice() : null,
      setupStep: Number.isInteger(row.setupStep) ? row.setupStep : 0,
      setupSkipped: Array.isArray(row.setupSkipped) ? row.setupSkipped.slice() : [],
      setupSites: Array.isArray(row.setupSites) ? row.setupSites.slice() : [],
      // tips プラグインが初回だけ旧い置き場から写すための写し（K3。読むだけ）
      completedStreams: Number.isInteger(row.completedStreams) ? row.completedStreams : 0,
      tipsDone: Array.isArray(row.tipsDone) ? row.tipsDone.slice() : [],
      tipPending: typeof row.tipPending === 'string' ? row.tipPending : '',
      features: Array.isArray(row.features) ? row.features.slice() : []
    };
  }

  function showExperimental() {
    try { return !!(src.uiSettings && src.uiSettings.get().showExperimental === true); } catch (_) { return false; }
  }

  // 今の段階（保存した値、無ければ既定）。レジストリの tierFor（electron-main）も同じ resolveUiLevel を使う。
  function currentUiLevel() {
    let stored = '';
    try { stored = src.uiSettings && typeof src.uiSettings.getView === 'function' ? src.uiSettings.getView().uiLevel : ''; } catch (_) { stored = ''; }
    return resolveUiLevel(stored, { devMode: devModeOn(), authorBuild: authorBuildOn() });
  }

  // 保存されている段階の生の値（未保存なら ''）
  function storedUiLevel() {
    try { return src.uiSettings && typeof src.uiSettings.getView === 'function' ? String(src.uiSettings.getView().uiLevel || '') : ''; } catch (_) { return ''; }
  }

  // レジストリが最後に反映した段階。レジストリが答えなければ今の段階。
  function appliedUiLevel() {
    const reg = src.pluginRegistry;
    if (reg && typeof reg.appliedTier === 'function') {
      try { const v = reg.appliedTier(); if (v === 'basic' || v === 'standard' || v === 'advanced') return v; } catch (_) { /* 今の段階を使う */ }
    }
    return currentUiLevel();
  }

  // 段階を変えたあとのプラグインの読み込みの反映。レジストリが無い（試験など）ときは何もしない。
  // keepObs: 配信中・配信中か分からないとき true。OBS を握る自動枠取りだけ今のまま、ほかは段階どおりに入れ替える。
  async function applyTierNow(keepObs) {
    const reg = src.pluginRegistry;
    if (!reg || typeof reg.applyTier !== 'function') return { ok: true, deferred: [] };
    let out;
    try { out = await reg.applyTier({ keepObs: keepObs === true }); } catch (_) { return { ok: false, error: 'failed' }; }
    if (!out || out.ok !== true) return { ok: false, error: out && out.error ? out.error : 'failed' };
    publishModes('*', ''); // 画面・ホットキーが読み直す（modes.changed を聞いているものが追いつく）
    return { ok: true, deferred: Array.isArray(out.deferred) ? out.deferred : [] };
  }

  // 段階の反映を先送りしている id（自動枠取り）
  function pendingTierIds() {
    const reg = src.pluginRegistry;
    if (!reg || typeof reg.pendingTier !== 'function') return [];
    try { return reg.pendingTier(); } catch (_) { return []; }
  }

  // 先送りがあって、いま動かしてよい（配信中でない）なら追いつく。画面の設定を読む・書くときに呼ぶ。
  async function catchUpTier() {
    if (pendingTierIds().length === 0) return [];
    if (!(await obsHoldersSafe())) return pendingTierIds();
    const out = await applyTierNow(false);
    return out.ok ? [] : pendingTierIds();
  }

  // いま OBS を握るもの（自動枠取り）を動かしてよいか。配信中でも、配信中か分からないときでも false。
  async function obsHoldersSafe() {
    const hub = await readHub();
    return hub.known && hub.liveCount === 0;
  }

  // 一般の画面に出してよいか。開発者モードなら全部。そうでなければ audience が public で、stable か「試験中も表示する」がオン。
  function rowVisible(row) {
    if (devModeOn()) return true;
    const audience = row && typeof row.audience === 'string' ? row.audience : 'public';
    if (audience !== 'public') return false;
    const stability = row && row.stability === 'experimental' ? 'experimental' : 'stable';
    return stability === 'stable' || showExperimental();
  }

  function withVisible(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map(function (row) { return Object.assign({}, row, { visible: rowVisible(row) }); });
  }

  async function setSend(params, ctx) {
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    const id = params.id;
    const hub = await readHub();
    const rows = visiblePlugins(hub.plugins);
    let row = null;
    for (let i = 0; i < rows.length; i += 1) {
      if (String(rows[i].id) === id) { row = rows[i]; break; }
    }
    // 対象は「サイトの説明（site）を持つ site-*」で、一般に見えるものだけ。sink・chat・obs-engine などは対象外。
    const eligible = row && /^site-/.test(id) && row.site && row.audience === 'public'
      && (row.stability !== 'experimental' || showExperimental());
    if (!eligible) return { ok: false, error: 'bad-id' };
    return setSwitch({ id: id, on: params.send === true, confirmName: params.confirmName }, ctx, 'sites.setSend');
  }

  // コメントの書き込み（sink-<サイト>）のオン・オフ（R25。M7 の答え）。送信のコードは増やさず、役目のオン・オフだけを切り替える。
  // オン: site-<サイト> がオン（送るがオン）・sink-<サイト> がある・ログイン済み・公開（試験中は「試験中も表示する」のとき）。オフは条件なし。
  async function setCommentSend(params, ctx) {
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    const site = String(params.site || '');
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(site)) return { ok: false, error: 'bad-id' };
    const hub = await readHub();
    const rows = visiblePlugins(hub.plugins);
    const find = function (id) {
      for (let i = 0; i < rows.length; i += 1) if (String(rows[i].id) === id) return rows[i];
      return null;
    };
    const siteRow = find('site-' + site);
    const sinkRow = find('sink-' + site);
    const open = function (row) {
      return !!row && row.audience === 'public' && (row.stability !== 'experimental' || showExperimental());
    };
    if (!open(sinkRow) || !siteRow || !siteRow.site || !open(siteRow)) return { ok: false, error: 'bad-id' };
    if (params.on === true) {
      if (siteRow.mode !== 'live') return { ok: false, error: 'send-off' };
      const login = await callInternal('sites.loginStatus', {});
      if (!login || login.ok !== true) return { ok: false, error: 'unavailable' };
      const state = login && login.ok === true && Array.isArray(login.sites)
        ? (login.sites.filter(function (r) { return r && r.id === site; })[0] || {}).state
        : '';
      if (state !== 'logged-in') return { ok: false, error: 'not-logged-in' };
    }
    return setSwitch({ id: 'sink-' + site, on: params.on === true, confirmName: params.confirmName }, ctx, 'sites.setCommentSend');
  }

  async function setReceive(params, ctx) {
    // 2026-10-07 ユーザー決定: 丸ストは当面コメントを受け取らない（受信は全部わんコメ）。将来のために仕組みは残し、既定では止める。
    if (src.receiveEnabled !== true) return { ok: false, error: 'receive-disabled' };
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    const site = params.site;
    const hub = await readHub();
    const rows = visiblePlugins(hub.plugins);
    let row = null;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].chatSource === site && /^chat-/.test(String(rows[i].id))) { row = rows[i]; break; }
    }
    const eligible = row && row.audience === 'public' && (row.stability !== 'experimental' || showExperimental());
    if (!eligible) return { ok: false, error: 'bad-id' };
    // 受け取りは読むだけで、外へ何も書かない。確認の文字を自動で埋めるのではなく、確認を省くと明示して渡す。
    return setSwitch({ id: row.id, on: params.receive === true, skipConfirm: true }, ctx, 'sites.setReceive');
  }

  async function setAutoSlot(params, ctx) {
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    const id = 'slot-' + params.site;
    const hub = await readHub();
    const rows = visiblePlugins(hub.plugins);
    const row = rows.find(function (r) { return String(r.id) === id; });
    if (!row || !rowVisible(row)) return { ok: false, error: 'bad-id' };
    // 枠を作る・終わらせるのは外へ書く操作。確認の文字は画面の確認ダイアログで済ませてあり、API では id を明示して通す。
    return setSwitch({ id: id, on: params.enabled === true, confirmName: id }, ctx, 'sites.setAutoSlot');
  }

  function setObsControl(params, ctx) {
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    const mode = params.enabled === true ? 'live' : 'legacy';
    const ids = ['obs-engine', 'broadcast'];
    for (let i = 0; i < ids.length; i += 1) {
      const wrote = setPluginMode(src.core, ids[i], mode);
      if (!wrote.ok) return { ok: false, error: wrote.error || 'failed' };
      auditModes(ctx, 'obs.setControl', ['id:' + ids[i], 'from:' + auditToken(wrote.from), 'to:' + mode]);
      publishModes(ids[i], mode);
    }
    return { ok: true, enabled: params.enabled === true };
  }

  function obsControlOn() {
    if (!modesReady()) return false;
    const read = readModesDocument(src.core);
    return explainMode('obs-engine', read, false, 'legacy').mode === 'live';
  }

  async function setDefault(params, ctx) {
    if (!modesReady()) return { ok: false, error: 'unavailable' };
    if (src.orchestrator && typeof src.orchestrator.modesPluginOn === 'function' && src.orchestrator.modesPluginOn() === false) {
      return { ok: false, error: 'unavailable' };
    }
    if (params.mode === 'live') return { ok: false, error: 'live-default' };
    const wrote = setDefaultMode(src.core, params.mode);
    if (!wrote.ok) return { ok: false, error: wrote.error || 'failed' };
    auditModes(ctx, 'modes.setDefault', ['id:*', 'from:' + auditToken(wrote.from), 'to:' + params.mode]);
    publishModes('*', params.mode);
    return { ok: true, mode: params.mode };
  }

  function settingsTool() {
    return createSettingsExport({
      core: src.core,
      layouts: src.layouts,
      store: src.store,
      hotkeys: typeof src.getHotkeys === 'function' ? src.getHotkeys() : null,
      appSettings: src.appSettings,
      now: function () { return new Date(clock()); }
    });
  }

  function migrationTool() {
    return createMigrationBundle({
      core: src.core,
      secrets: src.secrets || null,
      // 引っ越しの書き出しは全部の名前を読む（合言葉つきの暗号化・ウィンドウだけ）。読み手の範囲は核のここで決める
      reader: src.secrets && typeof src.secrets.coreReader === 'function' ? src.secrets.coreReader('migration', () => true) : null,
      settingsTool: settingsTool,
      isLive: function () {
        const current = engine();
        return !!(current && typeof current.anyOutputLive === 'function' && current.anyOutputLive());
      },
      now: function () { return new Date(clock()); }
    });
  }

  function diagnosticsInput() {
    let current = null;
    if (src.engine) current = src.engine;
    else if (registry && typeof registry.only === 'function') {
      try { current = registry.only(); } catch (_) { current = null; }
    }
    const engines = registry && typeof registry.list === 'function' && typeof registry.get === 'function' ? registry : null;
    return {
      now: clock,
      startedAt: src.startedAt,
      uptimeMs: src.uptimeMs,
      gateway: src.gateway,
      registry: src.pluginRegistry || null,
      orchestrator: src.orchestrator || null,
      engines: engines,
      engine: current,
      vault: src.secrets || null,
      store: src.store || null,
      core: src.core || null,
      getState: typeof src.getState === 'function' ? src.getState : null,
      logStat: src.logStat,
      stateReader: src.stateReader,
      modesReader: src.modesReader,
      plugins: src.plugins,
      skipNetwork: src.skipNetwork === true,
      skipDisk: src.skipDisk === true
    };
  }
  // devMode の仕組みが渡されていないとき（古いテストなど）はオン扱い。electron-main は必ず渡す。
  function devModeOn() {
    const dm = src.devMode;
    if (!dm || typeof dm.get !== 'function') return true;
    try { return dm.get().devMode === true; } catch (_) { return false; }
  }

  const table = {};
  // 名前空間ごとの実装（host/core/api/ns/<名前>.js）は、この道具箱 S から createApi の中の関数を受け取る
  const S = {
    appliedUiLevel,
    applyTierNow,
    approvals,
    call,
    callInternal,
    catchUpTier,
    cleanIds,
    collectFeatures,
    currentUiLevel,
    destinationControl,
    destinationRows,
    devModeOn,
    diagnosticsInput,
    enabledDestinationIds,
    engine,
    holdsObsId,
    installPublic,
    installerReady,
    listModes,
    listPlugins,
    listSets,
    listThemes,
    loginReadAllowed,
    migrationTool,
    modesReady,
    obsControlOn,
    obsHoldersSafe,
    packMissing,
    pluginInspect,
    pluginInstall,
    pluginReload,
    publicDestination,
    publishDev,
    publishModes,
    readHub,
    registry,
    reloadRow,
    rowHidden,
    runPreflight,
    safeToken,
    setAutoSlot,
    setCommentSend,
    setDefault,
    setFeature,
    setHidden,
    setMode,
    setObsControl,
    setReceive,
    setSend,
    setSet,
    settingsTool,
    showExperimental,
    src,
    storedThemeId,
    storedUiLevel,
    table,
    themeView,
    uiSettingsView,
    visiblePlugins,
    withVisible
  };
  const runs = Object.assign({}, ...nsList.map((ns) => ns.runs(S)));

  const specNames = Object.keys(SPECS);
  for (let i = 0; i < specNames.length; i += 1) {
    const method = specNames[i];
    if (typeof runs[method] !== 'function') throw new Error('missing run ' + method);
    table[method] = withRun(method, runs[method]);
  }

  function record(method, row, params, ctx, result) {
    if (!shouldRecord(method, row, ctx)) return;
    const ok = !!(result && result.ok === true);
    let paramNames;
    if (row.pluginId && result && Array.isArray(result.auditNames)) {
      // プラグインが「監査に残す名前」を答えに添えたとき（ファイル名など）。形の合うものだけ・32 件まで
      paramNames = result.auditNames.filter(function (n) { return typeof n === 'string' && /^[A-Za-z0-9._\/-]{1,80}$/.test(n); }).slice(0, 32);
    } else {
      const names = Object.keys(asObject(params));
      paramNames = method === 'modes.set'
        ? names.filter(function (name) { return name !== 'confirmName'; })
        : names;
    }
    audit.write({
      clientId: ctx && ctx.clientId ? ctx.clientId : '',
      kind: ctx && ctx.kind ? ctx.kind : '',
      method: method,
      paramNames: paramNames,
      ok: ok,
      error: ok ? '' : auditError(result)
    });
  }

  async function dispatch(name, row, params, ctx, granted) {
    if (granted.indexOf(CHAT_WRITE) !== -1 && name !== 'chat.publish' && row.permission !== 'read') {
      return { ok: false, error: 'forbidden' };
    }
    if (granted.indexOf(row.permission) === -1) return { ok: false, error: 'forbidden' };
    if (row.windowOnly && (!ctx || ctx.clientId !== WINDOW_ID)) return { ok: false, error: 'forbidden' };
    const problem = validateParams(row.params, params);
    if (problem) return { ok: false, error: problem };
    if (!devModeOn() && (row.devOnly === true
      || (name === 'modes.setDefault' && asObject(params).mode !== 'legacy'))) {
      return { ok: false, error: 'dev-only' };
    }
    if (ctx && ctx.requiresApproval === true && row.permission === 'emergency') {
      return { ok: false, error: 'forbidden' };
    }
    if (ctx && ctx.requiresApproval === true && row.noApproval !== true && row.permission === 'write' && ctx.approved !== true) {
      return approvals.hold({
        method: name,
        params: cloneParams(params),
        ctx: plainCtx(ctx, granted),
        clientId: ctx.clientId || '',
        kind: ctx.kind || ''
      });
    }
    const nextCtx = Object.assign({}, ctx || {}, { permissions: granted.slice() });
    return await row.run(asObject(params), nextCtx);
  }

  // 機能のプラグイン（manifest.feature）が出した行と、本体の行のうち featurePlugin を持つものは、
  // そのプラグインを切っている（legacy）あいだ無いものとして扱う（V2-15・V3-13）。
  // memo は 1 回の api.describe の中で id ごとにモードの答えを覚える（call からは渡さない）
  function rowHidden(row, memo) {
    if (!row) return false;
    const id = row.featurePlugin || (row.modeGated === true ? row.pluginId : '');
    if (!id) return false;
    if (memo && Object.prototype.hasOwnProperty.call(memo, id)) return memo[id];
    const orch = src.orchestrator;
    const read = orch && (typeof orch.modeSetting === 'function' ? orch.modeSetting : orch.modeFor);
    let hidden = false;
    if (typeof read === 'function') {
      try { hidden = read.call(orch, id) === 'legacy'; } catch (_) { hidden = false; }
    }
    // 今の段階では読み込まない印のプラグインも、切ってあるのと同じに扱う（V5）
    const reg = src.pluginRegistry;
    if (!hidden && reg && typeof reg.tierBlocked === 'function') {
      try { hidden = reg.tierBlocked(id) === true; } catch (_) { hidden = false; }
    }
    if (memo) memo[id] = hidden;
    return hidden;
  }

  async function call(method, params, ctx) {
    const name = typeof method === 'string' ? method : '';
    const row = table[name];
    if (!row || rowHidden(row)) return { ok: false, error: 'unknown-method' };
    const granted = ctx && Array.isArray(ctx.permissions) ? ctx.permissions : IPC_PERMISSIONS.slice();
    let result;
    try {
      result = await dispatch(name, row, params, ctx, granted);
    } catch (_) {
      result = { ok: false, error: 'failed' };
    }
    record(name, row, params, ctx, result);
    return result;
  }

  // サイトごとのログイン状態を読めるのは、窓と内蔵プラグインだけ（sites.loginStatus は windowOnly のまま。プラグインは windowOnly の行を呼べないので、この 2 つの read を通す）
  function loginReadAllowed(ctx) {
    return !!ctx && (ctx.clientId === WINDOW_ID || ctx.kind === 'plugin');
  }

  // 内蔵プラグインの ctx.api.call（V2-1）。registry だけが呼ぶ。名前の許可（manifest の api.calls）は registry が見る。
  // 引数の検査・開発者モードの門・監査は call → dispatch のまま。呼べないもの: プラグインが出した行（自分を含む）・windowOnly・read/write 以外の権限
  async function callAs(pluginId, method, params, grants) {
    if (typeof pluginId !== 'string' || !ID_RE.test(pluginId)) return { ok: false, error: 'forbidden' };
    const named = checkPluginCall(method);
    if (!named.ok) return { ok: false, error: named.error };
    const row = table[method];
    if (!row) return { ok: false, error: 'unknown-method' };
    if (row.pluginId || row.windowOnly === true || (row.permission !== 'read' && row.permission !== 'write')) {
      return { ok: false, error: 'forbidden' };
    }
    return call(method, cloneParams(params), {
      kind: 'plugin',
      clientId: 'plugin:' + pluginId,
      requiresApproval: false,
      permissions: ['read', 'write'],
      titleReserved: !!(grants && grants.titleReserved === true)
    });
  }

  // 核が、プラグインが出した read の API を呼ぶ内部の呼び出し（K3）。名前は核が持つ一覧だけ。外から渡された名前は通さない・書き込みは呼べない。
  // 切（legacy）・無いプラグインの行は unknown-method（呼ぶ側の核は「無い」として扱う）。権限と窓の判定は核の側なので通す。
  async function callInternal(name, params) {
    if (!Object.prototype.hasOwnProperty.call(INTERNAL_READS, name)) return { ok: false, error: 'forbidden' };
    const row = table[name];
    if (!row || row.builtin !== true || !Array.isArray(row.roles) || row.roles.indexOf(INTERNAL_READS[name]) === -1 || row.permission !== 'read' || rowHidden(row)) return { ok: false, error: 'unknown-method' };
    try {
      return await row.run(asObject(cloneParams(params)), { kind: 'core', clientId: '#core', permissions: ['read'] });
    } catch (_) {
      return { ok: false, error: 'failed' };
    }
  }

  function registerPluginAction(pluginId, actionName, permission, handler) {
    if (!ID_RE.test(pluginId) || !ACTION_RE.test(actionName)) return { ok: false, error: 'bad-action' };
    if (permission !== 'read' && permission !== 'write') return { ok: false, error: 'bad-permission' };
    if (typeof handler !== 'function') return { ok: false, error: 'bad-handler' };
    const method = 'plugin.' + pluginId + '.' + actionName;
    table[method] = {
      permission: permission,
      windowOnly: false,
      description: 'プラグイン ' + pluginId + ' の ' + actionName,
      params: {},
      pluginId: pluginId,
      run: function (params) { return handler(params); }
    };
    return { ok: true, method: method };
  }

  const namespaceOwner = {};

  // プラグインが ctx.api.register で出す API（registry だけが呼ぶ）。権限・承認・記録は dispatch のまま
  function registerPluginMethod(pluginId, method, opts, handler, meta) {
    const checked = checkPluginMethod(pluginId, method, opts, handler);
    if (!checked.ok) return { ok: false, error: checked.error };
    const ns = checked.ns;
    const given = checked.given;
    const rules = checked.rules;
    if (table[method] || (namespaceOwner[ns] && namespaceOwner[ns] !== pluginId)) return { ok: false, error: 'taken' };
    const audience = meta && typeof meta.audience === 'string' ? meta.audience : '';
    const timeoutMs = typeof src.pluginMethodTimeoutMs === 'number' && src.pluginMethodTimeoutMs > 0 ? src.pluginMethodTimeoutMs : PLUGIN_METHOD_TIMEOUT_MS;
    table[method] = {
      permission: given.access,
      windowOnly: given.windowOnly === true,
      devOnly: audience === 'dev' || audience === 'author',
      modeGated: !!(meta && meta.modeGated === true),
      builtin: !!(meta && meta.builtin === true),
      roles: meta && Array.isArray(meta.roles) ? meta.roles.slice() : [],
      noApproval: false,
      description: given.description || ('プラグイン ' + pluginId + ' の ' + method),
      params: rules,
      pluginId: pluginId,
      run: async function (params, ctx) {
        const info = Object.freeze({ kind: ctx && ctx.kind ? ctx.kind : '', clientId: ctx && ctx.clientId ? ctx.clientId : '' });
        let timer = null;
        const guard = new Promise(function (resolve) {
          timer = setTimeout(function () { resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
        });
        try {
          const result = await Promise.race([Promise.resolve().then(function () { return handler(cloneParams(params), info); }), guard]);
          if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') return { ok: false, error: 'bad-result' };
          return withoutSecrets(result);
        } finally {
          clearTimeout(timer);
        }
      }
    };
    namespaceOwner[ns] = pluginId;
    return { ok: true, method: method };
  }

  function unregisterPlugin(pluginId) {
    const prefix = 'plugin.' + pluginId + '.';
    const names = Object.keys(table);
    for (let i = 0; i < names.length; i += 1) {
      if (names[i].indexOf(prefix) === 0 || table[names[i]].pluginId === pluginId) delete table[names[i]];
    }
    Object.keys(namespaceOwner).forEach(function (ns) {
      if (namespaceOwner[ns] === pluginId) delete namespaceOwner[ns];
    });
  }

  return {
    call: call,
    get methods() {
      return Object.keys(table);
    },
    permissionFor: function (method) {
      const row = table[method];
      return row ? row.permission : '';
    },
    registerPluginAction: registerPluginAction,
    registerPluginMethod: registerPluginMethod,
    callAs: callAs,
    callInternal: callInternal,
    unregisterPlugin: unregisterPlugin,
    parsePluginMethod: parsePluginMethod
  };
}

module.exports = { createApi, CORE_NAMESPACES, checkPluginMethod, validate, IPC_PERMISSIONS, EXT_WRITE, CHAT_WRITE, PERMISSIONS, PROTOCOLS, parsePluginMethod };
