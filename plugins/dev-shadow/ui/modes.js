'use strict';

// モードの画面（開発者用。K3 で本体の ui/panels/modes.js から移した）。
// 読むのは iframe 自身（hub.getState・modes.list は読み取り）。モードを変える操作は、親の窓だけが実行する（marust.parent）。
// 確認の窓（live の id 入力・まとめて live の一覧）は親が自分の言葉で出す。ここは名前と値を渡すだけ。
var rootEl = document.getElementById('modes-root');
var statusEl = document.createElement('p');
var forceLegacyEl = document.getElementById('force-legacy');
var forceLiveEl = document.getElementById('force-live');
var isWindow = false;
var dialogBusy = false;
var signature = '';
var ticket = 0;
var fileNote = document.createElement('p');
var defaults = document.createElement('div');
var tableWrap = document.createElement('div');

function can() { return window.marust.can(); }
function canWrite() { return isWindow && can().write === true; }

function modeHintText(summary) {
  var row = summary || {};
  if ((row.live || 0) > 0) return S.uiModes1;
  if ((row.shadow || 0) > 0) return S.uiMetadata6;
  return S.sendNoneAll;
}
function modesSourceLabel(source) {
  if (source === 'plugins') return S.uiModes2;
  if (source === 'default') return S.uiModes3;
  if (source === 'forceLegacy') return S.uiModes4;
  if (source === 'defaultMode') return S.uiModes5;
  return source || '';
}
function modesErrorText(code) {
  if (code === 'confirm-name') return S.uiModes6;
  if (code === 'requires-unmet') return S.uiModes7;
  if (code === 'unreadable') return S.uiModes8;
  if (code === 'live-default') return S.uiModes9;
  if (code === 'unknown-plugin') return S.uiModes10;
  if (code === 'forbidden') return S.uiModes11;
  if (code === 'bad-mode') return S.uiModes12;
  if (code === 'bad-id') return S.uiModes13;
  if (code === 'unavailable') return S.uiModes14;
  return code ? String(code) : S.uiModes15;
}
function clearNode(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}
function tableBusy() {
  if (dialogBusy) return true;
  var active = document.activeElement;
  return !!(active && tableWrap.contains(active));
}
function paintChrome() {
  forceLegacyEl.disabled = !canWrite();
  forceLiveEl.disabled = !canWrite();
  var bulk = rootEl.querySelectorAll('button[data-need="write"]');
  for (var i = 0; i < bulk.length; i += 1) bulk[i].disabled = !canWrite();
}

// 親に頼む。答えが ok:false なら理由を出す。canceled（親の確認で「やめる」）は何も言わない。
function ask(name, params) {
  return window.marust.parent(name, params).then(function (res) {
    if (!res || res.ok === false) {
      statusEl.textContent = modesErrorText(res && res.error);
      return null;
    }
    statusEl.textContent = '';
    return res;
  }, function () {
    statusEl.textContent = modesErrorText('failed');
    return null;
  });
}

function reportMany(mode, res) {
  if (!res || res.canceled) return;
  var rows = res.results || [];
  var okIds = rows.filter(function (r) { return r.ok; }).length;
  var bad = rows.filter(function (r) { return !r.ok; }).map(function (r) { return r.id + '(' + modesErrorText(r.error) + ')'; });
  statusEl.textContent = mode + S.uiModes28 + okIds + S.uiMenubar79 + (bad.length ? S.uiModes29 + bad.join('、') : '');
}

function bulkButton(id, text, mode) {
  var b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.setAttribute('data-need', 'write');
  b.textContent = text;
  b.addEventListener('click', function () {
    if (!canWrite()) return;
    b.disabled = true;
    ask('modes.setMany', { mode: mode }).then(function (res) {
      reportMany(mode, res);
      signature = '';
      refresh();
    }).then(function () { b.disabled = !canWrite(); });
  });
  return b;
}

function setAllLive() {
  if (!canWrite()) return Promise.resolve();
  return window.marust.call('modes.list', {}).then(function (res) {
    var ids = (res && res.ok !== false && Array.isArray(res.plugins) ? res.plugins : []).map(function (row) { return row.id; });
    return ask('modes.setMany', { mode: 'live', ids: ids });
  }).then(function (res) {
    if (!res || res.canceled) return;
    var rows = res.results || [];
    var bad = rows.filter(function (r) { return !r.ok; }).length;
    statusEl.textContent = S.uiModes23 + (rows.length - bad) + S.uiMenubar79 + (bad ? S.uiModes24 + bad + S.uiModes25 : '');
    signature = '';
    refresh();
  }).catch(function () { statusEl.textContent = S.uiViewdock8; });
}

