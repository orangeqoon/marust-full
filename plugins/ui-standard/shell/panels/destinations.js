'use strict';

/**
 * 配信ボタン（サイトごとの 開始／停止 ボタンと、全配信開始・全配信停止）。
 * 「配信ボタン」パネル（id `destinations`）と、ホーム（ui/panels/home.js）が同じ部品を使う。
 * サイト名のボタン: 止まっている＝薄い赤、配信中＝明るい緑、接続中＝黄。押すと開始／停止（切り替え）。
 * 開始は broadcast.start（丸ストの配信先 id を使う。チェックと枠の確保は丸スト側）、停止は broadcast.stop。
 * 結びつきのない OBS の配信先だけ engine.start / engine.stop。秘密は扱わない。
 * hub.js より前に読み込む（hub.js の call・mk・can・hubApi・siteLabel などは、呼ばれたときに使う）。
 */

var STREAM_ACTIVE = ['live', 'connecting', 'reconnecting', 'starting'];

/** engine.listTargets の行を、サイトごとのボタン 1 つにまとめる。DOM を使わない。 */
function streamGroups(targets, names, siteLive, destRows) {
  var out = [];
  var byKey = {};
  var mainGroup = null;
  (Array.isArray(targets) ? targets : []).forEach(function (t) {
    if (!t) return;
    if (t.main === true || t.id === 'main') {
      // メイン出力（OBS の配信設定）は「メイン出力」のボタン 1 つ。サイトのボタンと混ぜない。使うかどうかは配信先 obs-main の enabled
      var did = t.destinationId ? String(t.destinationId) : 'obs-main';
      var drow = (Array.isArray(destRows) ? destRows : []).filter(function (r) { return r && r.id === did; })[0];
      if (!mainGroup) mainGroup = { key: 'main', site: '', label: STR.mainOutputButton, targets: [], destIds: [did], orphanIds: [], state: 'stopped', enabled: drow ? drow.enabled === true : t.enabled === true, isMain: true };
      mainGroup.targets.push(t);
      return;
    }
    var key = t.site ? 's:' + t.site : 't:' + t.id;
    var g = byKey[key];
    if (!g) {
      var label = t.site ? ((names && names[t.site]) || siteLabel(t.site)) : String(t.name || t.id);
      g = byKey[key] = { key: key, site: t.site || '', label: label, targets: [], destIds: [], orphanIds: [], state: 'stopped', enabled: false };
      out.push(g);
    }
    g.targets.push(t);
    if (t.destinationId) g.destIds.push(t.destinationId); else g.orphanIds.push(String(t.id));
    if (t.enabled === true) g.enabled = true;
  });
  if (mainGroup) out.unshift(mainGroup);
  out.forEach(function (g) {
    var states = g.targets.map(function (t) { return t.state; });
    if (states.indexOf('live') !== -1) g.state = 'live';
    else if (states.some(function (s) { return STREAM_ACTIVE.indexOf(s) !== -1; })) g.state = 'connecting';
    // 配信中（サイトで公開を見られた）は、送信中の配信先が 1 つでも siteLive のときだけ。核だけのときは付かない。
    g.siteLive = !!siteLive && g.targets.some(function (t) { return t.state === 'live' && t.destinationId && siteLive[t.destinationId] === true; });
  });
  return out;
}

/** 1 サイト（1 ボタン）を押したとき。配信中・接続中なら止め、止まっていれば始める。 */
function streamToggleGroup(group) {
  var active = group.state === 'live' || group.state === 'connecting';
  var jobs = [];
  if (active) {
    if (group.destIds.length) jobs.push(call('broadcast.stop', { destinationIds: group.destIds }));
    group.orphanIds.forEach(function (id) { jobs.push(call('engine.stop', { id: id })); });
  } else {
    if (group.destIds.length) jobs.push(call('broadcast.start', { destinationIds: group.destIds, confirmed: true }));
    group.orphanIds.forEach(function (id) { jobs.push(call('engine.start', { id: id })); });
  }
  return Promise.all(jobs);
}

/** destination.list の行から { 配信先 id: true }（siteLive の行だけ）を作る。DOM を使わない。 */
function streamSiteLiveMap(rows) {
  var out = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r) { if (r && r.id && r.siteLive === true) out[String(r.id)] = true; });
  return out;
}

