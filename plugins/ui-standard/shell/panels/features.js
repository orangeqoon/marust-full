'use strict';
/**
 * パネル `features`（機能を足す。中級）。manifest の feature から作った一覧（features.list）を、チェックで入れる／外す。
 * 専門語は出さない（上級の管理画面だけ）。入れる・探すボタンは置かない（PLAN-plugin-core §0）。
 * 足りないもの（ログイン・OBS）は、その行に出す。値（秘密）は扱わない。
 */
function initFeatures() {
  var root = panelRoot('features');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  var hint = root.querySelector('#features-hint');
  var box = root.querySelector('#features-list');
  var note = root.querySelector('#features-status');
  var busy = false;
  var mode = loadGroupMode();
  var lastList = null;
  var lastSets = [];
  hint.textContent = STR.featuresHint;
  function say(text) { note.textContent = text || ''; }
  function needText(need) {
    if (need.ok !== false) return '';
    if (need.kind === 'login') return STR.featuresNeedLogin(siteLabel(need.target));
    if (need.kind === 'obs') return STR.featuresNeedObs;
    if (need.kind === 'site') return STR.featuresNeedSite(siteLabel(need.target));
    return '';
  }
  function featureLine(f) {
    var line = mk('div', 'feature-row', null, { 'data-feature-row': f.id });
    var label = mk('label');
    var cb = mk('input', '', null, { type: 'checkbox', 'data-feature': f.id });
    cb.checked = f.on === true;
    if (!can.write) cb.disabled = true;
    cb.addEventListener('change', function () { toggle(f, cb); });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + f.label));
    line.appendChild(label);
    if (f.hint) line.appendChild(mk('span', 'timer-hint feature-hint', f.hint));
    // 足りないもの（サイトが入っていない・ログイン・OBS）は、オンでなくても出す（入っていないサイトの機能は使えない）
    f.needs.forEach(function (n) {
      if (!f.on && n.kind !== 'site') return;
      var t = needText(n);
      if (t) line.appendChild(mk('span', 'timer-hint feature-need', t));
    });
    if (f.on && f.openPanel) {
      var open = mk('button', 'timer-btn', STR.featuresOpen, { type: 'button', 'data-feature-open': f.id });
      open.addEventListener('click', function () { openPanel(f.openPanel); });
      line.appendChild(open);
    }
    return line;
  }
  function setLine(set) {
    var line = mk('div', 'feature-row', null, { 'data-set-row': set.id });
    var label = mk('label');
    var cb = mk('input', '', null, { type: 'checkbox', 'data-set': set.id });
    cb.checked = set.on === true;
    if (!can.write) cb.disabled = true;
    cb.addEventListener('change', function () { toggleSet(set, cb); });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + set.label));
    line.appendChild(label);
    var present = set.members.filter(function (m) { return m.present; });
    line.appendChild(mk('span', 'timer-hint feature-hint', STR.setCount(present.filter(function (m) { return m.on; }).length, present.length) + ' / ' + present.map(function (m) { return m.label; }).join('、')));
    if (set.missing.length) line.appendChild(mk('span', 'timer-hint feature-need', STR.setMissing(set.missing)));
    return line;
  }
  function paint(list) {
    lastList = list;
    while (box.firstChild) box.removeChild(box.firstChild);
    var rows = list.filter(function (f) { return f.level !== 'advanced' || levelAtLeast('advanced'); });
    box.appendChild(buildGroupSwitch(mode, function (next) { mode = next; paint(lastList); }));
    if (lastSets.length) {
      box.appendChild(mk('h3', '', STR.setsTitle));
      box.appendChild(mk('p', 'timer-hint', STR.setsHint));
      lastSets.forEach(function (set) { box.appendChild(setLine(set)); });
    }
    if (!rows.length) { box.appendChild(mk('p', 'empty', STR.featuresEmpty)); return; }
    groupRowsBy(rows, mode, function (f) { return { category: f.category, for: f.for, level: f.level }; }).forEach(function (g) {
      box.appendChild(mk('h3', 'feature-group', g.label, { 'data-feature-group': g.key }));
      g.rows.forEach(function (f) { box.appendChild(featureLine(f)); });
    });
  }
  function refresh() {
    if (busy) return Promise.resolve();
    return Promise.all([
      call('features.sets', {}).then(function (r) { lastSets = r && r.ok === true && Array.isArray(r.sets) ? r.sets : []; }).catch(function () { lastSets = []; }),
      call('features.list', {})
    ]).then(function (all) {
      var r = all[1];
      if (r && r.ok === true && Array.isArray(r.features)) { say(''); paint(r.features); }
      else say(STR.featuresFailed);
    }).catch(function () { say(STR.featuresFailed); });
  }
  function toggle(f, cb) {
    busy = true;
    say('');
    call('features.set', { id: f.id, enabled: cb.checked }).then(function (r) {
      busy = false;
      if (!r || r.ok !== true) {
        cb.checked = !cb.checked;
        say(r && r.error === 'streaming' ? STR.featuresStreaming : STR.featuresFailed);
        return;
      }
      refresh();
      // 核の画面（題名・コメント）は、モードの読み直しのあとに出す／引っ込める
      refreshPluginCatalog().then(function () { if (cb.checked && r.openPanel) openPanel(r.openPanel); });
    }).catch(function () { busy = false; cb.checked = !cb.checked; say(STR.featuresFailed); });
  }
  function toggleSet(set, cb) {
    busy = true;
    say('');
    call('features.setSet', { id: set.id, enabled: cb.checked }).then(function (r) {
      busy = false;
      if (!r || r.ok !== true) {
        cb.checked = !cb.checked;
        say(r && r.error === 'streaming' ? STR.featuresStreaming : STR.featuresFailed);
        return;
      }
      if (r.failed && r.failed.length) say(STR.featuresFailed);
      refresh();
      refreshPluginCatalog();
    }).catch(function () { busy = false; cb.checked = !cb.checked; say(STR.featuresFailed); });
  }
  function visible() { return root.offsetParent !== null; }
  refresh();
  setInterval(function () { if (visible()) refresh(); }, 15000);
  if (hubApi() && hubApi().subscribe) hubApi().subscribe(function (msg) { if (msg && msg.name === 'modes.changed' && visible()) refresh(); });
}

registerPanel('features', initFeatures);
