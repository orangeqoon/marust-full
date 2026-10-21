'use strict';

// タイトル変更プラグインの本体画面（全タブ共通の状態を表示・操作する）。
// 読む API（hub.getState・destination.list・category.suggest・favorites.get）は marust.call、
// お気に入りの書き込み（windowOnly）と本物への送信（hub.fanout）は親の窓の中継（marust.relay）、
// 確認は親が出す窓（marust.confirm）だけを通る。

var titleInput = document.getElementById('title');
var categoryInput = document.getElementById('category');
var sendButton = document.getElementById('send');
var statusEl = document.getElementById('obs-status');
var resultsEl = document.getElementById('results');
var suggestions = document.getElementById('category-suggestions');
var phaseBadgeEl = document.getElementById('phase-badge');
var phaseSummaryEl = document.getElementById('phase-summary');
var siteCardsEl = document.getElementById('site-cards');
var devMode = false;

var SITE_LABELS = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
  twitcasting: 'ツイキャス',
  niconico: 'ニコニコ生放送',
  fc2: 'FC2ライブ',
  soop: 'SOOP',
  kukulu: 'KukuluLive',
  picarto: 'Picarto',
  rumble: 'Rumble'
};
var SITE_ORDER = ['youtube', 'twitch', 'kick', 'twitcasting', 'niconico', 'fc2', 'soop', 'kukulu', 'picarto', 'rumble'];

var lastHubPlugins = [];
var lastTitleState = null;
var draftSyncTimer = null;

