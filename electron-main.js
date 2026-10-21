'use strict';

/**
 * marust（丸スト）Electron メインプロセス。
 * 旧いアプリとは別ウィンドウ／別プロセス。:18766 は触らない。
 * 起動時にプラグインを load し、同じ registry で orchestrator を 1 つ作る。
 * 画面は api.call だけ。OBS はエンジン登録表経由。初回同期のあとでセッションを復旧する。
 * タイマーは v2 プラグインとして起動する。終了時に各プラグインの destroy を呼ぶ。
 * 配信前チェックと配信開始は、登録表が揃ったあとで作り、API に渡す。
 * メインウィンドウの×で、トレイの終了と同じ後片付けをして本体も終了する。
 * 2 つ目の起動は既存のウィンドウを前に出す。自動起動は openAtLogin（既定オフ）。
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session, globalShortcut, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const { createCore } = require('./host/core');
const { createLogRetention } = require('./host/layer1/log-retention');
const { createRegistry } = require('./host/layer1/plugin-registry');
const { createObsStreamControl } = require('./host/core');
const { createOrchestrator, createPeersBridge, formatModeSummary, hubFanoutDecision, allowedLiveIdsForHub } = require('./host/layer1/orchestrator');
const { createEventBus } = require('./host/core');
const { createStateStore } = require('./host/core');
const { createFanoutReserved, coerceFanoutInput } = require('./host/layer1/fanout-gate');
const { createCaptureReceiver } = require('./host/layer1/capture-receiver');
const { productPort } = require('./host/layer1/port-lock');
const { createGateway } = require('./host/layer1/gateway');
const { createClients } = require('./host/layer1/clients');
const devAutopair = require('./host/layer1/dev-autopair');
const { createLayouts } = require('./host/layer1/layouts');
const { createDefaultRegistry } = require('./host/core');
const { createApi, IPC_PERMISSIONS } = require('./host/layer1/api');
const { createAudit } = require('./host/layer1/audit');
const { createAppInstaller } = require('./host/layer1/plugin-install-wire');
const { createBootContext } = require('./host/layer1/boot-context');
const { createModeSource } = require('./host/layer1/mode-source');
const { createDevMode } = require('./host/layer1/dev-mode');
const { createObsSetup } = require('./host/layer1/obs-setup');
const { createPluginInstaller } = require('./lib/obs-plugin-installer');
const { createUiSettings, resolveUiLevel, maxTier } = require('./host/layer1/ui-settings');
const { applyEditionDefaults } = require('./lib/edition-defaults');
const { summarizeSite } = require('./host/layer1/site-info');
const { createSiteConfig } = require('./host/layer1/site-config');
const { emergencyButtonState } = require('./host/core');
const {
  createTray,
  installSingleInstance,
  isHeadless,
  readAppSettings,
  writeAppSettings,
  applyOpenAtLogin,
  bringToFront
} = require('./host/layer1/tray');
const { createKeysPort } = require('./host/layer1/keys-port');
const { createSecretProvider } = require('./host/core');
const { createPreflight } = require('./host/core');
const { createBroadcast } = require('./host/core');
const { createChatPort } = require('./host/layer1/chat-port');
const { createHomeState } = require('./host/layer1/home-state');
const { createObservedBridge } = require('./host/core');
const { run } = require('./host/core');

const INITIAL_SYNC_MS = 10000;

// 機能の印のプラグイン（timer-link・hotkeys）が入って（legacy でなく）いるか。設定上のモードを見る（forceLegacy では変わらない。V3-4）
// 今の段階で読み込まない印のプラグイン（V5）は、切ってあるのと同じ。
function featureOn(id) {
  try {
    if (registry && typeof registry.tierBlocked === 'function' && registry.tierBlocked(id)) return false;
    return !!orchestrator && typeof orchestrator.modeSetting === 'function' && orchestrator.modeSetting(id) !== 'legacy';
  } catch (_) { return false; }
}

// 配り物の種類。exe に同梱の build-info.json の distribution が 'core'（npm run build:core）なら「本体だけ」。無ければ内蔵つき。
function readDistribution() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    return info && info.distribution === 'core' ? 'core' : 'full';
  } catch (_) { return 'full'; }
}

// プラグインを読み込む門（registry の tierFor）。max(今の段階, uiLevelMax) を使う（L7e）。画面は今の段階を使う。
function currentTier() {
  let stored = '';
  let maxStored = '';
  try {
    const view = getUiSettings().getView();
    stored = view.uiLevel;
    maxStored = view.uiLevelMax;
  } catch (_) { stored = ''; maxStored = ''; }
  let dev = false;
  try { dev = getDevMode().get().devMode === true; } catch (_) { dev = false; }
  const cur = resolveUiLevel(stored, { devMode: dev });
  return maxStored ? maxTier(cur, maxStored) : cur;
}

let hubState = null;
let mainWindow = null;
let settingsCore = null;
let registry = null;
let orchestrator = null;
let modeSource = null;
let bus = null;
let chat = null;
let homeState = null;
let observedBridge = null;
let stateStore = null;
// セッション（K3 でプラグイン session へ出した）。核が持つのは、registry が選ぶ session.store@1 の controller への薄い写しだけ。
// 切（legacy）・無いときは「進行中のセッションは無い」として答える。核の OBS エンジンと hub の状態がこれを使う。
function sessionPort() {
  try { return registry && typeof registry.port === 'function' ? registry.port('session.store@1', 'controller') : null; } catch (_) { return null; }
}
const INACTIVE_SESSION = Object.freeze({ active: false, title: '', state: 'none', elapsedMs: 0 });
const sessions = {
  view() { const p = sessionPort(); return p ? p.view() : INACTIVE_SESSION; },
  start(input) { const p = sessionPort(); return p ? p.start(input) : { ok: false, error: 'unavailable' }; },
  pause() { const p = sessionPort(); return p ? p.pause() : { ok: false, error: 'unavailable' }; },
  resume() { const p = sessionPort(); return p ? p.resume() : { ok: false, error: 'unavailable' }; },
  end(input) { const p = sessionPort(); return p ? p.end(input) : { ok: false, error: 'unavailable' }; },
  retitle(title) { const p = sessionPort(); return p ? p.retitle(title) : { ok: false, error: 'unavailable' }; },
  recover(input) { const p = sessionPort(); return p ? p.recover(input) : { ok: true, recovered: false }; },
  noteAggregate(info) { const p = sessionPort(); return p ? p.noteAggregate(info) : { ok: true, ended: false }; }
};
// 配信先の集計（ctx.destinations.aggregate）。OBS エンジンが最初の同期を終えていれば ready
function destinationAggregate() {
  const engine = engines && engines.engine;
  if (!engine || typeof engine.destinationAggregate !== 'function') return { ready: false, known: false, streaming: false, emergency: false, anyOutputLive: false };
  const row = engine.destinationAggregate();
  return { ready: row.known === true, known: row.known === true, streaming: row.streaming === true, emergency: false, anyOutputLive: row.known === true && typeof engine.anyOutputLive === 'function' && engine.anyOutputLive() === true };
}
let fanoutReserved = null;
let sessionRecovered = false;
let engines = null;
let lastHubTitle = '';
let api = null;
let hotkeys = null;
let clients = null;
let layouts = null;
let windowToken = '';
let secrets = null;
let devModeInst = null;
let obsSetup = null;
let uiSettings = null;
let pluginsClosed = false;
let quitting = false;
let trayHandle = null;
let retention = null;
let gateway = null;
const startedAt = Date.now();

// 隠した内蔵プラグイン（P3）。hub.getState のたびに全行で読まないよう、1 秒だけ覚える。
let hiddenCache = { at: 0, ids: [] };
function hiddenPluginIds() {
  const now = Date.now();
  if (now - hiddenCache.at < 1000) return hiddenCache.ids;
  let ids = [];
  try { ids = getUiSettings().getView().hiddenPlugins || []; } catch (_) { ids = []; }
  hiddenCache = { at: now, ids: ids };
  return ids;
}

function summarizePlugin(row, modeSnapshot) {
  const manifest = row.manifest || {};
  const mode = orchestrator ? orchestrator.modeFor(row.id, modeSnapshot) : 'legacy';
  return {
    // 上級の「プラグインの管理」用（P3）。秘密の名前・needs は read 権限の端末にも見えるので載せない（plugins.list だけが登録簿から引く）。
    hidden: hiddenPluginIds().indexOf(row.id) !== -1,
    id: row.id,
    name: typeof manifest.name === 'string' ? manifest.name : row.id,
    kind: typeof manifest.kind === 'string' ? manifest.kind : '',
    // 名乗り（計画 X・P1/P8。host/core/manifest-claims.js・host/core/owners.js）: 種類・効くサイト・検索の語・持ち主（内蔵だけ）。無ければ空。
    tier: typeof manifest.tier === 'string' ? manifest.tier : '',
    category: typeof manifest.category === 'string' ? manifest.category : (manifest.kind === 'theme' ? 'look' : (manifest.kind === 'layout' ? 'layout' : (manifest.kind === 'set' ? 'set' : ''))),
    for: Array.isArray(manifest.for) ? manifest.for.slice() : [],
    tags: Array.isArray(manifest.tags) ? manifest.tags.slice() : [],
    owns: row.source === 'set' && manifest.owns && typeof manifest.owns === 'object' ? { events: (manifest.owns.events || []).slice(), parentActions: (manifest.owns.parentActions || []).slice() } : null,
    source: row.source,
    community: row.community === true,
    status: row.status,
    reason: row.reason || '',
    version: typeof manifest.version === 'string' ? manifest.version : '',
    provides: Array.isArray(manifest.provides) ? manifest.provides.slice() : [],
    requires: Array.isArray(manifest.requires) ? manifest.requires.slice() : [],
    panels: Array.isArray(manifest.panels) ? manifest.panels : [],
    // 画面の差し込み口（V7。popup・settings・menu・slots・relay。形は登録簿が検査済み）
    ui: manifest.ui && typeof manifest.ui === 'object' ? manifest.ui : null,
    overlays: Array.isArray(manifest.overlays) ? manifest.overlays : [],
    subscribes: Array.isArray(manifest.subscribes) ? manifest.subscribes : [],
    // サイトのプラグイン（plugins/sites/<site>/。R16）: 同じサイトの役目の id・自分の役目・モードのキー。
    siblings: row.siteId && Array.isArray(manifest.siblings) ? manifest.siblings.slice() : [],
    role: typeof row.role === 'string' ? row.role : '',
    modeKey: typeof row.modeKey === 'string' ? row.modeKey : '',
    actions: manifest.actions && typeof manifest.actions === 'object' ? manifest.actions : {},
    mode: mode,
    // 公開版の 3 つの印（PLAN §1）。audience 既定: 作者専用の置き場なら author、そうでなければ public。stability 既定: stable。
    audience: ['public', 'dev', 'author'].indexOf(manifest.audience) !== -1 ? manifest.audience : (row.author === true ? 'author' : 'public'),
    stability: manifest.stability === 'experimental' ? 'experimental' : 'stable',
    // コメントを丸スト内で受け取るプラグインが担当するサイト（R19）。無ければ空。
    chatSource: typeof manifest.chatSource === 'string' && /^[a-z0-9-]{1,32}$/.test(manifest.chatSource) ? manifest.chatSource : '',
    // 中級の「機能」一覧の説明（PLAN-plugin-core）。無ければ null＝一覧に出ない。
    feature: manifest.feature && typeof manifest.feature === 'object' ? manifest.feature : null,
    site: summarizeSite(manifest.site, row.id, mode, manifest.secrets)
  };
}

function logLine(level, message) {
  const text = '[marust] ' + level + ' ' + (typeof message === 'string' ? message : '');
  if (level === 'error' || level === 'warn') console.error(text);
  else console.log(text);
}

function currentHubState() {
  if (!hubState) return hubState;
  const modeSnapshot = orchestrator ? orchestrator.takeSnapshot() : null;
  const summary = orchestrator
    ? orchestrator.summarizeModes(undefined, modeSnapshot)
    : { live: 0, shadow: 0, legacy: 0, forced: false, liveIds: [] };
  const mode = formatModeSummary(summary);
  const plugins = registry ? registry.snapshot().map((row) => summarizePlugin(row, modeSnapshot)) : hubState.plugins;
  const session = sessions.view();
  const destinations = stateStore ? stateStore.destinationSummary() : { count: 0 };
  const stateWarning = stateStore && typeof stateStore.warning === 'function' ? stateStore.warning() : '';
  const engineStatus = engines && engines.engine ? engines.engine.status() : { connected: false, detail: 'OBS 未接続', mode: 'legacy' };
  destinations.liveCount = Number(engineStatus.liveCount) || 0; // 上のバー右の「配信中: N か所」
  return Object.assign({}, hubState, {
    mode: mode,
    modeSummary: summary,
    plugins: plugins,
    session: session,
    timerFanout: fanoutReserved ? fanoutReserved.last() : null,
    destinations: destinations,
    stateWarning: stateWarning,
    engineStatus: engineStatus
  });
}

function getUiSettings() {
  if (!uiSettings) {
    uiSettings = createUiSettings({
      stateDir: settingsCore.STATE_DIR,
      atomicWriteJsonSync: settingsCore.atomicWriteJsonSync
    });
  }
  return uiSettings;
}

// 開発中の自動ペアリング（host/core/dev-autopair.js）。開発者モードのオン・オフに合わせて、CLI と AI（MCP）の合言葉を作る／取り消す。
function syncAutoPair() {
  try {
    return devAutopair.sync({ clients: clients, servicesDir: settingsCore.SERVICES_DIR, devModeOn: () => getDevMode().get().devMode === true });
  } catch (err) {
    console.error('[marust] auto-pair failed');
    return null;
  }
}

function getDevMode() {
  if (!devModeInst) {
    devModeInst = createDevMode({
      isPackaged: app.isPackaged,
      env: process.env,
      stateDir: settingsCore.STATE_DIR,
      atomicWriteJsonSync: settingsCore.atomicWriteJsonSync
    });
  }
  return devModeInst;
}

let obsStreamControlInst = null;
function getObsStreamControl() {
  if (!obsStreamControlInst) {
    obsStreamControlInst = createObsStreamControl({
      getOrchestrator: () => orchestrator,
      getConnection: () => (engines && engines.engine ? engines.engine.connection : null)
    });
    if (bus && typeof bus.subscribe === 'function') {
      bus.subscribe('stream.stopping', function (_name, payload) { obsStreamControlInst.onStopping(payload); });
    }
  }
  return obsStreamControlInst;
}

async function buildHubState() {
  const core = settingsCore || createCore();
  settingsCore = core;
  if (!bus) bus = createEventBus();
  // コメントの受け口はプラグイン chat-inlet（K3）。核は registry が選ぶ口への写しだけを持つ
  if (!chat) chat = createChatPort(() => registry);
  if (!homeState) homeState = createHomeState({ bus });
  if (!stateStore) stateStore = createStateStore({ core, bus });
  if (!observedBridge) observedBridge = createObservedBridge({ bus, stateStore });
  if (!secrets) {
    secrets = createSecretProvider({ core: core, logger: logLine });
    // 選んだ置き場がプラグイン（vault-store@1。内蔵だけ）のときの口。registry が読み込むまでは見つからない
    secrets.attachStore(() => (registry ? registry.portHit('vault-store@1', 'vaultStore') : null));
    try {
      const p = secrets.preloadMask();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => logLine('warn', 'vault mask preload failed: ' + (err && err.message ? err.message : String(err))));
      }
    } catch (err) {
      logLine('warn', 'vault mask preload failed: ' + (err && err.message ? err.message : String(err)));
    }
  }
  if (!registry) {
    // 起動時の移しかえ（作者の昔からの引き継ぎ）は、プラグイン dev-legacy-migrate の起動前フック（manifest の boot）。
    // registry の loadAll が、どの経路（hub.getState・MCP・タイマー）から呼ばれても、プラグインの読み込みより前に 1 回動かす。
    const bootAudit = createAudit({ core });
    if (!modeSource) modeSource = createModeSource();
    registry = createRegistry({
      core,
      appRoot: __dirname,
      tierFor: currentTier,
      bootContext: createBootContext({ core, bus, audit: bootAudit, uiSettings: getUiSettings(), logger: logLine, modeSource }),
      devModeFor: () => { try { return getDevMode().get().devMode === true; } catch (_) { return false; } },
      bus,
      keys: () => hotkeys,
      openExternal: (url) => shell.openExternal(url),
      app: { version: app.getVersion(), releasesRepo: require('./package.json').marustReleasesRepo },
      peers: createPeersBridge(() => orchestrator),
      secrets: secrets,
      aggregate: destinationAggregate,
      // 読むだけの口。GetStreamStatus 以外は拒否する（二重の安全。内側の call も読み取りだけ許可している）。
      obsRead: function (requestName) {
        if (requestName !== 'GetStreamStatus') return Promise.reject(new Error('obs-read-forbidden'));
        const connection = engines && engines.engine && engines.engine.connection;
        if (!connection || typeof connection.call !== 'function') return Promise.reject(new Error('obs-not-connected'));
        return connection.call(requestName);
      },
      // 配信全体の開始・停止だけ（プラグインの ctx.obs.streamControl）。条件は host/core/engine/obs-stream-control.js。
      obsControl: function (action) { return getObsStreamControl().control(action); },
      modeFor(id) { return orchestrator ? orchestrator.modeFor(id) : 'legacy'; },
      store: stateStore
    });
  }
  if (!orchestrator) orchestrator = createOrchestrator({ registry, core, bus, modeSource });
  // タイマーの自動送信は、プラグイン timer-link が hub.fanoutReserved で頼む。確認の門（予約）は核（K3）
  if (!fanoutReserved) {
    fanoutReserved = createFanoutReserved({
      summarize: () => orchestrator.summarizeModes({ titleTargets: true }),
      getReservation: () => {
        try { const v = getUiSettings().getView(); return { ack: v.fanoutAck === true, liveIds: v.fanoutAckLiveIds }; } catch (_) { return { ack: false, liveIds: [] }; }
      },
      setReservation: (ids) => getUiSettings().set({ fanoutAckLiveIds: ids.join(',') }),
      fanout: (payload) => fanoutFromHub(payload, 'timer-ui')
    });
  }
  if (!obsSetup) {
    obsSetup = createObsSetup({
      core: core,
      secrets: secrets,
      reader: secrets.coreReader('host', ['obs.websocket']),
      getEngine: () => (engines ? engines.engine : null)
    });
  }
  if (!engines) {
    engines = createDefaultRegistry({
      core: core,
      getStored: obsSetup.readStored,
      store: stateStore,
      bus: bus,
      orchestrator: orchestrator,
      getTitle: () => lastHubTitle,
      sessions: sessions
    });
  }
  if (!registry.isLoaded()) {
    registry.discover();
    await registry.loadAll();
  }
  const plugins = registry.snapshot().map((row) => summarizePlugin(row));
  const summary = orchestrator.summarizeModes();
  const mode = formatModeSummary(summary);
  return {
    product: 'marust',
    productJa: '丸スト',
    mode,
    modeSummary: summary,
    plugins,
    uiPlugins: plugins.filter((row) => row.kind === 'ui').map((row) => row.id),
    notes: [
      '題名とカテゴリは、この画面の送信ボタンから現在のモードで扱います。legacy では送りません。',
      'shadow はドライランで、送るはずだった内容を logs/marust に残します。モードはプラグインごとの legacy / shadow / live で、パネル「モード」で切り替えます。',
      'Cookie とキャプチャの受信は 127.0.0.1:18770 だけです。18766 は旧いアプリのままです。',
      'OBS への書き込みは、プラグイン obs-engine が live のときだけです。非常停止はモードに関係なく使えます。'
    ]
  };
}

function windowAlive(win) {
  return !!(win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed()));
}

function createWindow() {
  if (windowAlive(mainWindow)) return mainWindow;
  let allowShow = true;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    // 画面の上部メニュー（ファイル・編集・表示…）を使うので、Electron 標準のメニューは出さない。
    autoHideMenuBar: true,
    backgroundColor: '#f3f5f8',
    title: '丸スト / marust',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  try { mainWindow.setMenuBarVisibility(false); mainWindow.removeMenu(); } catch (_) { /* 古い版では何もしない */ }
  mainWindow.once('ready-to-show', () => {
    if (!allowShow || quitting) return;
    if (windowAlive(mainWindow)) mainWindow.show();
  });
  mainWindow.on('close', (event) => {
    allowShow = false;
    if (quitting) return;
    event.preventDefault();
    app.quit(); // トレイへ隠さず、before-quit の後片付けを通って終了する。
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  const contents = mainWindow.webContents;
  contents.on('will-navigate', (event, url) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { event.preventDefault(); return; }
    const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (parsed.protocol !== 'http:' || !local || parsed.port !== '18770') {
      event.preventDefault();
      openInSystemBrowser(url); // 画面の外へ出るリンクは、使っているブラウザで開く
    }
  });
  // 分離ウィンドウ（dockview の popout）だけは、同じ窓口の /ui/popout.html に限って許す。ほかは全部拒否。
  contents.setWindowOpenHandler((details) => {
    let parsed;
    try { parsed = new URL(details && details.url); } catch (_) { return { action: 'deny' }; }
    const local = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.port === '18770';
    if (!local || parsed.pathname !== '/ui/popout.html') {
      openInSystemBrowser(details && details.url); // 丸ストの中では開かない。使っているブラウザで開く
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 720, height: 560 } };
  });
  return mainWindow;
}