function paintDefault(res) {
  clearNode(defaults);
  var label = document.createElement('p');
  label.className = 'hint';
  var mode = res && res.defaultMode ? res.defaultMode : '';
  var source = res && res.defaultSource ? res.defaultSource : '';
  if (source === 'forceLegacy') label.textContent = S.uiModes33;
  else if (mode) label.textContent = S.uiModes34 + mode + '（' + modesSourceLabel(source) + '）';
  else label.textContent = S.uiModes35;
  defaults.appendChild(label);
  if (!isWindow || !res || res.readable === false) return;
  var row = document.createElement('div');
  row.className = 'actions';
  var select = document.createElement('select');
  select.id = 'modes-default-mode';
  select.setAttribute('aria-label', S.uiModes36);
  if (mode !== 'legacy' && mode !== 'shadow') {
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = S.uiModes37;
    placeholder.selected = true;
    select.appendChild(placeholder);
  }
  ['legacy', 'shadow'].forEach(function (item) {
    var option = document.createElement('option');
    option.value = item;
    option.textContent = item;
    if (item === mode) option.selected = true;
    select.appendChild(option);
  });
  var save = document.createElement('button');
  save.type = 'button';
  save.id = 'modes-default-save';
  save.setAttribute('data-need', 'write');
  save.textContent = S.uiModes38;
  save.addEventListener('click', function () {
    if (!canWrite()) return;
    if (select.value !== 'legacy' && select.value !== 'shadow') {
      statusEl.textContent = modesErrorText('live-default');
      return;
    }
    ask('modes.setDefault', { mode: select.value }).then(function (res) {
      if (!res) return;
      signature = '';
      refresh();
    });
  });
  row.appendChild(select);
  row.appendChild(save);
  defaults.appendChild(row);
}

function changeMode(row, select, next) {
  var prev = select.getAttribute('data-current') || 'legacy';
  if (next === prev) return;
  if (!canWrite()) {
    select.value = prev;
    return;
  }
  if (next === 'live' && row.requiresMet === false) {
    statusEl.textContent = modesErrorText('requires-unmet');
    select.value = prev;
    return;
  }
  dialogBusy = true;
  ask('modes.change', { id: row.id, mode: next }).then(function (res) {
    dialogBusy = false;
    if (!res || res.canceled) {
      select.value = prev;
      return;
    }
    select.setAttribute('data-current', next);
    signature = '';
    refresh();
  });
}

