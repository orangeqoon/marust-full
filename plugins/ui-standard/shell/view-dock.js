'use strict';

/**
 * `?view=dock`（OBS のブラウザドック向けの縦長の簡易表示）。
 *
 * - 表示の切り替えは DOM を使わない plan() で決める。`panel` を優先し、
 *   `view=dock` のときは 全停止（非常停止）だけを縦 1 列にする。
 * - mount() は 4 部品を #dock-view に移して足す部品だけ作る。watch() は定期の読み直しだけ。
 * - 権限は今までと同じ。部品は data-need を持ち、閲覧は read、開始・停止は write。
 *   ペアリングは gateway の /pair（今のペアリング画面）のまま。ウィンドウ専用の操作は出さない。
 * - 別のスクリプトと名前がぶつからないように、全部を関数の中で閉じる。
 */
(function (global) {

var DOCK_WIDGETS = ['emergency'];

function plan(search) {
  var params = new URLSearchParams(String(search == null ? '' : search));
  // `panel` が優先（今の `?panel=` の動きを壊さない）。
  if (params.has('panel')) return { mode: 'panel', panel: params.get('panel'), widgets: [] };
  if (params.get('view') === 'dock') return { mode: 'dock', panel: null, widgets: DOCK_WIDGETS.slice() };
  return { mode: 'default', panel: null, widgets: [] };
}

function rpc(method, params) {
  var api = (typeof window !== 'undefined' && window.marustApi) || null;
  if (!api || typeof api.call !== 'function') return Promise.reject(new Error('no-api'));
  return api.call(method, params);
}

function formatClock(ms) {
  var value = Number(ms);
  if (!Number.isFinite(value) || value < 0) value = 0;
  var total = Math.floor(value / 1000);
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}

function stateClass(state) {
  if (state === 'live') return 'state-live';
  if (state === 'connecting' || state === 'reconnecting') return 'state-connecting';
  if (state === 'stopped') return 'state-stopped';
  return 'state-error';
}

/**
 * 配信先 1 行ぶん。サイト名・状態・再接続回数だけを拾い、キーなどの値は拾わない。
 */
function destinationInfo(row) {
  var source = row || {};
  var name = source.name == null ? '' : String(source.name);
  var site = source.site == null ? '' : String(source.site);
  var label = site && name ? site + ' / ' + name : (site || name || STR.uiViewdock1);
  var state = source.state == null ? '' : String(source.state);
  var raw = source.reconnects;
  var reconnects = null;
  if (raw != null && raw !== '') {
    var n = Number(raw);
    reconnects = Number.isFinite(n) ? n : null;
  }
  return { label: label, state: state, reconnects: reconnects };
}

function fieldValue(doc, id) {
  var el = doc.getElementById(id);
  if (!el || el.value == null) return '';
  return String(el.value).trim();
}

function errorText(code) {
  if (code === 'session-active') return STR.uiViewdock2;
  if (code === 'forbidden') return STR.uiViewdock3;
  if (code === 'title-length') return STR.uiViewdock4;
  if (code === 'bad-title') return STR.uiViewdock4;
  if (code === 'bad-category') return STR.uiViewdock5;
  if (code === 'unavailable') return STR.uiViewdock6;
  if (code === 'no-api') return STR.uiViewdock7;
  return code ? String(code) : STR.uiViewdock8;
}

function setStatus(doc, text) {
  var status = doc.getElementById('dock-session-status');
  if (status) status.textContent = text || '';
}

function makeButton(doc, id, text, primary) {
  var button = doc.createElement('button');
  button.id = id;
  button.type = 'button';
  button.className = 'timer-btn' + (primary ? ' primary' : '');
  button.setAttribute('data-need', 'write');
  button.textContent = text;
  return button;
}

function startSession(doc) {
  var params = {};
  var title = fieldValue(doc, 'fanout-title');
  var category = fieldValue(doc, 'fanout-category');
  if (title) params.title = title;
  if (category) params.category = category;
  setStatus(doc, '');
  return rpc('session.start', params).then(function (res) {
    if (!res || res.ok === false) setStatus(doc, errorText(res && res.error));
    else setStatus(doc, '');
  }).catch(function (err) {
    setStatus(doc, errorText(err && err.message));
  });
}

function stopSession(doc) {
  setStatus(doc, '');
  return rpc('session.end', {}).then(function (res) {
    if (!res || res.ok === false) setStatus(doc, errorText(res && res.error));
    else setStatus(doc, '');
  }).catch(function (err) {
    setStatus(doc, errorText(err && err.message));
  });
}

function buildSessionWidget(doc) {
  var wrap = doc.createElement('div');
  wrap.id = 'dock-session';
  wrap.className = 'dock-session';

  var elapsed = doc.createElement('p');
  elapsed.id = 'dock-session-elapsed';
  elapsed.className = 'dock-elapsed idle';
  var label = doc.createElement('span');
  label.className = 'sr-only';
  label.textContent = STR.uiViewdock9;
  var clock = doc.createElement('span');
  clock.id = 'dock-session-clock';
  clock.textContent = '00:00:00';
  elapsed.appendChild(label);
  elapsed.appendChild(clock);

  var actions = doc.createElement('div');
  actions.className = 'dock-actions';
  var start = makeButton(doc, 'dock-session-start', STR.uiViewdock10, true);
  var stop = makeButton(doc, 'dock-session-stop', STR.uiViewdock11, false);
  start.addEventListener('click', function () {
    if (start.disabled) return;
    startSession(doc);
  });
  stop.addEventListener('click', function () {
    if (stop.disabled) return;
    stopSession(doc);
  });
  actions.appendChild(start);
  actions.appendChild(stop);

  var status = doc.createElement('p');
  status.id = 'dock-session-status';
  status.className = 'timer-hint';
  status.setAttribute('aria-live', 'polite');

  wrap.appendChild(elapsed);
  wrap.appendChild(actions);
  wrap.appendChild(status);
  return wrap;
}

function buildDestinationWidget(doc) {
  var box = doc.createElement('div');
  box.id = 'dock-dest-status';
  box.className = 'dock-dest-list';
  var empty = doc.createElement('p');
  empty.className = 'empty';
  empty.textContent = STR.uiViewdock12;
  box.appendChild(empty);
  return box;
}

function paintDestinations(doc, rows) {
  var box = doc.getElementById('dock-dest-status');
  if (!box) return;
  box.textContent = '';
  if (!rows.length) {
    var empty = doc.createElement('p');
    empty.className = 'empty';
    empty.textContent = STR.uiViewdock13;
    box.appendChild(empty);
    return;
  }
  rows.forEach(function (row) {
    var info = destinationInfo(row);
    var line = doc.createElement('div');
    line.className = 'dock-dest-row ' + stateClass(info.state);
    var name = doc.createElement('span');
    name.className = 'dock-dest-name';
    name.textContent = info.label;
    var state = doc.createElement('span');
    state.className = 'dock-dest-state';
    state.textContent = info.state ? (typeof STR !== 'undefined' ? STR.state(info.state) : info.state) : '-';
    var back = doc.createElement('span');
    back.className = 'dock-dest-reconnect';
    back.textContent = STR.uiViewdock14 + (info.reconnects == null ? '-' : String(info.reconnects));
    line.appendChild(name);
    line.appendChild(state);
    line.appendChild(back);
    box.appendChild(line);
  });
}

function paintSession(doc, session) {
  var row = session || { active: false };
  var active = row.active === true;
  var clock = doc.getElementById('dock-session-clock');
  if (clock) clock.textContent = formatClock(active ? row.elapsedMs || 0 : 0);
  var elapsed = doc.getElementById('dock-session-elapsed');
  if (elapsed) elapsed.className = 'dock-elapsed' + (active ? '' : ' idle');
}

/**
 * 4 部品だけを縦 1 列に組み立てる。タイマーは走らせない（watch が走らせる）。
 */
function mount(doc, planRow) {
  if (!doc || !doc.body) return null;
  var widgets = (planRow && planRow.widgets) || DOCK_WIDGETS;
  doc.body.classList.add('dock-view');
  var container = doc.createElement('div');
  container.id = 'dock-view';
  var moved = [];
  widgets.forEach(function (id) {
    var section = doc.querySelector('[data-panel="' + id + '"]');
    if (!section) return;
    container.appendChild(section);
    moved.push(id);
    if (id === 'destinations') section.appendChild(buildDestinationWidget(doc));
    if (id === 'session') section.appendChild(buildSessionWidget(doc));
  });
  doc.body.appendChild(container);
  container.setAttribute('data-widgets', moved.join(','));
  return container;
}

function watch(doc) {
  if (!doc) return null;
  function refreshDestinations() {
    rpc('engine.listTargets').then(function (rows) {
      paintDestinations(doc, Array.isArray(rows) ? rows : []);
    }).catch(function () {});
  }
  function refreshSession() {
    rpc('hub.getState').then(function (state) {
      paintSession(doc, state && state.session);
    }).catch(function () {});
  }
  refreshDestinations();
  refreshSession();
  var timers = [
    setInterval(refreshDestinations, 2000),
    setInterval(refreshSession, 1000)
  ];
  if (typeof window !== 'undefined' && window.marustApi && typeof window.marustApi.subscribe === 'function') {
    window.marustApi.subscribe(function () {
      refreshDestinations();
      refreshSession();
    });
  }
  return {
    stop: function () {
      timers.forEach(function (id) { clearInterval(id); });
      timers = [];
    }
  };
}

var api = {
  DOCK_WIDGETS: DOCK_WIDGETS,
  plan: plan,
  mount: mount,
  watch: watch,
  destinationInfo: destinationInfo,
  stateClass: stateClass,
  formatClock: formatClock,
  errorText: errorText
};

if (typeof module === 'object' && module.exports) module.exports = api;
if (global) global.marustDockView = api;

})(typeof window !== 'undefined' ? window : null);

