'use strict';

/**
 * 上部メニュー（ファイル・編集・表示・プロファイル・ツール・ヘルプ）。
 * hub.js と同じページで読み込む。dockApi・call・can・titleOf・pluginPanelRows・addOne・applyLayout
 * などは hub.js 側の関数と変数をそのまま使う（hub.js より前に読み込むので、使うのは呼ばれたとき）。
 * パネルを開く・閉じる・並びを保存する操作を、1 か所に集めるのが役目。値（秘密）は扱わない。
 */

// 3 つ目の { dev: true } は開発者モードだけ。{ min: 'advanced' } は表示の細かさが上級のときだけ（無ければ中級から。初級ではツールのメニュー自体を出さない）。
var TOOL_PANELS = [
  ['features', STR.featuresMenu],
  ['plugin-manager', STR.pluginManagerMenu, { min: 'advanced' }],
  ['obs-connect', STR.uiMenubar4],
  ['site-add', STR.uiMenubar5],
  ['sites', STR.uiState8],
  ['secrets', STR.uiMenubar7],
  ['clients', STR.uiMenubar8, { min: 'advanced' }],
  ['approvals', STR.uiMenubar9, { dev: true }]
];
function toolRowsForLevel() {
  return visiblePanelRows(TOOL_PANELS).filter(function (row) {
    return levelAtLeast(row[2] && row[2].min ? row[2].min : 'standard');
  });
}
// マウスを乗せたときに出す短い説明（タブとメニュー）。タイトル（表示名）で引く。
var PANEL_DESC = {
  '配信ボタン': STR.uiMenubar13,
  '題名とカテゴリ': STR.uiMenubar14,
  '配信の経過時間': STR.uiMenubar15,
  'コメント': STR.uiMenubar16,
  'サイト別の状態': STR.uiMenubar17,
  'オーバーレイ': STR.uiMenubar18,
  'タイマー': STR.uiMenubar19,
  '全部止める': STR.uiMenubar20,
  'モード': STR.uiMenubar21,
  '金庫': STR.uiMenubar22,
  '承認待ち': STR.uiMenubar23,
  '接続端末': STR.uiMenubar24,
  'ホットキー': STR.uiMenubar25,
  'バックアップと引っ越し': STR.uiMenubar26,
  '診断': STR.uiMenubar27,
  'この画面について': STR.uiMenubar28
};
function describePanel(title) {
  return PANEL_DESC[title] || '';
}
function tagTabs() {
  var tabs = document.querySelectorAll('#dock .dv-tab, #dock .dv-default-tab');
  for (var i = 0; i < tabs.length; i += 1) {
    var inner = tabs[i].querySelector('.dv-default-tab-content');
    var text = ((inner || tabs[i]).textContent || '').replace(/[×✕]/g, '').trim();
    var d = describePanel(text);
    if (d && tabs[i].getAttribute('title') !== d) tabs[i].setAttribute('title', d);
  }
}
function watchTabs() {
  var host = document.getElementById('dock');
  if (!host || typeof MutationObserver !== 'function') return;
  var timer = null;
  new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(function () { timer = null; tagTabs(); }, 150);
  }).observe(host, { childList: true, subtree: true });
  tagTabs();
}
var dockLocked = false;
var layoutState = { names: [STR.uiMenubar29], current: STR.uiMenubar29 };

// 上のメニューに出すパネルの行は、パネルが manifest の menu で名乗ったもの（key・title・desc・order・in・min・orDev）。本体はプラグインの名前を知らない（計画 X・P1）。
function panelMenuVisible(menu) {
  if (menu.min === 'advanced') return levelAtLeast('advanced') || (menu.orDev === true && devMode);
  return true;
}
function panelMenuRows(where) {
  return pluginPanelRows().filter(function (row) {
    return row.menu && row.menu.in === where && panelMenuVisible(row.menu);
  }).sort(function (a, b) { return (a.menu.order - b.menu.order) || (a.id < b.id ? -1 : 1); });
}