/**
 * 配信開始の結果（broadcast.start の返す形の配列）を、文と「出せなかった配信先の一覧」にする。DOM を使わない。
 * 返す形: { text, failed: [{ id, name, code, step, reason }], okIds: [id...], error }
 *  - error: 'preflight'（全体が外れた・何も出していない）は全体の理由を出す
 *  - error が空で全部 ok は「全部出しました」。一部だけ失敗は「出せたもの／出せなかったもの」
 * nameOf(id) は表示名（無ければ id）。キーの値は扱わない。
 */
function streamResultSummary(results, nameOf) {
  var nm = typeof nameOf === 'function' ? nameOf : function (id) { return id; };
  var failed = [];
  var okIds = [];
  var texts = [];
  var error = '';
  function addFail(id, code, step) {
    failed.push({ id: String(id), name: String(nm(String(id)) || id), code: String(code || ''), step: String(step || ''), reason: STR.broadcastFailReason(code, step) });
  }
  (results || []).forEach(function (res) {
    if (!res || typeof res !== 'object') return;
    var items = Array.isArray(res.items) ? res.items : [];
    if (res.error === 'preflight') {
      error = 'preflight';
      var pf = res.preflight && Array.isArray(res.preflight.items) ? res.preflight.items : [];
      var glob = pf.filter(function (x) { return x && x.scope === 'global' && x.level === 'error'; })[0];
      var reason = glob ? String(glob.message || glob.code || '') : '';
      texts.push(STR.broadcastNothingStarted(reason));
      if (items.length) {
        items.forEach(function (it) { if (it && it.ok === false) addFail(it.destinationId, it.error || it.step, it.step); });
      } else {
        pf.forEach(function (x) { if (x && x.level === 'error' && x.scope !== 'global' && x.destinationId) addFail(x.destinationId, x.code, 'preflight'); });
      }
      return;
    }
    if (res.error) { error = String(res.error); texts.push(STR.homeBroadcastFailed + ': ' + res.error); return; }
    items.forEach(function (it) {
      if (!it) return;
      if (it.ok === false) addFail(it.destinationId, it.error || it.step, it.step);
      else if (it.destinationId) okIds.push(String(it.destinationId));
    });
  });
  var text = texts.join(' ');
  if (!error) {
    if (failed.length) text = STR.broadcastPartial(okIds.map(nm).join('、'), failed.map(function (f) { return f.name; }).join('、'));
    else if (okIds.length) text = STR.broadcastAllOk;
  }
  return { text: text, failed: failed, okIds: okIds, error: error };
}

/** 結果のひとこと（失敗した配信先があれば名前つき）。 */
function streamResultText(results, nameOf) {
  return streamResultSummary(results, nameOf).text;
}

/**
 * 「もう一度出す」の結果を、前の「出せなかった一覧」に重ねる。DOM を使わない。
 * その 1 つが出せたら一覧から消し、まだだめなら理由を書き直す（全体の error で一覧が空になるときは前の行を残す）。
 */
function streamMergeRetry(prevFailed, destId, res, nameOf) {
  var sum = streamResultSummary([res], nameOf);
  var rest = (prevFailed || []).filter(function (f) { return f.id !== String(destId); });
  var again = sum.failed.filter(function (f) { return f.id === String(destId); });
  if (!again.length && sum.error) {
    var old = (prevFailed || []).filter(function (f) { return f.id === String(destId); })[0];
    if (old) again = [Object.assign({}, old, { reason: sum.text || old.reason })];
  }
  return { text: sum.text, failed: rest.concat(again), error: sum.error };
}

/** 作り直しに使うサイトの名簿（hub.getState の plugins の site）。{ サイト id: { name, url } }。読めなければ空。 */
function streamLoadRoster() {
  return call('hub.getState').then(function (state) {
    var out = {};
    ((state && state.plugins) || []).forEach(function (p) {
      if (!p || !p.site || !p.site.id) return;
      var url = '';
      (p.site.ingest || []).forEach(function (row) { if (!url && row && row.url) url = String(row.url); });
      out[p.site.id] = { name: p.site.name || p.site.id, url: url };
    });
    return out;
  }).catch(function () { return {}; });
}

