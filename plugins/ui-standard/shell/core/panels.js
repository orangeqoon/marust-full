'use strict';
/** パネルの一覧まわり（開発者モードで隠す・名前・権限の反映）と、各パネルのファイルの登録。 */
// PANELS / TOOL_PANELS の 3 つ目 { dev: true } の印。devMode がオフのときは一覧・メニューから隠す。
function panelIsDev(row) {
  return !!(row && row[2] && row[2].dev === true);
}
function visiblePanelRows(rows) {
  return rows.filter(function (row) { return devMode || !panelIsDev(row); });
}
function dropDevPanels() {
  if (devMode || !devModeKnown || !dockApi) return;
  PANELS.forEach(function (row) {
    if (!panelIsDev(row)) return;
    var panel = dockApi.getPanel(row[0]);
    if (panel) dockApi.removePanel(panel);
  });
}
function noteDevMode(state) {
  if (state && state.engineStatus && typeof state.engineStatus.connected === 'boolean') obsConnected = state.engineStatus.connected;
  if (state && state.destinations && typeof state.destinations.liveCount === 'number') obsLiveCount = state.destinations.liveCount;
  if (!state || typeof state.devMode !== 'boolean') return;
  var firstTime = !devModeKnown;
  devModeKnown = true;
  if (state.devMode === devMode && !firstTime) return;
  devMode = state.devMode;
  var mcpBtn = document.getElementById('pair-mcp');
  if (mcpBtn) mcpBtn.hidden = !devMode;
  dropDevPanels();
  if (soloListEl) renderSoloList();
  // ?panel=<開発者用パネル> で直接開いても、開発者モードがオフなら一覧に戻す
  if (!devMode && soloPanelId && PANELS.some(function (row) { return row[0] === soloPanelId && panelIsDev(row); })) {
    window.location.replace(window.location.pathname + '?panel=');
  }
}
function renderSoloList() {
  if (!soloListEl) return;
  soloListEl.innerHTML = STR.uiPanels1 + visiblePanelRows(PANELS).map(function (row) {
    return '<li><a href="/?panel=' + encodeURIComponent(row[0]) + '">' + escapeHtml(row[1]) + '</a></li>';
  }).join('') + '</ul>';
}
function pluginPanelRows() {
  if (!pluginHost || typeof pluginHost.listPanels !== 'function') return [];
  var rows = pluginHost.listPanels();
  return Array.isArray(rows) ? rows : [];
}
function titleOf(id) {
  for (var i = 0; i < PANELS.length; i += 1) if (PANELS[i][0] === id) return PANELS[i][1];
  var extras = pluginPanelRows();
  for (var j = 0; j < extras.length; j += 1) if (extras[j].id === id) return extras[j].title || id;
  return id;
}
function knownPanel(id) {
  for (var i = 0; i < PANELS.length; i += 1) if (PANELS[i][0] === id) return true;
  var extras = pluginPanelRows();
  for (var k = 0; k < extras.length; k += 1) if (extras[k].id === id) return true;
  return false;
}
function notePermissions(list) {
  if (!Array.isArray(list)) return;
  can.read = list.indexOf('read') !== -1;
  can.write = list.indexOf('write') !== -1;
  can.emergency = list.indexOf('emergency') !== -1;
  applyNeed();
}
function applyNeed() {
  var nodes = document.querySelectorAll('[data-need="write"]');
  for (var i = 0; i < nodes.length; i += 1) {
    if (!can.write) nodes[i].disabled = true;
  }
  var emergency = document.getElementById('emergency-stop');
  if (emergency && !can.emergency) emergency.disabled = true;
  var toggles = document.querySelectorAll('[data-panel-toggle]');
  for (var j = 0; j < toggles.length; j += 1) toggles[j].disabled = !can.write && toggles[j].getAttribute('data-panel-toggle') !== 'emergency';
}

// 各パネルのファイル（ui/panels/<id>.js）が、読み込まれるときに自分の id と初期化の関数を届ける。boot が読み込み順に呼ぶ。
var panelRegistry = [];
function registerPanel(id, init) {
  panelRegistry.push({ id: id, init: typeof init === 'function' ? init : null });
}
function initRegisteredPanels() {
  // 1 つのパネルの初期化が落ちても、残りは動かす（落ちた id は console に出す）
  panelRegistry.forEach(function (row) {
    if (!row.init) return;
    try { row.init(); } catch (err) { if (typeof console !== 'undefined' && console.warn) console.warn('panel init failed: ' + row.id, err); }
  });
}
