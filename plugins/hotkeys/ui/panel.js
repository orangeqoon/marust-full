'use strict';

// ホットキーの一覧と編集の画面（V7 C4。前は本体の ui/panels/hotkeys.js）。
// 読む API（hotkeys.list）は marust.call、保存（hotkeys.save。windowOnly の書き込み）は親の窓の中継（marust.relay）。
// キーを押したときの知らせ（hotkey.result）は、この画面を開いていなくても出す必要があるので、本体の画面が出す（ui/hub.js）。

var listBox = document.getElementById('hotkey-list');
var editor = document.getElementById('hotkey-editor');
var rowsBox = document.getElementById('hotkey-rows');
var statusEl = document.getElementById('hotkey-status');
var addButton = document.getElementById('hotkey-add');
var saveButton = document.getElementById('hotkey-save');
var isWindow = false;
var draft = [];

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function writable() {
  return window.marust.can().write === true;
}

function paramsText(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return '{}';
  try { return JSON.stringify(params); } catch (err) { return '{}'; }
}

function markText(row) {
  if (row.off === true) return 'このキーの機能は切ってあります';
  if (row.registered === true) return '登録済み';
  if (row.registered === false) return '未登録';
  return '';
}

function paintList() {
  clear(listBox);
  if (!draft.length) {
    listBox.appendChild(el('p', 'empty', 'ホットキーはありません。'));
    return;
  }
  draft.forEach(function (row) {
    var bits = [row.accelerator || '', row.label || row.method || '', markText(row)];
    listBox.appendChild(el('p', '', bits.filter(Boolean).join(' / ')));
  });
}

function field(name, value, placeholder) {
  var input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('data-field', name);
  input.value = value == null ? '' : String(value);
  input.placeholder = placeholder;
  return input;
}

function paintEditor() {
  clear(rowsBox);
  draft.forEach(function (row, i) {
    var box = el('div', 'hotkey-row');
    box.setAttribute('data-hotkey-row', String(i));
    box.appendChild(field('accelerator', row.accelerator, 'キー'));
    box.appendChild(field('method', row.method, 'メソッド'));
    box.appendChild(field('label', row.label, '表示名'));
    var params = document.createElement('textarea');
    params.setAttribute('data-field', 'params');
    params.value = paramsText(row.params);
    box.appendChild(params);
    box.appendChild(el('p', 'hint', markText(row)));
    var remove = el('button', '', '外す');
    remove.type = 'button';
    remove.disabled = !writable();
    remove.addEventListener('click', function () {
      if (!isWindow || !writable()) return;
      var current = collect();
      if (current.error) { statusEl.textContent = current.error; return; }
      current.bindings.splice(i, 1);
      draft = current.bindings;
      paintEditor();
    });
    box.appendChild(remove);
    rowsBox.appendChild(box);
  });
}

function paint() {
  editor.hidden = !isWindow;
  listBox.hidden = isWindow;
  if (isWindow) paintEditor();
  else paintList();
  addButton.disabled = !writable();
  saveButton.disabled = !writable();
}

function takeDraft(bindings) {
  var items = Array.isArray(bindings) ? bindings : [];
  draft = items.map(function (item) {
    var row = item && typeof item === 'object' ? item : {};
    return {
      accelerator: row.accelerator == null ? '' : String(row.accelerator),
      method: row.method == null ? '' : String(row.method),
      label: row.label == null ? '' : String(row.label),
      params: row.params && typeof row.params === 'object' && !Array.isArray(row.params) ? row.params : {},
      registered: row.registered === true,
      off: row.off === true
    };
  });
}

function refresh() {
  window.marust.call('hub.getState', {}).then(function (state) {
    isWindow = !!(state && state.clientId === 'local-window');
    return window.marust.call('hotkeys.list', {});
  }).then(function (res) {
    if (!res || res.ok === false) {
      draft = [];
      statusEl.textContent = res && res.error ? String(res.error) : 'unavailable';
      paint();
      return;
    }
    statusEl.textContent = '';
    takeDraft(res.bindings);
    paint();
  });
}

function collect() {
  var nodes = rowsBox.children;
  var bindings = [];
  for (var i = 0; i < nodes.length; i += 1) {
    var node = nodes[i];
    var raw = node.querySelector('[data-field="params"]').value.trim();
    var params = {};
    if (raw) {
      try { params = JSON.parse(raw); } catch (err) { return { error: 'bad-params' }; }
      if (!params || typeof params !== 'object' || Array.isArray(params)) return { error: 'bad-params' };
    }
    bindings.push({
      accelerator: node.querySelector('[data-field="accelerator"]').value,
      method: node.querySelector('[data-field="method"]').value,
      label: node.querySelector('[data-field="label"]').value,
      params: params
    });
  }
  return { bindings: bindings };
}

addButton.addEventListener('click', function () {
  if (!isWindow || !writable()) return;
  var current = collect();
  if (current.error) { statusEl.textContent = current.error; return; }
  draft = current.bindings;
  draft.push({ accelerator: '', method: '', label: '', params: {}, registered: false });
  paintEditor();
});

saveButton.addEventListener('click', function () {
  if (!isWindow || !writable()) return;
  var current = collect();
  if (current.error) { statusEl.textContent = current.error; return; }
  window.marust.relay('hotkeys.save', { bindings: current.bindings }).then(function (res) {
    if (!res || res.ok === false) {
      var text = res && res.error ? String(res.error) : 'failed';
      if (res && typeof res.index === 'number') text += ' #' + res.index;
      statusEl.textContent = text;
      return;
    }
    statusEl.textContent = '保存しました';
    refresh();
  });
});

window.marust.onPerm(paint);
refresh();
