'use strict';

// コメント送信（sink の役目）のパネル。ID は sink- で始まる。更新ボタンは節で共有。
(function () {
  const configuredEl = document.getElementById('sink-configured');
  const resultEl = document.getElementById('sink-result');
  const atEl = document.getElementById('sink-at');
  const RESULT = { ok: '\u6210\u529f', ng: '\u5931\u6557' };
  const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  let seq = 0;
  let pending = '';

  function call() {
    seq += 1;
    pending = 'sink' + seq;
    parent.postMessage({
      type: 'marust:call',
      id: pending,
      method: 'plugin.sink-picarto.getStatus',
      params: {}
    }, location.origin);
  }

  function show(result) {
    configuredEl.textContent = result && result.configured === true ? '\u3042\u308a' : '\u306a\u3057';
    const code = result && result.result;
    resultEl.textContent = RESULT[code] || '-';
    resultEl.className = code === 'ng' ? 'is-bad' : '';
    const at = result && result.at;
    atEl.textContent = typeof at === 'string' && TIME_RE.test(at) ? at : '-';
  }

  document.getElementById('refresh').addEventListener('click', call);
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'marust:result') return;
    if (String(msg.id) !== pending) return;
    const result = msg.result;
    if (!result || result.ok !== true) {
      resultEl.textContent = '\u5931\u6557';
      resultEl.className = 'is-bad';
      return;
    }
    show(result);
  });

  call();
  setInterval(call, 3000);
})();
