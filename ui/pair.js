'use strict';
document.getElementById('pair-form').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var code = document.getElementById('pair-input').value.trim();
  var error = document.getElementById('pair-error');
  fetch('/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code })
  }).then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
    .then(function (result) {
      if (result.body && result.body.ok) {
        window.location.assign('/');
        return;
      }
      error.textContent = 'コードが違います。もう一度、ウィンドウに出ているコードを入力してください。';
    }).catch(function () {
      error.textContent = '接続できませんでした。';
    });
});