// カテゴリごとに 1 つのウィンドウ（タブのまとまり）にする。
function categoryRows() {
  var rows = [
    { key: 'home', title: STR.uiMenubar30, ids: ['home'], desc: STR.uiMenubar31 },
    { key: 'obs', title: STR.uiMenubar32, ids: ['destinations'], desc: STR.uiMenubar33 }
  ];
  var named = panelMenuRows('view');
  var taken = {};
  named.forEach(function (row) { taken[row.id] = true; });
  named.filter(function (row) { return row.menu.order < 500; }).forEach(function (row) {
    rows.push({ key: row.menu.key, title: row.menu.title, ids: [row.id], desc: row.menu.desc });
  });
  // サイト別の状態の表にまとめたので、サイトごとのパネル（site-*, sink-*, chat-*）はここには並べない。
  var extras = pluginPanelRows().filter(function (row) {
    if (taken[row.id]) return false; // 名乗りのある行で出しているもの
    return !/^plugin:(site|sink|chat)-/.test(String(row.id || '')) && !(row.menu && row.menu.in !== 'view');
  }).sort(function (a, b) {
    return String(a.title || a.id).localeCompare(String(b.title || b.id), 'ja');
  });
  var buckets = [
    ['watch', STR.uiMenubar38, function (t) { return /(の枠|の睡眠)$/.test(t) || /^(同接|回線|配信監視|Discord|Google|Twitch レイド)/.test(t); }, STR.uiMenubar39],
    ['other', STR.uiMenubar40, function () { return true; }, STR.uiMenubar41]
  ];
  var placed = {};
  buckets.forEach(function (bucket) {
    var ids = extras.filter(function (row) {
      return !placed[row.id] && bucket[2](String(row.title || row.id));
    }).map(function (row) { placed[row.id] = true; return row.id; });
    // 開発中機能は開発者モードのときだけ見せる（R1）。
    if (bucket[0] === 'watch' && !devMode) return;
    if (ids.length) rows.push({ key: bucket[0], title: bucket[1], ids: ids, desc: bucket[3] || '' });
  });
  named.filter(function (row) { return row.menu.order >= 500; }).forEach(function (row) {
    rows.push({ key: row.menu.key, title: row.menu.title, ids: [row.id], desc: row.menu.desc });
  });
  // 機能が切れているあいだ（プラグインのパネルが一覧に無いとき）は、題名・コメントの行を出さない（P2・V7）
  rows = rows.filter(function (row) { return row.ids.every(knownPanel); });
  // 中級では、配信先の細かい一覧（上級の画面）は出さない。ホームで足りる。
  if (!levelAtLeast('advanced')) rows = rows.filter(function (row) { return row.key !== 'obs'; });
  return rows;
}

function openCategory(cat) {
  if (!dockApi || !cat.ids.length) return Promise.resolve();
  var anchorId = '';
  for (var i = 0; i < cat.ids.length; i += 1) {
    if (dockApi.getPanel(cat.ids[i])) { anchorId = cat.ids[i]; break; }
  }
  // 1 枚ずつ順番に開く（最初の 1 枚は右の列へ、2 枚目からは同じウィンドウのタブへ）。
  return cat.ids.reduce(function (chain, id) {
    return chain.then(function () {
      if (dockApi.getPanel(id)) return null;
      var position;
      if (anchorId) {
        position = { referencePanel: anchorId, direction: 'within' };
      } else {
        var groups = dockApi.groups || [];
        var last = groups.length ? groups[groups.length - 1] : null;
        var lastPanel = last && last.panels && last.panels.length ? last.panels[0] : null;
        if (lastPanel) position = { referencePanel: lastPanel.id, direction: 'right' };
      }
      if (id.indexOf('plugin:') === 0 && pluginHost) {
        return pluginHost.openAt(id, position).then(function () { if (!anchorId && dockApi.getPanel(id)) anchorId = id; });
      }
      var opt = { id: id, component: id, title: titleOf(id) };
      if (position) opt.position = position;
      try { dockApi.addPanel(opt); } catch (_) { delete opt.position; dockApi.addPanel(opt); }
      if (!anchorId) anchorId = id;
      return null;
    });
  }, Promise.resolve()).then(function () {
    var first = dockApi.getPanel(cat.ids[0]);
    if (first && first.api && first.api.setActive) first.api.setActive();
  });
}

function toggleCategory(cat) {
  var allOpen = cat.ids.every(function (id) { return !!dockApi.getPanel(id); });
  if (allOpen) cat.ids.forEach(closePanel);
  else openCategory(cat);
}