function streamFindNewTarget(name, beforeIds, tries) {
  return call('engine.listTargets').then(function (list) {
    var rows = Array.isArray(list) ? list : (list && Array.isArray(list.targets) ? list.targets : []);
    var hit = null;
    rows.forEach(function (r) { if (r.name === name && !r.linked && beforeIds.indexOf(String(r.id)) === -1) hit = r; });
    if (hit || tries <= 0) return hit;
    return new Promise(function (resolve) { setTimeout(resolve, 700); }).then(function () { return streamFindNewTarget(name, beforeIds, tries - 1); });
  });
}

/**
 * OBS の行を作り直して、その 1 つだけ出す（site-add と同じ流れ）。
 * engine.create → 新しい行を探す → engine.link（同じ destinationId・今の行のまま）→ broadcast.start。
 * キーは engine.create にだけ渡す（画面の文字・ログには出さない）。
 */
function streamRecreateAndStart(destId, site, roster, key) {
  var info = roster && roster[site];
  if (!info || !info.url) return Promise.resolve({ ok: false, error: 'no-url' });
  var name = info.name;
  var beforeIds = [];
  return call('engine.listTargets').then(function (list) {
    var rows = Array.isArray(list) ? list : (list && Array.isArray(list.targets) ? list.targets : []);
    beforeIds = rows.map(function (r) { return String(r.id); });
    return call('engine.create', { protocol: 'RTMP', name: name, server: info.url, key: key });
  }).then(function (res) {
    if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'create-failed' };
    return streamFindNewTarget(name, beforeIds, 6).then(function (target) {
      if (!target) return { ok: false, error: 'target-not-found' };
      return call('engine.link', { destinationId: destId, targetId: String(target.id), site: site }).then(function (linked) {
        if (linked && linked.ok === false) return { ok: false, error: linked.error || 'link-failed' };
        return call('broadcast.start', { destinationIds: [destId], confirmed: true });
      });
    });
  }).catch(function () { return { ok: false, error: 'failed' }; });
}

/**
 * 「出せなかった配信先」の箱を描く。1 行ごとに 理由・「もう一度出す」・「キーを貼り直す」、
 * 理由が target-missing で名簿に URL があるときだけ「OBS の行を作り直す」（キーの欄つき）。
 * o: { roster, siteOf(id), canWrite, onRetry(entry), onRepaste(entry), onRecreate(entry, key) }
 */
function streamRenderFailed(box, failed, o) {
  var opt = o || {};
  while (box.firstChild) box.removeChild(box.firstChild);
  var list = Array.isArray(failed) ? failed : [];
  box.hidden = !list.length;
  list.forEach(function (f) {
    var row = mk('div', 'broadcast-failed-row', null, { 'data-failed-dest': f.id });
    row.appendChild(mk('span', 'broadcast-failed-text', f.name + ': ' + f.reason));
    var acts = mk('span', 'broadcast-failed-acts');
    function btn(text, attr, fn) {
      var b = mk('button', 'timer-btn', text, { type: 'button', 'data-failed-act': attr });
      if (!opt.canWrite) b.disabled = true;
      b.addEventListener('click', fn);
      acts.appendChild(document.createTextNode(' '));
      acts.appendChild(b);
      return b;
    }
    btn(STR.broadcastRetry, 'retry', function () { if (typeof opt.onRetry === 'function') opt.onRetry(f); });
    btn(STR.broadcastRepasteKey, 'repaste', function () { if (typeof opt.onRepaste === 'function') opt.onRepaste(f); });
    row.appendChild(acts);
    if (f.code === 'target-missing') {
      var site = typeof opt.siteOf === 'function' ? opt.siteOf(f.id) : '';
      var info = site && opt.roster ? opt.roster[site] : null;
      if (!info || !info.url) {
        row.appendChild(mk('p', 'timer-hint', STR.broadcastRecreateNoUrl));
      } else {
        var kb = mk('div', 'timer-setup broadcast-recreate-box', null, { hidden: '' });
        var input = mk('input', '', null, { type: 'password', maxlength: '300', autocomplete: 'off', 'aria-label': f.name + ': ' + STR.broadcastRecreateKeyLabel });
        input.placeholder = STR.secretPlaceholder(f.keyTail);
        var run = mk('button', 'timer-btn', STR.broadcastRecreateRun, { type: 'button', 'data-failed-act': 'recreate-run' });
        if (!opt.canWrite) run.disabled = true;
        run.addEventListener('click', function () {
          var key = input.value.trim();
          input.value = '';
          if (!key) return;
          if (typeof opt.onRecreate === 'function') opt.onRecreate(f, key);
        });
        kb.appendChild(input);
        kb.appendChild(run);
        btn(STR.broadcastRecreate, 'recreate', function () { kb.hidden = !kb.hidden; });
        row.appendChild(kb);
      }
    }
    box.appendChild(row);
  });
}

