'use strict';

/**
 * サイトプラグインの二重探索。
 * 内蔵: <アプリルート>/plugins
 * 作者専用: <アプリルート>/plugins-author （あるときだけ。配る exe には入れない）
 * 外部: <STATE_DIR>/plugins （アプリ直下に state/plugins は作らない）
 * v1 で kind が site 以外は一覧に残し start しない。同一 id は内蔵が勝つ。
 * manifest v2 は runtime が inproc なら kind が ui / integration でも起動する。
 * child / external は listed-not-started。
 * v1 は読み込み時に provides へ写す。manifest ファイルは書き換えない。
 * load / start / stop / destroy には同じ ctx を渡す。
 * ctx.chat.ingest は provides に chat.source@1 があるときだけ。source はプラグイン id に固定する。
 * ctx.destinations.list は id, site, accountId, enabled, engine.id, actual.engineState, actual.siteLive だけ。
 * ctx.secrets.set は manifest の secrets に書いた名前だけ。監査には名前だけ残し、値はログに出さない。
 * ctx.obs の読むメソッドは needs の obs.read と createRegistry({ obsRead })、開始・停止は needs の obs.streamControl と createRegistry({ obsControl })。二つは別の口。
 */

const fs = require('fs');
const path = require('path');
const { run, defaultLogger, resolveSetDirs, isAuthorBuild } = require('../core');
const { cleanText, cleanError } = require('./plugin-errors');
const { createOverlayHub } = require('./overlay-hub');
const { createUnavailableProvider } = require('../core');
const { ID_RE } = require('./plugin-surface');
const manifestPart = require('./registry/manifest');
const { createContext } = require('./registry/context');
const { createDiscover } = require('./registry/discover');
const { createWiring } = require('./registry/wiring');
const { createGates } = require('./registry/gates');
const { createLifecycle } = require('./registry/lifecycle');
const { createReload } = require('./registry/reload');
const { EXT_PROVIDES_NOT_ALLOWED, LOG_BOX_LINES, LOG_LINE_CHARS, externalGuard, externalIdProblem, externalSecretOk } = manifestPart;

/** みんなのプラグインの置き場。隣の marust-plugins/plugins/（開発中）。配る exe では探さない。無ければ ''。 */
function defaultCommunityRoot(appRoot) {
  // 配る exe（resources/app）では隣のフォルダに切り替えない（並べて clone された外のプラグインに内蔵の窓口を渡さない・Q14）。
  if (/[\\/]resources[\\/]app(\.asar)?$/.test(path.resolve(appRoot))) return '';
  const sibling = path.join(appRoot, '..', 'marust-plugins', 'plugins');
  return fs.existsSync(sibling) ? sibling : '';
}

