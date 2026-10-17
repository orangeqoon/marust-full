'use strict';

/**
 * オーバーレイの最新値と SSE の購読。
 * 値の選別は registry が済ませてから publish する。ここは配るだけ。
 */

const { MAX_OVERLAY_CLIENTS } = require('./plugin-surface');

function createOverlayHub(options) {
  const opts = options || {};
  const maxConnections = Number.isInteger(opts.maxConnections) && opts.maxConnections >= 1
    ? opts.maxConnections
    : MAX_OVERLAY_CLIENTS;
  const latest = new Map();
  const listeners = new Map();
  const counts = new Map();

  function key(pluginId, name) {
    return String(pluginId) + '\n' + String(name);
  }

  function publish(pluginId, name, values) {
    const id = key(pluginId, name);
    const next = Object.assign({}, values || {});
    latest.set(id, next);
    const set = listeners.get(id);
    if (set) {
      const copy = Object.assign({}, next);
      for (const fn of Array.from(set)) {
        try { fn(copy); } catch (_) { /* one listener must not stop the rest */ }
      }
    }
    return Object.assign({}, next);
  }

  function getLatest(pluginId, name) {
    return Object.assign({}, latest.get(key(pluginId, name)) || {});
  }

  function subscribe(pluginId, name, fn) {
    if (typeof fn !== 'function') return function unsubscribe() {};
    const id = key(pluginId, name);
    let set = listeners.get(id);
    if (!set) {
      set = new Set();
      listeners.set(id, set);
    }
    set.add(fn);
    return function unsubscribe() {
      set.delete(fn);
    };
  }

  function acquire(pluginId, name) {
    const id = key(pluginId, name);
    const count = counts.get(id) || 0;
    if (count >= maxConnections) return null;
    counts.set(id, count + 1);
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      const current = counts.get(id) || 0;
      counts.set(id, Math.max(0, current - 1));
    };
  }

  return { publish, getLatest, subscribe, acquire, maxConnections };
}

module.exports = { createOverlayHub };
