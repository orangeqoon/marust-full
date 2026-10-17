'use strict';

/**
 * 初回の案内（R6）。ui-settings.json に setupDone が無いときだけ、ウィンドウで自動的に開く。
 * 手順は 7 つ。どれも「とばす」ができ、途中で閉じても次に開いたとき続きから（setupStep を保存）。
 * 既存の「OBS とつなぐ」「サイトを足す」「回線の余裕」のパネルを、案内の中へ一時的に移して使う（部品は 1 つだけ）。
 * 「確かめ」は読むだけ: 配信は始めず、枠取り（slot-*）も起こさない。秘密は扱わない。
 * hub.js より前に読み込む（hub.js の call・mk・can・dockApi・closePanel などは、呼ばれたときに使う）。
 */

var setupState = { open: false, step: 0, skipped: [], sites: [], moved: [], reopen: [], overlay: null };

function setupSave(patch) {
  return call('ui.setSettings', patch).catch(function () { return null; });
}
function setupReturnPanels() {
  var bin = document.getElementById('panel-bin');
  setupState.moved.forEach(function (sec) { if (bin && sec) bin.appendChild(sec); });
  setupState.moved = [];
  // 案内の前にドックで開いていたパネルは、案内のあと元どおり開く（M4 Should 7）
  var again = setupState.reopen;
  setupState.reopen = [];
  again.forEach(function (id) { if (typeof openPanel === 'function') openPanel(id); });
}
function setupEmbed(id, into) {
  var sec = panelRoot(id);
  if (!sec) return false;
  if (typeof dockApi !== 'undefined' && dockApi && dockApi.getPanel(id) && typeof closePanel === 'function') {
    closePanel(id);
    if (setupState.reopen.indexOf(id) === -1) setupState.reopen.push(id);
  }
  into.appendChild(sec);
  setupState.moved.push(sec);
  return true;
}
function setupClose() {
  setupReturnPanels();
  if (setupState.overlay && setupState.overlay.parentNode) setupState.overlay.parentNode.removeChild(setupState.overlay);
  setupState.overlay = null;
  setupState.open = false;
}
function setupFinish() {
  setupSave({ setupDone: true, setupStep: 0 }).then(function (res) {
    // 保存できないとき（ブラウザなど）は黙って閉じず、次にまた出ることを伝える
    if (!res || res.ok === false) window.alert(STR.setupSaveFailed);
    setupClose();
  });
}
function setupGo(n) {
  var total = STR.setupSteps.length;
  setupState.step = Math.max(0, Math.min(total - 1, n));
  setupSave({ setupStep: setupState.step, setupSkipped: setupState.skipped.join(',') });
  setupRender();
}
function setupNext(skipThis) {
  var id = STR.setupSteps[setupState.step].id;
  if (skipThis && setupState.skipped.indexOf(id) === -1) setupState.skipped.push(id);
  if (!skipThis) setupState.skipped = setupState.skipped.filter(function (s) { return s !== id; });
  if (setupState.step >= STR.setupSteps.length - 1) { setupFinish(); return; }
  setupGo(setupState.step + 1);
}

function setupSiteRows() {
  return call('modes.list', {}).then(function (r) {
    var rows = r && Array.isArray(r.plugins) ? r.plugins : [];
    return homeSiteRows(rows, []);
  }).catch(function () { return []; });
}

// 「OBS にプラグインを入れる」（L5b）。情報 → OBS が動いていれば止める → 別の版なら確認 → 入れる → 結果を 1 行
function setupPluginInstall(btn, status) {
  var lines = [];
  function show() { status.textContent = lines.join(' '); }
  btn.disabled = true;
  status.textContent = STR.setupPluginInstalling;
  call('obs.pluginInfo', {}).then(function (info) {
    if (!info || info.ok === false) { lines.push(STR.setupPluginInstallErr(info && info.error)); return null; }
    if (info.obsRunning) { lines.push(STR.setupPluginInstallObsRunning); return null; }
    if (!info.bundled) { lines.push(STR.setupPluginInstallErr('no-bundle')); return null; }
    lines.push(STR.setupPluginInstallTarget(info.target));
    var overwrite = false;
    if (info.state === 'different') {
      if (!window.confirm(STR.setupPluginInstallOverwrite)) return null;
      overwrite = true;
    }
    show();
    return call('obs.installPlugin', { overwrite: overwrite }).then(function (res) {
      lines.push(res && res.ok === true ? STR.setupPluginInstallDone : STR.setupPluginInstallErr(res && res.error));
      if (info.legacyCopy) lines.push(STR.setupPluginInstallLegacy(info.legacyPath || ''));
    });
  }).catch(function () { lines.push(STR.setupPluginInstallErr('failed')); }).then(function () {
    btn.disabled = false;
    show();
  });
}