function createRegistry(options) {
  const opts = options || {};
  if (!opts.core || !opts.core.STATE_DIR) {
    throw new Error('registry requires core.STATE_DIR');
  }
  if (!opts.appRoot) {
    throw new Error('registry requires appRoot');
  }

  const logger = opts.logger || defaultLogger;
  const runner = opts.run || run;
  const externalRoot = opts.externalRoot || path.join(opts.core.STATE_DIR, 'plugins');
  // セットの置き場（計画 C・D6。host/core/set-dirs.js）。試験が builtinRoot・authorRoot・communityRoot を渡したときは、その 3 つだけ（昔の決め方）。
  // 渡さないとき（本番・リポジトリの試験）は MARUST_SET_DIR → build-info.json の setDirs → exe の横の plugins/ → ソースの plugins などの順で決める。
  const explicitRoots = !!(opts.builtinRoot || opts.authorRoot || opts.communityRoot !== undefined);
  let setRoots;
  let setFrom = 'given';
  let setEnvMissing = false;
  if (opts.setDirs) setRoots = opts.setDirs.map((d) => ({ dir: d.dir, source: 'set', author: d.author === true, community: d.community === true }));
  else if (explicitRoots) {
    const communityGiven = opts.communityRoot !== undefined ? opts.communityRoot : (opts.builtinRoot ? '' : defaultCommunityRoot(opts.appRoot));
    setRoots = [
      { dir: opts.builtinRoot || path.join(opts.appRoot, 'plugins'), source: 'set', author: false, community: false },
      { dir: communityGiven, source: 'set', author: false, community: true },
      { dir: opts.authorRoot || path.join(opts.appRoot, 'plugins-author'), source: 'set', author: true, community: false }
    ].filter((row) => row.dir);
  } else {
    const resolved = resolveSetDirs({ appRoot: opts.appRoot, env: opts.env });
    setRoots = resolved.dirs;
    setFrom = resolved.from;
    setEnvMissing = resolved.envMissing === true;
  }
  const firstDir = (pick) => { const row = setRoots.find(pick); return row ? row.dir : ''; };
  const builtinRoot = firstDir((r) => !r.author && !r.community);
  const authorRoot = firstDir((r) => r.author);
  const communityRoot = firstDir((r) => r.community);
  const rootOf = { user: externalRoot };
  const core = opts.core;

  const records = [];
  const byId = new Map();
  const events = [];
  const overlayHub = opts.overlayHub || createOverlayHub();
  const secretProvider = opts.secrets && typeof opts.secrets.getFor === 'function'
    ? opts.secrets
    : createUnavailableProvider();
  // 持ち主の判定は金庫（核）が、ここで 1 回だけ渡した宣言（manifest の secrets）から決める
  if (typeof secretProvider.bindDeclared === 'function') {
    secretProvider.bindDeclared((id) => {
      const found = byId.get(id) || records.find((r) => r.id === id);
      return found && found.manifest && Array.isArray(found.manifest.secrets) ? found.manifest.secrets : [];
    });
  }
  const modeFor = typeof opts.modeFor === 'function' ? opts.modeFor : null;
  // 今の段階を返す関数（'basic' | 'standard' | 'advanced'）。無ければ上級＝段階で止めない（試験・CLI の骨格）。
  const tierFor = typeof opts.tierFor === 'function' ? opts.tierFor : null;
  // 開発者モードか返す関数。audience が dev のプラグインは段階ではなく、これで読み込むかを決める（V6）。無ければ段階で決める（試験・CLI の骨格）。
  const devModeFor = typeof opts.devModeFor === 'function' ? opts.devModeFor : null;
  // 起動前フック（manifest の boot）に渡す口を作る関数 (id, rows) => ctx（host/core/boot-context.js）。無ければ起動前フックは動かさない（試験・CLI の骨格）。
  const bootContext = typeof opts.bootContext === 'function' ? opts.bootContext : null;
  const bootResults = [];
  // セッションの口（K3）。opts.sessions があればそれ（試験・古い呼び方）。無ければ、provides に session.store@1 を持つ running の内蔵の controller。
  // 切（legacy）のあいだは無い（空の object）。呼ぶ側は typeof で見て 'unavailable' にする。
  const NO_PORT = Object.freeze({});
  function sessionsNow() { return opts.sessions || portOf('session.store@1', 'controller') || NO_PORT; }
  const appInfo = opts.app && typeof opts.app === 'object' ? opts.app : {};
  const openExternalImpl = typeof opts.openExternal === 'function' ? opts.openExternal : null;
  // ctx.keys の中身（核のキーの口。host/layer1/keys-port.js）。関数で渡す（登録簿のほうが先に作られるため）。渡す相手は needs に keys を書いたセットの最初の 1 つ（context.js の builtinHolder）
  const keysPort = () => { try { return typeof opts.keys === 'function' ? opts.keys() : opts.keys || null; } catch (_) { return null; } };
  // コメントの口（K3）。opts.chat があればそれ（試験・古い呼び方）。無ければ、provides に chat.inlet@1 を持つ running の内蔵の inlet（切のあいだは無い）。
  const NO_CHAT = Object.freeze({});
  function chatNow() { return opts.chat || portOf('chat.inlet@1', 'inlet') || NO_CHAT; }
  const obsRead = typeof opts.obsRead === 'function' ? opts.obsRead : null;
  // 配信全体の開始・停止だけの口。obsControl(action) は Promise。使えるかどうか（obs-engine が live か）は渡す側が決める。
  const obsControl = typeof opts.obsControl === 'function' ? opts.obsControl : null;

  const logBoxes = new Map();

  // provides を持つ running の「内蔵」の instance[name]（K3）。外から入れたものは選ばない（同じ provides を名乗って横取りさせない）。
  // 2 つ以上あれば使わない（plugin.logs に 1 行）。切（legacy）のものは無いものとして扱う。
  const portWarned = new Set();
  function portOf(provide, name) {
    const hit = portHit(provide, name);
    return hit ? hit.port : null;
  }
  // 口と、それを出しているプラグインの id（金庫は「選んだ置き場」の id と照らす）
  function portHit(provide, name) {
    const found = [];
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i];
      if (rec.status !== 'running' || !rec.instance || rec.source !== 'set') continue;
      const provides = rec.manifest && Array.isArray(rec.manifest.provides) ? rec.manifest.provides : [];
      if (provides.indexOf(provide) === -1) continue;
      const port = rec.instance[name];
      if (!port || typeof port !== 'object') continue;
      let mode = 'live';
      try { mode = modeFor ? modeFor(rec.id) : (rec.manifest.defaultMode || 'legacy'); } catch (_) { mode = 'legacy'; }
      // 本物の口として使うのは live だけ（shadow は本物に効かない。K3 評価 Should 2）
      if (mode !== 'live') continue;
      found.push(rec);
    }
    if (found.length > 1) {
      if (!portWarned.has(provide)) {
        portWarned.add(provide);
        for (let i = 0; i < found.length; i += 1) boxLog(found[i], 'warn', 'port ' + provide + ' has more than one provider; not used');
      }
      return null;
    }
    return found.length ? { id: found[0].id, port: found[0].instance[name] } : null;
  }

  function log(level, message) {
    logger(level, message);
  }

  // プラグインごとのログの箱（1 つ 200 行・1 行 500 文字）。絶対パスは掃除してから入れる。
  function boxLog(rec, level, text) {
    let box = logBoxes.get(rec.id);
    if (!box) { box = []; logBoxes.set(rec.id, box); }
    box.push({ at: Date.now(), level: String(level), text: cleanText(text, rec.dir, opts.appRoot).slice(0, LOG_LINE_CHARS) });
    if (box.length > LOG_BOX_LINES) box.splice(0, box.length - LOG_BOX_LINES);
  }

  function recLog(rec, level, message) {
    boxLog(rec, level, message);
    log(level, rec.id + ' ' + message);
  }

  // 親の窓が、そのプラグインの親の操作を断った記録（K3）。plugin.logs に 1 行
  function noteRefused(id, name) {
    const rec = byId.get(id) || records.find((r) => r.id === id);
    if (!rec) return { ok: false, error: 'unknown-id' };
    recLog(rec, 'warn', 'parent-action refused ' + String(name).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40));
    return { ok: true };
  }

  function logsOf(id, n) {
    const count = Number.isInteger(n) && n >= 1 ? Math.min(n, LOG_BOX_LINES) : 50;
    const box = logBoxes.get(id) || [];
    return box.slice(-count).map((row) => ({ at: row.at, level: row.level, text: row.text }));
  }

  function setLastError(rec, err) {
    rec.lastError = err ? cleanError(err, rec.dir, opts.appRoot) : null;
  }

  function inactiveSession() {
    return { active: false, title: '', state: 'none', elapsedMs: 0 };
  }

  function ensureDataDir(id) {
    const root = path.join(core.STATE_DIR, 'data', 'marust', 'plugins');
    const dir = path.resolve(root, id);
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('bad-datadir');
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 設定の置き場の名前。id が変わった役目は manifest の dataDirId で旧い名前のまま使う（rumble の slot は rumble-slot）。
  function dataDirName(rec) {
    const name = rec.source !== 'user' && rec.manifest && rec.manifest.dataDirId;
    return typeof name === 'string' && ID_RE.test(name) ? name : rec.id;
  }

  function freezeDeep(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    const keys = Object.getOwnPropertyNames(value);
    for (let i = 0; i < keys.length; i += 1) freezeDeep(value[keys[i]]);
    return Object.freeze(value);
  }

  function manifestCopy(manifest) {
    const copy = manifest ? structuredClone(manifest) : {};
    return freezeDeep(copy);
  }

  function isController(manifest) {
    const provides = manifest && Array.isArray(manifest.provides) ? manifest.provides : [];
    return provides.indexOf('session.controller@1') !== -1;
  }

  function isChatSource(manifest) {
    const provides = manifest && Array.isArray(manifest.provides) ? manifest.provides : [];
    return provides.indexOf('chat.source@1') !== -1;
  }

  // 共有の状態（旧 let 変数。部品が同じものを見るため 1 つの object にした）
  const st = { loaded: false, apiBind: null, appliedTier: null, appliedDev: null, busy: false };

  // 部品どうしの呼び合い（S.fn）。部品を作った順に関数が入る
  const fn = {};
  const S = { opts, st, fn, logger, runner, setRoots, setFrom, setEnvMissing, builtinRoot, externalRoot, authorRoot, communityRoot, rootOf, core, records, byId, events, overlayHub, secretProvider, modeFor, tierFor, devModeFor, bootContext, bootResults, NO_PORT, sessionsNow, appInfo, openExternalImpl, keysPort, NO_CHAT, chatNow, obsRead, obsControl, logBoxes, portWarned, portOf, portHit, log, boxLog, recLog, noteRefused, logsOf, setLastError, inactiveSession, ensureDataDir, dataDirName, freezeDeep, manifestCopy, isController, isChatSource, sourceOf, getRunning, dataPlugins };
  Object.assign(fn, createContext(S));
  Object.assign(fn, createDiscover(S));
  Object.assign(fn, createWiring(S));
  Object.assign(fn, createGates(S));
  Object.assign(fn, createLifecycle(S));
  Object.assign(fn, createReload(S));

  const { applyTier, attachApi, currentTier, discover, holdsObs, loadAll, pendingTier, reload, reloadAll, rescanExternal, snapshot, tierBlocked } = fn;

  function sourceOf(id) {
    const rec = byId.get(id);
    return rec ? rec.source : '';
  }

  function getRunning() {
    return records.filter((rec) => rec.status === 'running' && rec.instance);
  }

  // 検査を通ったデータだけのプラグイン（テーマ・並べ方）。画面の見た目と並べ方の見本の一覧に使う。
  function dataPlugins(kind) {
    return records
      .filter((rec) => rec.status === 'data' && byId.get(rec.id) === rec && rec.manifest && (!kind || rec.manifest.kind === kind))
      .map((rec) => ({
        id: rec.id,
        source: rec.source,
        kind: rec.manifest.kind,
        name: rec.manifest.name,
        theme: rec.manifest.theme || null,
        layout: rec.manifest.layout || null,
        set: rec.manifest.set || null,
        shell: rec.manifest.shell || null,
        for: Array.isArray(rec.manifest.for) ? rec.manifest.for.slice() : [],
        isDefault: rec.source === 'set' && rec.manifest.isDefault === true
      }));
  }

  return {
    discover,
    loadAll,
    dataPlugins,
    reload,
    reloadAll,
    rescanExternal,
    applyTier,
    pendingTier,
    bootResults: () => bootResults.slice(),
    tierBlocked,
    appliedTier: () => currentTier(),
    holdsObs,
    logsOf,
    noteRefused,
    sourceOf,
    getRunning,
    port: portOf,
    portHit: portHit,
    snapshot,
    attachApi,
    overlayHub,
    isLoaded: () => st.loaded,
    events,
    paths: { builtinRoot, authorRoot, communityRoot, externalRoot, setDirs: setRoots.map((r) => r.dir), authorBuild: typeof opts.authorBuild === 'boolean' ? opts.authorBuild : (explicitRoots ? !!authorRoot && fs.existsSync(authorRoot) : isAuthorBuild(opts.appRoot)) }
  };
}

module.exports = { createRegistry, externalGuard, externalSecretOk, externalIdProblem, EXT_PROVIDES_NOT_ALLOWED };

