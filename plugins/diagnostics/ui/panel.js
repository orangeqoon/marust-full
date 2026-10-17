'use strict';

// 診断の画面（K3 で本体の ui/panels/diagnostics.js から移した）。diagnostics.run（読むだけ。このプラグインが出す）を親の画面経由で呼ぶ。
var LABELS = {
  'agent-uptime': 'Agent の稼働時間',
  'gateway-listening': '窓口の待ち受け',
  'plugin-start-failed': 'プラグインの起動に失敗',
  'plugin-stuck': 'プラグインが止まっている',
  'plugin-status': 'プラグインの状態',
  'engine-disconnected': 'OBS エンジンが未接続',
  'engine-unsupported': 'OBS エンジンが非対応',
  'engine-status': 'OBS エンジン',
  'vault-unavailable': '金庫が使えない',
  'vault-status': '金庫',
  'logs-large': 'ログの容量が大きい',
  'logs-volume': 'ログの容量',
  'state-read-only': '状態ファイルが新しい版',
  'modes-unreadable': 'モード設定を読めない',
  'diagnostics-timeout': '診断を打ち切った',
  'recent-errors': '直近のエラー符号'
};
var listEl = document.getElementById('diagnostics-list');
var statusEl = document.getElementById('diagnostics-status');
var buttonEl = document.getElementById('diagnostics-run');

function paint(result) {
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  var findings = result && result.findings;
  if (!findings || !findings.length) {
    var empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '診断項目はありません';
    listEl.appendChild(empty);
  } else {
    var ul = document.createElement('ul');
    ul.className = 'diag-list';
    for (var i = 0; i < findings.length; i += 1) {
      var row = findings[i] || {};
      var li = document.createElement('li');
      var level = row.level === 'ok' || row.level === 'warn' || row.level === 'error' ? row.level : 'warn';
      li.className = 'diag-' + level;
      var code = typeof row.code === 'string' ? row.code : '';
      var label = LABELS[code] || '';
      var detail = typeof row.detail === 'string' ? row.detail : '';
      if (detail.length > 120) detail = detail.slice(0, 120);
      var bits = [];
      if (code) bits.push(code);
      if (label) bits.push(label);
      if (detail) bits.push(detail);
      li.textContent = bits.join(' ');
      ul.appendChild(li);
    }
    listEl.appendChild(ul);
  }
  if (result && result.recentErrors && result.recentErrors.length) {
    var extra = document.createElement('p');
    extra.className = 'diag-warn';
    extra.textContent = '直近のエラー符号: ' + result.recentErrors.join(', ');
    listEl.appendChild(extra);
  }
}

function refresh() {
  statusEl.textContent = '';
  window.marust.call('diagnostics.run', {}).then(function (res) {
    if (!res || (res.ok === false && res.error && !res.findings)) {
      statusEl.textContent = '診断できませんでした';
      paint(null);
      return;
    }
    paint(res);
  }).catch(function () {
    statusEl.textContent = '診断できませんでした';
    paint(null);
  });
}

buttonEl.addEventListener('click', refresh);
refresh();
