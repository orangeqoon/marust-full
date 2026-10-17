'use strict';

// バックアップの画面（V7 C5。前は本体の ui/panels/settings-export.js のバックアップの部分）。
// 引っ越し（別の PC へ。合言葉つき）は本体の画面 migration に残した（切れない機能。V3 §0-17）。
// 読む API（settings.preview）は marust.call、書き込み（settings.exportToFile・settings.import。windowOnly）は
// 親の窓の中継（marust.relay）。反映の前の確認は親が出す窓（marust.confirm）。

var statusEl = document.getElementById('settings-export-status');
var listEl = document.getElementById('settings-export-list');
var fileEl = document.getElementById('settings-export-file');
var exportBtn = document.getElementById('settings-export-save');
var importBtn = document.getElementById('settings-export-open');
var applyBtn = document.getElementById('settings-export-apply');
var isWindow = false;
var pending = null;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(text) {
  statusEl.textContent = text || '';
}

function writable() {
  return window.marust.can().write === true;
}

function offText() {
  return 'バックアップ（プラグイン）は切ってあります。「機能」から入れると使えます。';
}

function selectedSections() {
  var boxes = listEl.querySelectorAll('input[type="checkbox"]');
  var ids = [];
  for (var i = 0; i < boxes.length; i += 1) {
    if (boxes[i].checked) ids.push(boxes[i].value);
  }
  return ids;
}

function syncApply() {
  applyBtn.disabled = !isWindow || !writable() || !pending || selectedSections().length < 1;
}

function paintWindow() {
  exportBtn.disabled = !isWindow;
  importBtn.disabled = !isWindow;
  if (!isWindow) applyBtn.disabled = true;
  else syncApply();
}

function paintPreview(items) {
  clear(listEl);
  var rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    listEl.appendChild(el('p', 'empty', '項目はありません。'));
    syncApply();
    return;
  }
  var ul = el('ul', 'settings-export-list');
  rows.forEach(function (item) {
    var row = item || {};
    var li = document.createElement('li');
    var label = document.createElement('label');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.value = row.section == null ? '' : String(row.section);
    box.addEventListener('change', syncApply);
    var count = typeof row.count === 'number' ? row.count : 0;
    label.appendChild(box);
    label.appendChild(el('span', '', (row.name || row.section || '') + '（' + count + '）'));
    li.appendChild(label);
    var names = Array.isArray(row.names) ? row.names : [];
    if (names.length) {
      var shown = names.slice(0, 8).map(function (name) { return String(name); });
      var text = shown.join('、');
      if (names.length > shown.length) text += '、ほか';
      li.appendChild(el('p', 'hint', text));
    }
    ul.appendChild(li);
  });
  listEl.appendChild(ul);
  syncApply();
}

function refreshWindow() {
  window.marust.call('hub.getState', {}).then(function (state) {
    isWindow = !!(state && state.clientId === 'local-window');
    paintWindow();
    if (!isWindow) setStatus('この操作はこの PC のウィンドウだけです。');
  });
}

exportBtn.addEventListener('click', function () {
  if (!isWindow) return;
  // 保存ダイアログに頼らず、本体が STATE_DIR/exports に書く。押した直後に必ず状態を出す。
  setStatus('書き出し中…');
  exportBtn.disabled = true;
  window.marust.relay('settings.exportToFile', {}).then(function (res) {
    if (res && res.ok === false && res.error === 'unknown-method') { setStatus(offText()); return; }
    if (!res || res.ok === false) {
      setStatus('書き出せませんでした（' + (res && res.error ? String(res.error) : 'failed') + '）');
      return;
    }
    setStatus('書き出しました: ' + (res.dir || '') + '/' + (res.filename || ''));
  }).then(function () {
    exportBtn.disabled = !isWindow;
  });
});

importBtn.addEventListener('click', function () {
  if (!isWindow) return;
  fileEl.value = '';
  fileEl.click();
});

fileEl.addEventListener('change', function () {
  var picked = fileEl.files && fileEl.files[0];
  if (!picked || !isWindow) return;
  var reader = new FileReader();
  reader.onload = function () {
    var parsed;
    try { parsed = JSON.parse(String(reader.result || '')); } catch (err) {
      pending = null;
      paintPreview([]);
      setStatus('bad-document');
      return;
    }
    window.marust.call('settings.preview', { document: parsed }).then(function (res) {
      if (res && res.ok === false && res.error === 'unknown-method') { pending = null; paintPreview([]); setStatus(offText()); return; }
      if (!res || res.ok === false) {
        pending = null;
        paintPreview([]);
        setStatus(res && res.error ? String(res.error) : 'failed');
        return;
      }
      pending = parsed;
      paintPreview(res.items);
      setStatus('反映する項目を選んでください。反映の前に今の設定を控えます。');
    });
  };
  reader.onerror = function () { setStatus('failed'); };
  reader.readAsText(picked, 'utf-8');
});

applyBtn.addEventListener('click', function () {
  if (!isWindow || !writable() || !pending) return;
  var sections = selectedSections();
  if (!sections.length) return;
  applyBtn.disabled = true;
  // 設定を書き換える操作なので、親が出す確認の窓で 1 回聞く
  window.marust.confirm('選んだ項目を、今の設定に反映します（反映の前に今の設定を控えます）。よろしいですか？', { yes: '反映する', no: 'やめる' }).then(function (ok) {
    if (!ok) { syncApply(); return null; }
    return window.marust.relay('settings.import', { document: pending, sections: sections }).then(function (res) {
      if (res && res.ok === false && res.error === 'unknown-method') { setStatus(offText()); syncApply(); return; }
      if (!res || res.ok === false) {
        setStatus(res && res.error ? String(res.error) : 'failed');
        syncApply();
        return;
      }
      setStatus('反映しました');
      syncApply();
    });
  });
});

window.marust.onPerm(function () { paintWindow(); });
refreshWindow();
