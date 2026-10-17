'use strict';

/**
 * 起動前フック（manifest の boot。V6）に渡す口。プラグインの読み込み（loadAll）より前に 1 回、段階にも開発者モードにも関係なく動く。
 * 起動時の一度きりの移しかえ（dev-legacy-migrate）が使う。プラグインは本体のファイルを require せず、この口だけを使う
 * （本体が変わっても動く・単体で動く。モードのファイルの書き方は本体が持ち、AI が直接書かない決まりもここで守る）。
 *
 * 渡す口（ctx）:
 *   id / log(level, message) / stateDir
 *   modes.read()  → { ok, missing, writable, data（写し） }
 *   modes.write(next, tag) → { ok, error }   書く前に <modes>.<tag>.bak（あれば .<tag>.2.bak … .9.bak の最初の空き）を作る。作れなければ書かない
 *   settings.view() → ui-settings の読める値（getView）
 *   markers.has(name) / markers.place(name, value)   state/data/marust/<name>.json（済み印）
 *   rows() → [{ id, modeKey, legacyId, status }]   見つけたプラグインの行（modes のキーを写すため）
 *   announce({ method, paramNames, migrated })   modes.changed を 1 回・監査に 1 行
 * 秘密の値は扱わない。
 */

const fs = require('fs');
const path = require('path');
const { CHANGED_EVENT, isMode, legacyIdOf, modesPath, readModesDocument, writableShape } = require('./modes');

const MARKER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const TAG_RE = /^[a-z][a-z0-9]{0,15}$/;
const METHOD_RE = /^modes\.migrate(\.[a-z0-9]+)?$/;

function createBootContext(options) {
  const opts = options || {};
  const core = opts.core;
  const fsImpl = opts.fs || fs;
  const logger = typeof opts.logger === 'function' ? opts.logger : function () {};

  function markerFile(name) {
    if (!core || !core.STATE_DIR || !MARKER_RE.test(name)) return '';
    return path.join(core.STATE_DIR, 'data', 'marust', name + '.json');
  }

  return function contextFor(id, rowsFn) {
    return {
      id: String(id),
      stateDir: core && core.STATE_DIR ? core.STATE_DIR : '',
      isMode,
      log(level, message) { logger(level === 'error' || level === 'warn' ? level : 'info', String(id) + ' ' + String(message)); },
      modes: {
        read() {
          const read = readModesDocument(core, fsImpl);
          if (!read.ok) return { ok: false, missing: false, writable: false, data: null };
          return {
            ok: true,
            missing: read.missing,
            writable: read.missing || writableShape(read.data),
            data: read.missing ? null : JSON.parse(JSON.stringify(read.data))
          };
        },
        write(next, tag) {
          if (!core || typeof core.atomicWriteJsonSync !== 'function' || !TAG_RE.test(String(tag)) || !writableShape(next)) return { ok: false, error: 'failed' };
          const file = modesPath(core);
          if (!file) return { ok: false, error: 'failed' };
          if (fsImpl.existsSync(file)) {
            const names = [file + '.' + tag + '.bak'];
            for (let n = 2; n <= 9; n += 1) names.push(file + '.' + tag + '.' + n + '.bak');
            let backedUp = false;
            for (let i = 0; i < names.length && !backedUp; i += 1) {
              try {
                fsImpl.copyFileSync(file, names[i], fs.constants.COPYFILE_EXCL);
                backedUp = true;
              } catch (err) {
                if (!err || err.code !== 'EEXIST') return { ok: false, error: 'backup-failed' };
              }
            }
            if (!backedUp) return { ok: false, error: 'backup-failed' };
          }
          try {
            fsImpl.mkdirSync(path.dirname(file), { recursive: true });
            core.atomicWriteJsonSync(file, next);
          } catch (_) {
            return { ok: false, error: 'failed' };
          }
          return { ok: true };
        },
        provideResolver(resolver) {
          if (!opts.modeSource || typeof opts.modeSource.set !== 'function') return { ok: false, error: 'unavailable' };
          return opts.modeSource.set(resolver);
        }
      },
      settings: {
        view() {
          try { return opts.uiSettings && typeof opts.uiSettings.getView === 'function' ? opts.uiSettings.getView() || {} : {}; } catch (_) { return {}; }
        }
      },
      markers: {
        has(name) {
          const file = markerFile(name);
          return !!file && fsImpl.existsSync(file);
        },
        place(name, value) {
          const file = markerFile(name);
          if (!file || !core || typeof core.atomicWriteJsonSync !== 'function') return false;
          try {
            fsImpl.mkdirSync(path.dirname(file), { recursive: true });
            core.atomicWriteJsonSync(file, Object.assign({}, value && typeof value === 'object' ? value : {}, { at: new Date().toISOString() }));
            return true;
          } catch (_) {
            return false;
          }
        }
      },
      rows() {
        const list = typeof rowsFn === 'function' ? rowsFn() : [];
        return list.map((row) => ({
          id: String(row.id),
          modeKey: row.modeKey ? String(row.modeKey) : '',
          legacyId: legacyIdOf(String(row.id)),
          status: String(row.status || '')
        }));
      },
      announce(info) {
        const body = info || {};
        if (!METHOD_RE.test(String(body.method))) return;
        if (opts.bus && typeof opts.bus.publish === 'function') {
          try { opts.bus.publish(CHANGED_EVENT, { id: '*', mode: '', migrated: Number(body.migrated) || 0 }, { source: 'modes' }); } catch (_) { /* 書き込みは済んでいる */ }
        }
        if (opts.audit && typeof opts.audit.write === 'function') {
          const names = Array.isArray(body.paramNames) ? body.paramNames.map(String).filter((n) => /^[a-z]+:[0-9]+$/.test(n)) : [];
          try { opts.audit.write({ clientId: 'host', kind: 'host', method: String(body.method), paramNames: names, ok: true, error: '' }); } catch (_) { /* 監査に書けなくても続ける */ }
        }
      }
    };
  };
}

module.exports = { createBootContext };
