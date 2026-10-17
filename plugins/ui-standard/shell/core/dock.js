'use strict';
/** ドック（dockview）の組み立てと配置。 */
function NoCloseTab() {
  this._element = document.createElement('div');
  this._element.className = 'dv-default-tab';
  this._content = document.createElement('div');
  this._content.className = 'dv-default-tab-content';
  this._element.appendChild(this._content);
}
Object.defineProperty(NoCloseTab.prototype, 'element', {
  get: function () { return this._element; }
});
NoCloseTab.prototype.init = function (params) {
  var self = this;
  this._content.textContent = params.title || '';
  if (params.api && params.api.onDidTitleChange) {
    params.api.onDidTitleChange(function (ev) { self._content.textContent = ev.title || ''; });
  }
};
function panelIdFromEvent(ev) {
  if (!ev) return '';
  if (typeof ev.id === 'string') return ev.id;
  if (ev.panel && typeof ev.panel.id === 'string') return ev.panel.id;
  return '';
}
function addOne(id, position) {
  if (!dockApi || dockApi.getPanel(id)) return;
  var opt = { id: id, component: id, title: titleOf(id) };
  if (id === 'emergency' || id === 'home') opt.tabComponent = 'noclose';
  if (position) opt.position = position;
  try {
    dockApi.addPanel(opt);
  } catch (_) {
    delete opt.position;
    dockApi.addPanel(opt);
  }
}
function buildDefault() {
  // 最初はホーム。初級はホームだけ（配置は固定）。中級・上級は、右にもう少し足す。
  // そのほかのパネルは、上のメニュー（表示・ツール）から足す。
  addOne('home');
  if (uiLevel === 'advanced') addOne('destinations', { referencePanel: 'home', direction: 'right' });
  var first = dockApi && dockApi.getPanel('home');
  if (first && first.api && first.api.setActive) first.api.setActive();
  defaultPluginsDone = false;
  openDefaultPluginPanels();
}
// 題名・コメントなどの画面はプラグインのパネル（V7）。パネルが manifest の dock で名乗った段階の分だけ（順番は dockOrder）、
// 一覧が取れて、プラグインが入っているときに、既定の配置に足す（本体はプラグインの名前を知らない。計画 X・P1）。
function defaultPluginPanels() {
  return pluginPanelRows().filter(function (row) { return Array.isArray(row.dock) && row.dock.indexOf(uiLevel) !== -1; })
    .sort(function (a, b) { return (a.dockOrder - b.dockOrder) || (a.id < b.id ? -1 : 1); })
    .map(function (row) { return row.id; });
}
var defaultPluginsDone = false;
function openDefaultPluginPanels() {
  if (defaultPluginsDone || !useDefaultLayout || !dockApi || !pluginHost) return;
  var ids = defaultPluginPanels().filter(knownPanel);
  if (!ids.length) return; // 一覧がまだ無い・プラグインが切れている。次に一覧を取ったときにもう一度見る
  defaultPluginsDone = true;
  var advanced = uiLevel === 'advanced' && !!dockApi.getPanel('destinations');
  ids.forEach(function (id, i) {
    var position = advanced
      ? { referencePanel: 'destinations', direction: 'within' }
      : (i === 0 ? { referencePanel: 'home', direction: 'right' } : { referencePanel: ids[0], direction: 'within' });
    pluginHost.openAt(id, position);
  });
}
function syncToggles() {
  // 旧: 画面上部のチェックボックス一覧。今は上部メニューが開くたびに作り直すので、何もしない。
}
function refreshPluginCatalog() {
  return call('hub.getState').then(function (state) {
    catalogTries = 0;
    noteDevMode(state);
    var plugins = state && state.plugins;
    mergePanelAliases(plugins);
    if (typeof noteSiteOrder === 'function') noteSiteOrder(plugins);
    moveAliasedPanels();
    if (pluginHost && typeof pluginHost.sync === 'function') pluginHost.sync(plugins);
    if (typeof syncHomeSlots === 'function') syncHomeSlots();
    openDefaultPluginPanels();
    syncToggles();
  }).catch(function () {
    catalogTries += 1;
    if (catalogTries < 20) setTimeout(refreshPluginCatalog, 300);
  });
}
// やめたパネル（エンジン・配信開始・丸ストの非常停止）が古い配置に残っていたら、空のタブにならないよう外す。
// 非常停止は OBS 側のボタンがあるので、丸ストの画面には出さない（OBS のドック ?view=dock では今までどおり）。
function dropRetiredPanels() {
  ['engine-status', 'broadcast', 'emergency'].forEach(function (id) {
    var panel = dockApi && dockApi.getPanel(id);
    if (panel) dockApi.removePanel(panel);
  });
  dropDevPanels();
  moveAliasedPanels();
}
// サイトのプラグインを 1 つにまとめた（R16）ので、なくなった役目のパネルの id は、サイトのパネルの id に読み替える（1 版のあいだ）。
// 保存した配置に古い id が残っていたら、外して、サイトのパネルが無ければ開く。
var PANEL_ALIASES = {
  // 「バックアップと引っ越し」は、引っ越し（本体）とバックアップ（backup プラグイン）に分けた（V7 C5）
  'settings-export': 'migration',
  'plugin:rumble-slot:status': 'plugin:site-rumble:status',
  'plugin:sink-twitch:status': 'plugin:site-twitch:status',
  'plugin:sink-youtube:status': 'plugin:site-youtube:status',
  'plugin:slot-youtube:status': 'plugin:site-youtube:status',
  'plugin:sink-niconico:status': 'plugin:site-niconico:status',
  'plugin:slot-niconico:status': 'plugin:site-niconico:status'
  // プラグインのパネルへ移した昔のパネルの id は、そのパネルが manifest の aliases で名乗る（mergePanelAliases が足す）。
};
// 読み込んだプラグインの一覧から、読み替え表を作り足す（追加サイトを plugins/sites/ に移すたびに手で足さなくてよい）。
// パネルを持つ役目（site）の siblings（sink・slot）の古いパネル id → その役目のパネル id。
function derivePanelAliases(rows) {
  var out = {};
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (!row || typeof row.id !== 'string' || !Array.isArray(row.panels)) return;
    row.panels.forEach(function (p) {
      if (p && typeof p.name === 'string' && Array.isArray(p.aliases)) p.aliases.forEach(function (old) { if (typeof old === 'string' && old) out[old] = 'plugin:' + row.id + ':' + p.name; });
    });
  });
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (!row || typeof row.id !== 'string' || !Array.isArray(row.panels) || !row.panels.length || !Array.isArray(row.siblings)) return;
    row.siblings.forEach(function (sib) {
      if (typeof sib !== 'string' || sib === row.id) return;
      row.panels.forEach(function (p) {
        if (p && typeof p.name === 'string' && p.name) out['plugin:' + sib + ':' + p.name] = 'plugin:' + row.id + ':' + p.name;
      });
    });
  });
  return out;
}
function mergePanelAliases(rows) {
  var derived = derivePanelAliases(rows);
  Object.keys(derived).forEach(function (k) { PANEL_ALIASES[k] = derived[k]; });
}
function moveAliasedPanels() {
  Object.keys(PANEL_ALIASES).forEach(function (oldId) {
    var panel = dockApi && dockApi.getPanel(oldId);
    if (!panel) return;
    dockApi.removePanel(panel);
    var next = PANEL_ALIASES[oldId];
    if (!dockApi.getPanel(next)) {
      try { openPanel(next); } catch (_) { /* パネルの一覧がまだ無いときは、メニューから開ける */ }
    }
  });
}
function applyLayout(data) {
  if (!dockApi) return;
  if (uiLevel === 'basic') data = null; // 初級は配置を固定（保存した配置は使わない。消さない）
  suppressRestore = true;
  useDefaultLayout = !(data && data.dockview);
  try {
    dockApi.clear();
    if (data && data.dockview) {
      dockApi.fromJSON(data.dockview);
      dropRetiredPanels();
    } else buildDefault();
  } catch (_) {
    try { dockApi.clear(); } catch (err) { /* rebuild */ }
    useDefaultLayout = true;
    buildDefault();
  }
  suppressRestore = false;
  try { dockApi.updateOptions({ disableDnd: uiLevel === 'basic' }); } catch (_) { /* 古い dockview では何もしない */ }
  syncToggles();
  refreshPluginCatalog();
}
// 並べ方の見本（V9）を当てる。見本はパネルの id と置き場所だけのデータ。入っていないパネルは飛ばす。
// 見本が置けるパネルは本体が決めた一覧だけ（host/core/data-plugins.js）。金庫の警告と非常停止は枠に固定で、並べ方では動かない。
function applyLayoutPreset(preset) {
  if (!dockApi || uiLevel === 'basic' || !preset || !Array.isArray(preset.placements)) return;
  var items = preset.placements.filter(function (p) { return p && typeof p.panel === 'string' && knownPanel(p.panel); });
  if (!items.length) return;
  suppressRestore = true;
  var placed = {};
  var first = '';
  var chain = Promise.resolve();
  try { dockApi.clear(); } catch (_) { /* 空にできなければ、そのまま足す */ }
  useDefaultLayout = false;
  items.forEach(function (p) {
    // 前のパネルが置かれてから次を置く（プラグインのパネルは置くのが非同期）
    chain = chain.then(function () {
      var position;
      if (first) {
        position = placed[p.beside]
          ? { referencePanel: p.beside, direction: p.direction || 'right' }
          : { referencePanel: first, direction: 'right' };
      }
      placed[p.panel] = true;
      if (!first) first = p.panel;
      if (p.panel.indexOf('plugin:') === 0 && pluginHost) return pluginHost.openAt(p.panel, position);
      addOne(p.panel, position);
      return null;
    });
  });
  chain.catch(function () {
    try { dockApi.clear(); } catch (err) { /* 作り直す */ }
    useDefaultLayout = true;
    buildDefault();
  }).then(function () {
    suppressRestore = false;
    syncToggles();
  });
}
function mountDock() {
  var el = document.getElementById('dock');
  if (!window.dockview || typeof window.dockview.createDockview !== 'function' || !el) {
    document.body.classList.add('narrow');
    return;
  }
  document.body.classList.add('docked');
  dockApi = window.dockview.createDockview(el, {
    className: 'dockview-theme-github-dark-spaced',
    createRightHeaderActionComponent: function (group) {
      var el = document.createElement('div');
      el.className = 'dock-actions-right';
      var floatBtn = document.createElement('button');
      floatBtn.type = 'button';
      floatBtn.className = 'dock-icon-btn';
      floatBtn.title = STR.uiDock1;
      floatBtn.setAttribute('aria-label', STR.uiDock2);
      floatBtn.textContent = '⧉';
      floatBtn.addEventListener('click', function () {
        try {
          var loc = group.api.location;
          if (loc && loc.type === 'floating') {
            group.api.moveTo({ position: 'right' });
          } else {
            dockApi.addFloatingGroup(group.activePanel || group, { width: 460, height: 420 });
          }
        } catch (_) { /* 浮かせられない構成では何もしない */ }
      });
      el.appendChild(floatBtn);
      var popBtn = document.createElement('button');
      popBtn.type = 'button';
      popBtn.className = 'dock-icon-btn';
      popBtn.title = STR.uiDock3;
      popBtn.setAttribute('aria-label', STR.uiDock4);
      popBtn.textContent = '↗';
      popBtn.addEventListener('click', function () {
        try {
          var loc = group.api.location;
          if (loc && loc.type === 'popout') group.api.moveTo({ position: 'right' });
          else dockApi.addPopoutGroup(group.activePanel || group, { popoutUrl: '/ui/popout.html' });
        } catch (_) { /* 分けられない構成では何もしない */ }
      });
      el.appendChild(popBtn);
      return { element: el, init: function () {}, dispose: function () {} };
    },
    createComponent: function (options) {
      var section = knownPanel(options.name) ? panelRoot(options.name) : null;
      var holder = document.createElement('div');
      holder.className = 'dock-panel-root';
      if (section) holder.appendChild(section);
      return {
        element: holder,
        init: function () {},
        dispose: function () {
          var bin = document.getElementById('panel-bin');
          if (bin && section) bin.appendChild(section);
        }
      };
    },
    createTabComponent: function (options) {
      if (options.name === 'noclose') return new NoCloseTab();
      return undefined;
    }
  });
  pluginHost = createPluginHost({ api: hubApi(), dockview: dockApi, decorate: decoratePluginPanel, toast: PLUGIN_HOST_UI.toast, confirm: PLUGIN_HOST_UI.confirm, confirmFanout: PLUGIN_HOST_UI.confirmFanout, parentAction: PLUGIN_HOST_UI.parentAction });
  watchTabDragOut();
  if (hubApi() && typeof hubApi().subscribe === 'function') {
    hubApi().subscribe(function (msg) { if (msg && msg.name === 'modes.changed') refreshPluginCatalog(); });
  }
  dockApi.onDidRemovePanel(function () {
    if (suppressRestore) return;
    syncToggles();
  });
  mountMenubar();
  loadUiLevel().then(function () {
    // 表示の細かさを切り替えた直後だけ、そのレベルで最後に離れたときの配置を使う（初級は固定）。
    var switched = false;
    try {
      switched = window.sessionStorage.getItem(LEVEL_SWITCH_KEY) === '1';
      window.sessionStorage.removeItem(LEVEL_SWITCH_KEY);
    } catch (_) { switched = false; }
    var saved = switched && uiLevel !== 'basic'
      ? call('layout.getLevel', { level: uiLevel }).catch(function () { return null; })
      : Promise.resolve(null);
    return saved.then(function (got) {
      if (got && got.ok === true && got.data && got.data.dockview) return got;
      return refreshLayouts('').then(function (last) {
        return call('layout.get', { name: last || STR.uiMenubar29 });
      });
    });
  }).then(function (res) {
    applyLayout(res && res.ok ? res.data : null);
  }).catch(function () { applyLayout(null); }).then(function () {
    maybeOpenSetup(); // 配置の読み込みに失敗しても、初回の案内は出す
  });
}
function mountSoloPlugin(solo, id) {
  if (PANEL_ALIASES[id]) id = PANEL_ALIASES[id]; // 古い別ウィンドウのリンク（?panel=plugin:sink-twitch:status）もサイトのパネルへ
  var soloDock = {
    createComponent: null,
    updateOptions: function (next) {
      if (next && typeof next.createComponent === 'function') soloDock.createComponent = next.createComponent;
    },
    getPanel: function () { return null; },
    addPanel: function (opt) {
      var view = typeof soloDock.createComponent === 'function'
        ? soloDock.createComponent({ id: opt.id, name: opt.component, title: opt.title, params: opt.params })
        : null;
      if (view && view.element) solo.appendChild(view.element);
      if (view && typeof view.init === 'function') view.init({ params: opt.params, title: opt.title });
      return { id: opt.id, view: view };
    },
    onDidRemovePanel: function () {}
  };
  createPluginHost({ api: hubApi(), dockview: soloDock, toast: PLUGIN_HOST_UI.toast, confirm: PLUGIN_HOST_UI.confirm, confirmFanout: PLUGIN_HOST_UI.confirmFanout, parentAction: PLUGIN_HOST_UI.parentAction }).open(id);
}

// パネルを開く・閉じる（メニュー・ホーム・案内が使う）。
function openPanel(id) {
  if (PANEL_ALIASES[id]) id = PANEL_ALIASES[id]; // なくなった役目のパネル id（home.js の「枠の設定を開く」など）はサイトのパネルへ
  if (!dockApi) return;
  var existing = dockApi.getPanel(id);
  if (existing) {
    if (existing.api && existing.api.setActive) existing.api.setActive();
    return;
  }
  if (id.indexOf('plugin:') === 0 && pluginHost) {
    pluginHost.open(id);
    return;
  }
  addOne(id);
  var made = dockApi.getPanel(id);
  if (made && made.api && made.api.setActive) made.api.setActive();
}

function closePanel(id) {
  if (!dockApi || id === 'emergency') return;
  if (id.indexOf('plugin:') === 0 && pluginHost) {
    pluginHost.close(id);
    return;
  }
  var panel = dockApi.getPanel(id);
  if (panel) dockApi.removePanel(panel);
}

function togglePanel(id) {
  if (dockApi && dockApi.getPanel(id)) closePanel(id);
  else openPanel(id);
}
