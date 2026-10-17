'use strict';

/**
 * 配信前チェック。
 * createPreflight({ registry, engines, store, secrets, orchestrator, now })
 *   → { run(destinationIds) → { ok, items } }
 * ok は level が error の項目が無いときだけ true。
 * 秘密の値は読まない（secrets.describe の ok だけ）。各チェックの例外は
 * preflight-check-failed（warn）にして、他のチェックは続ける。
 * 全体は budgetMs（既定 5000）以内に返す。
 */

const { run: runPlugin } = require('../safe-runner');

const BUDGET_MS = 5000;
const CALL_MS = 1000;
const ACTIVE = new Set(['live', 'connecting', 'reconnecting']);

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function usableId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 80) return false;
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function engineApi(engines) {
  if (!engines || typeof engines !== 'object') {
    return { get: function () { return null; }, list: function () { return []; } };
  }
  if (typeof engines.get === 'function') {
    const list = typeof engines.list === 'function'
      ? function () { return engines.list(); }
      : function () { return []; };
    return {
      get: function (id) { return engines.get(id); },
      list: list
    };
  }
  if (engines.registry && typeof engines.registry === 'object') return engineApi(engines.registry);
  return { get: function () { return null; }, list: function () { return []; } };
}

function loadDestinations(store) {
  if (!store || typeof store !== 'object') return [];
  let snap = null;
  if (typeof store.snapshot === 'function') snap = store.snapshot();
  else if (Array.isArray(store.destinations)) snap = store.destinations;
  if (Array.isArray(snap)) return snap;
  if (snap && Array.isArray(snap.destinations)) return snap.destinations;
  return [];
}

function engineRef(row) {
  const engine = row && row.engine;
  if (!engine || typeof engine !== 'object') return { id: '', targetId: '' };
  const id = typeof engine.id === 'string' ? engine.id : '';
  const targetId = engine.targetId == null ? '' : String(engine.targetId);
  return { id: id, targetId: targetId };
}

function loadPlugins(registry) {
  const byId = new Map();
  if (registry && typeof registry.snapshot === 'function') {
    const snap = registry.snapshot();
    const rows = Array.isArray(snap) ? snap : [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || typeof row.id !== 'string' || !row.id) continue;
      byId.set(row.id, {
        id: row.id,
        status: row.status,
        manifest: row.manifest || {},
        instance: row.instance || null
      });
    }
  }
  if (registry && typeof registry.getRunning === 'function') {
    const running = registry.getRunning();
    const rows = Array.isArray(running) ? running : [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || typeof row.id !== 'string' || !row.id) continue;
      const prev = byId.get(row.id) || { id: row.id, manifest: {}, status: 'running', instance: null };
      byId.set(row.id, {
        id: row.id,
        status: row.status || 'running',
        manifest: row.manifest || prev.manifest || {},
        instance: row.instance || prev.instance || null
      });
    }
  }
  return Array.from(byId.values());
}

function isStarted(row) {
  if (!row || !row.instance || typeof row.instance !== 'object') return false;
  if (row.status == null) return true;
  return row.status === 'running';
}

function targetIdOf(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.id != null && String(row.id)) return String(row.id);
  if (row.targetId != null) return String(row.targetId);
  return '';
}

