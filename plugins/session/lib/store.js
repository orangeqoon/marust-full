'use strict';

/**
 * セッションの置き場（K3）。以前は state.json の session だった。今はプラグイン自身の dataDir の session.json。
 * snapshot() / setSession() の形。保存はここの 1 か所だけ（L6b: 核の state.json の session は読まない。K3 で写し済み）。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;

function createSessionStore(options) {
  const dir = options && typeof options.dir === 'string' ? options.dir : '';
  const file = dir ? path.join(dir, 'session.json') : '';
  let session = null;

  function persist() {
    if (!file) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, session: session }) + '\n', 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (_) { return false; }
  }

  function load() {
    if (file) {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size <= MAX_BYTES) {
          const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
          session = data && data.session && typeof data.session === 'object' && !Array.isArray(data.session) ? data.session : null;
        }
      } catch (_) { /* 無ければセッション無し */ }
    }
    return session;
  }

  function snapshot() {
    return { session: session ? JSON.parse(JSON.stringify(session)) : null };
  }

  function setSession(next) {
    session = next && typeof next === 'object' ? JSON.parse(JSON.stringify(next)) : null;
    persist();
    return snapshot().session;
  }

  return { load, snapshot, setSession };
}

module.exports = { createSessionStore };