/** リンクは、使っているブラウザ（OS の既定）で開く。http / https だけ。ユーザー情報つき・長すぎる URL は開かない。 */
function openInSystemBrowser(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch (_) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || String(url).length > 2048) return false;
  try { shell.openExternal(parsed.href); } catch (_) { return false; }
  return true;
}

/** 外から入れるプラグインの zip／フォルダは、ここ（メインプロセス）の選択ダイアログで選んだものだけ。画面や API の引数では場所を受けない。 */
async function pickPluginSource(kind) {
  const parent = windowAlive(mainWindow) ? mainWindow : undefined;
  const folder = kind === 'folder';
  const result = await dialog.showOpenDialog(parent, {
    properties: folder ? ['openDirectory'] : ['openFile'],
    filters: folder ? undefined : [{ name: 'zip', extensions: ['zip'] }]
  });
  if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) return null;
  return String(result.filePaths[0]);
}

/** 「フォルダを開く」: 自分のプラグインの置き場の <id> をエクスプローラーで開く。id は呼ぶ側が一覧にあるものだけ渡す。場所は画面に返さない。 */
async function openPluginFolder(id) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(id))) return { ok: false, error: 'bad-id' };
  const dir = path.join(settingsCore.STATE_DIR, 'plugins', String(id));
  const failure = await shell.openPath(dir);
  return failure ? { ok: false, error: 'failed' } : { ok: true };
}

