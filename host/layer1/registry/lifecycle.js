'use strict';

/**
 * 登録簿の部品: 読み込み・止める・読み直しの 1 件分（load/start/stop/destroy）（計画 X・S8b。host/core/plugin-registry.js から機械的に移した。動きは変えていない）。
 * S は host/core/plugin-registry.js の createRegistry が作る道具箱（共有の状態 st・opts・records など）。他の部品の関数は S.fn から呼ぶ。
 */

const path = require('path');
const { run } = require('../../core');

function createLifecycle(S) {
  const { runner, records, byId, bootContext, bootResults, chatNow, recLog, setLastError, st } = S;
  const clearSubs = (...args) => S.fn.clearSubs(...args);
  const discover = (...args) => S.fn.discover(...args);
  const dropActions = (...args) => S.fn.dropActions(...args);
  const makeCtx = (...args) => S.fn.makeCtx(...args);
  const modeOfRec = (...args) => S.fn.modeOfRec(...args);
  const pruneSiblings = (...args) => S.fn.pruneSiblings(...args);
  const readDev = (...args) => S.fn.readDev(...args);
  const readManifestFile = (...args) => S.fn.readManifestFile(...args);
  const readTier = (...args) => S.fn.readTier(...args);
  const registerActions = (...args) => S.fn.registerActions(...args);
  const registerSubscriptions = (...args) => S.fn.registerSubscriptions(...args);
  const release = (...args) => S.fn.release(...args);
  const requiredMethods = (...args) => S.fn.requiredMethods(...args);
  const siteNeedsMissing = (...args) => S.fn.siteNeedsMissing(...args);
  const siteRecords = (...args) => S.fn.siteRecords(...args);
  const snapshot = (...args) => S.fn.snapshot(...args);
  const tierAllows = (...args) => S.fn.tierAllows(...args);
  const validate = (...args) => S.fn.validate(...args);

  async function loadOne(rec) {
    delete rec.tierAt; // 読み込みの判断は今の段階で合わせ直す（先送りしていたものが追いつく）
    // 今の段階より上のものは、require も load も start もしない（画面で隠すだけではなく、動かさない。v3 §5）。
    if (!tierAllows(rec)) {
      rec.status = 'accepted';
      rec.reason = siteNeedsMissing(rec).length ? 'needs-site' : 'tier-not-loaded';
      rec.instance = null;
      rec.ctx = null;
      return;
    }
    // 外から入れたものは、legacy のあいだは require も load も start もしない（フォルダを置くだけで動かない）。
    if (rec.source === 'user' && modeOfRec(rec) === 'legacy') {
      rec.status = 'accepted';
      rec.reason = 'legacy-not-loaded';
      rec.instance = null;
      rec.ctx = null;
      return;
    }
    let plugin;
    try {
      plugin = require(rec.mainPath);
    } catch (err) {
      rec.status = 'invalid-exports';
      rec.reason = 'require-failed';
      rec.instance = null;
      setLastError(rec, err);
      recLog(rec, 'error', 'require-failed ' + rec.lastError.message + (rec.lastError.where ? ' (' + rec.lastError.where + ')' : ''));
      return;
    }
    const missing = requiredMethods(rec).filter((name) => typeof plugin[name] !== 'function');
    if (missing.length) {
      rec.status = 'invalid-exports';
      rec.reason = 'invalid-exports';
      rec.instance = null;
      setLastError(rec, { message: 'invalid-exports ' + missing.join(',') });
      recLog(rec, 'error', `invalid-exports ${missing.join(',')}`);
      return;
    }
    rec.instance = plugin;
    rec.ctx = null;
    rec.apiRegs = [];
    rec.apiOpen = true;
    const ctx = makeCtx(rec);
    const hostLogger = rec.ctxHostLogger;
    const loadedRun = await runner(plugin, 'load', [ctx], { logger: hostLogger });
    if (loadedRun.result !== 'ok') {
      rec.apiOpen = false;
      rec.apiRegs = [];
      clearSubs(rec);
      dropActions(rec);
      rec.status = 'load-failed';
      rec.reason = loadedRun.result;
      rec.instance = null;
      rec.ctx = null;
      setLastError(rec, { message: 'load ' + loadedRun.result + (loadedRun.message && loadedRun.message !== loadedRun.result ? ': ' + loadedRun.message : ''), stack: loadedRun.stack });
      recLog(rec, 'error', `load ${loadedRun.result}`);
      return;
    }
    const started = await runner(plugin, 'start', [ctx], { logger: hostLogger });
    rec.apiOpen = false;
    if (started.result !== 'ok') {
      rec.apiRegs = [];
      clearSubs(rec);
      dropActions(rec);
      rec.status = 'start-failed';
      rec.reason = started.result;
      setLastError(rec, { message: 'start ' + started.result + (started.message && started.message !== started.result ? ': ' + started.message : ''), stack: started.stack });
      recLog(rec, 'error', `start ${started.result}`);
      return;
    }
    rec.status = 'running';
    rec.reason = null;
    rec.lastError = null;
    registerSubscriptions(rec);
    registerActions(rec);
  }

  // 起動前フック（V6）。読み込み（loadAll）より前に 1 回だけ、内蔵・作者用のプラグインの manifest.boot（プラグインのフォルダの中の .js）の run(ctx) を呼ぶ。
  // 段階・開発者モード・モードに関係なく動く（起動時の移しかえは、プラグインが切れていても、済み印の仕組みで一度だけ動くため）。
  // 外から入れたものは動かさない。失敗しても起動は止めない（ログに残すだけ）。ctx は同期の口（host/core/boot-context.js）。
  function runBootHooks() {
    bootResults.length = 0;
    if (!bootContext) return bootResults;
    const rowsFn = () => records.filter((rec) => byId.get(rec.id) === rec).map((rec) => ({ id: rec.id, modeKey: rec.modeKey || '', status: rec.status }));
    for (const rec of records) {
      if (byId.get(rec.id) !== rec || rec.source === 'user') continue;
      const file = rec.manifest && rec.manifest.boot;
      if (typeof file !== 'string' || file === '' || rec.status === 'skip') continue;
      const full = path.resolve(rec.dir, file);
      if (full.indexOf(path.resolve(rec.dir) + path.sep) !== 0 || path.extname(full) !== '.js') {
        bootResults.push({ id: rec.id, result: 'bad-boot' });
        recLog(rec, 'warn', 'bad-boot');
        continue;
      }
      try {
        const mod = require(full);
        if (!mod || typeof mod.run !== 'function') throw new Error('no-run');
        mod.run(bootContext(rec.id, rowsFn));
        bootResults.push({ id: rec.id, result: 'ok' });
      } catch (err) {
        bootResults.push({ id: rec.id, result: 'failed' });
        recLog(rec, 'warn', 'boot-failed');
      }
    }
    return bootResults;
  }

  async function loadAll() {
    if (!st.loaded) discover();
    if (st.loaded) return snapshot();
    runBootHooks();
    st.appliedTier = readTier();
    st.appliedDev = readDev();
    for (const rec of records) {
      if (rec.status !== 'accepted') continue;
      try {
        await loadOne(rec);
      } catch (err) {
        rec.status = 'load-failed';
        rec.reason = 'load-failed';
        setLastError(rec, err);
        recLog(rec, 'error', 'load-failed');
      }
    }
    st.loaded = true;
    return snapshot();
  }

  function purgeCache(rec) {
    const dirPrefix = rec.dir.endsWith(path.sep) ? rec.dir : rec.dir + path.sep;
    for (const key of Object.keys(require.cache)) {
      const normalized = key;
      if (normalized === rec.mainPath || normalized.startsWith(dirPrefix)) {
        delete require.cache[key];
      }
    }
  }

  function reread(rec) {
    if (rec.siteId) {
      const fresh = siteRecords(rec.siteId, rec.dir, rec.source);
      const hit = fresh.find((row) => row.id === rec.id);
      if (hit) { if (rec.author) hit.author = true; return hit; }
      // manifest 自体が壊れた（skip の記録が 1 つだけ）ときだけ、その理由を返す。役目が消えただけなら別の役目では起動しない（M6 Should 1）。
      return fresh.length === 1 && fresh[0].status === 'skip' && fresh[0].id === rec.siteId ? fresh[0] : null;
    }
    const parsed = readManifestFile(rec.dir);
    const fresh = validate(path.basename(rec.dir), parsed, rec.source, { dir: rec.dir });
    if (fresh && rec.community) fresh.community = true;
    if (fresh && rec.author) fresh.author = true;
    return fresh;
  }

  async function teardown(rec) {
    clearSubs(rec);
    dropActions(rec);
    // 止める・読み直すプラグインが取っていたコメントの入り口は、プラグインの後始末（release）に頼らずホストが手放す。
    try { const inlet = chatNow(); if (typeof inlet.releaseAll === 'function') inlet.releaseAll(rec.id); } catch (_) { /* 手放せなくても続ける */ }
    if (rec.instance) {
      const ctx = rec.ctx || makeCtx(rec);
      const hostLogger = rec.ctxHostLogger;
      await runner(rec.instance, 'destroy', [ctx], { logger: hostLogger });
      await runner(rec.instance, 'stop', [ctx], { logger: hostLogger });
    }
    rec.ctx = null;
  }

  async function reinstate(rec) {
    const id = rec.id;
    const fresh = reread(rec);
    rec.instance = null;
    if (fresh && fresh.status === 'data') {
      // データだけのプラグイン（テーマ・並べ方・画面の本体役）は動かすものが無い。読み直しは検査をやり直すだけ。
      rec.status = 'data';
      rec.reason = null;
      rec.manifest = fresh.manifest;
      if (byId.get(id) !== rec) byId.set(id, rec);
      return { id, result: 'ok', message: 'data' };
    }
    if (!fresh || fresh.status !== 'accepted') {
      rec.status = fresh ? fresh.status : 'skip';
      rec.reason = fresh ? fresh.reason : 'invalid-manifest';
      rec.manifest = fresh ? fresh.manifest : rec.manifest;
      return { id, result: 'error', message: rec.reason || 'unloaded' };
    }
    rec.manifest = fresh.manifest;
    rec.mainPath = fresh.mainPath;
    rec.status = 'accepted';
    rec.reason = null;
    pruneSiblings();
    await loadOne(rec);
    if (rec.reason === 'legacy-not-loaded' || rec.reason === 'tier-not-loaded') return { id, result: 'skip', message: rec.reason };
    const ok = rec.status === 'running';
    const out = { id, result: ok ? 'ok' : 'error', message: rec.status };
    if (!ok && rec.lastError) out.error = { message: rec.lastError.message, where: rec.lastError.where };
    return out;
  }

  // 読み直しの単位はサイト: 同じサイトの役目（同じフォルダ）は、全部止めてから、まとめて読み直す。
  async function reloadGroup(id) {
    if (!st.loaded) await loadAll();
    const rec = byId.get(id) || records.find((row) => row && row.id === id && row.source === 'set') || records.find((row) => row && row.id === id);
    if (!rec) return [{ id, result: 'skip', message: 'unknown-id' }];
    const group = rec.siteId
      ? records.filter((row) => row.siteId === rec.siteId && row.dir === rec.dir && byId.get(row.id) === row)
      : [rec];
    for (const row of group) await teardown(row);
    purgeCache(rec);
    const results = [];
    for (const row of group) results.push(await reinstate(row));
    return results;
  }

  return {
    loadOne,
    loadAll,
    purgeCache,
    teardown,
    reloadGroup
  };
}

module.exports = { createLifecycle };
