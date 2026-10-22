'use strict';
/** パネル `sites`（サイト別の状態の表）。 */
// サイト別の状態: サイトごとの「題名とカテゴリを送る」「コメントを送る」「コメントを受ける」を 1 つの表にまとめる。
// サイトを並べる順。サイトのプラグインが manifest の site.order で名乗ったもの（小さいほど先）。プラグインの一覧が届くたび noteSiteOrder が入れ直す（計画 X・P1）
var SITE_ORDER = [];
function noteSiteOrder(rows) {
  var found = (Array.isArray(rows) ? rows : []).filter(function (r) { return r && r.site && typeof r.site.id === 'string'; });
  found.sort(function (a, b) { return (Number(a.site.order) || 999) - (Number(b.site.order) || 999); });
  var ids = [];
  found.forEach(function (r) {
    if (ids.indexOf(r.site.id) === -1) ids.push(r.site.id);
    if (typeof r.site.name === 'string' && r.site.name) SITE_LABELS[r.site.id] = r.site.name;
  });
  SITE_ORDER.length = 0;
  ids.forEach(function (id) { SITE_ORDER.push(id); });
}
var SITE_COLUMNS = [
  ['site', STR.sitesColSite, STR.sitesColSiteHint],
  ['sink', STR.sitesColSink, STR.sitesColSinkHint],
  ['chat', STR.sitesColChat, STR.sitesColChatHint],
  ['slot', STR.sitesColSlot, STR.sitesColSlotHint]
];
function siteCell(kind, status, mode) {
  var td = document.createElement('td');
  if (!status || status.ok === false) {
    td.className = 'site-off';
    td.textContent = '—';
    return td;
  }
  var badge = document.createElement('span');
  badge.className = 'site-mode site-mode-' + (mode || 'legacy');
  badge.textContent = mode === 'live' ? STR.sitesModeLive : mode === 'shadow' ? STR.sitesModeShadow : STR.sitesModeOff;
  td.appendChild(badge);
  var note = document.createElement('span');
  note.className = 'site-note';
  var text = '';
  var bad = false;
  if (kind === 'chat') {
    text = (status.label || '') + (typeof status.count === 'number' && status.count > 0 ? ' · ' + status.count + STR.sitesCountUnit : '');
  } else if (status.configured === false) {
    text = STR.sitesNotConfigured;
    td.classList.add('site-off');
  } else if (status.lastOk === true) {
    text = STR.sitesOk;
  } else if (status.lastOk === false) {
    text = STR.sitesFailedPrefix + (status.lastError || '');
    bad = true;
  } else {
    var res = status.result || status.lastResult || '';
    if (res && res !== 'none') {
      text = res === 'ok' || res === 'success' ? STR.sitesOk : String(res);
      bad = !(res === 'ok' || res === 'success');
    } else {
      text = STR.sitesNotSentYet;
    }
  }
  note.textContent = text;
  if (bad) note.classList.add('is-bad');
  td.appendChild(note);
  return td;
}
// ログインの列・説明・フォームを出すか。二層目（ログインを扱うプラグイン）があるサイトが 1 つでもあるときだけ（hasLayer2 は sites.loginStatus の行）。
function sitesLoginVisible(loginRows) {
  return Array.isArray(loginRows) && loginRows.some(function (r) { return r && r.hasLayer2 === true; });
}
// そのサイトのログインのセルを中身つきで出すか（二層目が無いサイトは空のセル）。
function sitesLoginRowActive(row) {
  return !!row && row.hasLayer2 === true;
}
function ensureSitesPanel() {
  var existing = panelRoot('sites');
  if (existing) return existing;
  var host = document.getElementById('panel-source');
  if (!host) return null;
  var section = mk('section', 'card', null, { 'data-panel': 'sites' });
  section.appendChild(mk('h2', '', STR.sitesTitle));
  section.appendChild(mk('p', 'timer-hint', STR.sitesIntro));
  section.appendChild(mk('p', 'timer-hint', STR.loginIntro, { id: 'sites-login-intro' }));
  var expLabel = mk('label', 'timer-hint');
  var expBox = mk('input', '', null, { type: 'checkbox', id: 'sites-experimental', 'data-need': 'write' });
  expLabel.appendChild(expBox);
  expLabel.appendChild(document.createTextNode(' ' + STR.showExperimental));
  section.appendChild(expLabel);
  section.appendChild(mk('p', 'timer-hint', STR.showExperimentalHint));
  var box = mk('div', '', null, { id: 'sites-table' });
  box.appendChild(mk('p', 'empty', STR.sitesLoading));
  section.appendChild(box);
  section.appendChild(mk('div', '', null, { id: 'sites-login-form' }));
  var actions = mk('div', 'timer-actions');
  actions.appendChild(mk('button', 'timer-btn', STR.sitesRefresh, { id: 'sites-refresh', type: 'button' }));
  section.appendChild(actions);
  host.appendChild(section);
  return section;
}
function initSites() {
  var root = ensureSitesPanel();
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var box = root.querySelector('#sites-table');
  var busy = false;
  var loginRows = null; // sites.loginStatus（ウィンドウだけ）。null のときはログイン列を出さない
  var siteInfo = {};    // hub.getState の site（ログインの種類・設定欄）
  var inlets = {};      // chat.inlets（サイトごとの今の入り口と、取り込まなかった件数）
  // 丸スト内でコメントを受け取れるサイト（chatSource を持つ chat-*）には「受け取る／受け取らない」と入り口の表示を足す。
  function decorateReceive(td, site, byId, inletRows) {
    var row = null;
    Object.keys(byId).forEach(function (key) {
      if (byId[key] && byId[key].chatSource === site && /^chat-/.test(key)) row = byId[key];
    });
    if (!row) return;
    td.classList.remove('site-off');
    var sw = mk('label', 'site-send');
    var cb = mk('input', '', null, { type: 'checkbox', 'data-receive-site': site, 'aria-label': siteLabel(site) + ': ' + STR.receiveOn });
    cb.checked = row.mode === 'live';
    cb.disabled = true; // 丸ストは当面コメントを受け取らない（受信はわんコメ）。ホスト側でも receive-disabled で断る
    sw.appendChild(cb);
    sw.appendChild(document.createTextNode(' ' + (row.mode === 'live' ? STR.receiveOn : STR.receiveOff)));
    sw.title = STR.receiveDisabledHint;
    td.appendChild(document.createElement('br'));
    td.appendChild(sw);
    if (row.stability === 'experimental') td.appendChild(mk('span', 'site-note', ' ' + STR.experimentalBadge));
    var inlet = inletRows && inletRows[site];
    var recent = inlet && inlet.lastAt && (Date.now() - Date.parse(inlet.lastAt)) < 15 * 60 * 1000;
    var via = inlet && inlet.owner ? STR.receiveViaMarust : (recent ? STR.receiveOutsideActive(inlet.lastSource) : STR.receiveOutsideIdle);
    var note = via + (inlet && inlet.skipped > 0 ? ' / ' + STR.receiveSkipped(inlet.skipped) : '');
    td.appendChild(document.createElement('br'));
    td.appendChild(mk('span', 'site-note', note));
  }
  // 自動枠取り（slot-<サイト>）にはオン/オフのスイッチと枠設定パネルへのボタンを足す。
  function decorateSlot(td, site, byId) {
    var row = byId['slot-' + site];
    if (!row) return;
    td.classList.remove('site-off');
    while (td.firstChild) td.removeChild(td.firstChild);
    var isLive = row.mode === 'live';
    var badge = document.createElement('span');
    badge.className = 'site-mode site-mode-' + (row.mode || 'legacy');
    badge.textContent = isLive ? STR.sitesModeLive : (row.mode === 'shadow' ? STR.sitesModeShadow : STR.sitesModeOff);
    td.appendChild(badge);
    var sw = mk('label', 'site-send');
    var cb = mk('input', '', null, { type: 'checkbox', 'data-slot-site': site, 'aria-label': siteLabel(site) + ': ' + STR.sitesColSlot });
    cb.checked = isLive;
    if (!can.write || !loginRows) cb.disabled = true;
    sw.appendChild(cb);
    sw.appendChild(document.createTextNode(' ' + (isLive ? STR.sitesSlotOn : STR.sitesSlotOff)));
    td.appendChild(document.createElement('br'));
    td.appendChild(sw);
    var slotBtn = mk('button', 'timer-btn', STR.sitesSlotOpen, { type: 'button' });
    if (!can.write) slotBtn.disabled = true;
    slotBtn.addEventListener('click', function () { openPanel('plugin:slot-' + site + ':status'); });
    td.appendChild(document.createTextNode(' '));
    td.appendChild(slotBtn);
    if (site === 'niconico') {
      td.appendChild(document.createElement('br'));
      td.appendChild(mk('span', 'site-note', STR.sitesSlotNicoHint));
    }
  }
  function paint(sites, byId, statuses) {
    var table = document.createElement('table');
    table.className = 'dest-table sites-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    var th0 = document.createElement('th');
    th0.textContent = STR.sitesColName;
    hr.appendChild(th0);
    var thSend = document.createElement('th');
    thSend.textContent = STR.sendColumn;
    thSend.title = STR.sendColumnHint;
    hr.appendChild(thSend);
    SITE_COLUMNS.forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col[1];
      th.title = col[2];
      hr.appendChild(th);
    });
    var showLogin = sitesLoginVisible(loginRows);
    var intro = root.querySelector('#sites-login-intro');
    if (intro) intro.hidden = !showLogin;
    var loginForm = root.querySelector('#sites-login-form');
    if (loginForm) { loginForm.hidden = !showLogin; if (!showLogin) while (loginForm.firstChild) loginForm.removeChild(loginForm.firstChild); }
    if (showLogin) {
      var thLogin = document.createElement('th');
      thLogin.textContent = STR.loginColumn;
      hr.appendChild(thLogin);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    sites.forEach(function (site) {
      var tr = document.createElement('tr');
      var name = document.createElement('td');
      name.className = 'dest-name';
      var siteRow = byId['site-' + site];
      name.textContent = siteRow && siteRow.site && siteRow.site.name ? siteRow.site.name : siteLabel(site);
      if (siteRow && siteRow.stability === 'experimental') {
        name.appendChild(mk('span', 'site-note', ' ' + STR.experimentalBadge));
      }
      tr.appendChild(name);
      var sendTd = document.createElement('td');
      if (siteRow && siteRow.site && siteRow.audience === 'public') {
        var sw = mk('label', 'site-send');
        var cb = mk('input', '', null, { type: 'checkbox', 'data-send-id': siteRow.id, 'aria-label': siteLabel(site) + ': ' + STR.sendColumn });
        cb.checked = siteRow.send === true;
        if (!can.write || !loginRows) cb.disabled = true; // loginRows が null ＝ウィンドウ以外
        sw.appendChild(cb);
        sw.appendChild(document.createTextNode(' ' + (siteRow.send === true ? STR.sendOn : STR.sendOff)));
        sendTd.appendChild(sw);
      } else {
        sendTd.className = 'site-off';
        sendTd.textContent = '—';
      }
      tr.appendChild(sendTd);
      SITE_COLUMNS.forEach(function (col) {
        var id = col[0] + '-' + site;
        var td = byId[id] ? siteCell(col[0], statuses[id], byId[id].mode) : siteCell(col[0], null, '');
        td.title = byId[id] ? col[2] : STR.sitesNoFeature;
        if (col[0] === 'chat') decorateReceive(td, site, byId, inlets);
        if (col[0] === 'slot') decorateSlot(td, site, byId);
        tr.appendChild(td);
      });
      if (showLogin) tr.appendChild(loginCell(site));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(table);
  }
  function loginCell(site) {
    var td = document.createElement('td');
    var row = null;
    loginRows.forEach(function (r) { if (r.id === site) row = r; });
    if (!sitesLoginRowActive(row)) { td.className = 'site-off'; td.textContent = '—'; return td; }
    td.appendChild(mk('span', 'site-note', STR.loginState(row.state)));
    var info = siteInfo[site] || {};
    function btn(label, fn) {
      var b = mk('button', 'timer-btn', label, { type: 'button' });
      if (!can.write) b.disabled = true;
      b.addEventListener('click', fn);
      td.appendChild(document.createTextNode(' '));
      td.appendChild(b);
    }
    if (row.type === 'oauth') {
      if (row.state === 'none') btn(STR.loginSetup, function () { showOauthForm(site, info); });
      else {
        btn(STR.loginRelink, function () { relink(site, info); });
      }
    } else if (row.type === 'cookie') {
      td.appendChild(document.createTextNode(' '));
      td.appendChild(mk('span', 'site-note', STR.loginCookieHint));
    } else if (row.type === 'config') {
      if (info.configSchema && info.configSchema.length) btn(STR.loginConfigure, function () { showConfigForm(site, info); });
      else { td.appendChild(document.createTextNode(' ')); td.appendChild(mk('span', 'site-note', STR.loginNoSchema)); }
    }
    return td;
  }
  function formBox() {
    var f = root.querySelector('#sites-login-form');
    while (f.firstChild) f.removeChild(f.firstChild);
    return f;
  }
  function field(box, label, type, id) {
    var l = mk('label', '', label + ' ');
    var input = mk('input', '', null, { type: type, id: id, autocomplete: 'off', spellcheck: 'false', maxlength: '2000' });
    if (type === 'password') {
      input.setAttribute('autocomplete', 'new-password');
      input.placeholder = STR.secretTailUnset;
    }
    l.appendChild(input);
    box.appendChild(l);
    box.appendChild(document.createTextNode(' '));
    return input;
  }
  // 結び直しは 1 つずつ。ブラウザの戻り先（localhost:3000）は全サイトで同じなので、重ねると前のほうが取り消される。
  var relinking = false;
  function relink(site, info) {
    if (!can.write) return;
    if (relinking) { window.alert(STR.sitesRelinkBusy); return; }
    if (!window.confirm(STR.sitesRelinkConfirm(info.name || site))) return;
    relinking = true;
    call('auth.reauth', { site: site }).then(function (res) {
      relinking = false;
      window.alert(res && res.ok === true ? STR.sitesRelinkDone : STR.loginErr(res && res.error));
      refresh();
    }).catch(function () { relinking = false; window.alert(STR.loginErr('failed')); });
  }
  function showOauthForm(site, info) {
    var f = formBox();
    f.appendChild(mk('h3', '', (info.name || site) + ': ' + STR.loginSetup));
    var rowInfo = null;
    (loginRows || []).forEach(function (r) { if (r.id === site) rowInfo = r; });
    var guideText = (site === 'youtube' && typeof STR.loginOauthGuideYoutube === 'function')
      ? STR.loginOauthGuideYoutube(rowInfo && rowInfo.defaultRedirect)
      : STR.loginOauthGuide(info.name || site, rowInfo && rowInfo.defaultRedirect);
    var guideEl = mk('p', 'timer-hint', guideText);
    if (site === 'youtube') guideEl.style.whiteSpace = 'pre-wrap';
    f.appendChild(guideEl);
    var setup = mk('div', 'timer-setup');
    var idEl = field(setup, STR.sitesClientId, 'text', 'login-client-id');
    var secEl = field(setup, STR.sitesClientSecret, 'password', 'login-client-secret');
    var reEl = field(setup, STR.sitesRedirectLabel(rowInfo && rowInfo.defaultRedirect), 'text', 'login-redirect');
    f.appendChild(setup);
    var status = mk('p', 'timer-hint', '', { 'aria-live': 'polite' });
    var run = mk('button', 'timer-btn primary', STR.sitesSaveAndLogin, { type: 'button' });
    run.addEventListener('click', function () {
      if (!can.write) return;
      if (relinking) { status.textContent = STR.sitesRelinkBusy; return; }
      var body = { site: site, clientId: idEl.value, clientSecret: secEl.value };
      if (reEl.value.trim()) body.redirectUri = reEl.value.trim();
      secEl.value = '';
      call('sites.setOAuthApp', body).then(function (res) {
        if (!res || res.ok === false) { status.textContent = STR.loginErr(res && res.error); return; }
        status.textContent = STR.loginSaved;
        idEl.value = '';
        relinking = true;
        return call('auth.reauth', { site: site }).then(function (r) {
          relinking = false;
          status.textContent = r && r.ok === true ? STR.sitesLoginOk : STR.loginErr(r && r.error);
          refresh();
        });
      }).catch(function () { relinking = false; status.textContent = STR.loginErr('failed'); });
    });
    f.appendChild(run);
    f.appendChild(status);
  }
  function showConfigForm(site, info) {
    var f = formBox();
    f.appendChild(mk('h3', '', (info.name || site) + ': ' + STR.loginConfigure));
    var setup = mk('div', 'timer-setup');
    var inputs = {};
    info.configSchema.forEach(function (fd) {
      inputs[fd.name] = field(setup, fd.label + (fd.required ? STR.sitesRequiredSuffix : ''), fd.secret ? 'password' : 'text', 'login-cfg-' + fd.name);
    });
    f.appendChild(setup);
    f.appendChild(mk('p', 'timer-hint', STR.sitesBlankKeeps));
    var status = mk('p', 'timer-hint', '', { 'aria-live': 'polite' });
    var run = mk('button', 'timer-btn primary', STR.sitesSave, { type: 'button' });
    run.addEventListener('click', function () {
      if (!can.write) return;
      var fields = {};
      Object.keys(inputs).forEach(function (k) { fields[k] = inputs[k].value; inputs[k].value = ''; });
      call('sites.setConfig', { site: site, fields: fields }).then(function (res) {
        status.textContent = res && res.ok === true ? STR.loginSaved : STR.loginErr(res && res.error);
        refresh();
      }).catch(function () { status.textContent = STR.loginErr('failed'); });
    });
    f.appendChild(run);
    f.appendChild(status);
  }
  function refresh() {
    if (busy) return;
    busy = true;
    call('modes.list', {}).then(function (res) {
      var rows = res && res.ok !== false && Array.isArray(res.plugins) ? res.plugins : [];
      var byId = {};
      var names = [];
      // 試験中・作者専用のサイトは、サイト本体（site-*）が見えないとき、コメント送信・受信の行ごと隠す
      var hiddenSites = {};
      rows.forEach(function (row) {
        var hm = /^site-(.+)$/.exec(row.id || '');
        if (hm && row.visible === false) hiddenSites[hm[1]] = true;
      });
      rows.forEach(function (row) {
        var m = /^(site|sink|chat|slot)-(.+)$/.exec(row.id || '');
        if (!m || row.visible === false || hiddenSites[m[2]]) return;
        byId[row.id] = row;
        if (names.indexOf(m[2]) === -1) names.push(m[2]);
      });
      names.sort(function (a, b) {
        var ia = SITE_ORDER.indexOf(a); var ib = SITE_ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      var statuses = {};
      var pre = Promise.all([
        call('sites.loginStatus', {}).then(function (r) { loginRows = r && r.ok === true && Array.isArray(r.sites) ? r.sites : null; }).catch(function () { loginRows = null; }),
        call('chat.inlets', {}).then(function (r) { inlets = r && r.ok === true && r.inlets ? r.inlets : {}; }).catch(function () { inlets = {}; }),
        call('hub.getState').then(function (st) {
          siteInfo = {};
          ((st && st.plugins) || []).forEach(function (p) { if (p.site && p.site.id) siteInfo[p.site.id] = p.site; });
        }).catch(function () {})
      ]);
      return pre.then(function () {
        return Promise.all(Object.keys(byId).map(function (id) {
          return call('plugin.' + id + '.getStatus', {}).then(function (r) { statuses[id] = r; }).catch(function () { statuses[id] = null; });
        }));
      }).then(function () { paint(names, byId, statuses); });
    }).catch(function () {
      while (box.firstChild) box.removeChild(box.firstChild);
      box.appendChild(mk('p', 'empty', STR.sitesLoadFailed));
    }).then(function () { busy = false; });
  }
  root.querySelector('#sites-refresh').addEventListener('click', refresh);
  // サイトごとの「送る／送らない」
  box.addEventListener('change', function (ev) {
    var cb = ev.target && ev.target.closest ? ev.target.closest('[data-send-id]') : null;
    if (!cb || !can.write) return;
    var id = cb.getAttribute('data-send-id');
    var want = cb.checked;
    if (want && confirmLiveWanted && !window.confirm(STR.sitesSendConfirm(id))) { cb.checked = false; return; }
    call('sites.setSend', { id: id, send: want, confirmName: want ? id : undefined }).then(function (res) {
      if (!res || res.ok === false) { cb.checked = !want; window.alert(STR.sendSwitchError(res && res.error)); }
      refresh();
    }).catch(function () { cb.checked = !want; });
  });
  // サイトごとの「受け取る／受け取らない」（丸スト内でコメントを受けるサイトだけ）
  box.addEventListener('change', function (ev) {
    var cb = ev.target && ev.target.closest ? ev.target.closest('[data-receive-site]') : null;
    if (!cb || !can.write) return;
    var site = cb.getAttribute('data-receive-site');
    var want = cb.checked;
    call('sites.setReceive', { site: site, receive: want }).then(function (res) {
      if (!res || res.ok === false) { cb.checked = !want; window.alert(STR.receiveSwitchError(res && res.error)); }
      refresh();
    }).catch(function () { cb.checked = !want; });
  });
  // サイトごとの「自動枠取り（オン／オフ）」
  box.addEventListener('change', function (ev) {
    var cb = ev.target && ev.target.closest ? ev.target.closest('[data-slot-site]') : null;
    if (!cb || !can.write) return;
    var site = cb.getAttribute('data-slot-site');
    var want = cb.checked;
    call('sites.setAutoSlot', { site: site, enabled: want }).then(function (res) {
      if (!res || res.ok === false) { cb.checked = !want; window.alert(STR.autoSlotErr ? STR.autoSlotErr(res && res.error) : '切り替えに失敗しました'); }
      refresh();
    }).catch(function () { cb.checked = !want; });
  });
  var expEl = root.querySelector('#sites-experimental');
  function loadExperimental() {
    call('ui.getSettings').then(function (res) { if (expEl && res && res.ok !== false) expEl.checked = res.showExperimental === true; }).catch(function () {});
  }
  if (expEl) expEl.addEventListener('change', function () {
    call('ui.setSettings', { showExperimental: expEl.checked }).then(function () { refresh(); }).catch(function () {});
  });
  loadExperimental();
  refresh();
  setInterval(function () { if (root.offsetParent) refresh(); }, 15000);
  if (hubApi() && hubApi().subscribe) {
    hubApi().subscribe(function (msg) {
      if (msg && msg.name === 'modes.changed') refresh();
    });
  }
}

registerPanel('sites', initSites);
if (typeof module === 'object' && module.exports) module.exports = { sitesLoginVisible: sitesLoginVisible, sitesLoginRowActive: sitesLoginRowActive };