/**
 * 「出せなかった配信先」の箱と、その操作（もう一度出す・作り直して出す）をまとめて持つ。ホームと配信ボタンのパネルが同じものを使う。
 * ctx: { box, say(text), nameOf(id), siteOf(id), canWrite(), after(), onRepaste(entry) }
 * 返す: { show(results), clear() }。「もう一度出す」は broadcast.start をその 1 つだけ（confirmed: true、確認の窓は出さない）。
 * 自動でやり直さない（押されたときだけ）。キーの値は say に渡さない。
 */
function streamBindFailed(ctx) {
  var failed = [];
  var roster = {};
  function paint() {
    streamRenderFailed(ctx.box, failed, {
      roster: roster,
      canWrite: ctx.canWrite(),
      siteOf: ctx.siteOf,
      onRetry: retry,
      onRepaste: ctx.onRepaste,
      onRecreate: recreate
    });
  }
  function apply(m) {
    failed = m.failed;
    ctx.say(m.text);
    paint();
    if (typeof ctx.after === 'function') ctx.after();
  }
  function retry(entry) {
    ctx.say(STR.broadcastRetrying);
    call('broadcast.start', { destinationIds: [entry.id], confirmed: true })
      .then(function (res) { apply(streamMergeRetry(failed, entry.id, res, ctx.nameOf)); })
      .catch(function () { ctx.say(STR.homeBroadcastFailed); });
  }
  function recreate(entry, key) {
    ctx.say(STR.broadcastRetrying);
    streamRecreateAndStart(entry.id, ctx.siteOf(entry.id), roster, key).then(function (res) {
      if (res && res.ok === false && !res.items) { ctx.say(STR.broadcastRecreateFailed); return; }
      apply(streamMergeRetry(failed, entry.id, res, ctx.nameOf));
    });
  }
  return {
    show: function (results) {
      var sum = streamResultSummary(results, ctx.nameOf);
      failed = sum.failed;
      ctx.say(sum.text);
      paint();
      // 作り直しに使う名簿は、「作り直す」が出る行があるときだけ読む
      if (failed.some(function (f) { return f.code === 'target-missing'; })) {
        streamLoadRoster().then(function (r) { roster = r; paint(); });
      }
      return sum;
    },
    clear: function () { failed = []; paint(); }
  };
}

/**
 * 配信中のサイトの通信状況を 1 行の文字にする（例 `30fps · 6200kbps · 1:23:45`）。DOM を使わない。
 * stats は engine.targetStats の targets を id で引ける形（{ id: { fps, kbps, durationMs } }）。値が 1 つも取れていなければ ''（呼ぶ側は「配信中」に戻す）。
 * 複数の配信先があるサイトは、fps は一番低いもの・kbps は合計・経過は一番長いもの。
 */
function streamStatsText(group, stats) {
  if (!group || !stats) return '';
  var fps = null; var kbps = null; var ms = null;
  (group.targets || []).forEach(function (t) {
    var s = t && stats[String(t.id)];
    if (!s || t.state !== 'live') return;
    if (typeof s.fps === 'number' && s.fps > 0) fps = fps == null ? s.fps : Math.min(fps, s.fps);
    if (typeof s.kbps === 'number' && s.kbps > 0) kbps = (kbps || 0) + s.kbps;
    if (typeof s.durationMs === 'number' && s.durationMs >= 0) ms = ms == null ? s.durationMs : Math.max(ms, s.durationMs);
  });
  var parts = [];
  if (fps != null) parts.push((Math.round(fps) === fps ? String(fps) : fps.toFixed(1)) + 'fps');
  if (kbps != null) parts.push(kbps + 'kbps');
  if (ms != null && parts.length) {
    var sec = Math.floor(ms / 1000);
    var h = Math.floor(sec / 3600); var m = Math.floor((sec % 3600) / 60); var s2 = sec % 60;
    parts.push(h + ':' + String(m).padStart(2, '0') + ':' + String(s2).padStart(2, '0'));
  }
  return parts.join(' · ');
}

