'use strict';

// 回線の余裕の画面（V7 C4。前は本体の ui/panels/uplink.js）。
// 読む API（uplink.estimate）は marust.call、保存（uplink.setSettings。windowOnly）は親の窓の中継（marust.relay）。
// 回線の見張りの入／切は、これまでこの画面の下にあったが、別プラグインの操作なので iframe からは呼べない。
// 「機能」の一覧と、回線の見張りの専用の画面（signal-monitor）から入／切できる。

var VERDICTS = {
  'ok': '余裕あり',
  'tight': 'ぎりぎり（上りの余裕が少ない）',
  'short': '足りない（このままだと途切れる恐れ）',
  'no-uplink': '上りの速さを入れてください',
  'unknown': 'ビットレートを読めませんでした（配信中、または OBS 側で設定があるときに分かります）',
  'no-targets': '使う予定の配信先がありません'
};

var mbps = document.getElementById('uplink-mbps');
var tight = document.getElementById('uplink-tight');
var short = document.getElementById('uplink-short');
var statusEl = document.getElementById('uplink-status');
var result = document.getElementById('uplink-result');
var saveButton = document.getElementById('uplink-save');

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function say(text) {
  statusEl.textContent = text;
}

function verdictText(v) {
  return Object.prototype.hasOwnProperty.call(VERDICTS, v) ? VERDICTS[v] : '—';
}

function plannedText(kbps, uplink, percent) {
  var planned = (Math.round(Number(kbps) / 100) / 10).toFixed(1) + ' Mbps';
  if (!(uplink > 0) || percent == null) return '使う予定: ' + planned;
  return '使う予定: ' + planned + ' ／ 上り ' + uplink + ' Mbps の ' + percent + '%';
}

function paint(res) {
  clear(result);
  if (!res || res.ok !== true) {
    say(res && res.error === 'unknown-method' ? '回線の余裕（プラグイン）が切ってあります。「機能」から入れると使えます。'
      : (res && res.error === 'not-connected' ? 'OBS につながっていないので読めません。先に「OBS とつなぐ」でつないでください。' : '計算できませんでした'));
    return;
  }
  say('');
  if (typeof res.uplinkMbps === 'number' && document.activeElement !== mbps) mbps.value = res.uplinkMbps > 0 ? String(res.uplinkMbps) : '';
  var cls = res.verdict === 'ok' ? 'broadcast-ok' : (res.verdict === 'tight' || res.verdict === 'short' ? 'broadcast-ng' : 'hint');
  result.appendChild(el('p', cls, verdictText(res.verdict)));
  if (res.knownCount > 0) result.appendChild(el('p', 'hint', plannedText(res.plannedKbps, res.uplinkMbps, res.ratioPercent)));
  if (res.unknownCount > 0) result.appendChild(el('p', 'hint', '不明 ' + (Number(res.unknownCount) || 0) + ' か所（足し算に入れていません）'));
  var rows = Array.isArray(res.targets) ? res.targets : [];
  if (!rows.length) return;
  var table = el('table');
  rows.forEach(function (row) {
    if (row.enabled !== true) return;
    var tr = el('tr');
    tr.appendChild(el('td', '', row.name || ''));
    var known = typeof row.kbps === 'number';
    var rate = known ? (Math.round(row.kbps / 100) / 10).toFixed(1) + ' Mbps（' + (row.source === 'live' ? '配信中の実測' : 'OBS の設定') + '）' : '不明';
    tr.appendChild(el('td', known ? '' : 'site-off', rate));
    table.appendChild(tr);
  });
  result.appendChild(table);
}

function run() {
  say('OBS から読んでいます…');
  window.marust.call('uplink.estimate', {}).then(paint);
}

function loadSettings() {
  // 設定の値だけ先に入れる（OBS を読まずに表示できる）。開いた直後の読み取りが失敗しても、文句は出さない
  window.marust.call('uplink.estimate', {}).then(function (res) {
    if (res && res.thresholds) {
      if (document.activeElement !== tight) tight.value = String(res.thresholds.tightPercent);
      if (document.activeElement !== short) short.value = String(res.thresholds.shortPercent);
    }
    if (res && res.ok === true) paint(res);
  });
}

function armButtons() {
  saveButton.disabled = window.marust.can().write !== true;
}

saveButton.addEventListener('click', function () {
  if (window.marust.can().write !== true) return;
  var body = {};
  var v = Number(mbps.value);
  if (mbps.value === '' || !(v >= 0)) { say('0 以上の数字で入れてください'); return; }
  body.uplinkMbps = v;
  if (tight.value) body.tightPercent = Number(tight.value);
  if (short.value) body.shortPercent = Number(short.value);
  window.marust.relay('uplink.setSettings', body).then(function (res) {
    if (res && res.error === 'unknown-method') { say('回線の余裕（プラグイン）が切ってあります。「機能」から入れると使えます。'); return; }
    if (!res || res.ok === false) { say('0 以上の数字で入れてください'); return; }
    say('保存しました');
    run();
  });
});
document.getElementById('uplink-run').addEventListener('click', run);
window.marust.onPerm(armButtons);
armButtons();
loadSettings();