function setupBodyFor(id, body) {
  var status;
  if (id === 'obs') {
    body.appendChild(mk('p', 'timer-hint', STR.setupObsDoneNote));
    setupEmbed('obs-connect', body);
  } else if (id === 'plugin') {
    status = mk('p', 'timer-hint', '', { id: 'setup-plugin-status', 'aria-live': 'polite' });
    var inst = mk('button', 'timer-btn primary', STR.setupPluginInstall, { type: 'button', id: 'setup-plugin-install' });
    var instStatus = mk('p', 'timer-hint', '', { id: 'setup-plugin-install-status', 'aria-live': 'polite' });
    inst.addEventListener('click', function () { setupPluginInstall(inst, instStatus); });
    body.appendChild(inst);
    body.appendChild(instStatus);
    var run = mk('button', 'timer-btn', STR.setupPluginCheck, { type: 'button', id: 'setup-plugin-run' });
    run.addEventListener('click', function () {
      status.textContent = STR.setupPluginChecking;
      call('obs.testConnection', {}).then(function (res) {
        if (!res || res.ok === false) { status.textContent = STR.obsErr(res && res.error); return; }
        status.textContent = STR.obsPlugin(res.plugin);
        if (res.plugin && res.plugin.state !== 'ok') {
          status.appendChild(document.createTextNode(' '));
          status.appendChild(guideLink(STR.obsPluginGuideLink, STR.obsPluginGuidePath));
        }
      }).catch(function () { status.textContent = STR.obsErr('failed'); });
    });
    body.appendChild(run);
    body.appendChild(status);
    var guide = mk('p', 'timer-hint');
    guide.appendChild(guideLink(STR.obsPluginGuideLink, STR.obsPluginGuidePath));
    body.appendChild(guide);
    body.appendChild(mk('p', 'timer-hint', STR.setupPluginGuide));
  } else if (id === 'using') {
    var box = mk('div', '', null, { id: 'setup-using' });
    body.appendChild(box);
    call('engine.listTargets').then(function (rows) {
      var list = Array.isArray(rows) ? rows : [];
      if (!list.length) { box.appendChild(mk('p', 'empty', STR.setupUsingNone)); return; }
      var ul = mk('ul', 'broadcast-list');
      list.forEach(function (r) { ul.appendChild(mk('li', '', (r.site ? siteLabel(r.site) + ' / ' : '') + r.name)); });
      box.appendChild(ul);
    }).catch(function () { box.appendChild(mk('p', 'empty', STR.setupUsingNone)); });
  } else if (id === 'wanted') {
    var wbox = mk('div', '', null, { id: 'setup-wanted' });
    body.appendChild(wbox);
    setupSiteRows().then(function (rows) {
      if (!rows.length) { wbox.appendChild(mk('p', 'empty', STR.setupWantedNone)); return; }
      rows.forEach(function (row) {
        var l = mk('label', 'site-send');
        var cb = mk('input', '', null, { type: 'checkbox', 'data-setup-site': row.site });
        cb.checked = setupState.sites.indexOf(row.site) !== -1;
        cb.addEventListener('change', function () {
          setupState.sites = setupState.sites.filter(function (s) { return s !== row.site; });
          if (cb.checked) setupState.sites.push(row.site);
          setupSave({ setupSites: setupState.sites.join(',') });
        });
        l.appendChild(cb);
        l.appendChild(document.createTextNode(' ' + row.name + (row.experimental ? '（' + STR.experimentalBadge + '）' : '')));
        wbox.appendChild(l);
        wbox.appendChild(document.createElement('br'));
      });
    });
  } else if (id === 'keys') {
    body.appendChild(mk('p', 'timer-hint', STR.setupGuideNote));
    var picks = mk('div', 'timer-actions', null, { id: 'setup-keys-picks' });
    body.appendChild(picks);
    var ctl = mk('p', 'timer-hint', '', { id: 'setup-keys-control', 'aria-live': 'polite' });
    body.appendChild(ctl);
    setupSiteRows().then(function (rows) {
      var wanted = rows.filter(function (r) { return setupState.sites.indexOf(r.site) !== -1; });
      if (!wanted.length) { picks.appendChild(mk('span', 'timer-hint', STR.setupKeysNone)); return; }
      picks.appendChild(mk('span', 'timer-hint', STR.setupKeysPick + ': '));
      wanted.forEach(function (row) {
        var b = mk('button', 'timer-btn', STR.setupWantedPick(row.name), { type: 'button', 'data-setup-pick': row.site });
        b.addEventListener('click', function () {
          var sel = document.getElementById('site-add-site');
          if (!sel) return;
          sel.value = row.site;
          sel.dispatchEvent(new Event('change'));
        });
        picks.appendChild(b);
      });
    });
    // 配信先を作るには丸ストからの操作が使える必要がある。まだ止まっていれば、ここで使えるようにする（配信は始めない）。
    call('broadcast.status').then(function (st) {
      if (st && st.ok !== false && st.mode && st.mode !== 'legacy') return null;
      if (!can.write) return null;
      return call('obs.setControl', { enabled: true }).then(function (res) {
        if (res && res.ok !== false) ctl.textContent = STR.setupKeysAutoOn;
      });
    }).catch(function () {});
    setupEmbed('site-add', body);
  } else if (id === 'uplink') {
    // 回線の余裕は上級の機能（プラグイン）。切ってあれば埋め込まず、とばせると伝える（手順の番号は変えない）
    call('uplink.last', {}).then(function (r) { return !!(r && r.ok !== true && r.error === 'unknown-method'); }, function () { return false; }).then(function (off) {
      if (!body.parentNode) return; // 手順が変わったあとは何もしない
      // 「機能」の一覧に上級の機能が出るのは上級だけ。それより下では入れ方を案内しない（V5）
      if (off) { body.appendChild(mk('p', 'timer-hint', levelAtLeast('advanced') ? STR.setupUplinkOff : STR.setupUplinkOffBeginner)); return; }
      body.appendChild(mk('p', 'timer-hint', STR.setupUplinkMiss));
      setupEmbed('uplink', body);
    });
  } else if (id === 'verify') {
    var out = mk('ul', 'broadcast-list', null, { id: 'setup-verify-list', 'aria-live': 'polite' });
    var go = mk('button', 'timer-btn primary', STR.setupVerifyRun, { type: 'button', id: 'setup-verify-run' });
    go.addEventListener('click', function () {
      while (out.firstChild) out.removeChild(out.firstChild);
      function line(text, ok) { out.appendChild(mk('li', ok ? 'broadcast-ok' : 'broadcast-ng', text)); }
      // 読むだけ: 接続の状態・プラグインの有無・配信先の一覧。配信と枠取りは起こさない。
      Promise.all([
        call('hub.getState').catch(function () { return null; }),
        call('obs.testConnection', {}).catch(function () { return null; }),
        call('engine.listTargets').catch(function () { return []; })
      ]).then(function (all) {
        var connected = !!(all[0] && all[0].engineStatus && all[0].engineStatus.connected === true);
        line(STR.setupVerifyObs(connected), connected);
        var pluginOk = !!(all[1] && all[1].ok !== false && all[1].plugin && all[1].plugin.state === 'ok');
        line(STR.setupVerifyPlugin(pluginOk), pluginOk);
        var targets = Array.isArray(all[2]) ? all[2] : [];
        var wanted = setupState.sites.length ? setupState.sites : [];
        wanted.forEach(function (site) {
          var mine = targets.filter(function (t) { return t.site === site && t.linked !== false; });
          line(STR.setupVerifyDest(siteLabel(site), mine.length > 0), mine.length > 0);
        });
        if (!wanted.length) targets.forEach(function (t) { line(STR.setupVerifyDest(t.name, t.linked !== false), t.linked !== false); });
      });
    });
    body.appendChild(go);
    body.appendChild(out);
    body.appendChild(mk('p', 'timer-hint', STR.setupVerifyDone));
  }
}

