(function () {
  'use strict';
  var btn = document.getElementById('copy');
  var done = document.getElementById('copied');
  if (!btn || !done) return;
  btn.addEventListener('click', function () {
    var text = document.getElementById('guide').textContent;
    var ok = function () { done.textContent = 'コピーしました'; };
    var ng = function () { done.textContent = 'コピーできませんでした。文を選んでコピーしてください'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, ng); else ng();
  });
})();
