'use strict';
/** パネル `site-add`（サイトを足す）。 */
function initSiteAdd() {
  var root = panelRoot('site-add');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var siteSel = root.querySelector('#site-add-site');
  var ingestSel = root.querySelector('#site-add-ingest');
  var serverEl = root.querySelector('#site-add-server');
  var keyEl = root.querySelector('#site-add-key');
  if (keyEl) keyEl.placeholder = STR.secretTailUnset;
  var createKeyEl = root.querySelector('#create-key');
  if (createKeyEl) createKeyEl.placeholder = STR.secretTailUnset;
  var linksEl = root.querySelector('#site-add-links');
  var notesEl = root.querySelector('#site-add-notes');
  var tosEl = root.querySelector('#site-add-tos');
  var statusEl = root.querySelector('#site-add-status');
  var expEl = root.querySelector('#site-add-experimental');
  var sites = [];
  root.querySelector('#site-add-guide').textContent = STR.addSiteGuide;
  root.querySelector('#site-add-experimental-label').textContent = STR.showExperimental;
  function say(text) { statusEl.textContent = text || ''; }
  var CUSTOM = '__custom__';
  var nameWrap = root.querySelector('#site-add-name-wrap');
  var nameEl = root.querySelector('#site-add-name');
  function currentSite() {
    if (siteSel.value === CUSTOM) return { id: CUSTOM, name: nameEl.value.trim(), ingest: [], custom: true };
    for (var i = 0; i < sites.length; i += 1) if (sites[i].id === siteSel.value) return sites[i];
    return null;
  }
  function linkNode(text, url) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    a.style.marginRight = '1.2em';
    return a;
  }
  function paintSite() {
    var site = currentSite();
    while (linksEl.firstChild) linksEl.removeChild(linksEl.firstChild);
    notesEl.textContent = '';
    tosEl.textContent = '';
    ingestSel.innerHTML = '';
    if (nameWrap) nameWrap.hidden = !(site && site.custom);
    if (site && site.custom) {
      // 一覧にないサイト: RTMP の URL とキーを自分で入れる。丸ストの題名送信などの対象にはならず、OBS の配信先だけができる。
      var only = document.createElement('option');
      only.value = 'manual';
      only.textContent = STR.addSiteManualUrl;
      ingestSel.appendChild(only);
      notesEl.textContent = STR.addSiteCustomNote;
      tosEl.textContent = STR.addSiteTos;
      return;
    }
    if (!site) return;
    (site.ingest || []).forEach(function (row, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = row.label || STR.addSiteIngestN(i + 1);
      ingestSel.appendChild(opt);
    });
    var manual = document.createElement('option');
    manual.value = 'manual';
    manual.textContent = STR.addSiteManualUrl;
    ingestSel.appendChild(manual);
    paintIngest();
    if (!site.custom) { var g = linkNode(STR.addSiteKeyGuide, STR.streamKeyGuidePath + '#' + encodeURIComponent(site.id)); linksEl.appendChild(g); }
    if (site.keyHelpUrl) { linksEl.appendChild(linkNode(STR.addSiteKeyHelp, site.keyHelpUrl)); linksEl.appendChild(document.createTextNode('  ')); }
    var notes = [];
    if (!(site.ingest || []).some(function (r) { return r.url; })) notes.push(STR.addSiteNoUrl);
    if (site.addHint) notes.push(site.addHint);
    notesEl.textContent = notes.join(' ');
    tosEl.textContent = STR.addSiteTos + ' ';
    if (site.tosUrl) tosEl.appendChild(linkNode(STR.addSiteTosLink, site.tosUrl));
  }
  function paintIngest() {
    var site = currentSite();
    if (!site) return;
    var row = ingestSel.value !== 'manual' ? (site.ingest || [])[Number(ingestSel.value)] : null;
    if (row && row.url) serverEl.value = row.url;
    else if (row || ingestSel.value === 'manual') serverEl.value = '';
    // 送り先の案内ページ
    var old = linksEl.querySelector('[data-ingest-link]');
    if (old) old.parentNode.removeChild(old);
    if (row && row.helpUrl) {
      var a = linkNode(STR.addSiteIngestHelp, row.helpUrl);
      a.setAttribute('data-ingest-link', '1');
      linksEl.insertBefore(a, linksEl.firstChild);
      linksEl.insertBefore(document.createTextNode('  '), a.nextSibling);
    }
  }
  function load() {
    call('hub.getState').then(function (state) {
      notePermissions(state && state.permissions);
      var rows = state && Array.isArray(state.plugins) ? state.plugins : [];
      if (typeof noteSiteOrder === 'function') noteSiteOrder(rows);
      sites = rows.filter(function (r) { return r.site && r.visible !== false && r.hidden !== true && r.audience === 'public'; })
        .map(function (r) { return Object.assign({ stability: r.stability }, r.site); })
        .sort(function (a, b) {
          var ia = SITE_ORDER.indexOf(a.id); var ib = SITE_ORDER.indexOf(b.id);
          return (a.tier === 'core' ? 0 : 1) - (b.tier === 'core' ? 0 : 1) || (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
      var keep = siteSel.value;
      siteSel.innerHTML = '';
      sites.forEach(function (site) {
        var opt = document.createElement('option');
        opt.value = site.id;
        opt.textContent = site.name + (site.stability === 'experimental' ? '（' + STR.experimentalBadge + '）' : '');
        siteSel.appendChild(opt);
      });
      var custom = document.createElement('option');
      custom.value = CUSTOM;
      custom.textContent = STR.addSiteCustom;
      siteSel.appendChild(custom);
      if (keep) siteSel.value = keep;
      paintSite();
    }).catch(function () {});
    call('ui.getSettings').then(function (res) { if (res && res.ok !== false) expEl.checked = res.showExperimental === true; }).catch(function () {});
    call('obs.getConnection').then(function (res) {
      var warn = root.querySelector('#site-add-obs-warn');
      if (warn) warn.textContent = res && res.ok === true && res.control === false ? STR.addSiteNeedControl : '';
    }).catch(function () {});
  }
  siteSel.addEventListener('change', paintSite);
  ingestSel.addEventListener('change', paintIngest);
  expEl.addEventListener('change', function () {
    call('ui.setSettings', { showExperimental: expEl.checked }).then(load).catch(function () {});
  });
  // ターゲットの一覧。メイン出力（OBS の配信設定。サイトに結びつける相手ではない）は外す
  function targetRows(list) {
    var rows = Array.isArray(list) ? list : (list && Array.isArray(list.targets) ? list.targets : []);
    return rows.filter(function (r) { return r && !(r.main === true || r.id === 'main'); });
  }
  // 作る前の id の一覧と比べて「増えた行」を探す（同じ名前の古い配信先と取りちがえない）
  function findNewTarget(name, beforeIds, tries) {
    return call('engine.listTargets').then(function (list) {
      var hit = null;
      targetRows(list).forEach(function (r) { if (r.name === name && !r.linked && beforeIds.indexOf(String(r.id)) === -1) hit = r; });
      if (hit || tries <= 0) return hit;
      return new Promise(function (resolve) { setTimeout(resolve, 700); }).then(function () { return findNewTarget(name, beforeIds, tries - 1); });
    });
  }
  root.querySelector('#site-add-run').addEventListener('click', function () {
    if (!can.write) return;
    var site = currentSite();
    var server = serverEl.value.trim();
    var key = keyEl.value;
    if (!site) return;
    if (!server || !key.trim()) { say(STR.addSiteNeedKey); return; }
    if (site.custom && !site.name) { say(STR.addSiteCustomNeedName); return; }
    if (!window.confirm(STR.addSiteConfirm(site.name))) return;
    keyEl.value = '';
    say(STR.addSiteCreating);
    var name = site.name;
    var beforeIds = [];
    call('engine.listTargets').then(function (list) {
      beforeIds = targetRows(list).map(function (r) { return String(r.id); });
      return call('engine.create', { protocol: 'RTMP', name: name, server: server, key: key });
    }).then(function (res) {
      if (!res || res.ok === false) { say(STR.addSiteErr(res && res.error)); return; }
      return findNewTarget(name, beforeIds, 6).then(function (target) {
        if (!target) { say(STR.addSiteDone + STR.addSiteLinkLater); return; }
        if (site.custom) { say(STR.addSiteDone + ' ' + STR.addSiteCustomDone); return; }
        return call('engine.link', {
          destinationId: site.id + '-' + target.id,
          targetId: String(target.id),
          site: site.id
        }).then(function (linked) {
          say(linked && linked.ok === false ? STR.addSiteErr(linked.error) : STR.addSiteDone);
          if (linked && linked.ok === false) return null;
          return askAutoSlot(site);
        });
      });
    }).catch(function () { say(STR.addSiteErr('failed')); });
  });
  // 自動枠取り（部品を持つサイト）を使うか、サイトを足したときに聞く。あとからホームの「詳細」でも切り替えられる。
  function askAutoSlot(site) {
    if (site.autoSlot !== true) return null; // 自動枠取りの部品を持つサイト（manifest の site.autoSlot）だけ聞く
    if (!levelAtLeast('standard')) return null; // 初級では自動枠取りのプラグインを読み込まない（V5）。聞かない
    if (!window.confirm(STR.autoSlotAsk(site.name))) return null;
    return call('sites.setAutoSlot', { site: site.id, enabled: true }).then(function (res) {
      say(res && res.ok !== false ? STR.addSiteDone + ' ' + STR.autoSlotOn(site.name) : STR.autoSlotErr(res && res.error));
    }).catch(function () { say(STR.autoSlotErr('failed')); });
  }
  // 詳しい設定: URL とキーを自分で入れて OBS に配信先を作る／既にある配信先をサイトに結びつける
  var createBtn = root.querySelector('#create-target');
  if (createBtn) createBtn.addEventListener('click', function () {
    if (!can.write) return;
    var keyBox = root.querySelector('#create-key');
    var cname = root.querySelector('#create-name').value;
    if (!window.confirm(STR.uiSiteadd1 + cname)) return;
    var keyValue = keyBox.value;
    keyBox.value = '';
    call('engine.create', {
      name: cname,
      protocol: root.querySelector('#create-protocol').value,
      server: root.querySelector('#create-server').value,
      key: keyValue
    }).then(function (res) { say(res && res.ok === false ? STR.addSiteErr(res.error) : STR.addSiteDone); }).catch(function () { say(STR.addSiteErr('failed')); });
  });
  var linkBtn = root.querySelector('#link-save');
  if (linkBtn) linkBtn.addEventListener('click', function () {
    if (!can.write) return;
    var destinationId = root.querySelector('#link-dest').value;
    var targetId = root.querySelector('#link-target').value;
    if (!window.confirm(STR.uiSiteadd2 + destinationId + ' -> ' + targetId)) return;
    call('engine.link', {
      destinationId: destinationId,
      targetId: targetId,
      site: root.querySelector('#link-site').value,
      accountId: root.querySelector('#link-account').value
    }).then(function (res) { say(res && res.ok === false ? STR.addSiteErr(res.error) : STR.addSiteDone); }).catch(function () { say(STR.addSiteErr('failed')); });
  });
  load();
  setInterval(function () { if (root.offsetParent) load(); }, 30000);
}

registerPanel('site-add', initSiteAdd);