function setupRender() {
  var ov = setupState.overlay;
  if (!ov) return;
  setupReturnPanels();
  var steps = STR.setupSteps;
  var step = steps[setupState.step];
  var card = ov.querySelector('.setup-card');
  while (card.firstChild) card.removeChild(card.firstChild);
  var head = mk('div', 'setup-head');
  head.appendChild(mk('h2', '', STR.setupTitle + '：' + step.title));
  head.appendChild(mk('span', 'timer-hint', STR.setupStepOf(setupState.step + 1, steps.length)));
  card.appendChild(head);
  card.appendChild(mk('p', 'timer-hint', step.lead));
  var body = mk('div', 'setup-body', null, { id: 'setup-body' });
  card.appendChild(body);
  setupBodyFor(step.id, body);
  var foot = mk('div', 'timer-actions setup-foot');
  var last = setupState.step === steps.length - 1;
  var later = mk('button', 'timer-btn', STR.setupLater, { type: 'button', id: 'setup-later' });
  later.addEventListener('click', setupClose);
  foot.appendChild(later);
  var all = mk('button', 'timer-btn', STR.setupSkipAll, { type: 'button', id: 'setup-skip-all' });
  all.addEventListener('click', function () {
    if (window.confirm(STR.setupSkipAllConfirm)) setupFinish();
  });
  foot.appendChild(all);
  if (setupState.step > 0) {
    var back = mk('button', 'timer-btn', STR.setupBack, { type: 'button', id: 'setup-back' });
    back.addEventListener('click', function () { setupGo(setupState.step - 1); });
    foot.appendChild(back);
  }
  if (!last) {
    var skip = mk('button', 'timer-btn', STR.setupSkipStep, { type: 'button', id: 'setup-skip-step' });
    skip.addEventListener('click', function () { setupNext(true); });
    foot.appendChild(skip);
  }
  var next = mk('button', 'timer-btn primary', last ? STR.setupFinish : STR.setupNext, { type: 'button', id: 'setup-next' });
  next.addEventListener('click', function () { setupNext(false); });
  foot.appendChild(next);
  card.appendChild(foot);
  var heading = card.querySelector('h2');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
}

