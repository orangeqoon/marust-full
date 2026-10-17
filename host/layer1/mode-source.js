'use strict';

function createModeSource() {
  let resolver = null;
  return {
    set(candidate) {
      if (!candidate || typeof candidate.modeFor !== 'function') return { ok: false, error: 'bad-resolver' };
      if (resolver) return { ok: false, error: 'already-set' };
      resolver = candidate;
      return { ok: true };
    },
    get() {
      return resolver;
    },
    has() {
      return resolver !== null;
    }
  };
}

module.exports = { createModeSource };
