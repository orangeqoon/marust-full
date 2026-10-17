'use strict';

/**
 * ウィンドウ以外からの write / emergency / ウィンドウ専用の操作と、承認・却下。
 * ファイルは core.STATE_DIR/logs/marust/api-YYYYMMDD.jsonl。
 * 残すのは引数の名前だけ。値は書かない。
 */

const path = require('path');
const { appendJsonl } = require('../core');

function localDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
}

function asDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  return new Date();
}

function createAudit(options) {
  const opts = options || {};
  const core = opts.core || {};
  const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };

  function fileFor(date) {
    if (!core.STATE_DIR) return '';
    const day = localDay(date || asDate(now()));
    return path.join(core.STATE_DIR, 'logs', 'marust', 'api-' + day + '.jsonl');
  }

  function write(entry) {
    const file = fileFor();
    if (!file) return { ok: false, error: 'no-state' };
    const src = entry && typeof entry === 'object' ? entry : {};
    const names = [];
    const given = Array.isArray(src.paramNames) ? src.paramNames : [];
    for (let i = 0; i < given.length; i += 1) {
      if (typeof given[i] === 'string') names.push(given[i]);
    }
    const row = {
      at: asDate(now()).toISOString(),
      clientId: src.clientId == null ? '' : String(src.clientId),
      kind: src.kind == null ? '' : String(src.kind),
      method: src.method == null ? '' : String(src.method),
      paramNames: names,
      ok: src.ok === true,
      error: src.ok === true ? '' : (src.error == null ? '' : String(src.error))
    };
    const ok = appendJsonl(path.dirname(file), 'api', row, { now: asDate(now()) });
    if (!ok) return { ok: false, error: 'failed' };
    return { ok: true, file: file };
  }

  return { write: write, fileFor: fileFor };
}

module.exports = { createAudit, localDay };