/** サイトのボタンを描く。onToggle(group) は押されたとき。opts.stats があれば、配信中の「配信中」の文字を通信状況に置き換える。 */
function streamRenderButtons(box, groups, opts) {
  var o = opts || {};
  while (box.firstChild) box.removeChild(box.firstChild);
  if (!groups.length && !o.onAdd) { box.appendChild(mk('p', 'empty', STR.homeNoDest)); return; }
  groups.forEach(function (g) {
    var cls = g.state === 'live' ? 'is-live' : (g.state === 'connecting' ? 'is-busy' : 'is-off');
    var b = mk('button', 'site-btn ' + cls, g.label, { type: 'button', 'data-stream-group': g.key, 'aria-pressed': g.state === 'live' ? 'true' : 'false' });
    var stateText = g.state === 'live' ? (g.siteLive ? STR.stateLiveWithSite() : STR.stateLive) : (g.state === 'connecting' ? STR.stateConnecting : STR.stateStopped);
    b.title = g.label + ': ' + stateText + STR.uiDestinations1 + (g.state === 'stopped' ? STR.uiDestinations2 : STR.uiDestinations3) + '。';
    // 通信状況（fps・kbps・経過）は中級・上級だけ。初級は「配信中／停止中」の文字だけ。
    var statsText = g.state === 'live' && !(typeof uiLevel !== 'undefined' && uiLevel === 'basic') ? streamStatsText(g, o.stats) : '';
    b.appendChild(mk('small', '', statsText || stateText));
    if (statsText) { b.setAttribute('aria-label', g.label + ': ' + stateText + '（' + statsText + '）'); b.title += ' ' + statsText; }
    if (o.alwaysOpen) b.title = STR.homeSiteSettings(g.label); // 初級: 押すと設定が開くだけなので、いつでも押せる
    else if (!can.write || o.locked) b.disabled = true;
    else if (g.state === 'stopped' && !g.enabled) { b.disabled = true; b.title = g.isMain ? STR.mainOutputNeedUse : g.label + STR.uiDestinations4; }
    b.addEventListener('click', function () { if (typeof o.onToggle === 'function') o.onToggle(g); });
    box.appendChild(b);
  });
  if (typeof o.onAdd === 'function') {
    var add = mk('button', 'site-btn site-add-tile', STR.homeAddTile, { type: 'button', 'data-site-add': '1', 'aria-label': STR.homeAddTileLabel, title: STR.homeAddTileLabel });
    add.addEventListener('click', o.onAdd);
    box.appendChild(add);
  }
}

