'use strict';

/**
 * ホーム画面（R8）。ドックの中のパネル 1 枚（id `home`）。部品は今あるパネルと同じ API を使い、ここは並べ方だけを持つ。
 * hub.js より前に読み込む（hub.js の mk・call・can・openPanel などは、呼ばれたときに使う）。
 * 言葉は ui/strings.js。モードの語（shadow / live / legacy）は出さない。秘密は扱わない（キーの入力欄は送ったらすぐ空にする）。
 * サイトの行と OBS の配信先の行は 1 つにまとめてある。配信先ごとの細かい操作（キー差し替え・削除・リンク解除）は行の「詳細」。
 * 更新: 表示中だけ・15 秒以上（PLAN §4）。すぐ変わる所は購読したイベントのあと 1 回だけ読み直す。
 */

var HOME_FAST_MS = 15000;
// プラグインの穴を置き直す（dock が一覧を取り直したあとに呼ぶ。initHome の中で入れる）
var syncHomeSlots = null;
var HOME_SLOW_MS = 15000;
// 中級機能の紹介（R24）の文・開く画面・オンにする機能は、機能（features.list）が manifest の feature.tip／tipAliases／openPanel で名乗る（計画 X・P1）
function homeTipFeature(rows, id) {
  var list = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && (list[i].id === id || (Array.isArray(list[i].tipAliases) && list[i].tipAliases.indexOf(id) !== -1))) return list[i];
  }
  return null;
}
var HOME_EVENTS = ['stream.stopped', 'modes.changed', 'slot.acquired', 'site.trouble', 'engine.target.changed', 'broadcast.result', 'broadcast.stopped', 'signal.stateChanged', 'auth.updated'];

function homeSiteName(row, id) {
  if (row && row.site && row.site.name) return row.site.name;
  return siteLabel(id);
}

