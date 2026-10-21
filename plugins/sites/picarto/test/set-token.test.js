'use strict';

// Picarto のトークンをパネルから金庫へ入れる（setToken）。値は答えに出ない・他の項目は残す・形の悪い値は断る。
const assert = require('assert');
const site = require('../site');

function box(initial) {
  const store = { value: initial };
  return {
    store,
    secrets: {
      get: async () => (store.value == null ? { ok: false } : { ok: true, value: store.value }),
      set: async (name, value) => { assert.strictEqual(name, 'picarto.config'); store.value = value; return { ok: true }; }
    }
  };
}

(async () => {
  const setToken = site.actions.setToken;
  assert.strictEqual(typeof setToken, 'function');

  const b = box(JSON.stringify({ token: 'old', channel: 'mine' }));
  const res = await setToken({ token: '  new-token  ' }, b);
  assert.deepStrictEqual(res, { ok: true });
  assert.deepStrictEqual(JSON.parse(b.store.value), { token: 'new-token', channel: 'mine' });
  assert.ok(!JSON.stringify(res).includes('new-token'));

  const fresh = box(null);
  assert.deepStrictEqual(await setToken({ token: 't' }, fresh), { ok: true });
  assert.deepStrictEqual(JSON.parse(fresh.store.value), { token: 't' });

  for (const bad of ['', '   ', 'a\nb', 'ここにトークン', 'x'.repeat(2001), 5, undefined]) {
    assert.deepStrictEqual(await setToken({ token: bad }, box(null)), { ok: false, error: 'bad-token' }, String(bad).slice(0, 10));
  }
  assert.deepStrictEqual(await setToken({ token: 't' }, {}), { ok: false, error: 'unavailable' });

  const manifest = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.roles.site.actions.setToken, 'write');
  console.log('picarto set-token: ok');
})().catch((e) => { console.error(e); process.exit(1); });
