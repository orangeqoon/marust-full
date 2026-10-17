'use strict';

// shadow の報告（開発者用）。本体の shadow.report（読むだけ）を親の画面経由で呼ぶ。値は表示しない。
var statusEl = document.getElementById('status');
var sitesEl = document.getElementById('sites');
var pluginsEl = document.getElementById('plugins');
var daysEl = document.getElementById('days');
var pending = '';
var seq = 0;

function call(method, params) {
  seq += 1;
  pending = 'r' + seq;
  parent.postMessage({ type: 'marust:call', id: pending, method: method, params: params || {} }, '*');
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function cell(text) {
  var td = document.createElement('td');
  td.textContent = text;
  return td;
}

function errorsText(errors) {
  if (!errors || typeof errors !== 'object') return 'なし';
  var names = Object.keys(errors);
  if (!names.length) return 'なし';
  return names.map(function (n) { return n + ' ' + errors[n]; }).join(', ');
}

function samplesText(samples) {
  if (!samples || !samples.length) return '';
  return samples.filter(function (s) { return typeof s === 'string' && s; }).join('、');
}

function rowsOf(map) {
  var rows = [];
  if (!map || typeof map !== 'object') return rows;
  Object.keys(map).forEach(function (name) {
    var body = map[name] || {};
    rows.push({ name: name, count: body.count || 0, lastAt: typeof body.lastAt === 'string' ? body.lastAt : '', samples: body.samples, errors: body.errors });
  });
  return rows;
}

function table(rows, nameHead) {
  var t = document.createElement('table');
  var head = document.createElement('tr');
  [nameHead, '回数', '最後', '見本', '失敗'].forEach(function (label) {
    var th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    head.appendChild(th);
  });
  var thead = document.createElement('thead');
  thead.appendChild(head);
  var tbody = document.createElement('tbody');
  rows.forEach(function (row) {
    var tr = document.createElement('tr');
    tr.appendChild(cell(row.name));
    tr.appendChild(cell(String(row.count)));
    tr.appendChild(cell(row.lastAt));
    tr.appendChild(cell(samplesText(row.samples)));
    tr.appendChild(cell(errorsText(row.errors)));
    tbody.appendChild(tr);
  });
  t.appendChild(thead);
  t.appendChild(tbody);
  return t;
}

function paint(result) {
  clear(sitesEl);
  clear(pluginsEl);
  var siteRows = rowsOf(result && result.sites);
  if (!siteRows.length) {
    var empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'サイトの記録はありません';
    sitesEl.appendChild(empty);
  } else {
    sitesEl.appendChild(table(siteRows, 'サイト'));
  }
  var title = document.createElement('h3');
  title.textContent = 'プラグイン';
  pluginsEl.appendChild(title);
  pluginsEl.appendChild(table(rowsOf(result && result.plugins), 'プラグイン'));
  if (result && result.truncated === true) {
    var cut = document.createElement('p');
    cut.className = 'note';
    cut.textContent = '大きいので途中で打ち切りました';
    pluginsEl.appendChild(cut);
  }
  if (result && result.broken) {
    var broken = document.createElement('p');
    broken.className = 'note';
    broken.textContent = '壊れた行: ' + String(result.broken);
    pluginsEl.appendChild(broken);
  }
}

function chosenDays() {
  var n = Math.floor(Number(daysEl.value));
  if (!isFinite(n)) n = 7;
  n = Math.min(30, Math.max(1, n));
  daysEl.value = String(n);
  return n;
}

function refresh() {
  statusEl.textContent = '読み込み中';
  call('shadow.report', { days: chosenDays() });
}

window.addEventListener('message', function (event) {
  var msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.type !== 'marust:result' || String(msg.id) !== pending) return;
  var res = msg.result;
  if (!res || res.ok === false) {
    statusEl.textContent = '報告を読めませんでした';
    paint(null);
    return;
  }
  statusEl.textContent = '';
  paint(res);
});

daysEl.addEventListener('change', refresh);
document.getElementById('refresh').addEventListener('click', refresh);
refresh();
