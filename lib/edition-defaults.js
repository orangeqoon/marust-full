'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SETTINGS_BYTES = 256 * 1024;
const EDITIONS = Object.freeze({
  minimum: Object.freeze({ devMode: false, uiLevel: 'standard' }),
  full: Object.freeze({ devMode: true, uiLevel: 'advanced' })
});

function readBuildInfo(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (_) { return null; }
}

function applyEditionDefaults(options) {
  const opts = options || {};
  const info = opts.buildInfo || (opts.buildInfoPath ? readBuildInfo(opts.buildInfoPath) : null);
  if (!info || info.distribution !== 'edition' || !Object.prototype.hasOwnProperty.call(EDITIONS, info.edition)) {
    return { ok: true, applied: false, reason: 'no-edition-defaults' };
  }
  if (typeof opts.stateDir !== 'string' || !opts.stateDir) return { ok: false, applied: false, reason: 'state-unavailable' };

  const file = path.join(opts.stateDir, 'data', 'marust', 'ui-settings.json');
  let data = {};
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return { ok: false, applied: false, reason: 'settings-unreadable' };
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, applied: false, reason: 'settings-unreadable' };
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return { ok: false, applied: false, reason: 'settings-unreadable' };
  }

  const defaults = EDITIONS[info.edition];
  const next = Object.assign({}, data);
  const applied = [];
  for (const key of ['devMode', 'uiLevel']) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      next[key] = defaults[key];
      applied.push(key);
    }
  }
  if (!applied.length) return { ok: true, applied: false, reason: 'already-configured' };
  try {
    if (typeof opts.atomicWriteJsonSync === 'function') opts.atomicWriteJsonSync(file, next);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
  } catch (_) { return { ok: false, applied: false, reason: 'settings-write-failed' }; }
  return { ok: true, applied: true, edition: info.edition, keys: applied };
}

module.exports = { applyEditionDefaults, EDITIONS };