function paintRows(res) {
  clearNode(tableWrap);
  var plugins = res && Array.isArray(res.plugins) ? res.plugins : [];
  if (!plugins.length) {
    var empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = S.uiModes39;
    tableWrap.appendChild(empty);
    return;
  }
  var table = document.createElement('table');
  table.className = 'modes-table';
  var head = document.createElement('thead');
  var headRow = document.createElement('tr');
  [S.uiModes40, S.uiState3, S.uiModes41, 'requires', S.uiModes42].forEach(function (text) {
    var cell = document.createElement('th');
    cell.textContent = text;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);
  var body = document.createElement('tbody');
  // 見やすさのため、種類ごとにまとめる。v1 の旧版（site-* に置き換え済み）は折りたたむ。
  var known = {};
  plugins.forEach(function (row) { known[String(row.id)] = true; });
  var GROUP_NAMES = [S.uiModes43, S.uiState7, S.uiModes44, S.uiModes45];
  function groupOf(row) {
    var id = String(row.id || '');
    if (/^site-/.test(id)) return 0;
    if (known['site-' + id]) return 3;
    if (/^(chat|sink)-/.test(id)) return 1;
    return 2;
  }
  var ordered = plugins.slice().sort(function (a, b) {
    var ga = groupOf(a);
    var gb = groupOf(b);
    if (ga !== gb) return ga - gb;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'ja');
  });
  var lastGroup = -1;
  var legacyRows = [];
  ordered.forEach(function (row) {
    var group = groupOf(row);
    if (group !== lastGroup) {
      lastGroup = group;
      var headTr = document.createElement('tr');
      headTr.className = 'modes-group';
      var headTd = document.createElement('td');
      headTd.colSpan = 5;
      if (group === 3) {
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = GROUP_NAMES[group] + S.uiModes46;
        toggle.addEventListener('click', function () {
          var open = toggle.getAttribute('aria-expanded') !== 'true';
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          toggle.textContent = GROUP_NAMES[group] + (open ? S.uiModes47 : S.uiModes46);
          legacyRows.forEach(function (r) { r.hidden = !open; });
        });
        headTd.appendChild(toggle);
      } else {
        headTd.textContent = GROUP_NAMES[group];
      }
      headTr.appendChild(headTd);
      body.appendChild(headTr);
    }
    var tr = document.createElement('tr');
    if (group === 3) {
      tr.hidden = true;
      legacyRows.push(tr);
    }
    var name = document.createElement('td');
    if (row.name && row.id && row.name !== row.id) name.textContent = row.name + ' (' + row.id + ')';
    else name.textContent = row.name || row.id || '';
    var modeCell = document.createElement('td');
    modeCell.textContent = row.mode || '';
    var sourceCell = document.createElement('td');
    sourceCell.textContent = modesSourceLabel(row.source);
    var needs = document.createElement('td');
    if (row.requiresMet === false) {
      needs.className = 'modes-unmet';
      var missing = Array.isArray(row.missing) ? row.missing : [];
      needs.textContent = missing.length ? (S.uiModes48 + missing.join(', ')) : S.uiModes49;
    } else {
      needs.className = 'modes-met';
      needs.textContent = S.uiModes50;
    }
    var controls = document.createElement('td');
    if (isWindow && res.readable !== false) {
      var select = document.createElement('select');
      select.setAttribute('aria-label', (row.name || row.id) + S.uiModes51);
      select.setAttribute('data-current', row.mode || 'legacy');
      ['legacy', 'shadow', 'live'].forEach(function (item) {
        var option = document.createElement('option');
        option.value = item;
        option.textContent = item;
        if (item === 'live' && row.requiresMet === false) option.disabled = true;
        if (item === row.mode) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', function () { changeMode(row, select, select.value); });
      controls.appendChild(select);
    } else {
      controls.textContent = S.uiModes53;
    }
    tr.appendChild(name);
    tr.appendChild(modeCell);
    tr.appendChild(sourceCell);
    tr.appendChild(needs);
    tr.appendChild(controls);
    body.appendChild(tr);
  });
  table.appendChild(body);
  tableWrap.appendChild(table);
}

function paint(res) {
  fileNote.textContent = res && res.readable === false ? S.uiModes54 : '';
  paintDefault(res);
  paintRows(res);
  paintChrome();
}

function refresh() {
  var mine = ++ticket;
  return window.marust.call('hub.getState', {}).then(function (state) {
    if (mine !== ticket) return null;
    isWindow = !!(state && state.clientId === 'local-window');
    var summary = state.modeSummary || { live: 0, shadow: 0, legacy: 0 };
    document.getElementById('mode').textContent = state.mode || ('live ' + (summary.live || 0) + ' / shadow ' + (summary.shadow || 0) + ' / legacy ' + (summary.legacy || 0));
    document.getElementById('mode-hint').textContent = modeHintText(summary);
    document.getElementById('state-warning').textContent = state.stateWarning || '';
    paintChrome();
    return window.marust.call('modes.list', {});
  }).then(function (res) {
    if (mine !== ticket || !res) return;
    if (res.ok === false) {
      statusEl.textContent = modesErrorText(res.error);
      paintChrome();
      return;
    }
    var nextSig = (isWindow ? '1' : '0') + '\n' + JSON.stringify(res);
    if (nextSig === signature || tableBusy()) {
      paintChrome();
      return;
    }
    signature = nextSig;
    paint(res);
  }).catch(function () {});
}

fileNote.className = 'modes-warn';
statusEl.className = 'hint';
statusEl.setAttribute('aria-live', 'polite');
tableWrap.className = 'modes-table-wrap';
var bulkNote = document.createElement('p');
bulkNote.className = 'hint';
bulkNote.textContent = S.uiModes26;
var bulkRow = document.createElement('div');
bulkRow.className = 'actions';
bulkRow.appendChild(bulkButton('modes-all-shadow', S.uiModes30, 'shadow'));
bulkRow.appendChild(bulkButton('modes-all-live', S.uiModes31, 'live'));
bulkRow.appendChild(bulkButton('modes-all-legacy', S.uiModes32, 'legacy'));
rootEl.appendChild(fileNote);
rootEl.appendChild(bulkNote);
rootEl.appendChild(bulkRow);
rootEl.appendChild(defaults);
rootEl.appendChild(tableWrap);
rootEl.appendChild(statusEl);

forceLegacyEl.disabled = true;
forceLiveEl.disabled = true;
forceLegacyEl.addEventListener('click', function () {
  if (!canWrite()) return;
  ask('hub.forceLegacy', {}).then(function () {
    signature = '';
    refresh();
  });
});
forceLiveEl.addEventListener('click', function () { setAllLive(); });
window.marust.onPerm(function () { paintChrome(); });
refresh();
setInterval(refresh, 1000);
window.marust.onEvent(function () { refresh(); });
