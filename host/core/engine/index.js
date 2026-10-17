'use strict';

/**
 * エンジン id から実装への登録表。
 * Core はここ経由で呼び、obs-local を直接 require しない。
 */

function createEngineRegistry() {
  const map = new Map();

  function register(id, engine) {
    const name = typeof id === 'string' ? id : '';
    if (!name || !engine || typeof engine !== 'object') return { ok: false, error: 'bad-engine' };
    map.set(name, engine);
    return { ok: true };
  }

  function get(id) {
    return map.get(String(id || '')) || null;
  }

  function list() {
    return Array.from(map.keys());
  }

  function only() {
    const ids = list();
    if (ids.length !== 1) return null;
    return get(ids[0]);
  }

  async function emergencyStop(ctx) {
    const results = [];
    for (const [id, engine] of map) {
      let caps = {};
      try {
        caps = engine && typeof engine.capabilities === 'function' ? engine.capabilities() : {};
      } catch (_) {
        caps = {};
      }
      if (!caps || caps.emergencyStop !== true || typeof engine.stopAll !== 'function') {
        results.push({ id: id, ok: false, error: 'no-emergency' });
        continue;
      }
      try {
        const result = await engine.stopAll(ctx || {});
        results.push(Object.assign({ id: id }, result && typeof result === 'object' ? result : { ok: true }));
      } catch (_) {
        results.push({ id: id, ok: false, error: 'failed' });
      }
    }
    return { ok: results.length > 0 && results.every((row) => row.ok !== false), results: results };
  }

  return { register, get, list, only, emergencyStop };
}

function createDefaultRegistry(deps) {
  const registry = createEngineRegistry();
  const { createObsLocalEngine } = require('./obs-local');
  const engine = createObsLocalEngine(deps || {});
  registry.register(engine.id || 'obs-local', engine);
  return { registry, engine };
}

module.exports = { createEngineRegistry, createDefaultRegistry };
