'use strict';
/** パネル `approvals`（承認待ち。開発者モード）。 */
function initApprovals() {
  var root = panelRoot('approvals');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var list = root.querySelector('#approval-list');
  var isWindow = false;
  function paint(rows) {
    var items = Array.isArray(rows) ? rows : [];
    if (!items.length) {
      list.innerHTML = STR.uiApprovals1;
      return;
    }
    list.innerHTML = items.map(function (row) {
      var id = row && row.approvalId ? String(row.approvalId) : '';
      var buttons = '';
      if (isWindow && id) {
        var disabled = can.write ? '' : ' disabled';
        buttons = ' <button class="timer-btn" type="button" data-act="approve" data-id="' + escapeHtml(id) + '"' + disabled + STR.uiApprovals2
          + ' <button class="timer-btn" type="button" data-act="deny" data-id="' + escapeHtml(id) + '"' + disabled + STR.uiApprovals3;
      }
      return '<p>' + escapeHtml(row && row.clientId) + ' / ' + escapeHtml(row && row.method) + STR.uiApprovals4 + escapeHtml(row && row.expiresAt) + (row && row.method === 'app.restart' ? escapeHtml(STR.uiApprovalsRestart) : '') + buttons + '</p>';
    }).join('');
  }
  function refresh() {
    call('hub.getState').then(function (state) {
      notePermissions(state && state.permissions); if (state && typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
      isWindow = !!(state && state.clientId === 'local-window');
    }).catch(function () {}).then(function () {
      return call('approval.list');
    }).then(function (res) {
      paint(res && res.approvals);
    }).catch(function () {});
  }
  list.addEventListener('click', function (ev) {
    var button = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!button) return;
    var act = button.getAttribute('data-act');
    if (act !== 'approve' && act !== 'deny') return;
    if (!isWindow || !can.write) return;
    var method = act === 'approve' ? 'approval.approve' : 'approval.deny';
    call(method, { id: button.getAttribute('data-id') }).then(refresh).catch(function () {});
  });
  refresh();
  setInterval(refresh, 2000);
  if (hubApi() && hubApi().subscribe) {
    hubApi().subscribe(function (msg) {
      if (msg && msg.name === 'approval.resolved') refresh();
    });
  }
}

registerPanel('approvals', initApprovals);
