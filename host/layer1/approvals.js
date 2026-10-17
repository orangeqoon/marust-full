'use strict';

/**
 * requiresApproval の端末からの write を、実行せずに預かる。
 * 期限は 2 分。承認・却下・期限切れは approval.resolved として渡す。
 * 引数の値は外に出さない（paramNames だけ）。実行に必要な値はメモリにだけ置く。
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 120000;

function createApprovals(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 1 ? opts.ttlMs : DEFAULT_TTL_MS;
  const setTimer = opts.setTimer || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  const onResolved = typeof opts.onResolved === 'function' ? opts.onResolved : function () {};
  const pending = new Map();

  function clearRowTimer(row) {
    if (!row || row.timer == null) return;
    clearTimer(row.timer);
    row.timer = null;
  }

  function emit(row, result, settlement) {
    const settled = result && typeof result === 'object' ? result : { ok: false, error: 'failed' };
    const payload = {
      approvalId: row.id,
      method: row.method,
      clientId: row.clientId,
      kind: row.kind,
      ok: settled.ok === true,
      error: settled.ok === true ? '' : (settled.error || settled.reason || 'failed'),
      settlement: settlement,
      result: settled
    };
    try { onResolved(payload); } catch (_) { /* 受け手が落ちても預かりは終わっている */ }
    return payload;
  }

  function drop(id, result, settlement) {
    const row = pending.get(id);
    if (!row) return null;
    pending.delete(id);
    clearRowTimer(row);
    return emit(row, result, settlement);
  }

  function expire(id) {
    const row = pending.get(id);
    if (!row) return null;
    if (now() <= row.expiresAt) return null;
    return drop(id, { ok: false, error: 'expired' }, 'expired');
  }

  function sweep() {
    const ids = Array.from(pending.keys());
    for (let i = 0; i < ids.length; i += 1) expire(ids[i]);
  }

  function arm(row) {
    const delay = Math.max(0, row.expiresAt - now());
    const timer = setTimer(function () {
      if (!pending.has(row.id)) return;
      drop(row.id, { ok: false, error: 'expired' }, 'expired');
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    row.timer = timer;
  }

  function view(row) {
    return {
      approvalId: row.id,
      method: row.method,
      paramNames: Object.keys(row.params || {}),
      clientId: row.clientId,
      kind: row.kind,
      expiresAt: new Date(row.expiresAt).toISOString()
    };
  }

  function hold(input) {
    sweep();
    const rowInput = input || {};
    const id = 'a-' + crypto.randomBytes(8).toString('hex');
    const row = {
      id: id,
      method: typeof rowInput.method === 'string' ? rowInput.method : '',
      params: rowInput.params && typeof rowInput.params === 'object' ? rowInput.params : {},
      ctx: rowInput.ctx && typeof rowInput.ctx === 'object' ? rowInput.ctx : {},
      clientId: rowInput.clientId == null ? '' : String(rowInput.clientId),
      kind: rowInput.kind == null ? '' : String(rowInput.kind),
      expiresAt: now() + ttlMs,
      timer: null
    };
    pending.set(id, row);
    arm(row);
    return { ok: false, pending: true, approvalId: id };
  }

  function list() {
    sweep();
    const rows = [];
    for (const row of pending.values()) rows.push(view(row));
    return { ok: true, approvals: rows };
  }

  function take(id) {
    sweep();
    const key = typeof id === 'string' ? id : '';
    if (!key) return { ok: false, error: 'bad-id' };
    const row = pending.get(key);
    if (!row) return { ok: false, error: 'not-found' };
    if (now() > row.expiresAt) {
      drop(key, { ok: false, error: 'expired' }, 'expired');
      return { ok: false, error: 'expired' };
    }
    pending.delete(key);
    clearRowTimer(row);
    return { ok: true, row: row };
  }

  function approve(id, executor) {
    const taken = take(id);
    if (!taken.ok) return Promise.resolve(taken);
    return Promise.resolve()
      .then(function () { return executor(taken.row); })
      .then(function (result) {
        const settled = result && typeof result === 'object' ? result : { ok: false, error: 'failed' };
        emit(taken.row, settled, 'approved');
        return { ok: true, approvalId: taken.row.id, result: settled };
      })
      .catch(function () {
        const settled = { ok: false, error: 'failed' };
        emit(taken.row, settled, 'approved');
        return { ok: true, approvalId: taken.row.id, result: settled };
      });
  }

  function deny(id) {
    const taken = take(id);
    if (!taken.ok) return taken;
    const result = { ok: false, error: 'denied' };
    emit(taken.row, result, 'denied');
    return { ok: true, approvalId: taken.row.id, result: result };
  }

  function stop() {
    for (const row of pending.values()) clearRowTimer(row);
    pending.clear();
  }

  return { hold: hold, list: list, approve: approve, deny: deny, stop: stop, sweep: sweep };
}

module.exports = { createApprovals, DEFAULT_TTL_MS };
