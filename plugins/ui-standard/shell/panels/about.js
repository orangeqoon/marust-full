'use strict';
/** パネル `about`（この画面について）。Windows の起動時に開く設定もここ。 */
function initOpenAtLogin() {
  var box = document.getElementById('login-item');
  var input = document.getElementById('open-at-login');
  var status = document.getElementById('open-at-login-status');
  if (!box || !input || input.dataset.bound === '1') return;
  input.dataset.bound = '1';
  var isWindow = false;
  var applying = false;
  var saving = false;
  function paint(openAtLogin) {
    applying = true;
    box.hidden = !isWindow;
    input.checked = openAtLogin === true;
    input.disabled = !isWindow || !can.write;
    applying = false;
    applyNeed();
  }
  function refresh() {
    if (saving) return;
    call('hub.getState').then(function (state) {
      if (saving) return null;
      notePermissions(state && state.permissions); if (state && typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
      isWindow = !!(state && state.clientId === 'local-window');
      if (!isWindow) {
        paint(false);
        return null;
      }
      return call('app.settings.get');
    }).then(function (res) {
      if (saving || !isWindow) return;
      if (!res || res.ok === false) {
        paint(false);
        if (status) status.textContent = res && res.error ? String(res.error) : '';
        return;
      }
      if (status) status.textContent = '';
      paint(res.openAtLogin === true);
    }).catch(function () {
      if (!saving) paint(false);
    });
  }
  input.addEventListener('change', function () {
    if (applying || saving) return;
    var next = input.checked === true;
    if (!isWindow || !can.write) {
      input.checked = !next;
      return;
    }
    saving = true;
    call('app.settings.set', { openAtLogin: next }).then(function (res) {
      if (!res || res.ok === false) {
        input.checked = !next;
        if (status) status.textContent = res && res.error ? String(res.error) : 'failed';
      } else {
        if (status) status.textContent = '';
        paint(res.openAtLogin === true);
      }
      saving = false;
    }).catch(function () {
      input.checked = !next;
      if (status) status.textContent = 'failed';
      saving = false;
    });
  });
  refresh();
  setInterval(refresh, 5000);
}
function initAbout() {
  var root = panelRoot('about');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  function refresh() {
    call('hub.getState').then(function (state) {
      notePermissions(state && state.permissions); if (state && typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
      var notes = root.querySelector('#notes');
      if (notes) notes.innerHTML = (state.notes || []).map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('');
    }).catch(function () {});
  }
  refresh();
  setInterval(refresh, 5000);
}

registerPanel('about', initAbout);