/** 案内を開く。fromStep が無ければ保存済みの続きから。 */
function openSetup(fromStep) {
  if (setupState.open) return;
  setupState.open = true;
  var ov = mk('div', 'setup-overlay', null, { id: 'setup-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': STR.setupTitle });
  ov.appendChild(mk('div', 'setup-card'));
  document.body.appendChild(ov);
  setupState.overlay = ov;
  // キーボード: Esc は「あとで続ける」。開いたら案内の中へフォーカス。Tab は案内の中だけを回る。
  ov.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); setupClose(); return; }
    if (ev.key !== 'Tab') return;
    var items = ov.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]');
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  call('ui.getSettings').then(function (s) {
    setupState.skipped = s && Array.isArray(s.setupSkipped) ? s.setupSkipped.slice() : [];
    setupState.sites = s && Array.isArray(s.setupSites) ? s.setupSites.slice() : [];
    var start = typeof fromStep === 'number' ? fromStep : (s && Number.isInteger(s.setupStep) ? s.setupStep : 0);
    setupState.step = Math.max(0, Math.min(STR.setupSteps.length - 1, start));
    setupRender();
  }).catch(function () { setupState.step = 0; setupRender(); });
}

/** 起動時: ウィンドウで、setupDone が無いときだけ自動で開く。ブラウザ（進み具合を保存できない）では開かない。 */
function maybeOpenSetup() {
  call('hub.getState').then(function (st) {
    if (!st || st.clientId !== 'local-window') return null;
    return call('ui.getSettings').then(function (s) {
      if (s && s.ok !== false && s.readable !== false && s.setupDone !== true) openSetup(); // 設定ファイルが読めないときは出さない（毎回出てしまうため）
    });
  }).catch(function () {});
}

if (typeof module === 'object' && module.exports) module.exports = {};
