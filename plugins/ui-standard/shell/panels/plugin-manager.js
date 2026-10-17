'use strict';
/**
 * パネル `plugin-manager`（プラグインの管理。上級）。一覧（plugins.list）と、無効／有効・隠す／戻す。
 * 外から入れる（P4b）: zip／フォルダは丸ストの本体が開く選択ダイアログで選ぶ（画面は場所を扱わない）。下見の結果を見せて承認したあと、その指紋（sha256）で入れる。
 * 値（秘密）は出さず、秘密の「名前」だけを見せる。
 */
function initPluginManager() {
  var root = panelRoot('plugin-manager');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var hint = root.querySelector('#plugin-manager-hint');
  var box = root.querySelector('#plugin-manager-list');
  var note = root.querySelector('#plugin-manager-status');
  var busy = false;
  var streaming = false;
  var installBox = root.querySelector('#plugin-manager-install');
  var makeBox = root.querySelector('#plugin-manager-make');
  var madeId = '';
  var installed = {};
  var shownInfo = null;
  hint.textContent = STR.pluginManagerHint;
  function say(text) { note.textContent = text || ''; }
  var ORIGIN = { set: STR.pluginManagerOriginSet, user: STR.pluginManagerOriginUser };
  var STATE = { running: STR.pluginManagerStateRunning, stopped: STR.pluginManagerStateStopped, error: STR.pluginManagerStateError };
  var MODE = { legacy: STR.pluginManagerModeLegacy, shadow: STR.pluginManagerModeShadow, live: STR.pluginManagerModeLive };
  function usesText(p) {
    var parts = [];
    if (p.uses.vaultNames.length) parts.push(STR.pluginManagerSecrets(p.uses.vaultNames.join('、')));
    if (p.uses.needs.length) parts.push(STR.pluginManagerNeeds(p.uses.needs.join('、')));
    if (p.uses.provides.length) parts.push(STR.pluginManagerProvides(p.uses.provides.join('、')));
    return parts.length ? parts.join(' / ') : STR.pluginManagerUsesNone;
  }
  function button(label, onClick, disabled) {
    var b = mk('button', 'timer-btn', label, { type: 'button' });
    if (disabled || !can.write) b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }
  function act(promise) {
    if (busy) return;
    busy = true;
    say('');
    promise.then(function (r) {
      busy = false;
      if (!r || r.ok !== true) say(r && r.error === 'streaming' ? STR.pluginManagerStreaming : (r && STR.pluginManagerBlock(r.error)) || STR.pluginManagerFailed);
      refresh();
      if (typeof refreshPluginCatalog === 'function') refreshPluginCatalog();
    }).catch(function () { busy = false; say(STR.pluginManagerFailed); refresh(); });
  }
  function setMode(p, mode) {
    // 外から入れたものは、試すだけにするときも live のときも、必ず本人が id を入力する（サーバーも求める）
    if (p.origin === 'user' || (mode === 'live' && confirmLiveWanted !== false)) {
      var typed = window.prompt(STR.pluginManagerConfirm(p.id), '');
      if (typed == null) return;
      act(call('modes.set', { id: p.id, mode: mode, confirmName: typed }));
      return;
    }
    act(call('modes.set', { id: p.id, mode: mode }));
  }
  function row(p) {
    var line = mk('div', 'feature-row', null, { 'data-plugin-row': p.id });
    var title = p.name + (p.version ? ' ' + p.version : '') + (p.feature && p.feature !== p.name ? '（' + p.feature + '）' : '');
    line.appendChild(mk('strong', '', title));
    line.appendChild(mk('span', 'timer-hint feature-hint', p.id + ' / ' + (ORIGIN[p.origin] || '') + ' / ' + (STATE[p.state] || '') + ' / ' + (MODE[p.mode] || '')));
    line.appendChild(mk('span', 'timer-hint feature-hint', STR.pluginManagerUses + ': ' + usesText(p)));
    if (!p.hidden) {
      var locked = streaming;
      if (p.mode === 'legacy') {
        // 機能（feature）つきで live／shadow のものは features.set（確認の入力なし）。それ以外を有効にするのは開発者モードだけ（modes.set の決まり）。
        if (p.feature && (p.activation === 'live' || p.activation === 'shadow')) {
          line.appendChild(button(STR.pluginManagerEnable, function () { act(call('features.set', { id: p.id, enabled: true })); }));
        } else if (devMode || p.origin === 'user') {
          line.appendChild(button(STR.pluginManagerEnable, function () { setMode(p, 'live'); }));
          line.appendChild(button(STR.pluginManagerTry, function () { setMode(p, 'shadow'); }));
        }
      } else {
        line.appendChild(button(STR.pluginManagerDisable, function () { act(call('plugins.disable', { id: p.id })); }, locked));
      }
      var hide = button(STR.pluginManagerHide, function () { act(call('plugins.setHidden', { id: p.id, hidden: true })); }, !!p.hideBlock || locked);
      if (p.hideBlock) hide.title = STR.pluginManagerBlock(p.hideBlock);
      line.appendChild(hide);
      if (p.origin === 'user') {
        var inst = installed[p.id] || {};
        var frozen = streaming || p.mode === 'live';
        if (inst.backupVersion) line.appendChild(button(STR.pluginInstallRestore(inst.backupVersion), function () { runInstall(call('plugin.restore', { id: p.id }), function (r) { return STR.pluginInstallRestored(p.id, r.version || ''); }); }, frozen));
        line.appendChild(button(STR.pluginInstallRemove, function () { if (window.confirm(STR.pluginInstallRemoveConfirm(p.name))) runInstall(call('plugin.remove', { id: p.id }), function () { return STR.pluginInstallRemoved(p.id); }); }, frozen));
      }
    } else {
      line.appendChild(button(STR.pluginManagerUnhide, function () { act(call('plugins.setHidden', { id: p.id, hidden: false })); }));
    }
    return line;
  }
  // ---- 外から入れる（P4b）
  function errText(r) { return (r && STR.pluginInstallErr(r.error)) || STR.pluginManagerFailed; }
  function runInstall(promise, okText) {
    if (busy) return;
    busy = true;
    say('');
    promise.then(function (r) {
      busy = false;
      if (r && r.ok === true) say(okText(r)); else say(errText(r));
      paintInstall(null);
      refresh();
      if (typeof refreshPluginCatalog === 'function') refreshPluginCatalog();
    }).catch(function () { busy = false; say(STR.pluginManagerFailed); paintInstall(null); refresh(); });
  }
  function pick(kind) {
    if (busy) return;
    busy = true;
    say('');
    call('plugin.inspect', { kind: kind }).then(function (r) {
      busy = false;
      if (r && r.ok === true && r.canceled === true) { paintInstall(null); return; }
      if (r && r.ok === true) { paintInstall(r); return; }
      paintInstall(null);
      say(errText(r));
    }).catch(function () { busy = false; paintInstall(null); say(STR.pluginManagerFailed); });
  }
  function browse() {
    call('plugins.browse', {}).then(function (r) {
      say(r && r.ok === true ? STR.pluginInstallBrowseOpened : (r && r.error === 'no-repo' ? STR.pluginInstallNoRepo : STR.pluginManagerFailed));
    }).catch(function () { say(STR.pluginManagerFailed); });
  }
  function approval(info) {
    var card = mk('div', 'feature-row', null, { 'data-plugin-approval': info.id });
    card.appendChild(mk('strong', '', STR.pluginInstallApprovalTitle));
    card.appendChild(mk('span', 'timer-hint feature-hint', STR.pluginInstallLine(info.name, info.id, info.version)));
    if (info.updates) card.appendChild(mk('span', 'timer-hint feature-hint', STR.pluginInstallUpdating(info.previousVersion || '')));
    var u = info.uses || { secrets: [], needs: [], provides: [] };
    var parts = [];
    if (u.slots && u.slots.length) parts.push(STR.pluginManagerSlots(u.slots.join('、')));
    if (u.menu && u.menu.length) parts.push(STR.pluginManagerMenu(u.menu.join('、')));
    if (u.secrets.length) parts.push(STR.pluginManagerSecrets(u.secrets.join('、')));
    if (u.needs.length) parts.push(STR.pluginManagerNeeds(u.needs.join('、')));
    if (u.provides.length) parts.push(STR.pluginManagerProvides(u.provides.join('、')));
    card.appendChild(mk('span', 'timer-hint feature-hint', STR.pluginManagerUses + ': ' + (parts.length ? parts.join(' / ') : STR.pluginManagerUsesNone)));
    card.appendChild(mk('span', 'timer-hint feature-hint', STR.pluginInstallSha(String(info.sha256 || '').slice(0, 12)) + ' / ' + STR.pluginInstallSize(info.fileCount, info.bytes)));
    card.appendChild(mk('p', 'timer-hint', STR.pluginInstallWarning, { 'data-plugin-warning': '1' }));
    card.appendChild(mk('p', 'timer-hint', STR.pluginInstallStaysOff));
    card.appendChild(button(info.updates ? STR.pluginInstallUpdate : STR.pluginInstallInstall, function () {
      // 承認した中身の指紋をそのまま返す。サーバーは、直前に見せたものと同じ中身だけ入れる
      runInstall(call('plugin.install', { sha256: info.sha256 }), function (r) { return STR.pluginInstallDone(r.id || info.id, r.version || info.version); });
    }, streaming));
    card.appendChild(button(STR.pluginInstallCancel, function () { paintInstall(null); }));
    return card;
  }
  function paintInstall(info) {
    shownInfo = info;
    while (installBox.firstChild) installBox.removeChild(installBox.firstChild);
    var bar = mk('div', 'feature-row');
    bar.appendChild(mk('p', 'timer-hint', STR.pluginInstallWarning, { 'data-plugin-warning': '1' }));
    bar.appendChild(button(STR.pluginInstallZip, function () { pick('zip'); }, streaming));
    bar.appendChild(button(STR.pluginInstallFolder, function () { pick('folder'); }, streaming));
    bar.appendChild(button(STR.pluginInstallBrowse, browse));
    if (streaming) bar.appendChild(mk('span', 'timer-hint feature-hint', STR.pluginInstallStreamingNote));
    installBox.appendChild(bar);
    if (info) installBox.appendChild(approval(info));
  }
  // ---- 作る（P5）。ひな形を自分のプラグインの置き場に作る（空いている名前のときだけ。上書きしない）
  function copyAiRequest() {
    var text = STR.pluginMakeAiRequest;
    var done = function () { say(STR.pluginMakeCopied); };
    if (typeof copyText === 'function') { copyText(text, window, document); done(); return; }
    var clip = window.navigator && window.navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') clip.writeText(text).then(done, function () { say(STR.pluginManagerFailed); });
    else say(STR.pluginManagerFailed);
  }
  function paintMake() {
    while (makeBox.firstChild) makeBox.removeChild(makeBox.firstChild);
    var bar = mk('div', 'feature-row', null, { 'data-plugin-make': '1' });
    bar.appendChild(mk('strong', '', STR.pluginMakeTitle));
    bar.appendChild(mk('p', 'timer-hint', STR.pluginMakeHint));
    var label = mk('label', 'timer-hint', STR.pluginMakeIdLabel);
    var input = mk('input', '', null, { type: 'text', maxlength: '32', placeholder: STR.pluginMakeIdPlaceholder, autocomplete: 'off', spellcheck: 'false', 'data-plugin-make-id': '1' });
    label.appendChild(input);
    bar.appendChild(label);
    bar.appendChild(button(STR.pluginMakeButton, function () {
      if (busy) return;
      var id = String(input.value || '').trim();
      busy = true;
      say('');
      call('plugin.create', { id: id }).then(function (r) {
        busy = false;
        if (r && r.ok === true) { madeId = r.id; say(STR.pluginMakeDone(r.id)); input.value = ''; paintMake(); }
        else say(STR.pluginMakeErr(r && r.error));
        refresh();
        if (typeof refreshPluginCatalog === 'function') refreshPluginCatalog();
      }).catch(function () { busy = false; say(STR.pluginManagerFailed); });
    }, streaming));
    bar.appendChild(button(STR.pluginMakeCopyAi, copyAiRequest));
    if (madeId) bar.appendChild(button(STR.pluginMakeOpenFolder, function () {
      call('plugin.openFolder', { id: madeId }).then(function (r) { if (!r || r.ok !== true) say(STR.pluginManagerFailed); }).catch(function () { say(STR.pluginManagerFailed); });
    }));
    var guide = mk('a', 'timer-hint', STR.pluginMakeGuide, { href: STR.pluginMakeGuidePath, target: '_blank', rel: 'noopener noreferrer' });
    bar.appendChild(guide);
    if (streaming) bar.appendChild(mk('span', 'timer-hint feature-hint', STR.pluginInstallStreamingNote));
    makeBox.appendChild(bar);
  }
  var mode = loadGroupMode();
  var lastList = [];
  function paint(list) {
    lastList = list;
    while (box.firstChild) box.removeChild(box.firstChild);
    var shown = list.filter(function (p) { return !p.hidden; });
    var hidden = list.filter(function (p) { return p.hidden; });
    if (!shown.length && !hidden.length) { box.appendChild(mk('p', 'empty', STR.pluginManagerEmpty)); return; }
    // 見せ方: 種類ごと（category）／サイトごと（for）／段階ごと（tier）。置き場は平らなまま、名乗りで集めて見せる（計画 X・P8）
    box.appendChild(buildGroupSwitch(mode, function (next) { mode = next; paint(lastList); }));
    groupRowsBy(shown, mode, function (p) { return { category: p.category, for: p.for, level: p.tier }; }).forEach(function (g) {
      box.appendChild(mk('h3', 'feature-group', g.label, { 'data-plugin-group': g.key }));
      g.rows.forEach(function (p) { box.appendChild(row(p)); });
    });
    if (hidden.length) {
      box.appendChild(mk('h3', '', STR.pluginManagerHiddenTitle));
      hidden.forEach(function (p) { box.appendChild(row(p)); });
    }
  }
  function refresh() {
    if (busy) return Promise.resolve();
    return Promise.all([call('plugins.list', {}), call('plugin.list', {}).catch(function () { return null; })]).then(function (res) {
      var r = res[0];
      var inst = res[1];
      installed = {};
      if (inst && inst.ok === true && Array.isArray(inst.installed)) inst.installed.forEach(function (x) { installed[x.id] = x; });
      if (r && r.ok === true && Array.isArray(r.plugins)) {
        var was = streaming;
        streaming = r.streaming === true;
        if (was !== streaming || !installBox.firstChild) paintInstall(shownInfo);
        if (was !== streaming || !makeBox.firstChild) paintMake();
        paint(r.plugins);
      } else say(STR.pluginManagerFailed);
    }).catch(function () { say(STR.pluginManagerFailed); });
  }
  function visible() { return root.offsetParent !== null; }
  refresh();
  setInterval(function () { if (visible()) refresh(); }, 15000);
  if (hubApi() && hubApi().subscribe) hubApi().subscribe(function (msg) { if (msg && msg.name === 'modes.changed' && visible()) refresh(); });
}

registerPanel('plugin-manager', initPluginManager);