/** 「機能をもっと探す」: 配布ページ（GitHub のリポジトリ）を使っているブラウザで開く。URL は package.json の marustReleasesRepo（owner/repo）から作る。 */
function openPluginBrowse() {
  const repo = String(require('./package.json').marustReleasesRepo || '');
  if (!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return { ok: false, error: 'no-repo' };
  return openInSystemBrowser('https://github.com/' + repo) ? { ok: true } : { ok: false, error: 'failed' };
}

function showMainWindow() {
  if (!windowAlive(mainWindow)) {
    createWindow();
    if (windowAlive(mainWindow)) bringToFront(mainWindow);
    if (windowToken) restoreWindowContents();
    return;
  }
  bringToFront(mainWindow);
}

async function restoreWindowContents() {
  try {
    await session.defaultSession.cookies.set({
      url: 'http://127.0.0.1:18770/',
      name: 'marust_session',
      value: windowToken,
      httpOnly: true,
      sameSite: 'strict',
      path: '/'
    });
    await mainWindow.loadURL('http://127.0.0.1:18770/');
  } catch (err) {
    const message = err && err.message ? err.message : 'unavailable';
    console.error('[marust] window not restored ' + message);
    if (!windowAlive(mainWindow)) return;
    try {
      await mainWindow.loadFile(path.join(__dirname, 'ui', 'offline.html'));
    } catch (_) { /* オフライン画面も出せない */ }
  }
}

async function openScreens() {
  createWindow();
  try {
    await session.defaultSession.cookies.set({
      url: 'http://127.0.0.1:18770/',
      name: 'marust_session',
      value: windowToken,
      httpOnly: true,
      sameSite: 'strict',
      path: '/'
    });
    await mainWindow.loadURL('http://127.0.0.1:18770/');
  } catch (_) {
    if (!windowAlive(mainWindow)) createWindow();
    try {
      await mainWindow.loadFile(path.join(__dirname, 'ui', 'offline.html'));
    } catch (_) { /* オフライン画面も出せない */ }
  }
  startTray();
}

function trayButtonState() {
  const engine = engines && engines.engine;
  if (!engine || typeof engine.status !== 'function' || typeof engine.listTargets !== 'function') {
    return emergencyButtonState([], false);
  }
  try {
    const status = engine.status();
    const targets = engine.listTargets();
    return emergencyButtonState(targets, !!(status && status.connected));
  } catch (_) {
    return emergencyButtonState([], false);
  }
}

function syncOpenAtLogin() {
  try {
    const saved = readAppSettings({ STATE_DIR: settingsCore.STATE_DIR });
    applyOpenAtLogin(app, saved.openAtLogin);
  } catch (_) {
    logLine('warn', 'openAtLogin not applied');
  }
}

function saveOpenAtLogin(openAtLogin) {
  const next = writeAppSettings({
    STATE_DIR: settingsCore.STATE_DIR,
    atomicWriteJsonSync: settingsCore.atomicWriteJsonSync
  }, { openAtLogin: openAtLogin === true });
  try {
    applyOpenAtLogin(app, next.openAtLogin);
  } catch (_) {
    logLine('warn', 'openAtLogin not applied');
  }
  return next;
}

function startTray() {
  if (trayHandle) return;
  try {
    trayHandle = createTray({
      Tray: Tray,
      Menu: Menu,
      nativeImage: nativeImage,
      dialog: dialog,
      shell: shell,
      assetsDir: path.join(__dirname, 'assets'),
      getButtonState: trayButtonState,
      emergencyStop: function () {
        if (!api || typeof api.call !== 'function') return { ok: false, error: 'unavailable' };
        return api.call('engine.emergencyStop', {}, {
          permissions: IPC_PERMISSIONS.slice(),
          via: 'tray',
          kind: 'tray'
        });
      },
      openWindow: showMainWindow,
      quit: function () {
        quitting = true;
        app.quit();
      },
      pollMs: 1000,
      logger: logLine
    });
  } catch (_) {
    logLine('warn', 'tray not started');
  }
}

function shutdownEngine() {
  if (engines && engines.engine && typeof engines.engine.shutdown === 'function') {
    try { engines.engine.shutdown(); } catch (_) { /* 切断に失敗しても終了は続ける */ }
  }
}

function shutdownGateway() {
  if (gateway && typeof gateway.close === 'function') {
    try { gateway.close(); } catch (_) { /* 停止に失敗しても終了は続ける */ }
    gateway = null;
  }
}

async function startGateway() {
  const receiver = createCaptureReceiver({
    core: settingsCore,
    onStatus: async () => ({
      name: 'marust',
      mode: hubState ? hubState.mode : 'legacy',
      receiver: '127.0.0.1:18770'
    })
  });
  gateway = createGateway({
    core: settingsCore,
    receiver: receiver,
    clients: clients,
    webAuth: process.env.MARUST_WEB_AUTH === '1', // 既定は凍結（コード無しで入れる）。1 で認証を戻す。docs/FROZEN.md
    layouts: layouts,
    api: api,
    bus: bus,
    secrets: secrets,
    store: stateStore,
    engine: engines.engine,
    plugins: registry,
    overlayHub: registry ? registry.overlayHub : null,
    uiRoot: path.join(__dirname, 'ui'),
    onStatus: async () => ({
      name: 'marust',
      mode: hubState ? hubState.mode : 'legacy',
      receiver: '127.0.0.1:18770'
    })
  });
  const port = productPort(process.env.MARUST_STATUS_PORT);
  await gateway.listen(port);
  if (isHeadless()) {
    console.log('[marust] headless gateway http://127.0.0.1:' + port + '/');
  } else {
    console.log('[marust] gateway http://127.0.0.1:18770');
  }
}

async function fanoutFromHub(payload, source) {
  const input = coerceFanoutInput(payload);
  const summary = orchestrator
    ? orchestrator.summarizeModes()
    : { live: 0, shadow: 0, legacy: 0, forced: false, liveIds: [] };
  const confirmed = payload && payload.confirmed === true;
  const decision = hubFanoutDecision(summary, confirmed);
  let mode = 'legacy';
  if (decision.legacy || !orchestrator) mode = 'legacy';
  else mode = formatModeSummary(summary);
  if (mode === 'legacy' || !orchestrator) {
    lastHubTitle = input.title;
    return {
      mode: 'legacy',
      sent: false,
      summary: summary,
      results: [{ id: '*', result: 'skip', elapsedMs: 0, message: 'legacy-mode' }]
    };
  }
  // 渡す先（題名のプラグイン）が無いなら、確認の窓を出す前に断る（送れないと分かっているのに確認させない）
  if (typeof orchestrator.fanoutProvider === 'function' && !orchestrator.fanoutProvider()) {
    return { ok: false, error: 'no-plugin' };
  }
  if (decision.needsConfirm === true && confirmed !== true) {
    return { needsConfirm: true, liveIds: decision.liveIds, mode: mode, summary: summary };
  }
  const allowedLiveIds = allowedLiveIdsForHub(payload, summary.liveIds);
  lastHubTitle = input.title;
  const results = await orchestrator.fanout({
    title: input.title,
    category: input.category,
    source: source === 'timer-ui' ? 'timer-ui' : 'hub-ui',
    allowedLiveIds: allowedLiveIds
  });
  return { mode: mode, sent: true, results: results, summary: summary };
}

// セッションの回復（起動の 1 回だけ。K3 評価 Must 1）。口（プラグイン session）が無いあいだは何もしないで false を返す（次の機会に呼ぶ）。
function recoverSessionOnce(ready) {
  if (sessionRecovered) return true;
  if (!sessionPort()) return false;
  sessionRecovered = true;
  const anyOutputLive = ready === true && engines.engine.anyOutputLive();
  sessions.recover({ anyOutputLive: !!anyOutputLive });
  if (typeof sessions.noteAggregate === "function" && typeof engines.engine.destinationAggregate === "function") {
    sessions.noteAggregate(engines.engine.destinationAggregate());
  }
  return true;
}

async function startObs() {
  const opening = engines.engine.connect().catch(() => {
    console.error('[marust] obs engine not started');
  });
  const ready = await Promise.race([
    engines.engine.whenReady().then(() => true),
    new Promise((resolve) => setTimeout(resolve, INITIAL_SYNC_MS)).then(() => false)
  ]);
  // 起動時の回復は 1 回だけ（セッションのプラグインがまだ読み込まれていなければ、読み込まれるまで 2 秒ごとに最大 30 回）
  if (!recoverSessionOnce(ready === true)) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (recoverSessionOnce(true) || tries >= 30) clearInterval(timer);
    }, 2000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  return opening;
}

