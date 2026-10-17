'use strict';
/** パネル `clients`（接続端末）。 */
function initClients() {
  var root = panelRoot('clients');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var list = root.querySelector('#client-list');
  var codeEl = root.querySelector('#pair-code');
  var isWindow = false;
  function refresh() {
    call('hub.getState').then(function (state) {
      notePermissions(state && state.permissions); if (state && typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
      isWindow = !!(state && state.clientId === 'local-window');
      var admin = root.querySelector('#client-admin');
      if (admin) admin.hidden = !isWindow;
    }).catch(function () {}).then(function () {
      if (!isWindow) {
        list.innerHTML = STR.uiClients1;
        return null;
      }
      return call('clients.list');
    }).then(function (res) {
      if (!isWindow) return;
      if (!res || res.ok === false) {
        list.innerHTML = STR.uiClients1;
        return;
      }
      var rows = res && res.clients ? res.clients : [];
      if (!rows.length) {
        list.innerHTML = STR.uiClients2;
        return;
      }
      list.innerHTML = rows.map(function (row) {
        var perms = Array.isArray(row.permissions) ? row.permissions.join(' + ') : '';
        var kind = row && row.kind ? String(row.kind) : '';
        var revoke = '';
        if (isWindow && row.id !== 'local-window') {
          revoke = ' <button class="timer-btn" type="button" data-act="revoke" data-id="' + escapeHtml(row.id) + '"' + (can.write ? '' : ' disabled') + STR.uiClients3;
        }
        return '<p>' + escapeHtml(row.name) + ' / ' + escapeHtml(kind) + ' / ' + escapeHtml(perms) + ' / ' + escapeHtml(row.lastSeenAt || '') + revoke + '</p>';
      }).join('');
    }).catch(function () {});
  }
  list.addEventListener('click', function (ev) {
    var button = ev.target.closest('button');
    if (!button || button.getAttribute('data-act') !== 'revoke') return;
    if (!isWindow || !can.write) return;
    var id = button.getAttribute('data-id');
    if (!window.confirm(STR.uiClients4)) return;
    call('clients.revoke', { id: id }).then(refresh).catch(function () {});
  });
  root.querySelector('#pair-start').addEventListener('click', function () {
    if (!isWindow || !can.write) return;
    var permissions = ['read'];
    if (root.querySelector('#pair-emergency').checked) permissions.push('emergency');
    if (root.querySelector('#pair-write').checked) permissions.push('write');
    call('clients.beginPairing', {
      name: root.querySelector('#pair-name').value,
      permissions: permissions
    }).then(function (res) {
      if (!res || res.ok === false) {
        codeEl.textContent = '';
        return;
      }
      codeEl.textContent = res.code || '';
    }).catch(function () {});
  });
  var extButton = document.createElement('button');
  extButton.className = 'timer-btn';
  extButton.type = 'button';
  extButton.id = 'pair-extension';
  extButton.setAttribute('data-need', 'write');
  extButton.textContent = STR.uiClients5;
  var setup = root.querySelector('#client-admin .timer-setup');
  if (setup) setup.appendChild(extButton);
  else if (root.querySelector('#client-admin')) root.querySelector('#client-admin').appendChild(extButton);
  extButton.addEventListener('click', function () {
    if (!isWindow || !can.write) return;
    call('clients.beginPairing', { name: STR.uiClients6, kind: 'extension' }).then(function (res) {
      if (!res || res.ok === false) {
        codeEl.textContent = '';
        return;
      }
      codeEl.textContent = res.code || '';
    }).catch(function () {});
  });
  var oneButton = document.createElement('button');
  oneButton.className = 'timer-btn';
  oneButton.type = 'button';
  oneButton.id = 'pair-onecomme';
  oneButton.setAttribute('data-need', 'write');
  oneButton.textContent = STR.uiClients7;
  if (setup) setup.appendChild(oneButton);
  else if (root.querySelector('#client-admin')) root.querySelector('#client-admin').appendChild(oneButton);
  oneButton.addEventListener('click', function () {
    if (!isWindow || !can.write) return;
    call('clients.beginPairing', {
      name: STR.uiClients8,
      kind: 'native',
      permissions: ['read', 'chat-write']
    }).then(function (res) {
      if (!res || res.ok === false) {
        codeEl.textContent = '';
        return;
      }
      codeEl.textContent = res.code || '';
    }).catch(function () {});
  });
  var mcpButton = document.createElement('button');
  mcpButton.className = 'timer-btn';
  mcpButton.type = 'button';
  mcpButton.id = 'pair-mcp';
  mcpButton.setAttribute('data-need', 'write');
  mcpButton.textContent = STR.uiClients9;
  mcpButton.hidden = !devMode; // AI（MCP）からの操作は承認待ちになり、承認の画面は開発者用。開発者モードのときだけ出す
  if (setup) setup.appendChild(mcpButton);
  else if (root.querySelector('#client-admin')) root.querySelector('#client-admin').appendChild(mcpButton);
  mcpButton.addEventListener('click', function () {
    if (!isWindow || !can.write) return;
    call('clients.beginPairing', {
      name: 'AI（MCP）',
      kind: 'native',
      requiresApproval: true,
      permissions: ['read', 'write'],
      mcp: true
    }).then(function (res) {
      if (!res || res.ok === false) {
        codeEl.textContent = '';
        return;
      }
      codeEl.textContent = res.code || '';
    }).catch(function () {});
  });
  refresh();
  setInterval(refresh, 2000);
  if (hubApi() && hubApi().subscribe) hubApi().subscribe(function () { refresh(); });
}

registerPanel('clients', initClients);