function clear(node) {
  if (!node) return;
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

// 足りない物（need）と入れ方（how）を 1 言にする。知らない言葉は何も足さない
var NEED_TEXT = {
  cookies: 'ログイン情報（Cookie）がありません',
  channel: 'チャンネルが分かりません',
  token: 'トークンがありません',
  config: '設定が足りません',
  'client-keys': 'ログインの鍵がありません',
  login: 'ログインが切れています'
};
var HOW_TEXT = {
  extension: '拡張で配信管理ページを開く',
  oauth: '結び直す',
  paste: 'このサイトのパネルに貼る',
  keys: 'ログインの準備で鍵を入れる'
};

function needDetail(need, how) {
  var n = NEED_TEXT[need];
  if (!n) return '';
  var h = HOW_TEXT[how];
  return h ? n + '（' + h + '）' : n;
}

function humanizeMessage(result, message, configured, mode, need, how) {
  if (mode === 'legacy' || message === 'legacy-mode') return { label: '送信オフ', detail: '「題名を送る」がオフです', tone: 'card-off' };
  if (result === 'ok') return { label: '反映完了', detail: '題名・カテゴリを更新しました', tone: 'card-ok' };
  if (message === 'not-configured' || message === 'not-configured-timeout' || configured === false) {
    return { label: '未設定・要ログイン', detail: needDetail(need, how) || '鍵とログインで設定が必要です', tone: 'card-warn' };
  }
  if (message === 'live-not-confirmed') return { label: '確認待ち', detail: '送信確認待ちです', tone: 'card-warn' };
  if (message === 'needs-title' || message === 'needs-title-or-category') return { label: '入力待ち', detail: '題名を入力してください', tone: 'card-warn' };
  if (result === 'error') {
    var detail = message === 'unauthorized' || message === 'login-expired'
      ? 'ログイン期限切れ（再ログインが必要）'
      : ('送信エラー' + (message ? ' (' + message + ')' : ''));
    return { label: '失敗', detail: detail, tone: 'card-error' };
  }
  return { label: '待機中', detail: '次の送信で反映されます', tone: '' };
}

function updateLiveDisplay(phaseOverride) {
  var phase = phaseOverride || (sending ? 'sending' : (lastTitleState && lastTitleState.phase ? lastTitleState.phase : 'idle'));
  var siteResultsMap = {};
  if (lastTitleState && Array.isArray(lastTitleState.siteResults)) {
    lastTitleState.siteResults.forEach(function (r) {
      if (r && r.site) siteResultsMap[r.site] = r;
    });
  }

  var pluginBySite = {};
  (Array.isArray(lastHubPlugins) ? lastHubPlugins : []).forEach(function (p) {
    if (!p || typeof p.id !== 'string') return;
    if (p.id.indexOf('site-') === 0) {
      var s = p.id.slice(5);
      if (SITE_LABELS[s]) pluginBySite[s] = p;
    } else if (SITE_LABELS[p.id] && !pluginBySite[p.id]) {
      pluginBySite[p.id] = p;
    }
  });

  var activeCount = 0;
  var okCount = 0;
  var warnCount = 0;
  var errCount = 0;

  if (siteCardsEl) {
    clear(siteCardsEl);
    SITE_ORDER.forEach(function (site) {
      var p = pluginBySite[site];
      var r = siteResultsMap[site];
      var mode = p && p.mode ? p.mode : (r && r.mode ? r.mode : 'legacy');
      var configured = p && typeof p.configured === 'boolean' ? p.configured : null;
      if (mode !== 'legacy') activeCount += 1;

      var info;
      if (phase === 'sending' && mode !== 'legacy') {
        info = { label: '送信中…', detail: 'サイトへ題名を送信しています', tone: 'card-sending' };
      } else if (r) {
        info = humanizeMessage(r.result, r.message, configured, mode, r.need, r.how);
      } else if (mode === 'legacy') {
        info = { label: 'オフ', detail: '送信対象外', tone: 'card-off' };
      } else if (configured === false) {
        info = { label: '未設定', detail: 'ログイン設定が必要です', tone: 'card-warn' };
      } else {
        info = { label: '送信対象 (ON)', detail: '準備完了', tone: '' };
      }

      if (mode !== 'legacy') {
        if (info.tone === 'card-ok') okCount += 1;
        else if (info.tone === 'card-warn') warnCount += 1;
        else if (info.tone === 'card-error') errCount += 1;
      }

      var card = el('div', 'site-card' + (info.tone ? ' ' + info.tone : ''));
      var top = el('div', 'site-card-top');
      top.appendChild(el('span', 'site-card-name', SITE_LABELS[site] || site));
      top.appendChild(el('span', 'site-card-state', info.label));
      card.appendChild(top);
      card.appendChild(el('div', 'site-card-detail', info.detail));
      siteCardsEl.appendChild(card);
    });
  }

  if (phaseBadgeEl) {
    if (phase === 'sending') {
      phaseBadgeEl.className = 'phase-badge phase-sending';
      phaseBadgeEl.textContent = '送信中…';
    } else if (errCount > 0) {
      phaseBadgeEl.className = 'phase-badge phase-error';
      phaseBadgeEl.textContent = '一部エラーあり';
    } else if (okCount > 0 && warnCount > 0) {
      phaseBadgeEl.className = 'phase-badge phase-warn';
      phaseBadgeEl.textContent = okCount + ' サイト反映済み（未設定 ' + warnCount + '）';
    } else if (okCount > 0) {
      phaseBadgeEl.className = 'phase-badge phase-done';
      phaseBadgeEl.textContent = okCount + ' サイトへ反映完了';
    } else if (warnCount > 0) {
      phaseBadgeEl.className = 'phase-badge phase-warn';
      phaseBadgeEl.textContent = '要設定 (' + warnCount + ' サイト)';
    } else {
      phaseBadgeEl.className = 'phase-badge phase-idle';
      phaseBadgeEl.textContent = activeCount > 0 ? ('待機中（対象 ' + activeCount + ' サイト）') : '待機中';
    }
  }

  if (phaseSummaryEl) {
    if (phase === 'sending') {
      phaseSummaryEl.textContent = '現在、有効な配信サイトへ題名とカテゴリを一斉送信しています…';
    } else if (lastTitleState && lastTitleState.lastTitle) {
      phaseSummaryEl.textContent = '直近の反映: 「' + lastTitleState.lastTitle + '」' + (lastTitleState.lastCategory ? ' / カテゴリ: ' + lastTitleState.lastCategory : '') + '（ホーム・タイマーと同期中）';
    } else {
      phaseSummaryEl.textContent = 'ホーム・題名パネル・タイマーのすべてがこのタイトル変更プラグインの状態を同期しています。';
    }
  }
}

function renderResults(res, note) {
  clear(resultsEl);
  if (note) resultsEl.appendChild(el('p', 'hint', note));
  var allRows = res && Array.isArray(res.results) ? res.results : [];
  var rows = allRows.filter(function (row) {
    if (!row || typeof row.id !== 'string') return false;
    if (row.message === 'no-fanout' || row.message === 'superseded-by-v2' || row.message === 'legacy-mode') return false;
    if (row.id === 'sample' || row.id === 'sample-v2') return false;
    return true;
  });
  if (!rows.length) rows = allRows;
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

function syncFromPluginState(st) {
  if (!st || typeof st !== 'object') return;
  lastTitleState = st;
  if (typeof st.title === 'string' && st.title && document.activeElement !== titleInput && !titleInput.value) {
    titleInput.value = st.title;
  }
  if (typeof st.category === 'string' && st.category && document.activeElement !== categoryInput && !categoryInput.value) {
    categoryInput.value = st.category;
  }
  updateLiveDisplay();
}

function scheduleDraftPush() {
  if (draftSyncTimer) clearTimeout(draftSyncTimer);
  draftSyncTimer = setTimeout(function () {
    window.marust.call('favorites.get', {
      title: titleInput.value,
      category: categoryInput.value,
      source: 'panel'
    }).then(function (res) {
      if (res && res.state) lastTitleState = res.state;
      updateLiveDisplay();
    });
  }, 250);
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
        scheduleDraftPush();
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
  }
  function apply(res) {
    if (res && res.ok === false && res.error === 'unknown-method') { wrap.hidden = true; return; }
    if (res && res.ok !== false) {
      wrap.hidden = false;
      items = (kind === 'title' ? res.titles : res.categories) || [];
      if (res.state) syncFromPluginState(res.state);
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
  input.addEventListener('input', function () {
    paintStar();
    scheduleDraftPush();
  });
  input.addEventListener('change', function () {
    paintStar();
    scheduleDraftPush();
  });
  document.addEventListener('click', function (ev) {
    if (!pop.hidden && !wrap.contains(ev.target)) { pop.hidden = true; open.setAttribute('aria-expanded', 'false'); }
  });
  window.marust.onPerm(function () { paintStar(); paintList(); });
  load();
  return { load: load, paintStar: paintStar };
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
  updateLiveDisplay('sending');
  var title = titleInput.value;
  var category = categoryInput.value;
  var summary = { live: 0, shadow: 0, legacy: 0 };
  window.marust.call('hub.getState', {}).then(function (state) {
    if (state && Array.isArray(state.plugins)) lastHubPlugins = state.plugins;
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
  sendButton.textContent = sending ? '送信中…' : '全部のサイトに反映';
}

function refresh() {
  window.marust.call('hub.getState', {}).then(function (state) {
    if (!state || state.ok === false) return;
    devMode = state.devMode === true;
    if (Array.isArray(state.plugins)) lastHubPlugins = state.plugins;
    if (state.engineStatus) statusEl.textContent = 'OBS: ' + (state.engineStatus.detail || '未接続');
    updateLiveDisplay();
  });
  window.marust.call('favorites.get', {}).then(function (res) {
    if (res && res.state) syncFromPluginState(res.state);
  });
}

if (typeof window.marust.onEvent === 'function') {
  window.marust.onEvent('stream.metadata.changed', function (payload) {
    if (payload && typeof payload.title === 'string' && document.activeElement !== titleInput) {
      titleInput.value = payload.title;
      if (favTitle && favTitle.paintStar) favTitle.paintStar();
    }
    if (payload && typeof payload.category === 'string' && document.activeElement !== categoryInput) {
      categoryInput.value = payload.category;
      if (favCategory && favCategory.paintStar) favCategory.paintStar();
    }
    window.marust.call('favorites.get', {}).then(function (res) {
      if (res && res.state) syncFromPluginState(res.state);
    });
  });
}

sendButton.addEventListener('click', sendNow);
window.marust.onPerm(armButton);
var favTitle = attachFavorites(titleInput, 'title');
var favCategory = attachFavorites(categoryInput, 'category');
armButton();
refresh();
refreshCategorySites();
// 表示中の更新は 15 秒以上あける（画面から定期的に呼ぶ API の決まり）
setInterval(refresh, 15000);
setInterval(refreshCategorySites, 30000);