// 並べ替え・集計は DOM を使わない関数にして、テストできるようにしてある。
function homeSiteRows(modeRows, targets) {
  var list = Array.isArray(modeRows) ? modeRows : [];
  var tg = Array.isArray(targets) ? targets : [];
  var out = [];
  list.forEach(function (row) {
    var m = /^site-(.+)$/.exec(String(row && row.id || ''));
    if (!m || !row.site || row.audience !== 'public' || row.visible === false) return;
    var site = m[1];
    var mine = tg.filter(function (t) { return t && t.site === site && !(t.main === true || t.id === 'main'); }); // メイン出力はサイトの行に混ぜない
    var live = mine.some(function (t) { return t.state === 'live'; });
    var starting = mine.some(function (t) { return t.state === 'connecting' || t.state === 'reconnecting' || t.state === 'starting'; });
    var slotRow = list.filter(function (r) { return r && r.id === 'slot-' + site && r.visible !== false; })[0];
    out.push({
      site: site,
      pluginId: row.id,
      name: homeSiteName(row, site),
      tier: row.site.tier === 'core' ? 'core' : 'extra',
      experimental: row.stability === 'experimental',
      send: row.send === true,
      targets: mine,
      destState: !mine.length ? 'none' : (live ? 'live' : (starting ? 'connecting' : 'stopped')),
      destEnabled: mine.length > 0 && mine.every(function (t) { return t.enabled === true; }),
      autoSlot: !slotRow ? 'none' : (slotRow.mode === 'live' ? 'on' : 'off')
    });
  });
  var order = (typeof SITE_ORDER !== 'undefined') ? SITE_ORDER : [];
  out.sort(function (a, b) {
    var ia = order.indexOf(a.site); var ib = order.indexOf(b.site);
    return (a.tier === 'core' ? 0 : 1) - (b.tier === 'core' ? 0 : 1) || (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return out;
}

/**
 * メイン出力の行き先ラベル（DOM を使わない純粋関数。L7e）。
 * site が空なら「メイン出力（行き先は未選択）」、other なら「メイン出力 → そのほか」、特定サイトなら「メイン出力 → <表示名>」。
 */
function homeMainOutputLabel(site, siteNames) {
  var map = {};
  if (Array.isArray(siteNames)) {
    siteNames.forEach(function (r) { if (r && r.site) map[r.site] = r.name || r.site; });
  } else if (siteNames && typeof siteNames === 'object') {
    map = siteNames;
  }
  if (typeof STR !== 'undefined' && typeof STR.mainOutputLabel === 'function') {
    return STR.mainOutputLabel(site, map);
  }
  var s = site != null ? String(site).trim() : '';
  if (!s) return 'メイン出力（行き先は未選択）';
  if (s === 'other') return 'メイン出力 → そのほか';
  var name = map[s] || (typeof siteLabel === 'function' ? siteLabel(s) : s);
  return 'メイン出力 → ' + name;
}

/**
 * 題名反映の結果を一文で表す純粋関数（DOM を使わない。L7e）。
 * 全体通った・一部失敗・全部skip・失敗なしの各状況を判定する。
 */
function homeApplyResultSentence(res, siteNames) {
  if (!res) return { text: (typeof STR !== 'undefined' ? STR.homeApplyFailed : '反映できませんでした'), kind: 'ng' };
  if (res.ok === false && res.error === 'no-plugin') return { text: (typeof STR !== 'undefined' ? STR.noTitlePlugin : '題名を送るプラグインがありません'), kind: 'warn' };
  var rows = Array.isArray(res.results) ? res.results : [];
  if (!rows.length) return { text: (typeof STR !== 'undefined' ? STR.homeApplyNone : '「題名を送る」になっているサイトがありません。'), kind: 'warn' };
  if (rows.every(function (r) { return r.result === 'skip'; })) {
    var skipMsg = typeof STR !== 'undefined' && STR.homeApplyAllSkipped ? STR.homeApplyAllSkipped : (typeof STR !== 'undefined' ? STR.homeApplySkipped : '送っていません。');
    return { text: skipMsg, kind: 'warn' };
  }
  var nameMap = {};
  if (Array.isArray(siteNames)) {
    siteNames.forEach(function (r) { if (r && r.site) nameMap[r.site] = r.name || r.site; });
  } else if (siteNames && typeof siteNames === 'object') {
    nameMap = siteNames;
  }
  var okRows = rows.filter(function (r) { return r.result === 'ok' || r.result === 'success'; });
  var badRows = rows.filter(function (r) { return !(r.result === 'ok' || r.result === 'success' || r.result === 'skip'); });
  if (badRows.length > 0) {
    var badNames = badRows.map(function (r) {
      var rawId = String(r.id || '').replace(/^site-/, '');
      return nameMap[rawId] || (typeof siteLabel === 'function' ? siteLabel(rawId) : rawId);
    }).join('、');
    if (okRows.length > 0) {
      var partialMsg = typeof STR !== 'undefined' && typeof STR.homeApplyPartial === 'function'
        ? STR.homeApplyPartial(okRows.length, badNames)
        : '題名を ' + okRows.length + ' サイトに反映しました。' + badNames + ' は反映できませんでした';
      return { text: partialMsg, kind: 'partial' };
    }
    var failMsg = typeof STR !== 'undefined' && typeof STR.homeApplyAllFailed === 'function'
      ? STR.homeApplyAllFailed(badNames)
      : '題名を反映できませんでした（' + badNames + '）。';
    return { text: failMsg, kind: 'ng' };
  }
  var okMsg = typeof STR !== 'undefined' && typeof STR.homeApplyAllOk === 'function'
    ? STR.homeApplyAllOk(okRows.length)
    : '題名を ' + okRows.length + ' サイトに反映しました';
  return { text: okMsg, kind: 'ok' };
}

/**
 * メイン出力の行の見え方（DOM を使わない）。destRow は destination.list の obs-main の行（無ければ null）、mainTarget は engine.listTargets の main（OBS 未接続なら無い）。
 * 送信中（live・connecting・reconnecting）は locked: true（チェックと選びを触れなくする）。
 */
var HOME_MAIN_SENDING = ['live', 'connecting', 'reconnecting'];
function homeMainOutputView(destRow, mainTarget, siteNames) {
  var connected = !!mainTarget;
  var st = connected ? String(mainTarget.state || 'stopped') : '';
  var text;
  if (!connected) text = STR.mainOutputObsOff;
  else if (st === 'live' && destRow && destRow.siteLive === true) text = STR.stateLiveWithSite();
  else text = STR.state(st);
  var site = destRow && destRow.site != null ? String(destRow.site) : '';
  return {
    use: !!destRow && destRow.enabled === true,
    site: site,
    label: homeMainOutputLabel(site, siteNames),
    connected: connected,
    state: st,
    stateText: text,
    locked: connected && HOME_MAIN_SENDING.indexOf(st) !== -1
  };
}

/**
 * OBS が止まったかの判定（直す所 17）。DOM を使わない。
 * prev・next は { liveCount, obs }（前に読んだ値と今読んだ値）。lastStopAt は こちらから止めた／broadcast.stopped を受けた時刻（ms。無ければ 0）。
 *  - 送信中が 1 つ以上 → 0 になり、15 秒以内にこちらから止めた記録が無い → true
 *  - 送信中が 1 つ以上あって、OBS が未接続になった → true
 */
var HOME_STOP_GRACE_MS = 15000;
function obsStoppedNotice(prev, next, lastStopAt, now) {
  var p = prev || {};
  var n = next || {};
  if (!(typeof p.liveCount === 'number' && p.liveCount > 0)) return false;
  if (p.obs === true && n.obs === false) return true;
  if (typeof n.liveCount === 'number' && n.liveCount === 0) {
    var at = Number(lastStopAt) || 0;
    return !(at > 0 && Number(now) - at <= HOME_STOP_GRACE_MS);
  }
  return false;
}

function ensureHomePanel() {
  var existing = panelRoot('home');
  if (existing) return existing;
  var host = document.getElementById('panel-source');
  if (!host) return null;
  var section = mk('section', 'card home', null, { 'data-panel': 'home' });
  section.appendChild(mk('div', 'home-alert', null, { id: 'home-alert', role: 'alert', hidden: '' }));
  section.appendChild(mk('div', 'home-alert', null, { id: 'home-timer-ack', role: 'alert', hidden: '' }));
  section.appendChild(mk('div', 'home-tip', null, { id: 'home-tip', role: 'region', 'aria-label': STR.tipTitle, hidden: '' }));
  section.appendChild(mk('h2', '', STR.homeTitle));
  // 全部止めるボタン（ホームのいちばん上に独立した行）
  var stopAllRow = mk('div', 'stop-all-row');
  stopAllRow.appendChild(mk('button', 'timer-btn stop-all', STR.homeStopAll, { id: 'home-stop-all', type: 'button', 'data-need': 'emergency' }));
  section.appendChild(stopAllRow);
  // プラグインの穴 home.top（V7。使うプラグインが無ければ空）
  section.appendChild(mk('div', 'plugin-slot', null, { id: 'home-slot-top', 'data-plugin-slot': 'home.top' }));
  var obsLine = mk('p', 'engine-line home-obs', null, { id: 'home-obs-line' });
  obsLine.appendChild(mk('span', '', STR.homeObsNg, { id: 'home-obs' }));
  obsLine.appendChild(document.createTextNode(' '));
  obsLine.appendChild(mk('button', 'timer-btn', STR.homeObsConnect, { id: 'home-obs-btn', type: 'button' }));
  section.appendChild(obsLine);

  var setup = mk('div', 'timer-setup');
  var l1 = mk('label', '', STR.homeTitleLabel + ' ');
  l1.appendChild(mk('input', '', null, { id: 'home-title', type: 'text', maxlength: '200', autocomplete: 'off' }));
  var l2 = mk('label', '', STR.homeCategoryLabel + ' ');
  l2.appendChild(mk('input', '', null, { id: 'home-category', type: 'text', maxlength: '100', autocomplete: 'off' }));
  setup.appendChild(l1);
  setup.appendChild(l2);
  setup.appendChild(mk('button', 'timer-btn primary', STR.homeApplyAll, { id: 'home-apply', type: 'button', 'data-need': 'write' }));
  section.appendChild(setup);
  section.appendChild(mk('p', 'timer-hint', '', { id: 'home-apply-status', 'aria-live': 'polite' }));

  // 配信ボタン: 全配信開始・全配信停止と、サイトごとのボタン（止まっている＝薄い赤、配信中＝明るい緑）
  var actions = mk('div', 'timer-actions broadcast-main');
  actions.appendChild(mk('button', 'timer-btn primary', STR.homeStart, { id: 'home-start', type: 'button', 'data-need': 'write' }));
  section.appendChild(actions);
  section.appendChild(mk('div', 'site-buttons', null, { id: 'home-site-buttons' }));
  section.appendChild(mk('p', 'timer-hint', '', { id: 'home-broadcast-status', 'aria-live': 'polite' }));
  section.appendChild(mk('div', 'broadcast-failed', null, { id: 'home-broadcast-failed', hidden: '' }));
  var ctl = mk('label', 'timer-hint', null, { id: 'home-obs-control-label' });
  ctl.appendChild(mk('input', '', null, { id: 'home-obs-control', type: 'checkbox', 'data-need': 'write' }));
  ctl.appendChild(document.createTextNode(' ' + STR.obsControlLabel));
  section.appendChild(ctl);

  var head = mk('div', 'home-head');
  head.appendChild(mk('h3', '', STR.homeSiteHead));
  head.appendChild(mk('button', 'timer-btn', STR.homeSiteAdd, { id: 'home-site-add', type: 'button' }));
  section.appendChild(head);
  section.appendChild(mk('div', '', null, { id: 'home-sites' }));

  section.appendChild(mk('p', 'timer-hint home-line', null, { id: 'home-line', 'aria-live': 'polite' }));

  var notes = mk('details', 'adv');
  notes.appendChild(mk('summary', '', STR.uiHome1));
  [STR.switchTitleHint, STR.switchDestHint, STR.switchObsHint, STR.commentHint].forEach(function (t) {
    notes.appendChild(mk('p', 'timer-hint', t));
  });
  section.appendChild(notes);
  // 中級・上級: 機能の一覧（チェックで入れる／外す）は「機能を足す」パネルへ
  var features = mk('div', 'timer-actions home-features-row', null, { id: 'home-features' });
  features.appendChild(mk('button', 'timer-btn', STR.featuresHomeButton, { id: 'home-features-open', type: 'button' }));
  section.appendChild(features);
  // 初級: サイトのボタンを押すと開く、そのサイトの設定
  var modal = mk('div', 'home-modal', null, { id: 'home-modal', role: 'dialog', 'aria-modal': 'true', hidden: '' });
  var card = mk('div', 'home-modal-card');
  card.appendChild(mk('h3', '', '', { id: 'home-modal-title' }));
  card.appendChild(mk('div', '', null, { id: 'home-modal-body' }));
  card.appendChild(mk('div', 'timer-actions', null, { id: 'home-modal-foot' }));
  modal.appendChild(card);
  section.appendChild(modal);
  host.appendChild(section);
  return section;
}

function initHome() {
  var root = ensureHomePanel();
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  function el(id) { return root.querySelector('#' + id); }
  var state = { allTargets: [], isWindow: false, sites: [], groups: [], login: null, slots: {}, alert: null, tips: { pending: '', features: [] }, uplink: null, uplinkOff: false, watch: null, liveCount: null, controlOn: false, obs: null, ids: [], stats: {}, destRows: [], mainMsg: '', siteLive: {}, obsStopped: false, lastStopAt: 0, prevLive: null };
  var busyFast = false;
  var busySlow = false;
  var busyStats = false;
  attachFavorites(el('home-title'), 'title');
  attachFavorites(el('home-category'), 'category');
  var timerEvent = null;
  var openDetails = {};   // 詳細を開いているサイト（描き直しても開いたままにする）
  var keyBoxOpen = {};    // キー差し替えの入力欄を開いているターゲット
  var lastSig = '';
  var burst = [];

  function visible() { return !!root.offsetParent; }
  function say(id, text) { var n = el(id); if (n) n.textContent = text || ''; }

  // ----- 描く -----
  // タイマーの自動送信が、予約に無い送り先が増えたせいで止まっているときの知らせ（K3）。もう一度確認すると、核が予約を今の送り先で書き直す
  function paintTimerAck() {
    var box = el('home-timer-ack');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var ids = Array.isArray(state.timerAck) ? state.timerAck : null;
    if (!ids) { box.hidden = true; return; }
    box.hidden = false;
    var names = ids.map(function (id) { return siteLabel(String(id).replace(/^site-/, '')); });
    box.appendChild(mk('span', '', STR.homeTimerAck(names.join('、'))));
    var b = mk('button', 'timer-btn', STR.homeTimerAckButton, { type: 'button', id: 'home-timer-ack-button' });
    if (!state.isWindow || !can.write) b.disabled = true;
    b.addEventListener('click', function () {
      confirmFanoutOnce(names.join('、'), ids, true).then(function (ok) {
        if (ok) { state.timerAck = null; paintTimerAck(); }
      }).catch(function () {});
    });
    box.appendChild(document.createTextNode(' '));
    box.appendChild(b);
  }
  function paintAlert() {
    paintTimerAck();
    var box = el('home-alert');
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!state.alert && !state.obsStopped) { box.hidden = true; return; }
    box.hidden = false;
    if (state.obsStopped) {
      // OBS が止まったときの知らせ。自動でやり直さない。次の配信開始か閉じるボタンで消える。
      box.appendChild(mk('span', '', STR.obsStoppedNotice));
      var ob = mk('button', 'timer-btn', STR.homeAlertDismiss, { type: 'button', id: 'home-obs-stopped-dismiss' });
      ob.addEventListener('click', function () { state.obsStopped = false; paintAlert(); });
      box.appendChild(document.createTextNode(' '));
      box.appendChild(ob);
    }
    if (!state.alert) return;
    if (state.obsStopped) box.appendChild(document.createElement('br'));
    box.appendChild(mk('span', '', STR.homeAlert(siteLabel(state.alert.site), state.alert)));
    var b = mk('button', 'timer-btn', STR.homeAlertDismiss, { type: 'button', id: 'home-alert-dismiss' });
    if (!state.isWindow || !can.write) b.disabled = true;
    b.addEventListener('click', function () {
      call('home.dismissAlert', {}).then(function () { state.alert = null; paintAlert(); }).catch(function () {});
    });
    box.appendChild(document.createTextNode(' '));
    box.appendChild(b);
    paintRelinkButton(box);
  }
  // ログイン切れの知らせには、その場で結び直すボタンを付ける。押されたときだけブラウザを開く（勝手には開かない）。
  var relinking = false;
  function paintRelinkButton(box) {
    var alert = state.alert;
    if (!alert || alert.kind !== 'login-expired') return;
    var row = loginOf(alert.site);
    if (!row || row.type !== 'oauth') return;
    var name = siteLabel(alert.site);
    var rb = mk('button', 'timer-btn', STR.homeRelink(name), { type: 'button', id: 'home-alert-relink' });
    if (!state.isWindow || !can.write) rb.disabled = true;
    rb.addEventListener('click', function () {
      if (relinking) { window.alert(STR.sitesRelinkBusy); return; }
      if (!window.confirm(STR.sitesRelinkConfirm(name))) return;
      relinking = true;
      call('auth.reauth', { site: alert.site }).then(function (res) {
        relinking = false;
        window.alert(res && res.ok === true ? STR.sitesRelinkDone : STR.loginErr(res && res.error));
      }).catch(function () { relinking = false; window.alert(STR.loginErr('failed')); });
    });
    box.appendChild(document.createTextNode(' '));
    box.appendChild(rb);
  }
  function paintObs() {
    var ok = state.obs === true;
    var live = typeof state.liveCount === 'number' && ok ? ' / ' + STR.liveCount(state.liveCount) : '';
    say('home-obs', ok ? STR.homeObsOk + ' ●' + live : STR.homeObsNg);
    el('home-obs').className = ok ? 'broadcast-ok' : 'broadcast-ng';
    el('home-obs-line').classList.toggle('is-connected', ok); // 初級: つながっているときは隠す
  }
  function loginOf(site) {
    var hit = null;
    (state.login || []).forEach(function (r) { if (r.id === site) hit = r; });
    return hit;
  }
  // サイトの枠（計画 X・S5b）: そのサイトに効く機能（manifest の for）と、セットの一覧と入／切。置き場ではなく名乗りで集めて見せる。
  function frameFeatureLine(f) {
    var line = mk('div', 'feature-row', null, { 'data-frame-feature': f.id });
    var label = mk('label', 'site-send');
    var cb = mk('input', '', null, { type: 'checkbox', 'data-frame-toggle': f.id, 'aria-label': f.label });
    cb.checked = f.on === true;
    if (!can.write || !state.isWindow) cb.disabled = true;
    cb.addEventListener('change', function () {
      call('features.set', { id: f.id, enabled: cb.checked }).then(function (r) {
        if (!r || r.ok !== true) { cb.checked = !cb.checked; window.alert(r && r.error === 'streaming' ? STR.featuresStreaming : STR.featuresFailed); return; }
        refreshPluginCatalog().then(function () { loadFrame(); });
      }).catch(function () { cb.checked = !cb.checked; });
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + f.label));
    line.appendChild(label);
    if (f.hint) line.appendChild(mk('span', 'timer-hint feature-hint', f.hint));
    (f.needs || []).forEach(function (n) {
      if (n.ok !== false || (!f.on && n.kind !== 'site')) return;
      var t = n.kind === 'login' ? STR.featuresNeedLogin(siteLabel(n.target)) : (n.kind === 'obs' ? STR.featuresNeedObs : (n.kind === 'site' ? STR.featuresNeedSite(siteLabel(n.target)) : ''));
      if (t) line.appendChild(mk('span', 'timer-hint feature-need', t));
    });
    return line;
  }
  function frameSetLine(set) {
    var line = mk('div', 'feature-row', null, { 'data-frame-set': set.id });
    var label = mk('label', 'site-send');
    var cb = mk('input', '', null, { type: 'checkbox', 'data-frame-set-toggle': set.id, 'aria-label': set.label });
    cb.checked = set.on === true;
    if (!can.write || !state.isWindow) cb.disabled = true;
    cb.addEventListener('change', function () {
      call('features.setSet', { id: set.id, enabled: cb.checked }).then(function (r) {
        if (!r || r.ok !== true) { cb.checked = !cb.checked; window.alert(r && r.error === 'streaming' ? STR.featuresStreaming : STR.featuresFailed); return; }
        refreshPluginCatalog().then(function () { loadFrame(); });
      }).catch(function () { cb.checked = !cb.checked; });
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + set.label));
    line.appendChild(label);
    if (set.missing && set.missing.length) line.appendChild(mk('span', 'timer-hint feature-need', STR.setMissing(set.missing)));
    return line;
  }
  function siteFrameBlock(siteId) {
    var wrap = mk('div', 'home-frame', null, { 'data-site-frame': siteId });
    if (!levelAtLeast('standard') || !Array.isArray(state.featureRows)) return wrap; // 初級では機能のプラグインを読み込まない（V5）
    var mine = state.featureRows.filter(function (f) { return Array.isArray(f.for) && f.for.indexOf(siteId) !== -1; });
    var all = state.featureRows.filter(function (f) { return Array.isArray(f.for) && f.for.indexOf('*') !== -1 && f.for.indexOf(siteId) === -1; });
    var sets = (state.setRows || []).filter(function (s) { return Array.isArray(s.for) && s.for.indexOf(siteId) !== -1; });
    wrap.appendChild(mk('h4', '', STR.siteFrameTitle));
    if (!mine.length && !sets.length) wrap.appendChild(mk('p', 'timer-hint', STR.siteFrameEmpty));
    sets.forEach(function (s) { wrap.appendChild(frameSetLine(s)); });
    mine.forEach(function (f) { wrap.appendChild(frameFeatureLine(f)); });
    if (all.length) {
      wrap.appendChild(mk('h4', '', STR.siteFrameAll));
      all.forEach(function (f) { wrap.appendChild(frameFeatureLine(f)); });
    }
    return wrap;
  }
  function loadFrame() {
    if (!levelAtLeast('standard')) return Promise.resolve();
    return Promise.all([
      call('features.list', {}).then(function (r) { state.featureRows = r && r.ok === true && Array.isArray(r.features) ? r.features : null; }).catch(function () { state.featureRows = null; }),
      call('features.sets', {}).then(function (r) { state.setRows = r && r.ok === true && Array.isArray(r.sets) ? r.sets : []; }).catch(function () { state.setRows = []; })
    ]).then(function () { lastSig = ''; paintSites(); if (modalKey) paintModal(); });
  }
  function detailBlock(row, basic) {
    var wrap = mk('div', 'home-detail');
    if (!row.targets.length) wrap.appendChild(mk('p', 'timer-hint', STR.homeNoDest));
    row.targets.forEach(function (t) {
      if (t.main === true || t.id === 'main') {
        var drow = mainDestRow();
        var msite = drow && drow.site ? drow.site : (t.site || '');
        var mlabel = homeMainOutputLabel(msite, state.sites);
        wrap.appendChild(mk('p', 'timer-hint', mlabel + '（' + STR.state(t.state) + '）'));
        return;
      } // メイン出力はキーの欄・削除・リンク解除を出さない
      var line = mk('div', 'home-target');
      var sync = (t.syncStart || t.syncStop) ? STR.homeSyncOn : STR.homeSyncOff;
      line.appendChild(mk('p', 'timer-hint', t.name + '（' + STR.state(t.state) + (t.enabled ? '' : STR.stateDisabledSuffix) + '）' + (t.lastError ? ' / ' + t.lastError : '')));
      if (!basic) line.appendChild(mk('p', 'timer-hint', STR.homeSyncLabel + ': ' + sync));
      var acts = mk('div', 'timer-actions');
      var tid = String(t.id);
      var dis = !can.write || !state.isWindow;
      [['key-toggle', STR.homeKeyReplace], ['remove', STR.homeRemove], ['unlink', STR.homeUnlink]].forEach(function (pair) {
        if (pair[0] === 'unlink' && !t.destinationId) return;
        var b = mk('button', 'timer-btn', pair[1], { type: 'button', 'data-act': pair[0], 'data-target-id': tid, 'data-dest-id': t.destinationId || '' });
        if (dis) b.disabled = true;
        acts.appendChild(b);
      });
      line.appendChild(acts);
      var kb = mk('div', 'timer-setup home-keybox', null, { 'data-keybox': tid });
      kb.hidden = !keyBoxOpen[tid];
      var isLive = ['live', 'connecting', 'reconnecting'].indexOf(t.state) !== -1;
      var input = mk('input', '', null, { type: 'password', maxlength: '300', autocomplete: 'off', 'data-key-input': tid, 'aria-label': t.name + ': ' + STR.homeKeyReplace });
      input.placeholder = STR.secretPlaceholder(t.keyTail);
      if (isLive) input.disabled = true;
      kb.appendChild(input);
      kb.appendChild(mk('span', 'timer-hint key-tail-hint', STR.secretPlaceholder(t.keyTail)));
      var saveBtn = mk('button', 'timer-btn', STR.homeKeySave, { type: 'button', 'data-act': 'key-save', 'data-target-id': tid });
      if (isLive) saveBtn.disabled = true;
      kb.appendChild(saveBtn);
      if (isLive) {
        kb.appendChild(mk('p', 'timer-hint key-live-note', STR.homeKeyLocked));
      }
      line.appendChild(kb);
      wrap.appendChild(line);
    });
    if (!basic && row.autoSlot !== 'none') {
      var l = mk('label', 'site-send home-autoslot');
      var cb = mk('input', '', null, { type: 'checkbox', 'data-home-autoslot': row.site, 'aria-label': row.name + ': ' + STR.autoSlotLabel });
      cb.checked = row.autoSlot === 'on';
      if (!can.write || !state.isWindow) cb.disabled = true;
      l.appendChild(cb);
      l.appendChild(document.createTextNode(' ' + STR.autoSlotLabel));
      wrap.appendChild(l);
      var slotOpen = mk('button', 'timer-btn', STR.autoSlotSettings, { type: 'button', 'data-home-slot-settings': row.site });
      slotOpen.addEventListener('click', function () { openPanel('plugin:slot-' + row.site + ':status'); });
      wrap.appendChild(slotOpen);
    }
    wrap.appendChild(siteFrameBlock(row.site));
    return wrap;
  }
  function mainDestRow() { return state.destRows.filter(function (d) { return d && d.id === 'obs-main'; })[0] || null; }
  function mainTargetRow() { return state.allTargets.filter(function (t) { return t && (t.main === true || t.id === 'main'); })[0] || null; }
  // メイン出力（OBS の配信設定）の行。使う／サイト／状態／説明。サーバーとキーは OBS で変える（ここでは書き換えない）。
  function mainOutputBlock(view) {
    var wrap = mk('div', 'home-main-output', null, { 'data-main-output': '1' });
    wrap.appendChild(mk('strong', '', view.label || STR.mainOutputName));
    wrap.appendChild(document.createTextNode(' '));
    var stText = view.stateText ? '（' + view.stateText + '）' : '';
    wrap.appendChild(mk('span', view.state === 'live' ? 'state-live' : (view.connected ? 'state-stopped' : 'site-note'), stText, { 'data-main-state': '1' }));
    var line = mk('div', 'timer-actions');
    var useLabel = mk('label', 'site-send');
    var useCb = mk('input', '', null, { type: 'checkbox', 'data-main-use': '1', 'aria-label': STR.mainOutputName + ': ' + STR.mainOutputUse });
    useCb.checked = view.use;
    if (!can.write || !state.isWindow || view.locked) useCb.disabled = true;
    useLabel.appendChild(useCb);
    useLabel.appendChild(document.createTextNode(' ' + STR.mainOutputUse));
    line.appendChild(useLabel);
    var siteLabelEl = mk('label', 'site-send', STR.mainOutputSite + ' ');
    var sel = mk('select', '', null, { 'data-main-site': '1', 'aria-label': STR.mainOutputName + ': ' + STR.mainOutputSite });
    var opts = [['', STR.mainOutputSiteNone]];
    state.sites.forEach(function (r) { opts.push([r.site, r.name]); });
    opts.push(['other', STR.mainOutputSiteOther]);
    if (view.site && !opts.some(function (o) { return o[0] === view.site; })) opts.splice(opts.length - 1, 0, [view.site, siteLabel(view.site)]);
    opts.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      sel.appendChild(opt);
    });
    sel.value = view.site;
    if (!can.write || !state.isWindow || view.locked) sel.disabled = true;
    siteLabelEl.appendChild(sel);
    line.appendChild(siteLabelEl);
    wrap.appendChild(line);
    wrap.appendChild(mk('p', 'timer-hint', STR.mainOutputNote));
    if (view.locked) wrap.appendChild(mk('p', 'timer-hint key-live-note', STR.mainOutputLocked));
    if (state.mainMsg) wrap.appendChild(mk('p', 'timer-hint', state.mainMsg, { role: 'status' }));
    return wrap;
  }
  function paintSites() {
    var mainView = homeMainOutputView(mainDestRow(), mainTargetRow(), state.sites);
    var sig = JSON.stringify([state.sites, state.siteLive, state.login, state.slots, state.isWindow, can.write, uiLevel, state.featureRows, state.setRows, mainView, state.mainMsg]);
    if (sig === lastSig) return; // 変わっていなければ描き直さない
    lastSig = sig;
    var box = el('home-sites');
    var open = box.querySelectorAll('details[data-home-detail]');
    for (var i = 0; i < open.length; i += 1) openDetails[open[i].getAttribute('data-home-detail')] = open[i].open === true;
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(mainOutputBlock(mainView));
    if (!state.sites.length) { box.appendChild(mk('p', 'empty', STR.homeNoSites)); }

    // Standard / Advanced UI
    var table = mk('table', 'dest-table home-sites');
    state.sites.forEach(function (row) {
      var tr = document.createElement('tr');
      var name = mk('td', 'dest-name', row.name);
      if (row.experimental) name.appendChild(mk('span', 'site-note', ' ' + STR.experimentalBadge));
      var slot = state.slots[row.site];
      if (slot) {
        name.appendChild(document.createElement('br'));
        name.appendChild(mk('span', 'site-note', STR.homeSlotReady(slot.reason, STR.homeClock(slot.at))));
      }
      tr.appendChild(name);
      var st = document.createElement('td');
      st.className = row.destState === 'live' ? 'state-live' : (row.destState === 'connecting' ? 'state-connecting' : 'state-stopped');
      var rowSiteLive = row.destState === 'live' && row.targets.some(function (t) { return t.state === 'live' && t.destinationId && state.siteLive[t.destinationId] === true; });
      st.textContent = row.destState === 'none' ? STR.homeNoDest : (rowSiteLive ? STR.stateLiveWithSite() : STR.state(row.destState));
      tr.appendChild(st);
      var use = document.createElement('td');
      var useLabel = mk('label', 'site-send');
      var useCb = mk('input', '', null, { type: 'checkbox', 'data-home-dest': row.site, 'aria-label': row.name + ': ' + STR.homeUseDest });
      useCb.checked = row.destEnabled;
      if (!can.write || !state.isWindow || !row.targets.length) useCb.disabled = true;
      useLabel.appendChild(useCb);
      useLabel.appendChild(document.createTextNode(' ' + STR.homeUseDest));
      useLabel.title = STR.switchDestHint;
      use.appendChild(useLabel);
      tr.appendChild(use);
      var send = document.createElement('td');
      var sendLabel = mk('label', 'site-send');
      var sendCb = mk('input', '', null, { type: 'checkbox', 'data-home-send': row.pluginId, 'aria-label': row.name + ': ' + STR.sendColumn });
      sendCb.checked = row.send;
      if (!can.write || !state.isWindow) sendCb.disabled = true;
      sendLabel.appendChild(sendCb);
      sendLabel.appendChild(document.createTextNode(' ' + (row.send ? STR.sendOn : STR.sendOff)));
      sendLabel.title = STR.switchTitleHint;
      send.appendChild(sendLabel);
      var login = loginOf(row.site);
      if (login) {
        send.appendChild(document.createElement('br'));
        send.appendChild(mk('span', 'site-note', STR.homeLoginFor(login.state)));
        if (login.state === 'none' || login.state === 'expired') {
          send.appendChild(document.createTextNode(' '));
          send.appendChild(mk('button', 'timer-btn', STR.homeLoginGo, { type: 'button', 'data-home-login': row.site }));
        }
      }
      tr.appendChild(send);
      table.appendChild(tr);
      var more = document.createElement('tr');
      var cell = mk('td', 'home-more');
      cell.setAttribute('colspan', '4');
      var d = mk('details', 'adv', null, { 'data-home-detail': row.site });
      if (openDetails[row.site]) d.open = true;
      d.appendChild(mk('summary', '', STR.homeDetail));
      d.appendChild(detailBlock(row));
      cell.appendChild(d);
      // プラグインの穴 home.siteCard.footer（V7。サイトごと。使うプラグインが無ければ空）
      cell.appendChild(mk('div', 'plugin-slot', null, { 'data-plugin-slot': 'home.siteCard.footer', 'data-home-site': row.site }));
      more.appendChild(cell);
      table.appendChild(more);
    });
    box.appendChild(table);
    mountHomeSlots(false);
  }
  // プラグインの穴（ui.slots）に iframe を置く。home.top は 1 つだけ作って置いたままにし、サイトごとの穴は描き直すたびに置き直す。
  var homeTopMount = null;
  var homeFooterMounts = [];
  syncHomeSlots = function () { mountHomeSlots(true); };
  function mountHomeSlots(withTop) {
    homeFooterMounts.forEach(function (m) { try { m.dispose(); } catch (_) { /* 外したあと */ } });
    homeFooterMounts = [];
    var ready = typeof pluginHost !== 'undefined' && pluginHost && typeof pluginHost.hasSlot === 'function';
    var top = document.getElementById('home-slot-top');
    if (top && withTop !== false) {
      var want = ready && pluginHost.hasSlot('home.top');
      if (homeTopMount && (!want || !top.firstChild)) { try { homeTopMount.dispose(); } catch (_) { /* 外したあと */ } homeTopMount = null; }
      if (want && !homeTopMount) homeTopMount = pluginHost.mountSlot('home.top', top);
    }
    if (!ready || !pluginHost.hasSlot('home.siteCard.footer')) return;
    var holes = document.querySelectorAll('[data-plugin-slot="home.siteCard.footer"]');
    for (var i = 0; i < holes.length; i += 1) {
      var m = pluginHost.mountSlot('home.siteCard.footer', holes[i]);
      if (m) homeFooterMounts.push(m);
    }
  }
  // 回線の見張りは開発者モードか上級（V3。manifest は public）
  function isAdvanced() { return typeof uiLevel !== 'undefined' && uiLevel === 'advanced'; }
  function isBasic() { return typeof uiLevel !== 'undefined' && uiLevel === 'basic'; }
  var modalKey = '';
  function modalRow(g) {
    var hit = null;
    state.sites.forEach(function (r) { if (g.site && r.site === g.site) hit = r; });
    return { site: g.site, name: g.label, targets: g.targets, autoSlot: 'none', hit: hit };
  }
  function paintModal() {
    var g = state.groups.filter(function (x) { return x.key === modalKey; })[0];
    var modal = el('home-modal');
    if (!g) { modal.hidden = true; modalKey = ''; return; }
    var body = el('home-modal-body');
    while (body.firstChild) body.removeChild(body.firstChild);
    say('home-modal-title', STR.homeSiteSettings(g.label));
    body.appendChild(detailBlock(modalRow(g), true));
    var foot = el('home-modal-foot');
    while (foot.firstChild) foot.removeChild(foot.firstChild);
    var close = mk('button', 'timer-btn', STR.homeSiteClose, { type: 'button', id: 'home-modal-close' });
    close.addEventListener('click', closeSiteModal);
    foot.appendChild(close);
    modal.hidden = false;
  }
  function openSiteModal(g) { modalKey = g.key; paintModal(); }
  function closeSiteModal() { modalKey = ''; keyBoxOpen = {}; el('home-modal').hidden = true; }
  function paintButtons() {
    var names = {};
    state.sites.forEach(function (r) { names[r.site] = r.name; });
    state.groups = streamGroups(state.allTargets, names, state.siteLive, state.destRows);
    if (isBasic()) {
      // 初級: 押すとそのサイトの設定が開く（開始・停止は上の 2 つのボタンだけ）。最後の「＋」でサイトを足す。
      streamRenderButtons(el('home-site-buttons'), state.groups, { alwaysOpen: true, onToggle: openSiteModal, onAdd: function () { openPanel('site-add'); } });
      return;
    }
    streamRenderButtons(el('home-site-buttons'), state.groups, { locked: !state.controlOn, onToggle: toggleGroup, stats: state.stats });
  }
  // 配信中のあいだだけ、数秒おきに通信状況（fps・kbps・経過）を読む。読めないときは「配信中」のまま。
  function refreshStats() {
    if (busyStats || !visible() || document.hidden) return;
    var anyLive = state.groups.some(function (g) { return g.state === 'live'; });
    if (!anyLive) { if (Object.keys(state.stats).length) { state.stats = {}; paintButtons(); } return; }
    busyStats = true;
    call('engine.targetStats', {}).then(function (r) {
      var map = {};
      if (r && r.ok === true && Array.isArray(r.targets)) r.targets.forEach(function (t) { if (t && t.id != null) map[String(t.id)] = t; });
      state.stats = map;
      paintButtons();
    }).catch(function () { state.stats = {}; }).then(function () { busyStats = false; });
  }
  function paintLine() {
    var line = el('home-line');
    while (line.firstChild) line.removeChild(line.firstChild);
    line.appendChild(document.createTextNode(STR.homeLineHead + ': '));
    // 回線の見張りは開発者モードか上級（V3。もとは M4 のあとのユーザー決定で開発者モードだけ）。初級は「余裕」の 1 行だけ。
    // 回線の余裕のプラグインを切っているとき（uplink.last が unknown-method）は、余裕の文と「計算」を出さない。見せるものが無ければ 1 行ごと隠す。
    var showWatch = devMode || isAdvanced();
    var showMargin = state.uplinkOff !== true;
    line.hidden = !showWatch && !showMargin;
    if (line.hidden) return;
    if (showWatch) {
      var w = state.watch;
      var off = !w || w.mode === 'legacy';
      if (off) {
        line.appendChild(document.createTextNode(STR.homeLineWatchOff + ' '));
        var use = mk('button', 'timer-btn', STR.homeLineWatchUse, { type: 'button', id: 'home-watch-use' });
        if (!state.isWindow || !can.write || !w) use.disabled = true;
        use.title = STR.watchHint;
        use.addEventListener('click', function () {
          call('features.set', { id: 'signal-monitor', enabled: true }).then(function () { refreshFast(); }).catch(function () {});
        });
        line.appendChild(use);
      } else if (state.liveCount === 0) {
        line.appendChild(document.createTextNode(STR.homeLineWatchIdle));
      } else {
        line.appendChild(document.createTextNode(STR.homeLineWatch(w.text && w.text.state)));
      }
      if (showMargin) line.appendChild(document.createTextNode(STR.uiHome2));
    }
    if (!showMargin) return;
    var u = state.uplink;
    if (u) {
      var ago = STR.homeAgo(Date.now() - Date.parse(u.at));
      line.appendChild(document.createTextNode(STR.homeLineMargin(u.verdict, ago) + ' '));
    } else {
      line.appendChild(document.createTextNode(STR.homeLineMarginNone + ' '));
    }
    var open = mk('button', 'timer-btn', STR.homeLineCalc, { type: 'button', id: 'home-uplink-open' });
    open.addEventListener('click', function () { openPanel('plugin:uplink-estimate:main'); });
    line.appendChild(open);
  }
  function paintControl() {
    var cb = el('home-obs-control');
    if (document.activeElement !== cb) cb.checked = !state.controlOn; // チェック＝止める
    cb.disabled = !state.isWindow || !can.write;
    var off = !state.controlOn || !can.write;
    el('home-start').disabled = off || !state.ids.length;
    var ctlLabel = el('home-obs-control-label');
    if (ctlLabel) ctlLabel.hidden = isBasic() && state.controlOn; // 初級: 止めてあるときだけ見せる
    var st = el('home-broadcast-status');
    if (!state.controlOn) say('home-broadcast-status', STR.homeNeedObsControl);
    else if (st.textContent === STR.homeNeedObsControl) say('home-broadcast-status', '');
  }
  // 中級機能の紹介（R24）。配信中は出さない。返事: 設定する（機能をオン・その画面を開く）・あとで・もう出さない。
  function paintTip() {
    var box = el('home-tip');
    while (box.firstChild) box.removeChild(box.firstChild);
    var id = state.tips && state.tips.pending ? state.tips.pending : '';
    var streaming = typeof state.liveCount === 'number' && state.liveCount > 0;
    // 紹介は中級以上だけ（初級では紹介する機能のプラグインを読み込まない。V5）
    var feature = id ? homeTipFeature(state.featureRows, id) : null;
    if (!id || streaming || !feature || !feature.tip || !levelAtLeast('standard')) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(mk('strong', '', STR.tipTitle + ': '));
    box.appendChild(mk('span', '', feature.tip));
    var row = mk('div', 'timer-actions');
    [['setup', STR.tipSetup, 'primary'], ['later', STR.tipLater, ''], ['never', STR.tipNever, '']].forEach(function (b) {
      var btn = mk('button', 'timer-btn' + (b[2] ? ' ' + b[2] : ''), b[1], { type: 'button', 'data-tip-action': b[0] });
      if (!state.isWindow || !can.write) btn.disabled = true;
      btn.addEventListener('click', function () {
        call('tips.respond', { id: id, action: b[0] }).then(function (r) {
          if (r && r.ok === true) {
            state.tips = { pending: r.tipPending || '', features: Array.isArray(r.features) ? r.features : [] };
            if (b[0] === 'setup' && feature.activation !== 'guide') {
              // 内蔵の機能プラグイン（P2）。オンにしてから画面を開く（自動枠取りのような guide の機能は、画面の中で本人が決めるので開くだけ）
              call('features.set', { id: feature.id, enabled: true }).then(function () { return refreshPluginCatalog(); }).then(function () { if (feature.openPanel) openPanel(feature.openPanel); }).catch(function () {});
            } else if (b[0] === 'setup' && feature.openPanel) openPanel(feature.openPanel);
          }
          paintTip();
        }).catch(function () {});
      });
      row.appendChild(btn);
    });
    box.appendChild(row);
  }
  function paintAll() {
    paintAlert(); paintTip(); paintObs(); paintSites(); paintButtons(); paintLine(); paintControl();
    if (modalKey && !Object.keys(keyBoxOpen).some(function (k) { return keyBoxOpen[k]; })) paintModal();
  }

  // ----- 読む -----
  function refreshFast() {
    if (busyFast) return Promise.resolve();
    busyFast = true;
    var mode = { rows: [], targets: [] };
    return Promise.all([
      call('hub.getState').then(function (s) {
        notePermissions(s && s.permissions);
        if (typeof noteSiteOrder === 'function') noteSiteOrder(s && s.plugins);
        state.isWindow = !!(s && s.clientId === 'local-window');
        state.obs = s && s.engineStatus && typeof s.engineStatus.connected === 'boolean' ? s.engineStatus.connected : null;
        state.liveCount = s && s.destinations && typeof s.destinations.liveCount === 'number' ? s.destinations.liveCount : null;
        var tf = s && s.timerFanout;
        state.timerAck = tf && tf.reason === 'needs-ack' && Array.isArray(tf.missing) && tf.missing.length ? tf.missing.slice() : null;
      }).catch(function () {}),
      call('destination.list', {}).then(function (r) {
        state.destRows = r && r.ok === true && Array.isArray(r.destinations) ? r.destinations : [];
        state.siteLive = streamSiteLiveMap(state.destRows);
      }).catch(function () { state.destRows = []; state.siteLive = {}; }),
      call('modes.list', {}).then(function (r) { mode.rows = r && Array.isArray(r.plugins) ? r.plugins : []; }).catch(function () {}),
      call('engine.listTargets').then(function (r) { mode.targets = Array.isArray(r) ? r : []; }).catch(function () {}),
      call('home.getState', {}).then(function (r) {
        if (r && r.ok === true) { state.slots = r.slots || {}; state.alert = r.alert || null; }
      }).catch(function () {}),
      call('tips.get', {}).then(function (r) {
        if (r && r.ok === true) state.tips = { pending: r.tipPending || '', features: Array.isArray(r.features) ? r.features : [] };
        // 紹介が出るときだけ、機能の一覧から文と開く画面を引く
        if (state.tips && state.tips.pending && !state.featureRows) {
          return call('features.list', {}).then(function (f) { if (f && f.ok !== false && Array.isArray(f.features)) { state.featureRows = f.features; paintTip(); } }).catch(function () {});
        }
        return null;
      }).catch(function () {}),
      call('uplink.last', {}).then(function (r) {
        if (r && r.ok === true) state.uplink = r.last || null;
        state.uplinkOff = !!(r && r.ok !== true && r.error === 'unknown-method');
      }).catch(function () {}),
      (devMode || isAdvanced()) ? call('plugin.signal-monitor.getStatus', {}).then(function (r) { state.watch = r && r.ok !== false ? r : null; }).catch(function () { state.watch = null; }) : Promise.resolve(),
      call('broadcast.status').then(function (r) {
        state.controlOn = !!(r && r.ok !== false && r.mode && r.mode !== 'legacy');
        state.ids = r && Array.isArray(r.destinations) ? r.destinations.map(function (d) { return d && d.id ? String(d.id) : ''; }).filter(Boolean) : [];
      }).catch(function () {})
    ]).then(function () {
      state.allTargets = mode.targets;
      state.sites = homeSiteRows(mode.rows, mode.targets);
      // OBS が止まったか（前に読んだ値と比べる。自動でやり直さない）
      var nowRead = { liveCount: state.liveCount, obs: state.obs };
      if (state.prevLive && obsStoppedNotice(state.prevLive, nowRead, state.lastStopAt, Date.now())) state.obsStopped = true;
      state.prevLive = nowRead;
      paintAll();
    }).then(function () { busyFast = false; }, function () { busyFast = false; });
  }
  function refreshSlow() {
    if (busySlow) return;
    busySlow = true;
    call('sites.loginStatus', {}).then(function (r) { state.login = r && r.ok === true && Array.isArray(r.sites) ? r.sites : null; paintSites(); })
      .catch(function () { state.login = null; })
      .then(function () { busySlow = false; });
  }
  function scheduleRefresh() {
    if (timerEvent) return;
    timerEvent = setTimeout(function () { timerEvent = null; if (visible()) refreshFast(); }, 400);
  }
  // 押した直後は状態がすぐ変わるので、少しの間だけ読み直す（1・3・6・10 秒後）
  function afterAction() {
    burst.forEach(clearTimeout);
    burst = [1000, 3000, 6000, 10000].map(function (ms) { return setTimeout(function () { refreshFast(); }, ms); });
  }

  // ----- 操作 -----
  function nameOfDest(id) {
    var hit = state.allTargets.filter(function (t) { return t && t.destinationId === id; })[0];
    return hit ? String(hit.name || id) : id;
  }
  function siteOfDest(id) {
    var hit = state.destRows.filter(function (d) { return d && d.id === id; })[0];
    return hit && hit.site ? String(hit.site) : '';
  }
  // 出せなかった配信先のキーの欄を開く（ホームの詳細。初級は設定の窓）。開けないときは文だけで案内する。
  function repasteKey(entry) {
    var t = state.allTargets.filter(function (x) { return x && x.destinationId === entry.id; })[0];
    var g = t ? state.groups.filter(function (x) { return x.targets.indexOf(t) !== -1; })[0] : null;
    if (!t || !g) { say('home-broadcast-status', STR.broadcastRepasteHint); return; }
    keyBoxOpen[String(t.id)] = true;
    if (isBasic()) { openSiteModal(g); return; }
    if (g.site) openDetails[g.site] = true;
    lastSig = '';
    paintSites();
    var kb = el('home-sites').querySelector('[data-keybox="' + String(t.id) + '"]');
    if (kb && kb.scrollIntoView) kb.scrollIntoView({ block: 'center' });
  }
  var failedCtl = streamBindFailed({
    box: el('home-broadcast-failed'),
    say: function (t) { say('home-broadcast-status', t); },
    nameOf: nameOfDest,
    siteOf: siteOfDest,
    canWrite: function () { return state.isWindow && can.write; },
    after: function () { refreshFast(); afterAction(); },
    onRepaste: repasteKey
  });
  function toggleGroup(group) {
    if (!state.controlOn || !can.write) return;
    say('home-broadcast-status', STR.homeBroadcastWait);
    failedCtl.clear();
    state.obsStopped = false; paintAlert();
    if (group.state === 'live' || group.state === 'connecting') state.lastStopAt = Date.now();
    streamToggleGroup(group).then(function (rs) { failedCtl.show(rs); refreshFast(); afterAction(); })
      .catch(function (err) { say('home-broadcast-status', err && err.message === 'timeout' ? STR.homeBroadcastWait : STR.homeBroadcastFailed); afterAction(); });
  }
  el('home-obs-btn').addEventListener('click', function () { openPanel('obs-connect'); });
  el('home-site-add').addEventListener('click', function () { openPanel('site-add'); });
  el('home-features-open').addEventListener('click', function () { openPanel('features'); });
  var sitesBox = el('home-sites');
  var modalBox = el('home-modal');
  modalBox.addEventListener('click', function (ev) { if (ev.target === modalBox) closeSiteModal(); });
  modalBox.addEventListener('click', function (ev) { onDetailClick(ev, modalBox); });
  sitesBox.addEventListener('click', function (ev) { onDetailClick(ev, sitesBox); });
  function onDetailClick(ev, sitesBox) {
    var login = ev.target && ev.target.closest ? ev.target.closest('[data-home-login]') : null;
    if (login) { openPanel('sites'); return; }
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b || !can.write || !state.isWindow) return;
    var act = b.getAttribute('data-act');
    var tid = b.getAttribute('data-target-id');
    var target = state.allTargets.filter(function (t) { return String(t.id) === tid; })[0];
    var tname = target ? target.name : tid;
    if (act === 'key-toggle') {
      keyBoxOpen[tid] = !keyBoxOpen[tid];
      var kb = sitesBox.querySelector('[data-keybox="' + tid + '"]');
      if (kb) kb.hidden = !keyBoxOpen[tid];
      return;
    }
    if (act === 'key-save') {
      var input = sitesBox.querySelector('[data-key-input="' + tid + '"]');
      var key = input ? input.value.trim() : '';
      if (!key) return;
      if (!window.confirm(STR.homeKeySave + ': ' + tname)) return;
      input.value = '';
      call('engine.setKey', { id: tid, key: key }).then(function (res) {
        say('home-broadcast-status', res && res.ok === false ? STR.homeBroadcastFailed : STR.homeKeyDone);
        lastSig = ''; refreshFast();
      }).catch(function () { say('home-broadcast-status', STR.homeBroadcastFailed); });
      return;
    }
    if (act === 'remove') {
      if (!window.confirm(STR.homeRemoveConfirm(tname))) return;
      call('engine.remove', { id: tid }).then(function () { lastSig = ''; closeIfModal(sitesBox); refreshFast(); }).catch(function () {});
      return;
    }
    if (act === 'unlink') {
      var dest = b.getAttribute('data-dest-id');
      if (!dest || !window.confirm(STR.homeUnlinkConfirm(tname))) return;
      call('engine.unlink', { destinationId: dest }).then(function () { lastSig = ''; closeIfModal(sitesBox); refreshFast(); }).catch(function () {});
    }
  }
  function closeIfModal(box) { if (box === modalBox) closeSiteModal(); }
  sitesBox.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !can.write) return;
    if (t.getAttribute('data-main-use') || t.getAttribute('data-main-site')) {
      var useNow = sitesBox.querySelector('[data-main-use]');
      var siteNow = sitesBox.querySelector('[data-main-site]');
      call('destination.setMain', { use: !!(useNow && useNow.checked), site: siteNow ? siteNow.value : '' }).then(function (res) {
        state.mainMsg = res && res.ok === true ? '' : (res && res.error === 'streaming' ? STR.mainOutputLocked : STR.mainOutputError(res && res.error));
        lastSig = ''; refreshFast(); afterAction();
      }).catch(function () { state.mainMsg = STR.mainOutputError('failed'); lastSig = ''; refreshFast(); });
      return;
    }
    if (t.getAttribute('data-home-send')) {
      var id = t.getAttribute('data-home-send');
      var want = t.checked;
      var named = state.sites.filter(function (r) { return r.pluginId === id; })[0];
      if (want && confirmLiveWanted && !window.confirm(STR.homeSendConfirm(named ? named.name : id))) { t.checked = false; return; }
      call('sites.setSend', { id: id, send: want, confirmName: want ? id : undefined }).then(function (res) {
        if (!res || res.ok === false) { t.checked = !want; window.alert(STR.sendSwitchError(res && res.error)); }
        refreshFast();
      }).catch(function () { t.checked = !want; });
    } else if (t.getAttribute('data-home-autoslot')) {
      var slotSite = t.getAttribute('data-home-autoslot');
      var slotWant = t.checked;
      var slotRow = state.sites.filter(function (r) { return r.site === slotSite; })[0];
      var slotName = slotRow ? slotRow.name : slotSite;
      if (slotWant && !window.confirm(STR.autoSlotAsk(slotName))) { t.checked = false; return; }
      call('sites.setAutoSlot', { site: slotSite, enabled: slotWant }).then(function (res) {
        if (!res || res.ok === false) { t.checked = !slotWant; window.alert(STR.autoSlotErr(res && res.error)); }
        refreshFast();
      }).catch(function () { t.checked = !slotWant; });
    } else if (t.getAttribute('data-home-dest')) {
      var site = t.getAttribute('data-home-dest');
      var on = t.checked;
      var row = null;
      state.sites.forEach(function (r) { if (r.site === site) row = r; });
      if (!row) return;
      // 配信中のサイトの「使う」を外すと、その配信先は止まり、対象からも外れる。確かめてから。
      if (!on && row.destState !== 'none' && row.destState !== 'stopped' && !window.confirm(STR.homeUnuseConfirm(row.name))) { t.checked = true; return; }
      Promise.all(row.targets.map(function (tg) { return call('engine.setEnabled', { id: tg.id, enabled: on }); })).then(function (rs) {
        if (rs.some(function (r) { return r && r.ok === false; })) { t.checked = !on; window.alert(STR.sendSwitchError('failed')); }
        refreshFast();
      }).catch(function () { t.checked = !on; });
    }
  });
  el('home-obs-control').addEventListener('change', function () {
    var cb = el('home-obs-control');
    var stopIt = cb.checked; // チェック＝止める（使わない）
    if (!state.isWindow || !can.write) { cb.checked = !stopIt; return; }
    call('obs.setControl', { enabled: !stopIt }).then(function (res) {
      if (!res || res.ok === false) { cb.checked = !stopIt; window.alert(STR.sendSwitchError(res && res.error)); }
      refreshFast();
    }).catch(function () { cb.checked = !stopIt; });
  });
  function sayApply(text, kind) {
    var s = el('home-apply-status');
    if (!s) return;
    s.textContent = text || '';
    s.className = 'timer-hint' + (kind ? ' apply-' + kind : '');
  }
  el('home-apply').addEventListener('click', function () {
    if (!can.write) return;
    var title = el('home-title').value;
    var category = el('home-category').value;
    sayApply('', '');
    var sending = state.sites.some(function (r) { return r.send; });
    if (!sending) { sayApply(STR.homeApplyNone, 'warn'); return; }
    call('hub.fanout', { title: title, category: category }).then(function (res) {
      if (res && res.needsConfirm === true) {
        var ids = Array.isArray(res.liveIds) ? res.liveIds : [];
        return confirmFanoutOnce(ids.join('、'), ids).then(function (ok) {
          return ok ? call('hub.fanout', { title: title, category: category, confirmed: true, allowedLiveIds: ids }) : null;
        });
      }
      return res;
    }).then(function (res) {
      if (!res) return;
      var info = homeApplyResultSentence(res, state.sites);
      sayApply(info.text, info.kind);
    }).catch(function () { sayApply(STR.homeApplyFailed, 'ng'); });
  });
  el('home-start').addEventListener('click', function () {
    if (!state.controlOn || !can.write) return;
    if (!state.ids.length) { say('home-broadcast-status', STR.homeNoTargets); return; }
    if (!window.confirm(STR.homeStartConfirm(state.groups.filter(function (g) { return g.enabled; }).map(function (g) { return g.label; }).join('、')))) return;
    say('home-broadcast-status', STR.homeBroadcastWait);
    failedCtl.clear();
    state.obsStopped = false; paintAlert();
    call('broadcast.start', { destinationIds: state.ids, confirmed: true }).then(function (res) {
      failedCtl.show([res]);
      refreshFast(); afterAction();
    }).catch(function (err) { say('home-broadcast-status', err && err.message === 'timeout' ? STR.homeBroadcastWait : STR.homeBroadcastFailed); afterAction(); });
  });

  el('home-stop-all').addEventListener('click', function () {
    if (!can.emergency) return;
    var btn = el('home-stop-all');
    if (btn.disabled) return;
    btn.disabled = true;
    say('home-broadcast-status', '');
    failedCtl.clear();
    state.lastStopAt = Date.now();
    call('broadcast.stopAll', {}).then(function (res) {
      btn.disabled = false;
      if (!res) { say('home-broadcast-status', STR.homeBroadcastFailed); return; }
      if (res.error === 'not-connected') { say('home-broadcast-status', STR.emergencyStopAllNotConnected); return; }
      if (res.ok === true) { say('home-broadcast-status', STR.emergencyStopAllOk); return; }
      var remain = [];
      var engineRows = (res.engines && res.engines.results) || [];
      engineRows.forEach(function (e) {
        if (e && e.targetsStillActive && e.targetsStillActive.length) {
          e.targetsStillActive.forEach(function (id) { remain.push(id); });
        }
        if (e && e.mainStillActive === true) {
          var drow = mainDestRow();
          var msite = drow && drow.site ? drow.site : '';
          remain.push(homeMainOutputLabel(msite, state.sites));
        }
      });
      if (remain.length) say('home-broadcast-status', STR.emergencyStopAllPartial(remain.join('、')));
      else say('home-broadcast-status', STR.emergencyStopAllOk);
      refreshFast(); afterAction();
    }).catch(function () {
      btn.disabled = false;
      say('home-broadcast-status', STR.homeBroadcastFailed);
    });
  });
  if (hubApi() && hubApi().subscribe) {
    hubApi().subscribe(function (msg) {
      if (msg && msg.name === 'broadcast.stopped') state.lastStopAt = Date.now();
      if (msg && HOME_EVENTS.indexOf(msg.name) !== -1) scheduleRefresh();
      if (msg && msg.name === 'modes.changed') loadFrame();
    });
  }
  refreshFast();
  refreshSlow();
  loadFrame();
  // 起動直後は OBS・プラグインがまだ揃っていないことがあるので、最初だけ少し早めに読み直す
  [2000, 5000, 9000].forEach(function (ms) { setTimeout(function () { refreshFast(); refreshSlow(); }, ms); });
  setInterval(function () { if (visible() && !document.hidden) refreshFast(); }, HOME_FAST_MS);
  setInterval(refreshStats, 3000);
  setInterval(function () { if (visible() && !document.hidden) refreshSlow(); }, HOME_SLOW_MS);
}

if (typeof module === 'object' && module.exports) module.exports = { homeSiteRows: homeSiteRows, obsStoppedNotice: obsStoppedNotice, homeMainOutputView: homeMainOutputView, homeMainOutputLabel: homeMainOutputLabel, homeApplyResultSentence: homeApplyResultSentence };

if (typeof registerPanel === 'function') registerPanel('home', initHome);
