(function () {
  'use strict';
  // 親の画面の検査済みの色だけを、形を確かめ直して当てる（CSSOM だけ。CSS の文字列は受け取らない）
  var names = ['bg', 'panel', 'panel-2', 'line', 'line-2', 'text', 'muted', 'accent', 'ok', 'warn', 'skip', 'danger', 'input-bg', 'tab-bar-bg', 'tab-active-bg', 'tab-inactive-bg'];
  var color = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.type !== 'marust:event' || msg.name !== 'theme') return;
    var t = msg.payload || {};
    var root = document.documentElement;
    var vars = t.vars && typeof t.vars === 'object' ? t.vars : {};
    names.forEach(function (name) {
      var value = vars[name];
      if (typeof value === 'string' && color.test(value)) root.style.setProperty('--' + name, value);
      else root.style.removeProperty('--' + name);
    });
    root.style.setProperty('color-scheme', t.colorScheme === 'light' ? 'light' : 'dark');
  });
})();
