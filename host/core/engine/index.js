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
    const timeoutMs = (ctx && Number.isFinite(ctx.timeoutMs)) ? ctx.timeoutMs : 5000;
    const tasks = Array.from(map.entries()).map(async ([id, engine]) => {
      let caps = {};
      try { caps = typeof engine?.capabilities === 'function' ? engine.capabilities() : {}; } catch (_) {}
      if (!caps || caps.emergencyStop !== true || typeof engine?.stopAll !== 'function') {
        return { id, ok: false, accepted: false, verified: false, error: 'no-emergency' };
      }
      let timer = null;
      try {
        const p = Promise.resolve().then(() => engine.stopAll(ctx || {}));
        p.catch(() => {});
        const res = await Promise.race([p, new Promise((r) => { timer = setTimeout(() => r('__to'), timeoutMs); })]);
        if (timer) clearTimeout(timer);
        if (res === '__to') return { id, ok: false, accepted: true, verified: false, error: 'emergency-stop-timeout' };
        const o = (res && typeof res === 'object') ? res : { ok: true };
        const isOk = o.ok !== false;
        return Object.assign({ id, accepted: true, verified: Boolean(isOk) }, o, { ok: isOk });
      } catch (_) {
        if (timer) clearTimeout(timer);
        return { id, ok: false, accepted: true, verified: false, error: 'failed' };
      }
    });
    const results = await Promise.all(tasks);
    return { ok: results.length > 0 && results.every((row) => row.ok !== false), results };
  }

  function resolveForDestination(dest) {
    const req = dest?.engine?.id && typeof dest.engine.id === 'string' ? dest.engine.id.trim() : '';
    return req ? get(req) : (get('obs-local') || only());
  }

  return { register, get, list, only, resolveForDestination, emergencyStop };
}

function createDefaultRegistry(deps) {
  const registry = createEngineRegistry();
  const { createObsLocalEngine } = require('./obs-local');
  const engine = createObsLocalEngine(deps || {});
  registry.register(engine.id || 'obs-local', engine);
  if (deps && deps.core && typeof deps.core.attachEngine === 'function') {
    deps.core.attachEngine(engine);
  }
  return { registry, engine };
}

module.exports = { createEngineRegistry, createDefaultRegistry };