function menuItem(label, opts) {
  var o = opts || {};
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'menu-item';
  b.setAttribute('role', o.role || 'menuitem');
  if (o.role) b.setAttribute('aria-checked', o.tick ? 'true' : 'false');
  var tick = document.createElement('span');
  tick.className = 'tick';
  tick.textContent = o.tick ? '✓' : '';
  var text = document.createElement('span');
  text.textContent = label;
  b.appendChild(tick);
  b.appendChild(text);
  if (o.hint) {
    var hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = o.hint;
    b.appendChild(hint);
  }
  if (o.title) b.title = o.title;
  if (o.disabled) {
    b.disabled = true;
  } else {
    b.addEventListener('click', function () {
      closeMenus();
      if (typeof o.run === 'function') o.run();
    });
  }
  return b;
}

function menuSep() {
  var d = document.createElement('div');
  d.className = 'menu-sep';
  return d;
}

function menuLabel(text) {
  var d = document.createElement('div');
  d.className = 'menu-label';
  d.textContent = text;
  return d;
}

function closeMenus() {
  var pops = document.querySelectorAll('#menubar .menu-pop');
  for (var i = 0; i < pops.length; i += 1) {
    pops[i].hidden = true;
    var btn = pops[i].parentNode.querySelector('.menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}

function refreshLayouts(selectName) {
  return call('layout.list').then(function (res) {
    var names = res && Array.isArray(res.names) && res.names.length ? res.names : [STR.uiMenubar29];
    var last = selectName || (res && res.last) || STR.uiMenubar29;
    layoutState.names = names;
    layoutState.current = names.indexOf(last) === -1 ? names[0] : last;
    return layoutState.current;
  });
}

function saveLayoutAs() {
  if (!can.write) return;
  var suggestion = layoutState.current === STR.uiMenubar29 ? '' : layoutState.current;
  var typed = window.prompt(STR.uiMenubar46, suggestion);
  if (typed == null) return;
  var name = String(typed).trim();
  if (!name) return;
  call('layout.list').then(function (res) {
    var names = res && Array.isArray(res.names) ? res.names : [];
    var clash = '';
    for (var i = 0; i < names.length; i += 1) {
      if (String(names[i]).toLowerCase() === name.toLowerCase() && names[i] !== name) clash = names[i];
    }
    if (clash && !window.confirm('「' + name + STR.uiMenubar47 + clash + STR.uiMenubar48)) return null;
    return call('layout.save', { name: name, data: { version: 1, dockview: dockApi.toJSON() } });
  }).then(function (saved) {
    if (!saved) return null;
    return refreshLayouts(name);
  }).catch(function () { /* 保存に失敗しても画面は今のまま */ });
}

function loadLayout(name) {
  call('layout.get', { name: name }).then(function (res) {
    if (res && res.ok) {
      applyLayout(res.data);
      layoutState.current = name;
    }
  }).catch(function () { /* 読めなければ今のまま */ });
}

function resetLayout() {
  call('layout.get', { name: STR.uiMenubar29 }).then(function (res) {
    applyLayout(res && res.ok ? res.data : null);
    return refreshLayouts(res && res.name ? res.name : STR.uiMenubar29);
  }).catch(function () { applyLayout(null); });
}

var levelMenuRefreshed = false;
function fillMenu(kind, pop) {
  while (pop.firstChild) pop.removeChild(pop.firstChild);
  pop.fillSeq = (pop.fillSeq || 0) + 1;
  var seq = pop.fillSeq;
  var add = function (el) { pop.appendChild(el); };
  if (kind === 'file') {
    // バックアップなどは、プラグインのパネルが menu.in: file で名乗った行（入っているときだけ）。引っ越しは本体の機能で、いつでも出す（V7 C5）
    panelMenuRows('file').forEach(function (row) {
      add(menuItem(row.menu.title, { title: row.menu.desc, run: function () { openPanel(row.id); } }));
    });
    add(menuItem(STR.migrationMenu, { title: STR.migrationMenuTitle, run: function () { openPanel('migration'); } }));
    // 初級は「ファイル（バックアップ）」だけ。金庫・ログインの結び直しは中級から。
    if (levelAtLeast('standard')) {
      add(menuSep());
      add(menuItem(STR.uiMenubar51, { run: function () { openPanel('secrets'); } }));
    }
  } else if (kind === 'level') {
    // 配り物の種類は最初に開いたとき 1 回読み直す（起動直後に読めていなくても、メニューは正しく出す）
    if (!levelMenuRefreshed) {
      levelMenuRefreshed = true;
      loadUiLevel().then(function () { if (buildDistribution === 'core') fillMenu(kind, pop); });
    }
    add(menuLabel(STR.levelMenu));
    ['basic', 'standard', 'advanced'].forEach(function (lv) {
      var core = buildDistribution === 'core';
      add(menuItem(STR.levelNames[lv], { role: 'menuitemradio', tick: lv === uiLevel, title: core && lv === 'standard' ? STR.levelCoreNoStandard + STR.levelCorePackTitle : STR.levelHints[lv], disabled: !can.write, run: function () { setUiLevel(lv); } }));
    });
    if (buildDistribution === 'core') add(menuLabel(STR.levelCoreNoStandard + STR.levelCoreAdvanced));
  } else if (kind === 'edit') {
    add(menuItem(dockLocked ? STR.uiMenubar52 : STR.uiMenubar53, { run: function () {
      dockLocked = !dockLocked;
      dockApi.updateOptions({ disableDnd: dockLocked });
    } }));
    add(menuItem(STR.uiMenubar54, { run: resetLayout }));
    add(menuSep());
    // モード・本番切り替えは開発者モードだけ（R9）。一般の画面は、サイトの「題名を送る」と OBS の操作スイッチだけ。
    if (devMode) {
      add(menuSep());
      add(menuItem(STR.uiMenubar55, { disabled: !can.write, run: function () {
        call('hub.forceLegacy').catch(function () { /* 失敗は画面のモード表示で分かる */ });
      } }));
      add(menuItem(STR.uiMenubar56, { disabled: !can.write, run: function () { setAllLive(null); } }));
    }
  } else if (kind === 'view') {
    add(menuLabel(STR.uiMenubar57));
    categoryRows().forEach(function (cat) {
      var openCount = cat.ids.filter(function (id) { return !!dockApi.getPanel(id); }).length;
      var hint = openCount ? (openCount + '/' + cat.ids.length) : String(cat.ids.length);
      add(menuItem(cat.title, { role: 'menuitemcheckbox', title: cat.desc, tick: openCount === cat.ids.length, hint: hint, run: function () { toggleCategory(cat); } }));
    });
    add(menuSep());
    add(menuLabel(STR.uiMenubar58));
    categoryRows().forEach(function (cat) {
      if (cat.ids.length < 2) {
        cat.ids.forEach(function (id) {
          add(menuItem(titleOf(id), { role: 'menuitemcheckbox', title: describePanel(titleOf(id)), tick: !!dockApi.getPanel(id), run: function () { togglePanel(id); } }));
        });
      }
    });
    // 並べ方の見本（V9。データだけのプラグイン kind:layout）。初級は配置が固定なので出さない
    if (uiLevel !== 'basic') {
      add(menuSep());
      add(menuLabel(STR.layoutPresetLabel));
      call('ui.layouts').then(function (res) {
        if (pop.fillSeq !== seq) return; // メニューが作り直されたあとに届いた答えは使わない
        var rows = res && Array.isArray(res.layouts) ? res.layouts : [];
        rows.filter(function (l) { return l.levels.indexOf(uiLevel) !== -1; }).forEach(function (l) {
          add(menuItem(l.label, { run: function () { applyLayoutPreset(l); } }));
        });
      }).catch(function () { /* 一覧が取れなければ見本は出さない */ });
    }
  } else if (kind === 'look') {
    add(menuLabel(STR.themeMenuLabel));
    if (!themeList.length) add(menuLabel(STR.themeNone));
    themeList.forEach(function (t) {
      add(menuItem(t.label, { role: 'menuitemradio', tick: t.id === currentThemeId, disabled: !can.write, run: function () { chooseTheme(t.id); } }));
    });
  } else if (kind === 'profile') {
    add(menuLabel(STR.uiMenubar59));
    layoutState.names.forEach(function (name) {
      add(menuItem(name, { role: 'menuitemradio', tick: name === layoutState.current, run: function () { loadLayout(name); } }));
    });
    add(menuSep());
    add(menuItem(STR.uiMenubar60, { disabled: !can.write, run: saveLayoutAs }));
    add(menuItem(STR.uiMenubar61, { disabled: !can.write || layoutState.current === STR.uiMenubar29, run: function () {
      call('layout.remove', { name: layoutState.current }).then(function () { return refreshLayouts(STR.uiMenubar29); }).then(resetLayout).catch(function () { /* 削除できなければ今のまま */ });
    } }));
    add(menuItem(STR.uiMenubar62, { run: resetLayout }));
  } else if (kind === 'tools') {
    toolRowsForLevel().forEach(function (row) {
      add(menuItem(row[1], { run: function () { openPanel(row[0]); } }));
    });
    // プラグインの ui.menu（V7）。呼べるのはそのプラグイン自身の操作と、自分のパネルを開くことだけ。
    var pluginMenu = pluginHost && typeof pluginHost.listMenu === 'function' ? pluginHost.listMenu() : [];
    if (pluginMenu.length) add(menuSep());
    pluginMenu.forEach(function (item) {
      add(menuItem(item.label, { disabled: !!item.method && !can.write, run: function () { pluginHost.runMenu(item); } }));
    });
  } else if (kind === 'help') {
    add(menuItem(STR.helpStartGuide, { title: STR.helpStartGuideTitle, run: function () { window.open(STR.startGuidePath, '_blank', 'noopener'); } }));
    add(menuItem(STR.helpKeyGuide, { title: STR.helpKeyGuideTitle, run: function () { window.open(STR.streamKeyGuidePath, '_blank', 'noopener'); } }));
    add(menuItem(STR.helpOnecommeGuide, { title: STR.helpOnecommeGuideTitle, run: function () { window.open(STR.onecommeGuidePath, '_blank', 'noopener'); } }));
    add(menuItem(STR.helpAiGuide, { title: STR.helpAiGuideTitle, run: function () { window.open(STR.aiGuidePath, '_blank', 'noopener'); } }));
    // オーバーレイの説明。画面（iframe）の中からは外のブラウザを開けないので、ここに置く（V7）
    add(menuItem(STR.overlayGuideLink, { run: function () { window.open(STR.overlayGuidePath, '_blank', 'noopener'); } }));
    add(menuItem(STR.uiMenubar63, { run: function () { openPanel('about'); } }));
    add(menuItem(STR.setupMenu, { disabled: !can.write, title: STR.uiMenubar64, run: function () { openSetup(0); } }));
    add(menuItem(STR.tipsResetMenu, { disabled: !can.write, title: STR.uiMenubar65, run: function () {
      call('tips.reset', {}).then(function (r) { window.alert(r && r.ok === true ? STR.tipsResetDone : STR.loginErr('failed')); }).catch(function () { window.alert(STR.loginErr('failed')); });
    } }));
    add(menuItem(STR.updateMenu, { disabled: !can.write, title: STR.updateMenuTitle, run: checkUpdate }));
    add(menuSep());
    add(menuItem(STR.uiMenubar66, {
      role: 'menuitemcheckbox',
      tick: devMode,
      disabled: !can.write,
      title: STR.uiMenubar67,
      run: toggleDevMode
    }));
  }
}

// 押したときだけ配布ページの最新の版を読む。新しい版があれば、確認のあと使っているブラウザで配布ページを開く（丸ストの中では開かない）。
function checkUpdate() {
  call('update.check', {}).then(function (r) {
    if (!r || r.ok !== true) {
      window.alert(r && r.error === 'not-configured' ? STR.updateNotConfigured : STR.updateNetwork);
      return;
    }
    if (r.none) { window.alert(STR.updateNone); return; }
    if (!r.newer) { window.alert(STR.updateLatest(r.current)); return; }
    if (window.confirm(STR.updateNewer(r.current, r.latest)) && r.url) window.open(r.url, '_blank', 'noopener');
  }).catch(function () { window.alert(STR.updateNetwork); });
}

// 表示の細かさの切り替え。離れる側の配置を先に保存し（初級は配置固定なので保存しない）、切り替えたあとの最初の読み込みで、そのレベルの保存があれば使う。
var LEVEL_SWITCH_KEY = 'marust.levelSwitch';
function saveLeavingLayout() {
  if (uiLevel === 'basic' || !dockApi) return Promise.resolve();
  var data;
  try { data = { version: 1, dockview: dockApi.toJSON() }; } catch (_) { return Promise.resolve(); }
  return call('layout.saveLevel', { level: uiLevel, data: data }).catch(function () { /* 保存できなくても切り替える */ });
}
function setUiLevel(level) {
  if (level === uiLevel) return;
  saveLeavingLayout().then(function () {
    return call('ui.setSettings', { uiLevel: level });
  }).then(function (res) {
    if (res && res.ok !== false) {
      if (res.deferred && res.deferred.length) window.alert(STR.levelSlotDeferred); // 配信中の自動枠取りだけは、配信が終わってから段階に合わせる
      try { window.sessionStorage.setItem(LEVEL_SWITCH_KEY, '1'); } catch (_) { /* 使えなければ、いつもの配置で開く */ }
      window.location.reload();
      return;
    }
    window.alert(res && res.error === 'not-in-build' ? (res.unreadable ? STR.levelCorePackUnreadable : STR.levelCoreNoStandard + STR.levelCorePack + (res.missing || '') + ' 個') : res && res.error === 'streaming' ? STR.levelStreaming : (res && res.error === 'busy' ? STR.levelBusy : STR.uiMenubar68));
  }).catch(function () { window.alert(STR.uiMenubar68); });
}

function toggleDevMode() {
  var want = !devMode;
  if (want && !window.confirm(STR.uiMenubar69)) return;
  call('devmode.set', { value: want }).then(function (res) {
    if (res && res.ok === true) {
      window.location.reload();
      return;
    }
    var why = res && res.error === 'env-locked' ? STR.uiMenubar70 : STR.uiMenubar71;
    window.alert(why);
  }).catch(function () { window.alert(STR.uiMenubar68); });
}

function mountMenubar() {
  watchTabs();
  var bar = document.getElementById('menubar');
  if (!bar) return;
  var menus = bar.querySelectorAll('.menu');
  Array.prototype.forEach.call(menus, function (menu) {
    var btn = menu.querySelector('.menu-btn');
    var pop = menu.querySelector('.menu-pop');
    var kind = menu.getAttribute('data-menu');
    function openMenu() {
      fillMenu(kind, pop);
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var wasOpen = !pop.hidden;
      closeMenus();
      if (!wasOpen) openMenu();
    });
    // どれかのメニューが開いているときは、ほかのメニューへ動かすだけで切り替わる。
    btn.addEventListener('mouseenter', function () {
      var anyOpen = bar.querySelector('.menu-pop:not([hidden])');
      if (anyOpen && anyOpen !== pop) {
        closeMenus();
        openMenu();
      }
    });
  });
  document.addEventListener('click', function (ev) {
    if (!bar.contains(ev.target)) closeMenus();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeMenus();
  });
}


// タブを画面の枠の外へ持っていったら、別のウィンドウにする（右上のボタンと同じ）。
function watchTabDragOut() {
  document.addEventListener('dragend', function (ev) {
    if (!dockApi || !ev.target || !ev.target.closest) return;
    var tab = ev.target.closest('.dv-tab');
    if (!tab) return;
    var outside = ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight;
    if (!outside) return;
    var groupEl = tab.closest('.dv-groupview');
    var found = null;
    (dockApi.groups || []).forEach(function (g) {
      if (g.element === groupEl || (groupEl && g.element && g.element.contains && groupEl.contains(g.element))) found = g;
    });
    if (!found || !found.activePanel) return;
    if (found.api && found.api.location && found.api.location.type === 'popout') return;
    try { dockApi.addPopoutGroup(found.activePanel, { popoutUrl: '/ui/popout.html' }); } catch (_) { /* 分けられなければ何もしない */ }
  }, true);
}

// タイマーのパネルの下に、Google カレンダーとの連携と「使い方」を付ける（本体側の部品）。
function decoratePluginPanel(panelId, root) {
  if (panelId !== 'plugin:timer:clock') return;
  root.classList.add('with-extras');
  var extras = document.createElement('div');
  extras.className = 'timer-extras';
  root.appendChild(extras);
  // Google カレンダーの節は上級だけ（gcal は上級のプラグイン。V5）。中級以下は節ごと出さず、読みにも行かない
  if (levelAtLeast('advanced')) buildGcalSection(extras);
  buildGuideSection(extras);
}

function buildGcalSection(host) {
  var box = document.createElement('section');
  box.className = 'extras-card';
  var h = document.createElement('h3');
  h.textContent = STR.uiMenubar72;
  var note = document.createElement('p');
  note.className = 'timer-hint';
  note.textContent = STR.uiMenubar73;
  var row = document.createElement('label');
  row.className = 'extras-row';
  var box1 = document.createElement('input');
  box1.type = 'checkbox';
  box1.id = 'gcal-link';
  box1.setAttribute('data-need', 'write');
  row.appendChild(box1);
  row.appendChild(document.createTextNode(STR.uiMenubar74));
  var state = document.createElement('p');
  state.className = 'timer-hint';
  state.setAttribute('aria-live', 'polite');
  box.appendChild(h);
  box.appendChild(note);
  box.appendChild(row);
  box.appendChild(state);
  host.appendChild(box);

  // 接続（Google にログインして、丸ストにカレンダーへ書く許可を渡す）
  var link = document.createElement('div');
  link.className = 'gcal-login';
  var linkState = document.createElement('p');
  linkState.className = 'timer-hint';
  linkState.setAttribute('aria-live', 'polite');
  var guide = document.createElement('a');
  guide.setAttribute('href', STR.gcalGuidePath);
  guide.setAttribute('target', '_blank');
  guide.setAttribute('rel', 'noopener noreferrer');
  guide.textContent = STR.gcalGuideLink;
  var form = document.createElement('div');
  form.className = 'timer-setup';
  function gfield(label, type) {
    var l = document.createElement('label');
    l.appendChild(document.createTextNode(label + ' '));
    var input = document.createElement('input');
    input.type = type;
    input.setAttribute('autocomplete', type === 'password' ? 'new-password' : 'off');
    input.setAttribute('spellcheck', 'false');
    input.maxLength = 2000;
    if (type === 'password') input.placeholder = STR.secretTailUnset;
    l.appendChild(input);
    form.appendChild(l);
    form.appendChild(document.createTextNode(' '));
    return input;
  }
  var idEl = gfield(STR.sitesClientId, 'text');
  var secEl = gfield(STR.sitesClientSecret, 'password');
  var loginBtn = document.createElement('button');
  loginBtn.type = 'button';
  loginBtn.className = 'timer-btn primary';
  var rekeyBtn = document.createElement('button');
  rekeyBtn.type = 'button';
  rekeyBtn.className = 'timer-btn';
  rekeyBtn.textContent = STR.loginRekey;
  var linking = false;
  var haveKeys = false;
  var showForm = false;
  link.appendChild(linkState);
  link.appendChild(form);
  link.appendChild(loginBtn);
  link.appendChild(document.createTextNode(' '));
  link.appendChild(rekeyBtn);
  var guideP = document.createElement('p');
  guideP.className = 'timer-hint';
  guideP.appendChild(guide);
  // カレンダーのプラグイン（gcal）が読まれていない（calendar.loginStatus が unknown-method）ときは、この行だけにする
  function paintNoPlugin() {
    linkState.textContent = STR.gcalNoPlugin;
    form.style.display = 'none';
    loginBtn.style.display = 'none';
    rekeyBtn.style.display = 'none';
    guideP.style.display = 'none';
  }
  function showLinkParts() {
    loginBtn.style.display = '';
    guideP.style.display = '';
  }
  link.appendChild(guideP);
  box.appendChild(link);

  function runLogin() {
    linking = true;
    loginBtn.disabled = true;
    linkState.textContent = STR.gcalLinking;
    return call('auth.reauth', { site: 'google' }).then(function (res) {
      linkState.textContent = res && res.ok === true ? STR.gcalLinkDone : STR.loginErr(res && res.error);
    }).catch(function () {
      linkState.textContent = STR.loginErr('failed');
    }).then(function () { linking = false; paintLink(); });
  }
  loginBtn.addEventListener('click', function () {
    if (!can.write || linking) return;
    if (showForm || !haveKeys) {
      var body = { site: 'google', clientId: idEl.value, clientSecret: secEl.value };
      secEl.value = '';
      linking = true;
      loginBtn.disabled = true;
      call('sites.setOAuthApp', body).then(function (res) {
        linking = false;
        if (!res || res.ok === false) { linkState.textContent = STR.loginErr(res && res.error); paintLink(); return; }
        idEl.value = '';
        showForm = false;
        return runLogin();
      }).catch(function () { linking = false; linkState.textContent = STR.loginErr('failed'); paintLink(); });
      return;
    }
    if (!window.confirm(STR.gcalLinkConfirm)) return;
    runLogin();
  });
  rekeyBtn.addEventListener('click', function () { showForm = true; paintLink(); });

  function paintLink() {
    return call('calendar.loginStatus', {}).then(function (st) {
      if (st && st.ok === false && st.error === 'unknown-method') { paintNoPlugin(); return; }
      showLinkParts();
      var s = st && st.ok !== false ? st.state : 'none';
      haveKeys = s !== 'none';
      if (!linking) linkState.textContent = STR.gcalLoginState(s);
      form.style.display = (!haveKeys || showForm) ? '' : 'none';
      rekeyBtn.style.display = haveKeys && !showForm ? '' : 'none';
      loginBtn.textContent = !haveKeys || showForm ? STR.gcalSaveAndLogin : (s === 'logged-in' ? STR.loginRelink : STR.gcalLogin);
      loginBtn.disabled = !can.write || linking;
      rekeyBtn.disabled = !can.write;
    }).catch(function () { linkState.textContent = STR.gcalLoginUnknown; loginBtn.disabled = true; });
  }

  function paint() {
    paintLink();
    return call('plugin.gcal.getStatus', {}).then(function (st) {
      var mode = st && st.mode ? st.mode : 'legacy';
      box1.checked = mode === 'live';
      box1.disabled = !can.write;
      var parts = [mode === 'live' ? STR.uiMenubar75 : (mode === 'shadow' ? STR.uiMenubar76 : STR.uiMenubar77)];
      if (st && typeof st.queue === 'number' && st.queue > 0) parts.push(STR.uiMenubar78 + st.queue + STR.uiMenubar79);
      if (st && st.lastError) parts.push(STR.uiMenubar80 + st.lastError);
      state.textContent = parts.join(' / ');
    }).catch(function () {
      state.textContent = STR.uiMenubar81;
      box1.disabled = true;
    });
  }
  box1.addEventListener('change', function () {
    var want = box1.checked ? 'live' : 'legacy';
    if (want === 'live' && !window.confirm(STR.uiMenubar82)) { box1.checked = false; return; }
    box1.disabled = true;
    call('modes.set', { id: 'gcal', mode: want, confirmName: 'gcal' }).then(function (res) {
      if (res && res.ok === false) state.textContent = STR.uiMenubar83 + (res.error || '');
    }).catch(function () {
      state.textContent = STR.uiMenubar68;
    }).then(paint);
  });
  paint();
  setInterval(function () { if (host.offsetParent) paint(); }, 10000);
}

var GUIDE_KEY = 'marust.timer.guideClosed';
function guideClosedBefore() {
  try { return window.localStorage.getItem(GUIDE_KEY) === '1'; } catch (_) { return false; }
}
function buildGuideSection(host) {
  var box = document.createElement('section');
  box.className = 'extras-card guide';
  var head = document.createElement('div');
  head.className = 'guide-head';
  var strong = document.createElement('strong');
  strong.textContent = STR.uiMenubar84;
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'link-btn';
  close.textContent = STR.uiMenubar85;
  head.appendChild(strong);
  head.appendChild(close);
  var list = document.createElement('ol');
  list.className = 'steps';
  [
    [STR.uiMenubar86, STR.uiMenubar87],
    [STR.uiMenubar88, STR.uiMenubar89],
    [STR.uiMenubar90, STR.uiMenubar91]
  ].forEach(function (step, i) {
    var li = document.createElement('li');
    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    var body = document.createElement('div');
    var b = document.createElement('b');
    b.textContent = step[0];
    var small = document.createElement('small');
    small.textContent = step[1];
    body.appendChild(b);
    body.appendChild(small);
    li.appendChild(num);
    li.appendChild(body);
    list.appendChild(li);
  });
  var link = document.createElement('button');
  link.type = 'button';
  link.className = 'link-btn small';
  link.textContent = STR.uiMenubar92;
  box.appendChild(head);
  box.appendChild(list);
  host.appendChild(box);
  host.appendChild(link);

  function show(on) {
    box.hidden = !on;
    link.hidden = on;
  }
  show(!guideClosedBefore());
  close.addEventListener('click', function () {
    try { window.localStorage.setItem(GUIDE_KEY, '1'); } catch (_) { /* 覚えられなくても閉じる */ }
    show(false);
  });
  link.addEventListener('click', function () { show(true); });
}
