'use strict';

/**
 * 登録簿の部品: 全部の読み直し・外から入れたものの再探索（1 つずつ順番に）（計画 X・S8b。host/core/plugin-registry.js から機械的に移した。動きは変えていない）。
 * S は host/core/plugin-registry.js の createRegistry が作る道具箱（共有の状態 st・opts・records など）。他の部品の関数は S.fn から呼ぶ。
 */

const fs = require('fs');
const path = require('path');
const { setModeKeys } = require('../modes');
const { ID_RE } = require('../plugin-surface');

function createReload(S) {
  const { externalRoot, records, byId, recLog, setLastError, st } = S;
  const loadAll = (...args) => S.fn.loadAll(...args);
  const loadOne = (...args) => S.fn.loadOne(...args);
  const pruneSiblings = (...args) => S.fn.pruneSiblings(...args);
  const purgeCache = (...args) => S.fn.purgeCache(...args);
  const readManifestFile = (...args) => S.fn.readManifestFile(...args);
  const register = (...args) => S.fn.register(...args);
  const reloadGroup = (...args) => S.fn.reloadGroup(...args);
  const scanRoot = (...args) => S.fn.scanRoot(...args);
  const snapshot = (...args) => S.fn.snapshot(...args);
  const teardown = (...args) => S.fn.teardown(...args);
  const validate = (...args) => S.fn.validate(...args);

  // 読み直しは同時に 2 つ走らせない（止める・読むが混ざる）。実行中なら st.busy で断る。
  async function exclusive(refused, work) {
    if (st.busy) return refused;
    st.busy = true;
    try { return await work(); } finally { release(); }
  }

  // st.busy を手放す。待っている人（画面のインストーラ）がいれば、その人に順番を渡す。
  const idleWaiters = [];
  function release() {
    const next = idleWaiters.shift();
    if (next) next(); // st.busy は true のまま次の人へ
    else st.busy = false;
  }
  // 空くまで待って st.busy を取る（インストーラの経路用。AI の reload は待たず st.busy で断る）
  function whenIdle() {
    if (!st.busy) { st.busy = true; return Promise.resolve(); }
    return new Promise((resolve) => { idleWaiters.push(resolve); });
  }

  async function reload(id) {
    return exclusive({ id, result: 'error', message: 'busy' }, async () => {
      const results = await reloadGroup(id);
      return results.find((row) => row.id === id) || results[0];
    });
  }

  // options.skip(id) が true の id は、同じサイトのまとまりごと飛ばす（配信中に OBS を握るプラグインなど）
  async function reloadAll(options) {
    return exclusive([{ id: '*', result: 'error', message: 'busy' }], () => reloadAllInner(options));
  }

  async function reloadAllInner(options) {
    const skip = options && typeof options.skip === 'function' ? options.skip : null;
    if (!st.loaded) await loadAll();
    const ids = records
      .filter((rec) => rec.source && byId.get(rec.id) === rec)
      .map((rec) => rec.id);
    const results = [];
    const done = new Set();
    for (const id of ids) {
      const rec = byId.get(id);
      if (!rec || done.has(id)) continue;
      const manifest = rec.manifest || {};
      const v2Inproc = manifest.manifestVersion === 2 && manifest.runtime === 'inproc';
      if (manifest.kind !== 'site' && !v2Inproc) continue;
      if (skip) {
        const members = rec.siteId
          ? records.filter((row) => row.siteId === rec.siteId && row.dir === rec.dir && byId.get(row.id) === row)
          : [rec];
        if (members.some((row) => skip(row.id))) {
          members.forEach((row) => { done.add(row.id); results.push({ id: row.id, result: 'skip', message: 'streaming-slot' }); });
          continue;
        }
      }
      const group = await reloadGroup(id);
      group.forEach((row) => { done.add(row.id); results.push(row); });
    }
    return results;
  }

  // OBS の開始・停止を握るか（capabilities に obs-start / obs-stop、slot の役目、needs の obs.streamControl）。
  // 同じサイトのまとまりに 1 つでもあれば true。V7 で manifest の宣言に変えるときはこの関数だけ直す。
  function holdsObs(id) {
    const me = byId.get(id);
    if (!me || (me.manifest && me.manifest.kind === 'shell')) return false;
    const group = me.siteId
      ? records.filter((row) => row.siteId === me.siteId && row.dir === me.dir && byId.get(row.id) === row)
      : [me];
    return group.some((row) => {
      const caps = row.manifest && Array.isArray(row.manifest.capabilities) ? row.manifest.capabilities : [];
      const needs = row.manifest && Array.isArray(row.manifest.needs) ? row.manifest.needs : [];
      return row.role === 'slot' || caps.indexOf('obs-start') !== -1 || caps.indexOf('obs-stop') !== -1 || needs.indexOf('obs.streamControl') !== -1;
    });
  }

  // 外から入れたものの入れ替え（入れた・更新した・消した・戻したあと）。外部の記録をいったん全部止めて消し、置き場を読み直す。
  // 内蔵・作者用には触らない。読み込みは loadOne の門（legacy なら動かさない）を通る。
  // id を渡したら、その id（置き場のフォルダ名）だけを止めて読み直す。ほかの外部は動いたまま（★2 M6）。
  // options.wait: true なら st.busy で断らず、空くまで待つ（画面の入れる・外す・作る。ファイルは動いた後なので断れない）
  async function rescanExternal(id, options) {
    if (options && options.wait) await whenIdle();
    else if (st.busy) throw new Error('busy');
    else st.busy = true;
    try { return await rescanExternalInner(id); } finally { release(); }
  }

  async function rescanExternalInner(id) {
    if (!st.loaded) await loadAll();
    if (typeof id === 'string' && id !== '') return rescanExternalOne(id);
    const mine = records.filter((rec) => rec.source === 'user');
    for (const rec of mine) {
      if (byId.get(rec.id) === rec) await teardown(rec);
      purgeCache(rec);
      if (byId.get(rec.id) === rec) byId.delete(rec.id);
    }
    const keep = records.filter((rec) => rec.source !== 'user');
    records.length = 0;
    keep.forEach((rec) => records.push(rec));
    scanRoot(externalRoot, 'user');
    setModeKeys(records.filter((rec) => rec.modeKey && byId.get(rec.id) === rec).map((rec) => [rec.id, rec.modeKey]));
    pruneSiblings();
    for (const rec of records) {
      if (rec.source !== 'user' || rec.status !== 'accepted') continue;
      try {
        await loadOne(rec);
      } catch (err) {
        rec.status = 'load-failed';
        rec.reason = 'load-failed';
        setLastError(rec, err);
        recLog(rec, 'error', 'load-failed');
      }
    }
    return snapshot();
  }

  async function rescanExternalOne(id) {
    if (!ID_RE.test(id)) return snapshot(); // 置き場の外を指す名前は読まない
    const dir = path.join(externalRoot, id);
    const mine = records.filter((rec) => rec.source === 'user' && (rec.id === id || rec.dir === dir));
    for (const rec of mine) {
      if (byId.get(rec.id) === rec) await teardown(rec);
      purgeCache(rec);
      if (byId.get(rec.id) === rec) byId.delete(rec.id);
    }
    const keep = records.filter((rec) => mine.indexOf(rec) === -1);
    records.length = 0;
    keep.forEach((rec) => records.push(rec));
    const added = [];
    if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) {
      const parsed = readManifestFile(dir);
      if (!parsed.missing) {
        const rec = validate(id, parsed, 'user');
        if (rec) { register(rec); added.push(rec); }
      }
    }
    setModeKeys(records.filter((rec) => rec.modeKey && byId.get(rec.id) === rec).map((rec) => [rec.id, rec.modeKey]));
    pruneSiblings();
    for (const rec of added) {
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
    return snapshot();
  }

  return {
    exclusive,
    release,
    reload,
    reloadAll,
    holdsObs,
    rescanExternal
  };
}

module.exports = { createReload };
