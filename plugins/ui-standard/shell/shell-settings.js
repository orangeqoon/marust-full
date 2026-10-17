'use strict';
(function () {
  var root = document.querySelector('[data-panel="about"]');
  if (!root || !window.marustApi) return;
  var label = document.createElement('label'); label.textContent = '画面の本体役 ';
  var select = document.createElement('select'); label.appendChild(select); root.appendChild(label);
  window.marustApi.call('ui.getShell', {}).then(function (answer) {
    var def = document.createElement('option'); def.value = ''; def.textContent = 'セットの既定'; select.appendChild(def);
    (answer.shells || []).forEach(function (shell) { var opt = document.createElement('option'); opt.value = shell.id; opt.textContent = shell.label; select.appendChild(opt); });
    select.value = answer.wanted || '';
  }).catch(function () { select.disabled = true; });
  select.onchange = function () { select.disabled = true; window.marustApi.call('ui.setShell', { id: select.value }).then(function (answer) { if (!answer || answer.ok === false) select.disabled = false; }).catch(function () { select.disabled = false; }); };
})();
