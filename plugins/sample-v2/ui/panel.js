'use strict';

const out = document.getElementById('out');
let seq = 0;

document.getElementById('save').addEventListener('click', () => {
  seq += 1;
  parent.postMessage({
    type: 'marust:call',
    id: String(seq),
    method: 'plugin.sample-v2.remember',
    params: { note: '見本' }
  }, location.origin);
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'marust:result') out.textContent = msg.result && msg.result.ok ? 'ok' : 'ng';
  if (msg.type === 'marust:event') out.textContent = msg.name || '';
});
