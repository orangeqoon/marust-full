'use strict';
/** パネル `emergency`（全部止める。OBS のドック `?view=dock` でだけ使う）。 */
function initEmergency() {
  // OBS 側で非常停止が押されたときのトーストは引き続き出す（engine.emergencyStop は broadcast.stopAll を呼ぶ）
  if (!document.getElementById('engine-emergency-toast')) {
    var emergencyToast = document.createElement('div');
    emergencyToast.id = 'engine-emergency-toast';
    emergencyToast.setAttribute('role', 'status');
    emergencyToast.setAttribute('aria-live', 'polite');
    emergencyToast.hidden = true;
    document.body.appendChild(emergencyToast);
    var emergencyToastTimer = null;
    if (hubApi() && hubApi().subscribe) {
      hubApi().subscribe(function (msg) {
        if (!msg || msg.name !== 'engine.emergencyStop') return;
        emergencyToast.textContent = STR.uiEmergency1;
        emergencyToast.className = 'ng';
        emergencyToast.hidden = false;
        if (emergencyToastTimer) clearTimeout(emergencyToastTimer);
        emergencyToastTimer = setTimeout(function () { emergencyToast.hidden = true; }, 4000);
      });
    }
  }
  var root = panelRoot('emergency');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var button = root.querySelector('#emergency-stop');
  var result = root.querySelector('#emergency-result');
  var running = false;

  function setBusy(busy) {
    running = busy;
    button.disabled = busy || !can.emergency;
  }

  function showResult(text) {
    if (result) result.textContent = text || '';
  }

  function handleStopAll() {
    if (running || !can.emergency) return;
    setBusy(true);
    showResult('');
    call('broadcast.stopAll', {}).then(function (res) {
      setBusy(false);
      if (!res) { showResult(STR.homeBroadcastFailed); return; }
      if (res.error === 'not-connected') { showResult(STR.emergencyStopAllNotConnected); return; }
      if (res.ok === true) { showResult(STR.emergencyStopAllOk); return; }
      // ok でない場合は残りを並べる
      var remain = [];
      var engineRows = (res.engines && res.engines.results) || [];
      engineRows.forEach(function (e) {
        if (e && e.targetsStillActive && e.targetsStillActive.length) {
          e.targetsStillActive.forEach(function (id) { remain.push(id); });
        }
        if (e && e.mainStillActive === true) remain.push(STR.emergencyMainOutput);
      });
      if (remain.length) {
        showResult(STR.emergencyStopAllPartial(remain.join('、')));
      } else {
        showResult(STR.emergencyStopAllOk);
      }
    }).catch(function () {
      setBusy(false);
      showResult(STR.homeBroadcastFailed);
    });
  }

  button.addEventListener('click', handleStopAll);

  function refresh() {
    var stateRead = displayRead('hub.getState').catch(function () { return null; });
    return displayRead('engine.status').then(function (status) {
      var view = (status && status.button) || { color: 'gray', label: STR.uiEmergency2, hold: false };
      button.textContent = view.label;
      button.className = 'emergency ' + (view.color || 'gray');
      button.disabled = !can.emergency;
      if (running) button.disabled = true;
      return stateRead;
    }).then(function (state) {
      notePermissions(state && state.permissions);
      if (state && typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
      if (!running) button.disabled = !can.emergency;
    }).catch(function () {});
  }
  watchDisplay(root, refresh, displayStateEvent);
}

registerPanel('emergency', initEmergency);
