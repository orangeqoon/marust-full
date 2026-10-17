'use strict';

// プラグイン一覧（開発者の表。K3 で本体の ui/panels/plugins.js から移した）。読むだけ。
var box = document.getElementById('plugins');

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch];
  });
}
function statusClass(status) {
  if (status === 'running') return 'status-running';
  if (status === 'listed-not-started') return 'status-listed-not-started';
  if (status === 'accepted') return 'status-accepted';
  return 'status-other';
}

function refresh() {
  window.marust.call('hub.getState', {}).then(function (state) {
    var rows = state && Array.isArray(state.plugins) ? state.plugins : [];
    if (!rows.length) {
      box.innerHTML = S.uiPlugins1;
      return;
    }
    var body = rows.map(function (row) {
      return '<tr><td>' + escapeHtml(row.id) + '</td><td>' + escapeHtml(row.name) + '</td><td>' + escapeHtml(row.kind) + '</td><td>' + escapeHtml(row.mode || '') + '</td><td>' + escapeHtml(Array.isArray(row.provides) ? row.provides.join(', ') : '') + '</td><td>' + escapeHtml(Array.isArray(row.requires) ? row.requires.join(', ') : '') + '</td><td>' + escapeHtml(row.source) + '</td><td class="' + statusClass(row.status) + '">' + escapeHtml(row.status) + '</td><td>' + escapeHtml(row.reason) + '</td></tr>';
    }).join('');
    box.innerHTML = S.uiPlugins2 + body + '</tbody></table>';
  }).catch(function (err) {
    box.innerHTML = S.uiPlugins3 + escapeHtml(err && err.message) + '</p>';
  });
}

refresh();
setInterval(refresh, 1000);
window.marust.onEvent(function () { refresh(); });