function isSessionController(rec) {
  const manifest = rec && rec.manifest;
  const provides = manifest && Array.isArray(manifest.provides) ? manifest.provides : [];
  return provides.indexOf('session.controller@1') !== -1;
}

async function destroyPlugins() {
  if (!registry || typeof registry.getRunning !== 'function') return;
  const rows = registry.getRunning();
  const ordered = rows.filter(isSessionController).concat(rows.filter((rec) => !isSessionController(rec)));
  for (let i = 0; i < ordered.length; i += 1) {
    const rec = ordered[i];
    if (!rec || !rec.instance) continue;
    await run(rec.instance, 'destroy', [rec.ctx]);
  }
}

async function boot() {
  settingsCore = createCore();
  const defaults = applyEditionDefaults({ buildInfoPath: path.join(__dirname, 'build-info.json'), stateDir: settingsCore.STATE_DIR, atomicWriteJsonSync: settingsCore.atomicWriteJsonSync });
  if (defaults.ok === false) console.warn('[marust] edition defaults unavailable: ' + defaults.reason);
  retention = createLogRetention({ core: settingsCore, logger: logLine });
  retention.start();
  syncOpenAtLogin();
  hubState = await buildHubState();
  console.log('[marust] ウィンドウ起動 mode=' + hubState.mode + ' plugins=' + hubState.plugins.length);
  for (const row of hubState.plugins) {
    console.log('[marust] plugin id=' + row.id + ' kind=' + row.kind + ' status=' + row.status + (row.reason ? ' reason=' + row.reason : ''));
  }
  clients = createClients({ core: settingsCore });
  syncAutoPair();
  const opened = clients.ensureWindowClient();
  windowToken = opened.token;
  layouts = createLayouts({ core: settingsCore, bundledLayout: () => {
    const { pickShell } = require('./host/layer1/shell-pick');
    const selected = pickShell(registry.dataPlugins('shell'), getUiSettings().getView().shell, registry.snapshot());
    if (!selected.active || !selected.active.layout) return { panels: [] };
    const record = registry.snapshot().find(row => row.id === selected.active.id);
    const { safeFile, UI_EXT } = require('./host/layer1/gateway/http-util');
    const file = record && safeFile(path.join(record.dir, 'shell'), selected.active.layout, UI_EXT);
    return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : { panels: [] };
  } });
  const preflight = createPreflight({
    registry: registry,
    engines: engines.registry,
    store: stateStore,
    secrets: secrets,
    orchestrator: orchestrator
  });
  const broadcast = createBroadcast({
    preflight: preflight,
    registry: registry,
    engines: engines.registry,
    store: stateStore,
    sessions: sessions,
    bus: bus,
    orchestrator: orchestrator,
    logger: logLine
  });
  api = createApi({
    confirmLive: process.env.MARUST_CONFIRM_LIVE === '1', // 既定は凍結（id の入力を求めない）。1 で戻す。docs/FROZEN.md
    getState: currentHubState,
    devMode: {
      get: () => getDevMode().get(),
      isOn: () => getDevMode().isOn(),
      set: (value) => {
        const done = getDevMode().set(value);
        if (done && done.ok !== false) syncAutoPair();
        return done;
      }
    },
    aiAutoPair: () => devAutopair.enabled({ devModeOn: () => getDevMode().get().devMode === true }),
    obsSetup: obsSetup,
    pluginInstaller: createPluginInstaller(),
    siteConfig: createSiteConfig({
      secrets: secrets,
      extensionPaired: () => !!clients && clients.list().some((c) => c && c.kind === 'extension'),
      // 読んでよいのは、サイトの manifest が宣言した名前だけ
      reader: secrets.coreReader('site-config', (name) => /\.config$/.test(name) && (registry ? registry.snapshot() : []).map(summarizePlugin)
        .some((p) => p.site && Array.isArray(p.site.secretNames) && p.site.secretNames.indexOf(name) !== -1)),
      getDeclaredNames: () => {
        let layers; try { layers = require('./host/layer1/plugin-layers.json'); } catch (_) { layers = { layer2: [] }; }
        return require('./host/layer1/site-config').layer2DeclaredNames(registry ? registry.snapshot() : [], layers);
      },
      getSites: async () => (registry ? registry.snapshot() : []).map(summarizePlugin)
        .filter((p) => p.site).map((p) => ({ id: p.site.id, login: p.site.login, secretNames: p.site.secretNames, configSchema: p.site.configSchema }))
    }),
    uiSettings: getUiSettings(),
    dataPlugins: (kind) => (registry && typeof registry.dataPlugins === 'function' ? registry.dataPlugins(kind) : []),
    distribution: readDistribution(),
    fanout: fanoutFromHub,
    forceLegacy: () => {
      if (orchestrator) return orchestrator.forceLegacy('hub');
      return { ok: false, error: 'unavailable' };
    },
    engine: engines.engine,
    registry: engines.registry,
    clients: clients,
    layouts: layouts,
    sessions: sessions,
    store: stateStore,
    bus: bus,
    chat: chat,
    homeState: homeState,
    fanoutReserved: fanoutReserved,
    core: settingsCore,
    secrets: secrets,
    preflight: preflight,
    broadcast: broadcast,
    getHotkeys: function () { return hotkeys; },
    appSettings: {
      get: function () {
        return readAppSettings({ STATE_DIR: settingsCore.STATE_DIR });
      },
      set: saveOpenAtLogin
    },
    pluginRegistry: registry,
    restartApp: function () { app.relaunch(); app.exit(0); },
    pluginInstaller: createAppInstaller({
      core: settingsCore,
      registry: registry,
      bus: bus,
      audit: createAudit({ core: settingsCore }),
      isStreaming: () => {
        const dest = (currentHubState() || {}).destinations || {};
        return (Number(dest.liveCount) || 0) > 0;
      },
      modeOf: (id) => (orchestrator ? orchestrator.modeFor(id) : 'live')
    }),
    pickPluginSource: pickPluginSource,
    openPluginBrowse: openPluginBrowse,
    openPluginFolder: openPluginFolder,
    orchestrator: orchestrator,
    get gateway() { return gateway; },
    startedAt: startedAt
  });
  hotkeys = createKeysPort({
    api: api,
    globalShortcut: globalShortcut,
    store: {
      STATE_DIR: settingsCore.STATE_DIR,
      atomicWriteJsonSync: settingsCore.atomicWriteJsonSync
    },
    logger: logLine,
    // キーの口を持つ内蔵（manifest needs の keys）が入っているときだけ有効（本体はそのプラグインの名前を知らない。計画 X・P1）
    enabled: () => {
      const rows = registry && typeof registry.snapshot === 'function' ? registry.snapshot() : [];
      const holder = rows.find((r) => r && r.source === 'set' && r.manifest && Array.isArray(r.manifest.needs) && r.manifest.needs.indexOf('keys') !== -1);
      return !!holder && featureOn(holder.id);
    },
    // 保存のとき、表に無い名前でも、読み込んである（切っているだけの）プラグインが持つ名前なら「切ってある」として残す
    knownMethod: function (method) {
      const parts = String(method).split('.');
      const rows = registry && typeof registry.snapshot === 'function' ? registry.snapshot() : [];
      return rows.some(function (r) {
        const m = r && r.manifest;
        if (!m) return false;
        if (parts[0] === 'plugin') return parts.length === 3 && r.id === parts[1];
        const ns = m.api && Array.isArray(m.api.namespaces) ? m.api.namespaces : [];
        return ns.indexOf(parts[0]) !== -1;
      });
    },
    notify: function (event) {
      if (!bus || !event || event.event !== 'hotkey.result') return;
      bus.publish('hotkey.result', {
        accelerator: event.accelerator,
        method: event.method,
        label: event.label,
        ok: event.ok === true,
        error: typeof event.error === 'string' ? event.error : '',
        message: typeof event.message === 'string' ? event.message : ''
      });
    }
  });
  if (registry && typeof registry.attachApi === 'function') registry.attachApi(api);
  // プラグインが出した API が表に入ってから登録する（そうしないと、それを割り当てたキーが起動のときに捨てられる）
  await hotkeys.reload();
  // 機能の入／切・プラグインの読み直しでの登録の作り直しは、プラグイン hotkeys が ctx.keys.reload() で行う（K3）
  try {
    await startGateway();
  } catch (err) {
    const message = err && err.message ? err.message : 'unavailable';
    if (isHeadless()) {
      console.log('[marust] headless gateway not started ' + message);
    } else {
      console.error('[marust] gateway not started ' + message);
    }
  }
  if (!isHeadless()) {
    await openScreens();
  }
  await startObs();
}

