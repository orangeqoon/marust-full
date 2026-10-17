'use strict';

/**
 * 出口で金庫の値を伏せる（L8a）。
 * 長さ 6 文字以上の秘密を覚え、テキストやオブジェクト内の該当文字列を *** に伏せる。
 * 核・一層目・プラグインの各出口で利用される。
 * 値そのものはこのモジュールの外に出さない（一覧を返す関数は作らない）。
 */

function createSecretMask() {
  const secrets = new Set();
  let sortedSecrets = [];
  let dirty = false;

  function remember(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length < 6) return;
    if (!secrets.has(trimmed)) {
      secrets.add(trimmed);
      dirty = true;
    }
  }

  function forget(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (secrets.delete(trimmed)) {
      dirty = true;
    }
  }

  function ensureSorted() {
    if (!dirty) return;
    sortedSecrets = Array.from(secrets).sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    dirty = false;
  }

  function mask(text) {
    if (secrets.size === 0) return text;
    if (typeof text !== 'string') {
      if (text == null) return '';
      text = String(text);
    }
    ensureSorted();
    let out = text;
    for (let i = 0; i < sortedSecrets.length; i += 1) {
      const secret = sortedSecrets[i];
      if (out.indexOf(secret) !== -1) {
        out = out.split(secret).join('***');
      }
    }
    return out;
  }

  function maskDeep(obj) {
    const seen = new WeakSet();
    function walk(val, depth) {
      if (depth > 20) return '[depth-limit]';
      if (val === null || val === undefined) return val;
      if (typeof val === 'string') return mask(val);
      if (typeof val !== 'object') return val;
      if (seen.has(val)) return '[circular]';
      seen.add(val);
      if (Array.isArray(val)) {
        const copy = [];
        for (let i = 0; i < val.length; i += 1) {
          copy.push(walk(val[i], depth + 1));
        }
        return copy;
      }
      if (val instanceof Date) {
        return new Date(val.getTime());
      }
      if (val instanceof RegExp) {
        return new RegExp(val.source, val.flags);
      }
      if (val instanceof Error) {
        const copy = {
          name: val.name,
          message: mask(val.message)
        };
        if (typeof val.stack === 'string') {
          copy.stack = mask(val.stack);
        }
        if (val.code !== undefined) {
          copy.code = val.code;
        }
        return copy;
      }
      const copy = {};
      const keys = Object.keys(val);
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        copy[k] = walk(val[k], depth + 1);
      }
      return copy;
    }
    return walk(obj, 0);
  }

  return {
    remember,
    forget,
    mask,
    maskDeep
  };
}

const defaultMask = createSecretMask();

module.exports = {
  createSecretMask,
  defaultMask
};
