'use strict';
/** パネル `obs-connect`（OBS とつなぐ）。 */
function initObsConnect() {
  var root = panelRoot('obs-connect');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var guide = root.querySelector('#obs-connect-guide');
  if (guide) guide.textContent = STR.obsConnectGuide;
  var nowEl = root.querySelector('#obs-connect-now');
  var statusEl = root.querySelector('#obs-connect-status');
  var pluginEl = root.querySelector('#obs-plugin-status');
  var hostEl = root.querySelector('#obs-host');
  var portEl = root.querySelector('#obs-port');
  var passEl = root.querySelector('#obs-password');
  var noteEl = root.querySelector('#obs-password-note');
  var isWindow = false;
  var filled = false;
  var controlEl = root.querySelector('#obs-control');
  var controlLabel = root.querySelector('#obs-control-label');
  var controlHint = root.querySelector('#obs-control-hint');
  if (controlLabel) controlLabel.textContent = STR.obsControlLabel;
  if (controlHint) controlHint.textContent = STR.obsControlHint;
  if (controlEl) controlEl.addEventListener('change', function () {
    // チェック＝止める（丸ストからの配信の開始・停止を使わない）。外した状態がふだんの状態（使える）。
    var stopIt = controlEl.checked;
    if (!isWindow || !can.write) { controlEl.checked = !stopIt; return; }
    call('obs.setControl', { enabled: !stopIt }).then(function (res) {
      if (!res || res.ok === false) { controlEl.checked = !stopIt; window.alert(STR.sendSwitchError(res && res.error)); }
    }).catch(function () { controlEl.checked = !stopIt; });
  });
  function say(el, text) { if (el) el.textContent = text || ''; }
  function inputs() {
    var out = {};
    var host = hostEl ? hostEl.value.trim() : '';
    if (host) out.host = host;
    if (portEl && portEl.value !== '') out.port = Number(portEl.value);
    if (passEl && passEl.value !== '') out.password = passEl.value;
    return out;
  }
  function paint(res) {
    if (!res || res.ok === false) { nowEl.innerHTML = '<p class="empty">' + escapeHtml(STR.obsConnectLoadFailed) + '</p>'; return; }
    var passTail = res.passwordTail ? res.passwordTail : (res.hasPassword ? '••••' : '');
    if (passEl) {
      passEl.placeholder = STR.secretPlaceholder(passTail);
    }
    var passSavedText = STR.obsPasswordSaved + (passTail ? ' (' + passTail + ')' : '');
    nowEl.innerHTML = '<p>' + escapeHtml(STR.obsStatus(res.connected)) + ' / '
      + escapeHtml(res.host + ':' + res.port) + ' / ' + escapeHtml(STR.obsPasswordLabel) + ' '
      + escapeHtml(res.hasPassword ? passSavedText : STR.obsPasswordNone) + '</p>';
    say(noteEl, res.hasPassword ? STR.obsPasswordKeep + STR.obsPasswordHostNote : '');
    if (controlEl && document.activeElement !== controlEl) controlEl.checked = res.control !== true;
    if (!filled) {
      filled = true;
      if (hostEl) hostEl.value = res.host;
      if (portEl) portEl.value = res.port;
    }
  }
  function refresh() {
    call('hub.getState').then(function (state) {
      notePermissions(state && state.permissions);
      isWindow = !!(state && state.clientId === 'local-window');
      var admin = root.querySelector('#obs-connect-admin');
      if (admin) admin.hidden = !isWindow;
      return call('obs.getConnection');
    }).then(paint).catch(function () { paint(null); });
  }
  function showResult(res, saved) {
    if (!res || res.ok === false) {
      say(statusEl, STR.obsErr(res && res.error));
      say(pluginEl, '');
      return;
    }
    say(statusEl, saved && res.connected === false ? STR.obsErr('unreachable') : STR.obsTestOk);
    say(pluginEl, res.plugin ? STR.obsPlugin(res.plugin) : '');
    if (res.plugin && pluginEl && res.plugin.state !== 'ok') {
      pluginEl.appendChild(document.createTextNode(' '));
      pluginEl.appendChild(guideLink(STR.obsPluginGuideLink, STR.obsPluginGuidePath));
    }
  }
  // 「OBS の設定を読んでつなぐ」（おすすめ）。手で入れる欄の上に置く。押したときだけ OBS の設定を読む。
  var setupBox = root.querySelector('.timer-setup');
  if (setupBox && setupBox.parentNode && !root.querySelector('#obs-import')) {
    var importBtn = mk('button', 'timer-btn primary', STR.obsImportButton, { id: 'obs-import', type: 'button', 'data-need': 'write' });
    var importNote = mk('p', 'timer-hint', STR.obsImportHint);
    setupBox.parentNode.insertBefore(importBtn, setupBox);
    setupBox.parentNode.insertBefore(importNote, setupBox);
    importBtn.addEventListener('click', function () {
      if (!isWindow || !can.write) return;
      say(statusEl, STR.obsImporting);
      call('obs.importConfig').then(function (res) {
        say(statusEl, res && res.ok === true ? STR.obsImportDone(res) : STR.obsImportErr(res && res.error));
        filled = false;
      }).catch(function () { say(statusEl, STR.obsImportErr('failed')); }).then(refresh);
    });
  }
  root.querySelector('#obs-test').addEventListener('click', function () {
    if (!isWindow || !can.write) return;
    say(statusEl, STR.obsConnecting);
    call('obs.testConnection', inputs()).then(function (res) { showResult(res, false); })
      .catch(function () { say(statusEl, STR.obsErr('failed')); });
  });
  root.querySelector('#obs-save').addEventListener('click', function () {
    if (!isWindow || !can.write) return;
    var body = inputs();
    if (passEl) passEl.value = '';
    say(statusEl, STR.obsSavingConnecting);
    call('obs.setConnection', body).then(function (res) {
      if (res && res.ok === true && res.connected) {
        // つながったら、保存した値でプラグインの有無も確かめて見せる
        return call('obs.testConnection', {}).then(function (t) { showResult(t, true); });
      }
      showResult(res, true);
    }).catch(function () { say(statusEl, STR.obsErr('failed')); }).then(refresh);
  });
  refresh();
  setInterval(function () { if (root.offsetParent) refresh(); }, 15000);
}

registerPanel('obs-connect', initObsConnect);