const instance = installSingleInstance(app, {
  getWindow: function () { return mainWindow; },
  showWindow: showMainWindow
});

if (!instance.primary) {
  app.quit();
} else {
  app.whenReady().then(() => {
    boot().catch((err) => {
      const message = err && err.message ? err.message : String(err);
      console.error('[marust] fatal ' + message);
      destroyPlugins().catch(() => {}).then(() => {
        app.exit(1);
      });
    });
  });
}

app.on('before-quit', (event) => {
  if (retention) {
    try { retention.stop(); } catch (_) { /* 整理の停止に失敗しても終了は続ける */ }
    retention = null;
  }
  if (pluginsClosed) return;
  pluginsClosed = true;
  quitting = true;
  if (trayHandle) {
    try { trayHandle.destroy(); } catch (_) { /* トレイが残っても終了は続ける */ }
    trayHandle = null;
  }
  if (hotkeys) hotkeys.unregisterAll();
  shutdownEngine();
  if (typeof shutdownGateway === 'function') shutdownGateway();
  if (!registry || typeof registry.getRunning !== 'function') {
    try {
      if (typeof settingsCore !== 'undefined' && settingsCore && typeof settingsCore.close === 'function') {
        settingsCore.close().catch(() => {});
      }
    } catch (_) {}
    if (typeof app.exit === 'function' && !isHeadless()) {
      setImmediate(() => { try { app.exit(0); } catch (_) {} });
    }
    return;
  }
  event.preventDefault();
  destroyPlugins().catch(() => {}).then(async () => {
    if (typeof shutdownGateway === 'function') shutdownGateway();
    try {
      if (typeof settingsCore !== 'undefined' && settingsCore && typeof settingsCore.close === 'function') {
        await settingsCore.close();
      }
    } catch (_) {}
    app.quit();
    if (typeof app.exit === 'function' && !isHeadless()) {
      setImmediate(() => { try { app.exit(0); } catch (_) {} });
    }
  });
});

app.on('window-all-closed', async () => {
  if (isHeadless()) return; // 明示的な画面なし起動は SIGINT・SIGTERM で終了する。
  if (typeof shutdownGateway === 'function') shutdownGateway();
  try {
    if (typeof settingsCore !== 'undefined' && settingsCore && typeof settingsCore.close === 'function') {
      await settingsCore.close();
    }
  } catch (_) {}
  if (quitting) {
    if (typeof app.exit === 'function') {
      try { app.exit(0); } catch (_) {}
    }
    return;
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && hubState) showMainWindow();
});

process.on('SIGINT', () => { app.quit(); });
process.on('SIGTERM', () => { app.quit(); });
