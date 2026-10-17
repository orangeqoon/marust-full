'use strict';

// オーバーレイ一覧（V7 C4。前は本体の ui/panels/overlays.js）。OBS のブラウザソースに貼る URL と、小さなプレビュー。
// 一覧は、読み込まれている全プラグインの overlays 宣言（hub.getState の plugins）から作る。読むだけ。
// プレビューも sandbox="allow-scripts" だけ（親の Cookie を渡さない）。

var ORIGIN = 'http://127.0.0.1:18770';
var listEl = document.getElementById('overlay-list');
var emptyEl = document.getElementById('overlay-empty');

function validPluginId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

function validOverlayName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(name);
}

function overlayUrl(pluginId, name) {
  if (!validPluginId(pluginId) || !validOverlayName(name)) return '';
  return ORIGIN + '/overlay/' + encodeURIComponent(pluginId) + '/' + encodeURIComponent(name);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function pluginLabel(row) {
  if (row && typeof row.name === 'string' && row.name.trim()) return row.name.trim();
  return row && row.id ? row.id : '';
}

function collect(plugins) {
  var items = [];
  var seen = {};
  (Array.isArray(plugins) ? plugins : []).forEach(function (row) {
    if (!row || typeof row !== 'object' || row.status === 'skip' || !validPluginId(row.id)) return;
    var overlays = Array.isArray(row.overlays) ? row.overlays : [];
    overlays.forEach(function (entry) {
      if (!entry || typeof entry !== 'object' || !validOverlayName(entry.name)) return;
      var key = row.id + '/' + entry.name;
      if (seen[key]) return;
      seen[key] = true;
      items.push({ label: pluginLabel(row), name: entry.name, url: overlayUrl(row.id, entry.name) });
    });
  });
  return items;
}

function copyText(text) {
  var area = document.createElement('textarea');
  area.value = text;
  document.body.appendChild(area);
  if (typeof area.select === 'function') area.select();
  try {
    if (typeof document.execCommand === 'function') document.execCommand('copy');
  } catch (_) { /* 手で選ぶ */ }
  if (area.parentNode) area.parentNode.removeChild(area);
}

function renderItem(item) {
  var li = document.createElement('li');
  li.className = 'overlay-item';
  var title = document.createElement('div');
  title.className = 'overlay-title';
  title.textContent = item.label + ' / ' + item.name;
  var input = document.createElement('input');
  input.className = 'overlay-url';
  input.setAttribute('type', 'text');
  input.setAttribute('readonly', 'readonly');
  input.value = item.url;
  var button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.textContent = 'コピー';
  button.addEventListener('click', function () {
    copyText(item.url);
    window.marust.toast('URL をコピーしました');
  });
  var frame = document.createElement('iframe');
  frame.className = 'overlay-preview';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('src', item.url);
  frame.setAttribute('title', item.label + ' / ' + item.name);
  li.appendChild(title);
  li.appendChild(input);
  li.appendChild(button);
  li.appendChild(frame);
  return li;
}

var lastKey = '';

function paint(items) {
  // 一覧が変わらないときは描き直さない（プレビューが読み直されるのを避ける）
  var key = items.map(function (item) { return item.url; }).join('\n');
  if (key === lastKey) return;
  lastKey = key;
  clear(listEl);
  emptyEl.hidden = items.length > 0;
  items.forEach(function (item) { listEl.appendChild(renderItem(item)); });
}

function refresh() {
  window.marust.call('hub.getState', {}).then(function (state) {
    if (state && state.ok !== false) paint(collect(state.plugins));
  });
}

window.marust.onEvent(function (name) {
  if (name === 'modes.changed') refresh();
});
refresh();
// 表示中の更新は 15 秒以上あける
setInterval(refresh, 30000);
