'use strict';
/** パネル `secrets`（金庫・ログインの結び直し）。 */
function initSecrets() {
  var root = panelRoot('secrets');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var list = root.querySelector('#secret-list');
  var statusEl = root.querySelector('#secret-status');
  var reauthStatus = root.querySelector('#oauth-reauth-status');
  var isWindow = false;
  function showStatus(code) {
    if (!statusEl) return;
    statusEl.textContent = code ? String(code) : '';
  }
  var currentSecrets = [];
  function paint(rows) {
    var items = Array.isArray(rows) ? rows : [];
    currentSecrets = items;
    if (!items.length) {
      list.innerHTML = STR.uiSecrets1;
      return;
    }
    list.innerHTML = items.map(function (row) {
      var name = row && row.name ? String(row.name) : '';
      var del = '';
      if (isWindow && name) {
        del = ' <button class="timer-btn" type="button" data-act="secret-remove" data-name="' + escapeHtml(name) + '"' + (can.write ? '' : ' disabled') + STR.uiSecrets2;
      }
      var tailText = row && row.tail ? ' / ' + escapeHtml(row.tail) : '';
      return '<p>' + escapeHtml(name) + ' / ' + escapeHtml(row && row.updatedAt) + ' / ' + escapeHtml(row && row.size) + tailText + del + '</p>';
    }).join('');
  }
  var refresh = function () {};
  function loadSecrets() {
    return displayRead('hub.getState').then(function (state) {
      notePermissions(state && state.permissions); if (state && typeof state.confirmLive === 'boolean') confirmLiveWanted = state.confirmLive;
      isWindow = !!(state && state.clientId === 'local-window');
      if (state && !reauthBuilt) { buildReauthButtons(state.plugins); reauthBuilt = true; }
      var admin = root.querySelector('#secret-admin');
      if (admin) admin.hidden = !isWindow;
      setReauthBusy(reauthBusy); // ボタンは画面の判定（ウィンドウか）が済む前に作られることがある。判定のあとで押せる状態に直す
    }).catch(function () {}).then(function () {
      return displayRead('secrets.list');
    }).then(function (res) {
      if (!res || res.ok === false) {
        showStatus(res && res.error);
        paint([]);
        return;
      }
      showStatus('');
      paint(res.secrets);
    }).catch(function (err) {
      showStatus(err && err.message);
    });
  }
  list.addEventListener('click', function (ev) {
    var button = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!button || button.getAttribute('data-act') !== 'secret-remove') return;
    if (!isWindow || !can.write) return;
    call('secrets.remove', { name: button.getAttribute('data-name') }).then(function (res) {
      showStatus(res && res.ok === false ? res.error : '');
      refresh();
    }).catch(function (err) {
      showStatus(err && err.message);
    });
  });
  function reauthMessage(code) {
    if (!code) return STR.uiSecrets3;
    if (code === 'port-in-use') return STR.uiSecrets4;
    if (code === 'redirect-uri-unsupported') return STR.uiSecrets5;
    if (code === 'timeout') return STR.uiSecrets6;
    if (code === 'forbidden') return STR.uiSecrets7;
    return STR.uiSecrets8;
  }
  // ログインの結び直しのボタンは、OAuth でログインするサイト（manifest の site.login.type が oauth）の分だけ、サイトの並べる順で作る（計画 X・P1。サイトの名前を決め打ちしない）
  var reauthButtons = [];
  var reauthBuilt = false;
  var reauthAll = root.querySelector('#oauth-reauth-all');
  var oauthSites = [];
  var reauthBusy = false;
  function setReauthBusy(on) {
    reauthBusy = on;
    if (reauthAll) reauthAll.disabled = on || !isWindow || !can.write;
    for (var bi = 0; bi < reauthButtons.length; bi += 1) reauthButtons[bi].disabled = on || !isWindow || !can.write;
  }
  function buildReauthButtons(rows) {
    var holder = root.querySelector('#oauth-reauth-actions');
    if (!holder) return;
    reauthButtons.forEach(function (btn) { if (btn.parentNode) btn.parentNode.removeChild(btn); });
    reauthButtons = [];
    oauthSites = (Array.isArray(rows) ? rows : []).filter(function (r) {
      return r && r.site && r.site.login && r.site.login.type === 'oauth' && r.visible !== false && r.hidden !== true;
    }).sort(function (a, b) { return (Number(a.site.order) || 999) - (Number(b.site.order) || 999); })
      .map(function (r) { return { id: r.site.id, name: r.site.name || r.site.id }; });
    oauthSites.forEach(function (site) {
      var btn = document.createElement('button');
      btn.className = 'timer-btn';
      btn.type = 'button';
      btn.textContent = site.name + STR.secretsReauthOne;
      btn.setAttribute('data-auth-site', site.id);
      btn.addEventListener('click', function () {
        if (!isWindow || !can.write) return;
        if (!window.confirm(site.id + STR.uiSecrets9)) return;
        setReauthBusy(true);
        if (reauthStatus) reauthStatus.textContent = reauthMessage('');
        call('auth.reauth', { site: site.id }).then(function (res) {
          if (reauthStatus) reauthStatus.textContent = res && res.ok === true ? STR.uiSecrets10 : reauthMessage(res && res.error);
          refresh();
        }).catch(function () {
          if (reauthStatus) reauthStatus.textContent = reauthMessage('failed');
        }).then(function () { setReauthBusy(false); });
      });
      holder.insertBefore(btn, reauthAll);
      reauthButtons.push(btn);
    });
    if (reauthAll) {
      reauthAll.textContent = STR.secretsReauthAllLabel(oauthSites.length);
      reauthAll.hidden = !oauthSites.length;
    }
    setReauthBusy(false);
  }
  if (reauthAll) reauthAll.addEventListener('click', function () {
    if (!isWindow || !can.write) return;
    if (!window.confirm(STR.secretsReauthAllConfirm(oauthSites.map(function (s) { return s.name; })))) return;
    var order = oauthSites.map(function (s) { return s.id; });
    function nameOf(id) { for (var i = 0; i < oauthSites.length; i += 1) if (oauthSites[i].id === id) return oauthSites[i].name; return id; }
    var results = [];
    setReauthBusy(true);
    // 戻り先のポートは全サイトで共有なので、必ず 1 つ終わってから次を始める
    function next(i) {
      if (i >= order.length) {
        if (reauthStatus) reauthStatus.textContent = STR.secretsReauthAllDone(results);
        refresh();
        setReauthBusy(false);
        return;
      }
      if (reauthStatus) reauthStatus.textContent = STR.secretsReauthAllStep(nameOf(order[i]), i + 1, order.length);
      call('auth.reauth', { site: order[i] }).then(function (res) {
        results.push({ site: nameOf(order[i]), ok: !!(res && res.ok === true), error: res && res.error });
      }).catch(function () {
        results.push({ site: nameOf(order[i]), ok: false, error: 'failed' });
      }).then(function () { next(i + 1); });
    }
    next(0);
  });
  var nameEl = root.querySelector('#secret-name');
  var valueEl = root.querySelector('#secret-value');
  if (nameEl && valueEl) {
    nameEl.addEventListener('input', function () {
      var n = nameEl.value.trim();
      var hit = null;
      for (var i = 0; i < currentSecrets.length; i += 1) {
        if (currentSecrets[i] && currentSecrets[i].name === n) { hit = currentSecrets[i]; break; }
      }
      valueEl.placeholder = STR.secretPlaceholder(hit && hit.tail ? hit.tail : '');
    });
  }
  root.querySelector('#secret-save').addEventListener('click', function () {
    var name = nameEl ? nameEl.value : '';
    var value = valueEl ? valueEl.value : '';
    if (valueEl) valueEl.value = '';
    if (!isWindow || !can.write) return;
    call('secrets.set', { name: name, value: value }).then(function (res) {
      showStatus(res && res.ok === false ? res.error : '');
      refresh();
    }).catch(function (err) {
      showStatus(err && err.message);
    });
  });
  var importList = root.querySelector('#secret-import-list');
  var importStatus = root.querySelector('#secret-import-status');
  var importRun = root.querySelector('#secret-import-run');
  var importBulk = root.querySelector('#secret-import-bulk');
  var importBusy = false;
  function importNote(code) {
    if (importStatus) importStatus.textContent = code ? String(code) : '';
  }
  function paintImport(entries) {
    var items = Array.isArray(entries) ? entries : [];
    if (!importList) return;
    if (importBulk) importBulk.hidden = !items.length;
    if (!items.length) {
      importList.innerHTML = STR.uiSecrets11;
      if (importRun) importRun.hidden = true;
      return;
    }
    if (importRun) importRun.hidden = false;
    importList.innerHTML = items.map(function (row) {
      var name = row && row.name ? String(row.name) : '';
      var secret = row && row.secretName ? String(row.secretName) : '';
      var when = row && row.mtime ? String(row.mtime) : '';
      var size = row && row.size != null ? String(row.size) : '';
      var have = row && row.inVault === true ? STR.uiSecrets12 : STR.uiSecrets13;
      var box = can.write ? '' : ' disabled';
      return '<p><label><input type="checkbox" data-import-name="' + escapeHtml(name) + '" data-import-have="' + (row && row.inVault === true ? '1' : '0') + '"' + box + ' /> '
        + escapeHtml(name) + ' / ' + escapeHtml(size) + ' / ' + escapeHtml(when) + ' / '
        + escapeHtml(secret) + ' / ' + have + '</label></p>';
    }).join('');
  }
  // 一括チェック: 1 件ずつ押さなくてよい。which は 'all'（すべて）・'new'（金庫にないものだけ）・'none'（すべて外す）
  function checkImport(which) {
    if (!importList || !can.write) return;
    var boxes = importList.querySelectorAll('[data-import-name]');
    var chosen = 0;
    for (var i = 0; i < boxes.length; i += 1) {
      var inVault = boxes[i].getAttribute('data-import-have') === '1';
      // OBS の接続先は、金庫にあるなら「すべて選ぶ」でも選ばない（古い値で上書きしない）
      var guarded = inVault && boxes[i].getAttribute('data-import-name') === 'obs-config.json';
      var on = !guarded && (which === 'all' || (which === 'new' && !inVault));
      boxes[i].checked = on;
      if (on) chosen += 1;
    }
    importNote(which === 'none' ? '' : STR.uiSecrets17(chosen));
  }
  [['#secret-import-all', 'all'], ['#secret-import-new', 'new'], ['#secret-import-none', 'none']].forEach(function (pair) {
    var button = root.querySelector(pair[0]);
    if (button) button.addEventListener('click', function () { checkImport(pair[1]); });
  });
  function paintImportResult(results) {
    var items = Array.isArray(results) ? results : [];
    if (importRun) importRun.hidden = true;
    if (importBulk) importBulk.hidden = true;
    if (!importList) return;
    if (!items.length) {
      importList.innerHTML = STR.uiSecrets14;
      return;
    }
    importList.innerHTML = items.map(function (row) {
      var name = row && row.name ? String(row.name) : '';
      var secret = row && row.secretName ? String(row.secretName) : '';
      var mark = row && row.ok === true ? 'ok' : (row && row.error ? String(row.error) : 'failed');
      return '<p>' + escapeHtml(name) + ' / ' + escapeHtml(secret) + ' / ' + escapeHtml(mark) + '</p>';
    }).join('');
  }
  var scanButton = root.querySelector('#secret-import-scan');
  if (scanButton) {
    scanButton.addEventListener('click', function () {
      if (importBusy || !isWindow || !can.read) return;
      importBusy = true;
      call('legacyImport.scan', {}).then(function (res) {
        if (!res || res.ok === false) {
          importNote(res && res.error === 'unknown-method' ? STR.uiSecrets16 : (res && res.error ? res.error : 'failed'));
          paintImport([]);
          return;
        }
        importNote('');
        paintImport(res.entries);
      }).catch(function (err) {
        importNote(err && err.message);
      }).then(function () {
        importBusy = false;
      });
    });
  }
  if (importRun) {
    importRun.addEventListener('click', function () {
      if (importBusy || !isWindow || !can.write || !importList) return;
      var boxes = importList.querySelectorAll('[data-import-name]');
      var names = [];
      for (var i = 0; i < boxes.length; i += 1) {
        if (boxes[i].checked) names.push(boxes[i].getAttribute('data-import-name') || '');
      }
      if (!names.length) {
        importNote(STR.uiSecrets15);
        return;
      }
      importBusy = true;
      call('legacyImport.run', { names: names }).then(function (res) {
        if (!res || res.ok === false) {
          importNote(res && res.error ? res.error : 'failed');
          return;
        }
        importNote('');
        paintImportResult(res.results);
        refresh();
        // お気に入りは bulk-title へ渡して足す（プラグインどうしは呼び合わない）
        (res.results || []).forEach(function (row) {
          if (row && row.ok === true && row.favorites) {
            call('favorites.merge', { titles: row.favorites.titles || [], categories: row.favorites.categories || [] }).then(function (merged) {
              if (!merged || merged.ok === false) importNote(merged && merged.error === 'unknown-method' ? STR.uiSecrets18 : (merged && merged.error ? merged.error : 'failed'));
              else importNote(STR.favImportDone(merged.titlesAdded, merged.categoriesAdded));
            }).catch(function () { importNote('failed'); });
          }
        });
      }).catch(function (err) {
        importNote(err && err.message);
      }).then(function () {
        importBusy = false;
      });
    });
  }
  refresh = watchDisplay(root, loadSecrets, function (msg) {
    return !!(msg && /^(auth|modes|plugin|feature)\./.test(msg.name || ''));
  });
}

registerPanel('secrets', initSecrets);
