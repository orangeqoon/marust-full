'use strict';

// 題名とカテゴリを全サイトへ送る画面（V7 C3。前は本体の ui/panels/metadata.js）。
// 読む API（hub.getState・destination.list・category.suggest・favorites.get）は marust.call、
// お気に入りの書き込み（windowOnly）と本物への送信（hub.fanout）は親の窓の中継（marust.relay）、
// 確認は親が出す窓（marust.confirm）だけを通る。

var titleInput = document.getElementById('title');
var categoryInput = document.getElementById('category');
var sendButton = document.getElementById('send');
var statusEl = document.getElementById('obs-status');
var resultsEl = document.getElementById('results');
var suggestions = document.getElementById('category-suggestions');
var devMode = false;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function say(className, text) {
  clear(resultsEl);
  resultsEl.appendChild(el('p', className, text));
}

function renderResults(res, note) {
  clear(resultsEl);
  if (note) resultsEl.appendChild(el('p', 'hint', note));
  var rows = res && Array.isArray(res.results) ? res.results : [];
  if (!rows.length) {
    resultsEl.appendChild(el('p', 'empty', '結果はありません。'));
    return;
  }
  var table = el('table');
  var head = el('tr');
  ['id', 'result', 'message'].forEach(function (name) {
    var th = el('th', '', name);
    th.scope = 'col';
    head.appendChild(th);
  });
  var thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  var tbody = el('tbody');
  rows.forEach(function (row) {
    var tr = el('tr');
    tr.appendChild(el('td', '', String(row && row.id != null ? row.id : '')));
    tr.appendChild(el('td', '', String(row && row.result != null ? row.result : '')));
    tr.appendChild(el('td', '', String(row && row.message != null ? row.message : '')));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  resultsEl.appendChild(table);
}

// ---- お気に入り（★と一覧）。読むのは favorites.get、書くのはこのプラグインの操作 ----
function attachFavorites(input, kind) {
  var items = [];
  var row = el('div', 'row');
  input.parentNode.insertBefore(row, input);
  row.appendChild(input);
  var wrap = el('span', 'fav-wrap');
  var star = el('button', 'fav-star', '☆');
  star.type = 'button';
  star.title = 'お気に入りに入れる／外す';
  star.setAttribute('aria-label', 'お気に入りに入れる／外す');
  star.setAttribute('aria-pressed', 'false');
  var open = el('button', 'fav-open', '▾');
  open.type = 'button';
  open.title = 'お気に入りの一覧から選ぶ';
  open.setAttribute('aria-label', 'お気に入りの一覧から選ぶ');
  open.setAttribute('aria-expanded', 'false');
  var pop = el('div', 'fav-pop');
  pop.hidden = true;
  var note = el('span', 'fav-note');
  note.setAttribute('aria-live', 'polite');
  wrap.appendChild(star);
  wrap.appendChild(open);
  wrap.appendChild(note);
  wrap.appendChild(pop);
  row.appendChild(wrap);

  function writable() { return window.marust.can().write === true; }
  function saved() { return items.indexOf(String(input.value || '').trim()) !== -1; }
  function paintStar() {
    var on = saved();
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('fav-on', on);
    star.setAttribute('aria-pressed', on ? 'true' : 'false');
    star.disabled = !writable();
  }
  function paintList() {
    clear(pop);
    if (!items.length) pop.appendChild(el('p', 'hint', 'お気に入りはまだありません。★ で入れられます。'));
    items.forEach(function (text) {
      var line = el('div', 'fav-row');
      var pick = el('button', 'fav-pick', text);
      pick.type = 'button';
      pick.addEventListener('click', function () {
        input.value = text;
        pop.hidden = true;
        open.setAttribute('aria-expanded', 'false');
        paintStar();
      });
      var del = el('button', 'fav-del', '×');
      del.type = 'button';
      del.title = '一覧から外す';
      del.setAttribute('aria-label', '一覧から外す: ' + text);
      del.disabled = !writable();
      del.addEventListener('click', function () {
        window.marust.relay('favorites.remove', { kind: kind, value: text }).then(apply);
      });
      line.appendChild(pick);
      line.appendChild(del);
      pop.appendChild(line);
    });
    if (devMode) {
      var imp = el('button', 'fav-import', 'NeonTimer から取り込む');
      imp.type = 'button';
      imp.disabled = !writable();
      imp.addEventListener('click', function () { importLegacy(imp); });
      pop.appendChild(imp);
    }
  }
  // 読むのは開発者プラグイン dev-legacy-import（legacyImport.favorites）・足すのはこのプラグインの favMerge
  function importLegacy(button) {
    note.textContent = '取り込み中…';
    window.marust.call('legacyImport.favorites', {}).then(function (read) {
      if (!read || read.ok !== true) {
        if (read && read.error === 'unknown-method') button.hidden = true;
        note.textContent = read && read.error === 'not-found' ? 'NeonTimer のお気に入りが見つかりません' : '取り込めませんでした';
        return null;
      }
      return window.marust.relay('favorites.merge', { titles: read.titles, categories: read.categories }).then(function (res) {
        if (res && res.ok === true) {
          apply(res);
          note.textContent = '取り込みました（題名 ' + res.titlesAdded + ' 件・カテゴリ ' + res.categoriesAdded + ' 件を追加）';
        } else note.textContent = '取り込めませんでした';
      });
    });
  }
  function apply(res) {
    if (res && res.ok === false && res.error === 'unknown-method') { wrap.hidden = true; return; }
    if (res && res.ok !== false) {
      wrap.hidden = false;
      items = (kind === 'title' ? res.titles : res.categories) || [];
      paintStar();
      paintList();
    } else if (res && res.ok === false) {
      note.textContent = 'お気に入りを保存できませんでした';
    }
  }
  function load() {
    window.marust.call('favorites.get', {}).then(apply);
  }
  star.addEventListener('click', function () {
    var text = String(input.value || '').trim();
    if (!text) { note.textContent = '先に文字を入れてください'; return; }
    note.textContent = '';
    window.marust.relay(saved() ? 'favorites.remove' : 'favorites.add', { kind: kind, value: text }).then(apply);
  });
  open.addEventListener('click', function () {
    pop.hidden = !pop.hidden;
    open.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
    if (!pop.hidden) load();
  });
  input.addEventListener('input', paintStar);
  input.addEventListener('change', paintStar);
  document.addEventListener('click', function (ev) {
    if (!pop.hidden && !wrap.contains(ev.target)) { pop.hidden = true; open.setAttribute('aria-expanded', 'false'); }
  });
  window.marust.onPerm(function () { paintStar(); paintList(); });
  load();
  return { load: load };
}

// ---- カテゴリ候補 ----
var categorySite = document.createElement('select');
categorySite.setAttribute('aria-label', 'カテゴリ候補のサイト');
var siteLabel = el('label', '', '候補サイト ');
siteLabel.appendChild(categorySite);
categoryInput.closest('label').parentNode.insertBefore(siteLabel, categoryInput.closest('label'));
var suggestTimer = null;

function paintSuggestions(list) {
  clear(suggestions);
  (Array.isArray(list) ? list : []).forEach(function (item) {
    var value = item && item.name ? String(item.name) : '';
    if (!value) return;
    var option = document.createElement('option');
    option.value = value;
    suggestions.appendChild(option);
  });
}

function refreshCategorySites() {
  window.marust.call('destination.list', {}).then(function (res) {
    var rows = res && Array.isArray(res.destinations) ? res.destinations : [];
    var sites = [];
    rows.forEach(function (row) {
      var site = row && typeof row.site === 'string' ? row.site : '';
      if ((site === 'twitch' || site === 'kick') && sites.indexOf(site) === -1) sites.push(site);
    });
    if (!sites.length) sites = ['twitch', 'kick'];
    var current = categorySite.value;
    clear(categorySite);
    sites.forEach(function (site) {
      var option = document.createElement('option');
      option.value = site;
      option.textContent = site;
      categorySite.appendChild(option);
    });
    categorySite.value = sites.indexOf(current) !== -1 ? current : sites[0];
  });
}

categoryInput.addEventListener('input', function () {
  if (suggestTimer) clearTimeout(suggestTimer);
  paintSuggestions([]);
  var query = categoryInput.value.trim();
  if (query.length < 2) return;
  suggestTimer = setTimeout(function () {
    window.marust.call('category.suggest', { site: categorySite.value, query: query }).then(function (res) {
      paintSuggestions(res && res.ok === true ? res.items : []);
    });
  }, 300);
});

// ---- 送る ----
var sending = false;

function fanoutResult(res, summary) {
  if (res && res.ok === false && res.error === 'no-plugin') {
    say('empty', '題名のプラグインが入っていません。「機能」で「題名・カテゴリのくわしい設定」を入れてください');
    return;
  }
  var sum = res && res.summary ? res.summary : summary;
  var shadowOnly = (sum.live || 0) === 0 && (sum.shadow || 0) > 0;
  renderResults(res, shadowOnly || (res && res.mode === 'shadow') ? 'ドライラン（記録のみ）' : '');
}

function sendNow() {
  if (sending || window.marust.can().write !== true) return;
  sending = true;
  armButton();
  var title = titleInput.value;
  var category = categoryInput.value;
  var summary = { live: 0, shadow: 0, legacy: 0 };
  window.marust.call('hub.getState', {}).then(function (state) {
    if (state && state.modeSummary) summary = state.modeSummary;
    if ((summary.live || 0) + (summary.shadow || 0) === 0) {
      say('empty', '「題名を送る」になっているサイトがありません');
      return null;
    }
    // 本番へ送る前の確認は親（本体）が出す。iframe は確認の印を付けられない
    return window.marust.relay('hub.fanout', { title: title, category: category });
  }).then(function (res) {
    if (!res) return;
    if (res.canceled === true) {
      say('empty', '送信をキャンセルしました');
      return;
    }
    if (res.summary) summary = res.summary;
    fanoutResult(res, summary);
  }).catch(function () {
    say('empty', '送信に失敗しました');
  }).then(function () {
    sending = false;
    armButton();
    refresh();
  });
}

function armButton() {
  sendButton.disabled = sending || window.marust.can().write !== true;
}

function refresh() {
  window.marust.call('hub.getState', {}).then(function (state) {
    if (!state || state.ok === false) return;
    devMode = state.devMode === true;
    if (state.engineStatus) statusEl.textContent = 'OBS: ' + (state.engineStatus.detail || '未接続');
  });
}

sendButton.addEventListener('click', sendNow);
window.marust.onPerm(armButton);
attachFavorites(titleInput, 'title');
attachFavorites(categoryInput, 'category');
armButton();
refresh();
refreshCategorySites();
// 表示中の更新は 15 秒以上あける（画面から定期的に呼ぶ API の決まり）
setInterval(refresh, 15000);
setInterval(refreshCategorySites, 30000);
