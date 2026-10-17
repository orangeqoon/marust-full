'use strict';
function initEngineStatus() {
  var root = panelRoot('engine-status');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  function modeLabel(engineMode) {
    if (engineMode === 'legacy') return STR.engineModeLegacy;
    if (engineMode === 'shadow') return STR.engineModeShadow;
    return '';
  }
  function refresh() {
    return displayRead('engine.status').then(function (status) {
      if (!status) return;
      var head = root.querySelector('#engine-headline');
      if (head) head.textContent = (status.detail || STR.engineNotConnected) + (status.apiVersion ? STR.engineApiVersion(status.apiVersion) : '');
      var modeEl = root.querySelector('#engine-mode');
      if (modeEl) modeEl.textContent = modeLabel(status.mode || 'legacy');
      var warn = root.querySelector('#profile-warn');
      if (warn) warn.textContent = status.profileWarning ? STR.engineProfileWarning : '';
    }).catch(function () {});
  }
  watchDisplay(root, refresh, displayStateEvent);
}
// 上のバー右のモードの表示（K3）。モードの画面は dev-shadow のプラグインへ移ったので、バーの更新は本体が持つ。
function initModeBadge() {
  var badge = document.getElementById('mode-badge');
  if (!badge || badge.dataset.bound === '1') return;
  badge.dataset.bound = '1';
  function refresh() {
    return displayRead('hub.getState').then(function (state) {
      if (!state) return;
      noteDevMode(state);
      notePermissions(state.permissions);
      if (typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
      var summary = state.modeSummary || { live: 0, shadow: 0, legacy: 0 };
      var modeName = state.mode || ('live ' + (summary.live || 0) + ' / shadow ' + (summary.shadow || 0) + ' / legacy ' + (summary.legacy || 0));
      badge.textContent = STR.topBar(devMode, modeName, obsConnected, obsLiveCount);
    }).catch(function () {});
  }
  watchDisplay(badge, refresh, displayStateEvent);
}
// 開発中の「すぐ反映」: ui.reload の theme は hub.css を取り直し、all は画面ごと読み直す（plugin:<id> は plugin-host.js が受ける）。
function initDevReload() {
  if (!hubApi() || !hubApi().subscribe) return;
  hubApi().subscribe(function (msg) {
    if (msg && msg.name === 'ui.themeChanged') { initTheme(); return; }
    if (!msg || msg.name !== 'ui.reloadRequested' || !msg.payload) return;
    if (msg.payload.target === 'all') {
      window.location.reload();
    } else if (msg.payload.target === 'theme') {
      initTheme();
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var i = 0; i < links.length; i += 1) {
        var href = links[i].getAttribute('href') || '';
        if (href.indexOf('/ui/') !== 0) continue;
        links[i].setAttribute('href', href.replace(/[?&]r=\d+$/, '') + (href.indexOf('?') === -1 ? '?' : '&') + 'r=' + Date.now());
      }
    }
  });
}
// キーを押した結果の知らせ。ホットキーの画面を開いていなくても出すので、本体の画面が受ける（画面はホットキーのプラグイン）。
function hotkeyToastText(payload) {
  var body = payload && typeof payload === 'object' ? payload : {};
  if (typeof body.message === 'string' && body.message) return body.message;
  var name = body.label || body.method || STR.uiMenubar10;
  if (body.ok === true) return name + STR.uiHotkeys4;
  var error = typeof body.error === 'string' && body.error ? body.error : 'failed';
  if (error === 'unknown-method') return STR.uiHotkeysOff; // そのキーの機能を切ってある
  return name + ' ' + error;
}
function initHotkeyToast() {
  var toast = document.getElementById('hotkey-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'hotkey-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.hidden = true;
    document.body.appendChild(toast);
  }
  var toastTimer = null;
  if (hubApi() && hubApi().subscribe) {
    hubApi().subscribe(function (msg) {
      if (!msg || msg.name !== 'hotkey.result') return;
      var payload = msg.payload || {};
      toast.textContent = hotkeyToastText(payload);
      toast.className = payload.ok === true ? 'ok' : 'ng';
      toast.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.hidden = true; }, 4000);
    });
  }
}
function boot() {
  initTheme(); // 見た目（V8）。ほかの窓（別ウィンドウのパネル・縦 1 列）にも当てる
  initEngineStatus();
  initModeBadge();
  initDevReload();
  initHotkeyToast();
  // 各パネル（ui/panels/<id>.js）の初期化は、読み込まれた順（hub.html の並び）に呼ぶ。
  initRegisteredPanels();
  initOpenAtLogin();
  var params = new URLSearchParams(window.location.search);
  var viewDock = (typeof window !== 'undefined' && window.marustDockView) ? window.marustDockView : null;
  // `panel` を優先し、次に `?view=dock`（縦 1 列の簡易表示）。view-dock.js が無いときは今の動きのまま。
  var plan = viewDock && typeof viewDock.plan === 'function'
    ? viewDock.plan(window.location.search)
    : { mode: params.has('panel') ? 'panel' : 'default', panel: params.get('panel'), widgets: [] };
  // 金庫の警告は画面の固定の枠（V9）。並べ方・パネルの出し入れでは消えない。OBS のドック（縦 1 列）には出さない
  if (plan.mode !== 'dock') attachVaultWarn(document.getElementById('vault-bar'), true);
  if (plan.mode === 'panel') {
    var only = plan.panel;
    soloPanelId = typeof only === 'string' ? only : '';
    document.body.classList.add('solo');
    var solo = document.getElementById('solo');
    solo.hidden = false;
    document.getElementById('dock').hidden = true;
    if (typeof only === 'string' && PANEL_ALIASES[only]) only = PANEL_ALIASES[only]; // 古い ?panel=overlays などはプラグインのパネルへ
    if (typeof only === 'string' && only.indexOf('plugin:') === 0 && typeof createPluginHost === 'function') {
      mountSoloPlugin(solo, only);
      return;
    }
    if (!knownPanel(only)) {
      soloListEl = solo;
      renderSoloList();
      return;
    }
    var section = panelRoot(only);
    if (section) solo.appendChild(section);
    return;
  }
  if (plan.mode === 'dock') {
    viewDock.mount(document, plan);
    viewDock.watch(document);
    return;
  }
  var wide = window.innerWidth >= 600;
  window.addEventListener('resize', function () {
    var nowWide = window.innerWidth >= 600;
    if (nowWide !== wide) window.location.reload();
  });
  if (!wide) {
    document.body.classList.add('narrow');
    return;
  }
  mountDock();
}
boot();
if (window.marustShell) window.marustShell.ready();
