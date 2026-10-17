'use strict';

/**
 * Secret Provider の口。
 * getFor(pluginId, name) → Promise<{ ok: true, value: string } | { ok: false, error: string }>（持ち主は bindDeclared で渡された宣言から核が決める）
 * error は短いコードだけ。値は返さないし、ログにも残さない。
 * 宣言に無い名前は not-declared で止める。この仮実装は常に unavailable。
 */

function createUnavailableProvider() {
  return {
    getFor(_pluginId, _name) {
      return Promise.resolve({ ok: false, error: 'unavailable' });
    },
    bindDeclared() { return false; }
  };
}

function safeSecretError(code) {
  return typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code) ? code : 'unavailable';
}

module.exports = { createUnavailableProvider, safeSecretError };