/** 「配信ボタン」パネル（id `destinations`）。 */
function initStreamButtons() {
  var root = panelRoot('destinations');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var box = root.querySelector('#stream-buttons');
  var status = root.querySelector('#stream-status');
  var modeLine = root.querySelector('#stream-mode');
  var allStart = root.querySelector('#stream-all-start');
  var failedBox = root.querySelector('#stream-failed');
  var st = { groups: [], controlOn: false, ids: [], targets: [], names: {}, destRows: [] };
  var busy = false;
  var burst = [];
  function say(t) { status.textContent = t || ''; }
  function nameOf(id) {
    var hit = st.targets.filter(function (t) { return t && t.destinationId === id; })[0];
    return hit ? String(hit.name || id) : id;
  }
  function siteOf(id) {
    var hit = st.destRows.filter(function (d) { return d && d.id === id; })[0];
    return hit && hit.site ? String(hit.site) : '';
  }
  var failedCtl = failedBox ? streamBindFailed({
    box: failedBox, say: say, nameOf: nameOf, siteOf: siteOf,
    canWrite: function () { return can.write; },
    after: function () { refresh(); afterAction(); },
    onRepaste: function () { say(STR.broadcastRepasteHint); if (typeof openPanel === 'function') openPanel('home'); }
  }) : null;
  function showResult(results) {
    if (failedCtl) failedCtl.show(results); else say(streamResultText(results, nameOf));
  }
  function paint() {
    streamRenderButtons(box, st.groups, { locked: !st.controlOn, onToggle: toggle });
    while (modeLine.firstChild) modeLine.removeChild(modeLine.firstChild);
    if (!st.controlOn) {
      modeLine.appendChild(document.createTextNode(STR.sendNone + ' '));
      var on = mk('button', 'timer-btn', STR.sendNoneButton, { type: 'button', id: 'stream-enable' });
      on.disabled = !can.write;
      on.addEventListener('click', function () {
        call('obs.setControl', { enabled: true }).then(function (res) {
          if (!res || res.ok === false) window.alert(STR.sendSwitchError(res && res.error));
          refresh();
        }).catch(function () { window.alert(STR.sendFailed); });
      });
      modeLine.appendChild(on);
    }
    allStart.disabled = !st.controlOn || !can.write || !st.ids.length;
  }
  function refresh() {
    if (busy) return Promise.resolve();
    busy = true;
    return Promise.all([
      call('engine.listTargets').then(function (r) { st.targets = Array.isArray(r) ? r : []; }).catch(function () {}),
      call('destination.list').then(function (r) { st.destRows = r && r.ok === true && Array.isArray(r.destinations) ? r.destinations : []; }).catch(function () { st.destRows = []; }),
      call('broadcast.status').then(function (r) {
        st.controlOn = !!(r && r.ok !== false && r.mode && r.mode !== 'legacy');
        st.ids = r && Array.isArray(r.destinations) ? r.destinations.map(function (d) { return d && d.id ? String(d.id) : ''; }).filter(Boolean) : [];
      }).catch(function () {}),
      call('hub.getState').then(function (s) {
        notePermissions(s && s.permissions);
        st.names = {};
        ((s && s.plugins) || []).forEach(function (p) { if (p.site && p.site.id) st.names[p.site.id] = p.site.name; });
      }).catch(function () {})
    ]).then(function () {
      st.groups = streamGroups(st.targets, st.names, streamSiteLiveMap(st.destRows), st.destRows);
      paint();
    }).then(function () { busy = false; }, function () { busy = false; });
  }
  // 押した直後は状態がすぐ変わるので、少しの間だけ読み直す（1・3・6・10 秒後）
  function afterAction() {
    burst.forEach(clearTimeout);
    burst = [1000, 3000, 6000, 10000].map(function (ms) { return setTimeout(function () { refresh(); }, ms); });
  }
  function toggle(group) {
    if (!st.controlOn || !can.write) return;
    say(STR.homeBroadcastWait);
    if (failedCtl) failedCtl.clear();
    streamToggleGroup(group).then(function (rs) { showResult(rs); refresh(); afterAction(); })
      .catch(function (err) { say(err && err.message === 'timeout' ? STR.homeBroadcastWait : STR.homeBroadcastFailed); afterAction(); });
  }
  allStart.addEventListener('click', function () {
    if (!st.controlOn || !can.write || !st.ids.length) return;
    if (!window.confirm(STR.homeStartConfirm(st.groups.filter(function (g) { return g.enabled; }).map(function (g) { return g.label; }).join('、')))) return;
    say(STR.homeBroadcastWait);
    if (failedCtl) failedCtl.clear();
    call('broadcast.start', { destinationIds: st.ids, confirmed: true }).then(function (res) {
      showResult([res]); refresh(); afterAction();
    }).catch(function (err) { say(err && err.message === 'timeout' ? STR.homeBroadcastWait : STR.homeBroadcastFailed); afterAction(); });
  });
  var evTimer = null;
  if (hubApi() && hubApi().subscribe) {
    hubApi().subscribe(function (msg) {
      var name = msg && msg.name;
      if (['engine.target.changed', 'broadcast.result', 'broadcast.stopped', 'modes.changed', 'stream.started', 'stream.stopped'].indexOf(name) === -1) return;
      if (evTimer) return;
      evTimer = setTimeout(function () { evTimer = null; if (root.offsetParent) refresh(); }, 400);
    });
  }
  refresh();
  // 起動直後は OBS・プラグインがまだ揃っていないことがあるので、最初だけ少し早めに読み直す
  [2000, 5000, 9000].forEach(function (ms) { setTimeout(refresh, ms); });
  setInterval(function () { if (root.offsetParent && !document.hidden) refresh(); }, 15000);
}

if (typeof module === 'object' && module.exports) module.exports = { streamGroups: streamGroups, streamStatsText: streamStatsText, streamResultSummary: streamResultSummary, streamResultText: streamResultText, streamMergeRetry: streamMergeRetry, streamSiteLiveMap: streamSiteLiveMap };

if (typeof registerPanel === 'function') registerPanel('destinations', initStreamButtons);