function createPreflight(options) {
  const opts = options || {};
  const registry = opts.registry || null;
  const engines = engineApi(opts.engines);
  const store = opts.store || null;
  const orchestrator = opts.orchestrator || null;
  const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
  const logger = typeof opts.logger === 'function' ? opts.logger : function () {};
  const budgetMs = positive(opts.budgetMs, BUDGET_MS);
  const callTimeoutMs = positive(opts.callTimeoutMs, CALL_MS);

  function readClock() {
    try {
      const value = now();
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch (_) { /* 時計が壊れても実時間で予算を切る */ }
    return Date.now();
  }

  function namedMode(value) {
    if (value === 'live' || value === 'shadow' || value === 'legacy') return value;
    return '';
  }

  // 全体に効く code（OBS 未接続など）。ほかは配信先ごと（destinationId があるとき）。
  const GLOBAL_CODES = new Set([
    'broadcast-mode', 'obs-profile-warning', 'engine-disconnected', 'engine-unsupported'
  ]);

  function run(destinationIds) {
    const items = [];
    const seen = new Set();
    const statusMemo = new Map();
    const targetMemo = new Map();
    let pluginState = null;
    let budgetNoted = false;
    let stopped = false;
    const started = readClock();

    function overBudget() {
      return readClock() - started >= budgetMs;
    }

    function push(item) {
      if (stopped) return;
      if (seen.has(item.id)) return;
      seen.add(item.id);
      items.push(item);
    }

    function makeItem(code, level, destinationId, message, extra) {
      const dest = destinationId || '';
      const id = extra
        ? code + ':' + (dest || 'global') + ':' + extra
        : code + ':' + (dest || 'global');
      const scope = dest && !GLOBAL_CODES.has(code) ? 'destination' : 'global';
      const item = { id: id, level: level, code: code, message: message, scope: scope };
      if (dest) item.destinationId = dest;
      return item;
    }

    function noteBudget() {
      if (budgetNoted) return;
      budgetNoted = true;
      items.push(makeItem(
        'preflight-check-failed',
        'warn',
        '',
        '時間内に終わりませんでした',
        'budget'
      ));
      seen.add('preflight-check-failed:global:budget');
    }

    function failed(label, destinationId) {
      push(makeItem(
        'preflight-check-failed',
        'warn',
        destinationId,
        'チェックに失敗しました（' + label + '）',
        label
      ));
    }

    async function attempt(label, destinationId, fn) {
      if (stopped) return;
      if (overBudget()) {
        noteBudget();
        return;
      }
      try {
        await fn();
      } catch (_) {
        failed(label, destinationId);
      }
    }

    function plugins() {
      if (!pluginState) {
        try {
          pluginState = { rows: loadPlugins(registry) };
        } catch (err) {
          pluginState = { error: err };
        }
      }
      if (pluginState.error) throw pluginState.error;
      return pluginState.rows;
    }

    function readStatus(engineId, engine) {
      if (!statusMemo.has(engineId)) {
        statusMemo.set(engineId, Promise.resolve().then(function () {
          if (!engine || typeof engine.status !== 'function') return { connected: false };
          return Promise.resolve(engine.status()).then(function (status) {
            if (!status || typeof status !== 'object') return { connected: false };
            return status;
          });
        }));
      }
      return statusMemo.get(engineId);
    }

    function readTargets(engineId, engine) {
      if (!targetMemo.has(engineId)) {
        targetMemo.set(engineId, Promise.resolve().then(function () {
          if (!engine || typeof engine.listTargets !== 'function') {
            throw new Error('no-list');
          }
          return Promise.resolve(engine.listTargets()).then(function (rows) {
            if (!Array.isArray(rows)) throw new Error('bad-list');
            return rows;
          });
        }));
      }
      return targetMemo.get(engineId);
    }

    function modeOf(engine, status) {
      const fromStatus = namedMode(status && status.mode);
      if (fromStatus) return fromStatus;
      const modeId = engine && typeof engine.modeId === 'string' && engine.modeId
        ? engine.modeId
        : 'obs-engine';
      if (orchestrator && typeof orchestrator.modeFor === 'function') {
        const value = namedMode(orchestrator.modeFor(modeId));
        if (value) return value;
      }
      return 'legacy';
    }

    function resolveIds(input) {
      if (Array.isArray(input)) {
        const ids = [];
        for (let i = 0; i < input.length; i += 1) {
          const id = input[i];
          if (!usableId(id) || ids.indexOf(id) !== -1) continue;
          ids.push(id);
        }
        return ids;
      }
      const ids = [];
      const rows = loadDestinations(store);
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!row || !usableId(row.id) || ids.indexOf(row.id) !== -1) continue;
        ids.push(row.id);
      }
      return ids;
    }

    function findDestination(id) {
      const rows = loadDestinations(store);
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === id) return rows[i];
      }
      return null;
    }

    function engineIds() {
      const ids = [];
      let listed = [];
      try {
        const raw = engines.list();
        if (Array.isArray(raw)) listed = raw;
      } catch (err) {
        throw err;
      }
      for (let i = 0; i < listed.length; i += 1) {
        if (typeof listed[i] === 'string' && listed[i] && ids.indexOf(listed[i]) === -1) ids.push(listed[i]);
      }
      const rows = loadDestinations(store);
      for (let i = 0; i < rows.length; i += 1) {
        const ref = engineRef(rows[i]);
        if (ref.id && ids.indexOf(ref.id) === -1) ids.push(ref.id);
      }
      return ids;
    }

    async function checkBroadcastMode() {
      let mode = 'legacy';
      if (orchestrator && typeof orchestrator.modeFor === 'function') {
        mode = namedMode(orchestrator.modeFor('broadcast')) || 'legacy';
      }
      if (mode === 'live') return;
      const message = mode === 'shadow'
        ? '配信開始のモードは shadow です。記録だけです'
        : '配信開始のモードは legacy です。何もしません';
      push(makeItem('broadcast-mode', 'warn', '', message));
    }

    async function checkProfile() {
      const ids = engineIds();
      let live = false;
      for (let i = 0; i < ids.length; i += 1) {
        if (overBudget()) {
          noteBudget();
          return;
        }
        const engine = engines.get(ids[i]);
        if (!engine) continue;
        const status = await readStatus(ids[i], engine);
        if (status && status.profileWarning === true) live = true;
        if (typeof engine.listTargets !== 'function') continue;
        const targets = await readTargets(ids[i], engine);
        for (let t = 0; t < targets.length; t += 1) {
          const state = String(targets[t] && targets[t].state || '').toLowerCase();
          if (ACTIVE.has(state)) live = true;
        }
      }
      if (live) {
        push(makeItem(
          'obs-profile-warning',
          'warn',
          '',
          '配信中の出力があります。OBS のプロファイルを切り替えると全部止まります'
        ));
      }
    }

    async function checkDisconnected(destinationId, engineId) {
      const engine = engines.get(engineId);
      if (!engine) {
        push(makeItem('engine-disconnected', 'error', '', 'エンジンが未接続です', engineId));
        return;
      }
      const status = await readStatus(engineId, engine);
      if (status.connected !== true) {
        push(makeItem('engine-disconnected', 'error', '', 'エンジンが未接続です', engineId));
      }
    }

    async function checkUnsupported(destinationId, engineId) {
      const engine = engines.get(engineId);
      if (!engine) return;
      const status = await readStatus(engineId, engine);
      // 未接続のときは版を見ていないので、非対応にはしない。
      if (status.connected !== true) return;
      const missing = Array.isArray(status.missing) && status.missing.length > 0;
      if (status.supported === false || missing) {
        push(makeItem('engine-unsupported', 'error', '', 'エンジンが非対応です', engineId));
      }
    }

    async function checkReadOnly(destinationId, engineId) {
      const engine = engines.get(engineId);
      if (!engine) return;
      const status = await readStatus(engineId, engine);
      const mode = modeOf(engine, status);
      if (mode === 'live') return;
      push(makeItem(
        'engine-read-only',
        'warn',
        destinationId,
        'エンジンのモードは ' + mode + ' です。実際には書き込まれません'
      ));
    }

    async function checkTargetMissing(destinationId, engineId, targetId) {
      const engine = engines.get(engineId);
      if (!engine) return;
      const status = await readStatus(engineId, engine);
      if (status.connected !== true) return;
      const targets = await readTargets(engineId, engine);
      const found = targets.some(function (row) { return targetIdOf(row) === targetId; });
      if (!found) {
        push(makeItem('target-missing', 'error', destinationId, 'ひも付いた配信先がエンジンの一覧にありません'));
      }
    }

    async function checkAlreadyLive(destinationId, engineId, targetId) {
      const engine = engines.get(engineId);
      if (!engine) return;
      const status = await readStatus(engineId, engine);
      if (status.connected !== true) return;
      const targets = await readTargets(engineId, engine);
      const found = targets.find(function (row) { return targetIdOf(row) === targetId; });
      if (found && String(found.state || '').toLowerCase() === 'live') {
        push(makeItem('target-already-live', 'warn', destinationId, 'すでに配信中です'));
      }
    }

    async function checkSite(destinationId, site) {
      const rows = plugins();
      let match = null;
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].id === site) {
          match = rows[i];
          break;
        }
      }
      if (!match || !isStarted(match)) {
        push(makeItem(
          'site-not-configured',
          'warn',
          destinationId,
          'サイトプラグインが起動していないため、題名を更新できません'
        ));
        return;
      }
      const left = budgetMs - (readClock() - started);
      if (left <= 0) {
        noteBudget();
        return;
      }
      const timeoutMs = Math.min(callTimeoutMs, left);
      const ran = await runPlugin(match.instance, 'isConfigured', [], {
        timeoutMs: timeoutMs,
        logger: logger
      });
      if (stopped) return;
      if (!ran || ran.result === 'timeout') {
        push(makeItem(
          'site-not-configured',
          'warn',
          destinationId,
          'サイトの設定確認が時間内に終わりませんでした'
        ));
        return;
      }
      if (ran.result === 'error') throw new Error('isConfigured');
      if (ran.result !== 'ok' || !ran.value) {
        push(makeItem(
          'site-not-configured',
          'warn',
          destinationId,
          'サイトが未設定のため、題名を更新できません'
        ));
      }
    }

    async function checkDestination(id) {
      let row = null;
      let lookupFailed = false;
      try {
        row = findDestination(id);
      } catch (_) {
        lookupFailed = true;
      }
      if (lookupFailed) {
        failed('destinations', id);
        return;
      }
      if (!row) {
        push(makeItem('destination-unknown', 'error', id, '配信先がありません'));
        return;
      }
      if (row.enabled !== true) {
        push(makeItem('destination-disabled', 'error', id, '配信先が無効です'));
      }
      const ref = engineRef(row);
      if (!ref.id || !ref.targetId) {
        push(makeItem('destination-unlinked', 'error', id, 'エンジンの配信先にひも付いていません'));
      }
      const site = typeof row.site === 'string' ? row.site : '';
      if (ref.id) {
        await attempt('engine-disconnected', id, function () { return checkDisconnected(id, ref.id); });
        await attempt('engine-unsupported', id, function () { return checkUnsupported(id, ref.id); });
        await attempt('engine-read-only', id, function () { return checkReadOnly(id, ref.id); });
      }
      if (ref.id && ref.targetId) {
        await attempt('target-missing', id, function () { return checkTargetMissing(id, ref.id, ref.targetId); });
        await attempt('target-already-live', id, function () { return checkAlreadyLive(id, ref.id, ref.targetId); });
      }
      await attempt('site-configured', id, function () { return checkSite(id, site); });
    }

    function finish() {
      const snapshot = items.slice();
      const blocked = [];
      let globalOk = true;
      snapshot.forEach(function (item) {
        if (item.level !== 'error') return;
        if (item.scope === 'destination' && item.destinationId) {
          if (blocked.indexOf(item.destinationId) === -1) blocked.push(item.destinationId);
        } else {
          globalOk = false;
        }
      });
      return {
        ok: !snapshot.some(function (item) { return item.level === 'error'; }),
        globalOk: globalOk,
        blocked: blocked,
        items: snapshot
      };
    }

    return new Promise(function (resolve) {
      let settled = false;
      let timer = null;

      function settle(fromTimer) {
        if (settled) return;
        settled = true;
        if (fromTimer) noteBudget();
        const result = finish();
        stopped = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }

      timer = setTimeout(function () { settle(true); }, budgetMs);
      const job = (async function () {
        await attempt('broadcast-mode', '', checkBroadcastMode);
        await attempt('obs-profile', '', checkProfile);
        let ids = [];
        try {
          ids = resolveIds(destinationIds);
        } catch (_) {
          failed('destinations', '');
          ids = [];
        }
        for (let i = 0; i < ids.length; i += 1) {
          if (stopped || overBudget()) {
            noteBudget();
            break;
          }
          await checkDestination(ids[i]);
        }
      })();
      job.then(function () { settle(false); }, function () { settle(true); });
    });
  }

  return { run: run };
}

module.exports = { createPreflight };
