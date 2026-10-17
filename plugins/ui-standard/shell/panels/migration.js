'use strict';
/** パネル `migration`（引っ越し）。引っ越しファイル（パスフレーズつき）の書き出しと読み込み。本体の機能で、切れない（V3 §0-17）。バックアップは backup プラグインの画面。 */
function ensureMigrationPanel() {
  var existing = panelRoot('migration');
  if (existing) return existing;
  var host = document.getElementById('panel-source');
  if (!host) return null;
  var section = document.createElement('section');
  section.className = 'card';
  section.setAttribute('data-panel', 'migration');
  var heading = document.createElement('h2');
  heading.textContent = STR.migrationTitle;
  section.appendChild(heading);
  section.appendChild(buildMigrationBlock());
  host.appendChild(section);
  return section;
}
function buildMigrationBlock() {
  var box = document.createElement('div');
  box.id = 'migration-box';
  var h = document.createElement('h3');
  h.textContent = STR.uiSettingsexport7;
  var hint = document.createElement('p');
  hint.className = 'timer-hint';
  hint.textContent = STR.uiSettingsexport8;
  function field(id, labelText, type) {
    var label = document.createElement('label');
    label.textContent = labelText + ' ';
    var input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.autocomplete = 'off';
    label.appendChild(input);
    return label;
  }
  function button(id, text) {
    var b = document.createElement('button');
    b.className = 'timer-btn';
    b.type = 'button';
    b.id = id;
    b.textContent = text;
    return b;
  }
  var makeRow = document.createElement('div');
  makeRow.className = 'timer-setup';
  makeRow.appendChild(field('migration-pass', STR.uiSettingsexport9, 'password'));
  makeRow.appendChild(field('migration-pass2', STR.uiSettingsexport10, 'password'));
  makeRow.appendChild(button('migration-export', STR.uiSettingsexport11));
  var takeRow = document.createElement('div');
  takeRow.className = 'timer-setup';
  var file = document.createElement('input');
  file.type = 'file';
  file.id = 'migration-file';
  file.accept = '.marustbundle,application/json';
  takeRow.appendChild(field('migration-pass-in', STR.uiSettingsexport12, 'password'));
  takeRow.appendChild(file);
  takeRow.appendChild(button('migration-import', STR.uiSettingsexport13));
  var status = document.createElement('p');
  status.id = 'migration-status';
  status.className = 'timer-hint';
  status.setAttribute('aria-live', 'polite');
  box.appendChild(h);
  box.appendChild(hint);
  box.appendChild(makeRow);
  box.appendChild(takeRow);
  box.appendChild(status);
  return box;
}
var MIGRATION_ERRORS = {
  'passphrase-short': STR.uiSettingsexport14,
  'bad-passphrase': STR.uiSettingsexport15,
  'wrong-passphrase': STR.uiSettingsexport16,
  'not-a-bundle': STR.uiSettingsexport17,
  'bad-version': STR.uiSettingsexport18,
  'bad-bundle': STR.uiSettingsexport19,
  'live-now': STR.uiSettingsexport20,
  'forbidden': STR.uiSettingsexport21,
  'backup-failed': STR.uiSettingsexport22
};
function initMigration(root, isWindowFn) {
  var q = function (id) { return root.querySelector(id); };
  var status = q('#migration-status');
  var exportBtn = q('#migration-export');
  var importBtn = q('#migration-import');
  var file = q('#migration-file');
  if (!status || !exportBtn || !importBtn || !file) return;
  function say(text) { status.textContent = text || ''; }
  function errText(res) {
    var code = res && res.error ? String(res.error) : 'failed';
    return MIGRATION_ERRORS[code] || (STR.uiSettingsexport23 + code + '）');
  }
  exportBtn.addEventListener('click', function () {
    if (!isWindowFn()) { say(MIGRATION_ERRORS.forbidden); return; }
    var a = q('#migration-pass').value;
    var b = q('#migration-pass2').value;
    if (a !== b) { say(STR.uiSettingsexport24); return; }
    say(STR.uiSettingsexport25);
    exportBtn.disabled = true;
    call('migration.export', { passphrase: a }).then(function (res) {
      if (!res || res.ok === false) { say(errText(res)); return; }
      q('#migration-pass').value = '';
      q('#migration-pass2').value = '';
      say(STR.uiSettingsexport26 + (res.dir || '') + '/' + (res.filename || '') + STR.uiSettingsexport27 + ((res.counts && res.counts.secrets) || 0) + STR.uiSettingsexport28);
    }).catch(function (err) {
      say(STR.uiSettingsexport23 + (err && err.message ? err.message : 'failed') + '）');
    }).then(function () { exportBtn.disabled = false; });
  });
  importBtn.addEventListener('click', function () {
    if (!isWindowFn()) { say(MIGRATION_ERRORS.forbidden); return; }
    var picked = file.files && file.files[0];
    if (!picked) { file.click(); say(STR.uiSettingsexport29); return; }
    var pass = q('#migration-pass-in').value;
    if (!pass) { say(STR.uiSettingsexport30); return; }
    var reader = new FileReader();
    reader.onerror = function () { say(STR.uiSettingsexport31); };
    reader.onload = function () {
      say(STR.uiSettingsexport32);
      importBtn.disabled = true;
      call('migration.import', { passphrase: pass, bundle: String(reader.result || '') }).then(function (res) {
        if (!res || res.ok === false) { say(errText(res)); return; }
        q('#migration-pass-in').value = '';
        file.value = '';
        var c = res.counts || {};
        var text = STR.uiSettingsexport33 + (c.secrets || 0) + STR.uiSettingsexport34 + (c.files || 0) + STR.uiSettingsexport35 + ((res.sections || []).length) + STR.uiSettingsexport36;
        if (c.secretsFailed) text += STR.uiSettingsexport27 + c.secretsFailed + STR.uiSettingsexport37;
        say(text);
      }).catch(function (err) {
        say(STR.uiSettingsexport23 + (err && err.message ? err.message : 'failed') + '）');
      }).then(function () { importBtn.disabled = false; });
    };
    reader.readAsText(picked, 'utf-8');
  });
}
function initMigrationPanel() {
  var root = ensureMigrationPanel();
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var isWindow = false;
  initMigration(root, function () { return isWindow; });
  call('hub.getState').then(function (state) {
    notePermissions(state && state.permissions);
    isWindow = !!(state && state.clientId === 'local-window');
  }).catch(function () { isWindow = false; });
}

registerPanel('migration', initMigrationPanel);
