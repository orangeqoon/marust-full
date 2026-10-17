'use strict';

/**
 * Local Vault。Secret Provider の口。
 * 値を読む道は 2 つだけ。どちらも持ち主（読んでよい名前）を核が決める:
 *   getFor(pluginId, name)        プラグイン用。宣言は bindDeclared(fn) で registry が 1 回だけ渡す（manifest の secrets。表示用）。L8g: get・has は宣言の有無を見ない（set だけ context.js が宣言を見る）。
 *   coreReader(actor, allow)      核の読み手用（obs-setup・site-config・migration-bundle）。allow は名前の配列か関数。組み立てる側が決める。
 * 呼ぶ側が宣言（secrets の引数）を渡す道は無い。provider 自身に get は無い。
 * list / describe は名前・更新時刻・バイト数・期限だけ。値は返さない。
 * 保存は STATE_DIR/services/marust-vault.json。監査は logs/marust/vault-YYYYMMDD.jsonl。
 * Cloud Vault は作らない。既存の Cookie・トークンのファイルは読まない。
 */

const fs = require('fs');
const path = require('path');
const { safeSecretError } = require('./secret-provider');
const WINDOW_ID = 'local-window';
const { selectBackend } = require('./vault-backends');
const { defaultLogger } = require('./safe-runner');
const { appendJsonl } = require('./log-writer');
const { NAME_RE, MAX_SECRET_BYTES, BACKEND_RE, hasValueField, normalizeEntry } = require('./vault-row');
const { createFileStore } = require('./vault-store-file');
const { ID_RE: STORE_ID_RE } = require('./vault-store-id');
const { defaultMask } = require('./secret-mask');
const { tailOf } = require('./secret-tail');

const STORE_CALL_MS = 5000;
const ACTOR_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

const SECRET_API_SPEC = Object.freeze({
  'secrets.list': Object.freeze({ permission: 'read', windowOnly: true }),
  'secrets.set': Object.freeze({ permission: 'write', windowOnly: true }),
  'secrets.remove': Object.freeze({ permission: 'write', windowOnly: true })
});

function fail(code) {
  return { ok: false, error: safeSecretError(code) };
}

function asDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  return new Date();
}

function sanitizeActor(actor) {
  if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) return 'unknown';
  return actor;
}

function scrubActor(actor, value) {
  if (typeof actor === 'string' && typeof value === 'string' && value.length > 0) {
    if (actor === value || (value.length >= 8 && actor.includes(value))) return 'unknown';
  }
  return sanitizeActor(actor);
}

function safeName(name) {
  return typeof name === 'string' && NAME_RE.test(name) ? name : '';
}

function valueError(value) {
  if (typeof value !== 'string') return 'bad-value';
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) return 'too-large';
  return '';
}

function leaks(ciphertext, value) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return true;
  if (ciphertext === value) return true;
  if (value.length >= 16 && ciphertext.includes(value)) return true;
  return false;
}

function isInsecure(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.production === false) return true;
  return candidate.id === 'fake';
}

function publicView(row) {
  return {
    name: row.name,
    updatedAt: row.updatedAt,
    size: row.size,
    expiresAt: null,
    tail: typeof row.tail === 'string' ? row.tail : ''
  };
}

function createSecretProvider(options) {
  const opts = options || {};
  const core = opts.core;
  if (!core || !core.STATE_DIR) throw new Error('vault requires core.STATE_DIR');
  const writeJson = opts.writeJson || core.atomicWriteJsonSync;
  if (typeof writeJson !== 'function') throw new Error('vault requires atomicWriteJsonSync');
  const logger = typeof opts.logger === 'function' ? opts.logger : defaultLogger;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  let declared = null;
  const allowFake = opts.allowFake === true;
  const backend = Object.prototype.hasOwnProperty.call(opts, 'backend') ? opts.backend : selectBackend();
  // 暗号文の置き場。既定は核の中のファイル。選んだ置き場は STATE_DIR/services/marust-vault-store.json（無ければ 'file'）。
  // プラグインの置き場（vault-store@1。内蔵だけ）を選んだときは、attachStore で渡された口が見つかるまで store-missing。ファイルには戻らない
  const selectionPath = path.join(core.STATE_DIR, 'services', 'marust-vault-store.json');
  const fileStore = opts.store ? null : createFileStore({ stateDir: core.STATE_DIR, writeJson: writeJson, warn: warn, now: () => currentDate() });
  let selected = opts.store ? { store: 'injected' } : readSelection();
  let portGetter = null;
  const storeTimeoutMs = Number.isFinite(opts.storeTimeoutMs) && opts.storeTimeoutMs > 0 ? opts.storeTimeoutMs : STORE_CALL_MS;
  let entries = new Map();
  let backendOk = false;
  let storeReason = ''; // 起動で置き場を読めなかった理由（'store-timeout' | 'store-bad-row' | 'store-missing'）。読み書きとも止める
  let storeDirty = false; // 書き込みの埋め合わせまで失敗した。起動し直すまで書き込みを止める（読みは控えから答える）
  let chain = Promise.resolve();

  function currentDate() {
    return asDate(now());
  }

  function warn(message) {
    try { logger('warn', message); } catch (_) { /* ignore */ }
  }

  function readSelection() {
    try {
      if (!fs.existsSync(selectionPath)) return { store: 'file' };
      const parsed = JSON.parse(fs.readFileSync(selectionPath, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed && parsed.schemaVersion === 1 && typeof parsed.store === 'string' && (parsed.store === 'file' || STORE_ID_RE.test(parsed.store))) {
        return { store: parsed.store };
      }
    } catch (_) { /* 読めない選択は、どの置き場も選ばない */ }
    return { store: '', bad: true };
  }

  function storeFor(id) {
    if (opts.store) return opts.store;
    if (id === 'file') return fileStore;
    if (typeof portGetter !== 'function' || !id) return null;
    try {
      const found = portGetter();
      return found && found.id === id && found.port && typeof found.port === 'object' ? found.port : null;
    } catch (_) {
      return null;
    }
  }

  function resolveStore() {
    return selected.bad ? null : storeFor(selected.store);
  }

  function backendId() {
    const id = backend && typeof backend.id === 'string' ? backend.id : '';
    return BACKEND_RE.test(id) ? id : '';
  }

  // 置き場への 1 回の呼び出し。時間切れ・例外・ok:false は { ok:false } にそろえる
  function storeCall(work, on) {
    const target = on || resolveStore();
    if (!target) return Promise.resolve({ ok: false, error: 'missing' });
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: 'timeout' });
      }, storeTimeoutMs);
      Promise.resolve().then(() => work(target)).then((result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result && typeof result === 'object' ? result : { ok: false, error: 'unavailable' });
      }, () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: 'unavailable' });
      });
    });
  }

  function rowForStore(row) {
    return { name: row.name, ciphertext: row.ciphertext, backend: row.backend || '', updatedAt: row.updatedAt, size: row.size };
  }

  // 置き場へ 1 行（row が null なら削除）。失敗したら前の行へ埋め合わせる。埋め合わせも失敗したら storeDirty
  async function commit(name, row, previous) {
    healthCache = null;
    const done = await storeCall((st) => (row ? st.put(rowForStore(row)) : st.delete(name)));
    if (done.ok === true) return true;
    // 置き場がはっきり ok:false を返したときは適用されていないので、埋め合わせは要らない（時間切れ・例外のときだけ送る）
    if (done.error !== 'timeout' && done.error !== 'missing') return false;
    const back = await storeCall((st) => (previous ? st.put(rowForStore(previous)) : st.delete(name)));
    if (back.ok !== true) storeDirty = true;
    return false;
  }

  let maskPreloaded = false;

  async function load() {
    maskPreloaded = false;
    healthCache = null;
    const wasMissing = storeReason === 'store-missing';
    entries = new Map();
    const listed = await storeCall((st) => st.list());
    if (listed.ok !== true || !Array.isArray(listed.rows)) {
      const missing = listed.error === 'missing';
      const reason = listed.error === 'timeout' ? 'store-timeout' : 'store-missing';
      if (!(missing && wasMissing)) warn('vault load failed count=1');
      storeReason = reason;
      return;
    }
    for (let i = 0; i < listed.rows.length; i += 1) {
      if (hasValueField(listed.rows[i])) {
        storeReason = 'store-bad-row';
        warn('vault load failed count=1');
        return;
      }
    }
    storeReason = '';
    const next = new Map();
    for (let i = 0; i < listed.rows.length; i += 1) {
      const row = normalizeEntry(listed.rows[i]);
      if (row) next.set(row.name, row);
    }
    entries = next;
  }

  async function ensureMaskPreloaded() {
    if (maskPreloaded || !isUsable()) return;
    maskPreloaded = true;
    const current = backendId();
    for (const row of entries.values()) {
      if (row.backend && current && row.backend !== current) continue;
      try {
        const val = await backend.decrypt(row.ciphertext);
        if (typeof val === 'string') {
          defaultMask.remember(val);
          row.tail = tailOf(val);
        }
      } catch (_) {
        warn('vault mask preload failed');
      }
    }
  }

  function probe() {
    backendOk = false;
    if (!backend || typeof backend.encrypt !== 'function' || typeof backend.decrypt !== 'function') return;
    if (isInsecure(backend) && !allowFake) {
      warn('vault fake backend refused');
      return;
    }
    try {
      if (typeof backend.available !== 'function' || backend.available() !== true) return;
    } catch (_) {
      return;
    }
    backendOk = true;
  }

  const ready = Promise.resolve().then(() => {
    probe();
    return load();
  });

  function isUsable() {
    return backendOk && storeReason === '';
  }

  function exclusive(work) {
    const run = chain.then(async () => {
      await ready;
      try {
        // 選んだ置き場の口が後から見つかったとき、読み直す（ファイルには戻らない）
        if (storeReason === 'store-missing' && resolveStore()) await load();
        return await work();
      } catch (_) {
        return fail('unavailable');
      }
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function audit(action, name, actor, ok) {
    const atDate = currentDate();
    const record = {
      at: atDate.toISOString(),
      action: action,
      name: safeName(name),
      actor: sanitizeActor(actor),
      ok: ok === true
    };
    const dir = path.join(core.STATE_DIR, 'logs', 'marust');
    const written = appendJsonl(dir, 'vault', record, { now: atDate });
    if (!written) warn('vault audit failed');
  }

  // 復号して値を返す内側。持ち主の判定は呼ぶ側（getFor・coreReader）が済ませてから呼ぶ
  async function readValue(name, actor) {
    await ensureMaskPreloaded();
    if (!isUsable()) {
      audit('get', name, actor, false);
      return fail('unavailable');
    }
    const row = entries.get(name);
    if (!row) {
      audit('get', name, actor, false);
      return fail('not-found');
    }
    const current = backendId();
    if (row.backend && current && row.backend !== current) {
      audit('get', name, actor, false);
      return fail('decrypt-failed');
    }
    let value;
    try {
      value = await backend.decrypt(row.ciphertext);
    } catch (_) {
      audit('get', name, actor, false);
      return fail('decrypt-failed');
    }
    if (typeof value !== 'string') {
      audit('get', name, actor, false);
      return fail('decrypt-failed');
    }
    defaultMask.remember(value);
    audit('get', name, actor, true);
    return { ok: true, value: value };
  }

  function getFor(pluginId, name) {
    return exclusive(async () => {
      const actor = typeof pluginId === 'string' ? pluginId : '';
      if (!safeName(name)) {
        audit('get', '', actor, false);
        return fail('bad-name');
      }
      // L8g: 宣言していない名前の get も通す（悪意への守りは外した。ADR 0006）
      return readValue(name, actor);
    });
  }

  function hasFor(pluginId, name) {
    return exclusive(async () => {
      const actor = typeof pluginId === 'string' ? pluginId : '';
      if (!safeName(name)) return fail('bad-name');
      return { ok: true, has: entries.has(name) };
    });
  }

  function bindDeclared(fn) {
    if (typeof declared === 'function' || typeof fn !== 'function') return false;
    declared = fn;
    return true;
  }

  function coreReader(actor, allow) {
    const who = sanitizeActor(actor);
    function permits(name) {
      if (Array.isArray(allow)) return allow.indexOf(name) !== -1;
      if (typeof allow === 'function') {
        try { return allow(name) === true; } catch (_) { return false; }
      }
      return false;
    }
    return {
      get(name) {
        return exclusive(async () => {
          if (!safeName(name)) {
            audit('get', '', who, false);
            return fail('bad-name');
          }
          if (!permits(name)) {
            audit('get', name, who, false);
            return fail('not-declared');
          }
          return readValue(name, who);
        });
      },
      list() {
        return exclusive(async () => {
          await ensureMaskPreloaded();
          const secrets = [];
          for (const row of entries.values()) if (permits(row.name)) secrets.push(publicView(row));
          secrets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          return { ok: true, secrets: secrets };
        });
      }
    };
  }

  function set(name, value, actor) {
    return exclusive(async () => {
      const who = scrubActor(actor, typeof value === 'string' ? value : '');
      if (!safeName(name)) {
        audit('set', '', who, false);
        return fail('bad-name');
      }
      const problem = valueError(value);
      if (problem) {
        audit('set', name, who, false);
        return fail(problem);
      }
      if (!isUsable() || storeDirty) {
        audit('set', name, who, false);
        return fail('unavailable');
      }
      let ciphertext;
      try {
        ciphertext = await backend.encrypt(value);
      } catch (_) {
        audit('set', name, who, false);
        return fail('unavailable');
      }
      if (leaks(ciphertext, value)) {
        audit('set', name, who, false);
        return fail('unavailable');
      }
      const row = {
        name: name,
        ciphertext: ciphertext,
        updatedAt: currentDate().toISOString(),
        size: Buffer.byteLength(value, 'utf8'),
        backend: backendId(),
        tail: tailOf(value)
      };
      const previous = entries.get(name);
      entries.set(name, row);
      if (!(await commit(name, row, previous))) {
        if (previous) entries.set(name, previous);
        else entries.delete(name);
        audit('set', name, who, false);
        return fail('unavailable');
      }
      defaultMask.remember(value);
      audit('set', name, who, true);
      return { ok: true };
    });
  }

  function remove(name, actor) {
    return exclusive(async () => {
      if (!safeName(name)) {
        audit('remove', '', actor, false);
        return fail('bad-name');
      }
      if (!entries.has(name)) {
        audit('remove', name, actor, false);
        return fail('not-found');
      }
      if (storeReason !== '' || storeDirty) {
        audit('remove', name, actor, false);
        return fail('unavailable');
      }
      const previous = entries.get(name);
      entries.delete(name);
      if (!(await commit(name, null, previous))) {
        entries.set(name, previous);
        audit('remove', name, actor, false);
        return fail('unavailable');
      }
      audit('remove', name, actor, true);
      return { ok: true };
    });
  }

  function list() {
    return exclusive(async () => {
      await ensureMaskPreloaded();
      const secrets = [];
      for (const row of entries.values()) secrets.push(publicView(row));
      secrets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { ok: true, secrets: secrets };
    });
  }

  // 保存した秘密を復号できるかの件数だけを返す（値は出さない・記録もしない）。60 秒だけ覚える。
  let healthCache = null;
  function health() {
    return exclusive(async () => {
      const at = Date.now();
      if (healthCache && at - healthCache.at < 60000) return healthCache.body;
      const total = entries.size;
      let readable = 0;
      if (isUsable()) {
        const current = backendId();
        for (const row of entries.values()) {
          if (row.backend && current && row.backend !== current) continue;
          try {
            const value = await backend.decrypt(row.ciphertext);
            if (typeof value === 'string') readable += 1;
          } catch (_) { /* 数えるだけ */ }
        }
      }
      const usable = isUsable();
      const reason = !backendOk ? 'no-backend' : storeReason !== '' ? storeReason : storeDirty ? 'store-dirty' : '';
      const body = { ok: true, usable: usable, reason: reason, store: selected.store, total: total, readable: readable, unreadable: total - readable, lost: total > 0 && readable === 0 };
      healthCache = { at: at, body: body };
      return body;
    });
  }

  function describe(name) {
    return exclusive(async () => {
      if (!safeName(name)) return fail('bad-name');
      await ensureMaskPreloaded();
      const row = entries.get(name);
      if (!row) return fail('not-found');
      return { ok: true, secret: publicView(row) };
    });
  }

  function attachStore(getter) {
    if (typeof portGetter === 'function' || typeof getter !== 'function') return false;
    portGetter = getter;
    return true;
  }

  // 置き場を替える（核の関数だけ。API・画面は作らない）。古い側の控えの全行を新しい側へ入れ、全部一致したら選択を書き換える。
  // 途中で失敗したら新しい側へ入れた行を消し、古い側と選択は残す。古い側の行は消さない。答えは件数だけ。
  function migrateStore(targetId) {
    return exclusive(async () => {
      if (opts.store || !isUsable() || storeDirty) return fail('unavailable');
      const id = typeof targetId === 'string' && (targetId === 'file' || STORE_ID_RE.test(targetId)) ? targetId : '';
      if (!id) return fail('bad-store');
      if (id === selected.store) return fail('same-store');
      const target = storeFor(id);
      if (!target) return fail('store-missing');
      const before = await storeCall((st) => st.list(), target);
      if (before.ok !== true || !Array.isArray(before.rows)) return fail('unavailable');
      if (before.rows.length > 0) return fail('target-not-empty');
      const moved = [];
      async function undo() {
        for (let i = 0; i < moved.length; i += 1) await storeCall((st) => st.delete(moved[i]), target);
      }
      for (const row of entries.values()) {
        moved.push(row.name);
        const put = await storeCall((st) => st.put(rowForStore(row)), target);
        if (put.ok !== true) {
          await undo();
          return fail('unavailable');
        }
      }
      const after = await storeCall((st) => st.list(), target);
      let same = after.ok === true && Array.isArray(after.rows) && after.rows.length === entries.size;
      if (same) {
        for (let i = 0; i < after.rows.length; i += 1) {
          const got = after.rows[i];
          const mine = got && typeof got === 'object' ? entries.get(got.name) : null;
          if (hasValueField(got) || !mine || got.ciphertext !== mine.ciphertext) { same = false; break; }
        }
      }
      if (!same) {
        await undo();
        return fail('unavailable');
      }
      try {
        writeJson(selectionPath, { schemaVersion: 1, store: id });
      } catch (_) {
        await undo();
        return fail('unavailable');
      }
      selected = { store: id };
      healthCache = null;
      let unreadable = 0;
      const current = backendId();
      for (const row of entries.values()) if (row.backend && current && row.backend !== current) unreadable += 1;
      return { ok: true, moved: entries.size, unreadable: unreadable };
    });
  }

  function preloadMask() {
    return exclusive(ensureMaskPreloaded);
  }

  return {
    file: fileStore ? fileStore.file : '',
    ready: ready,
    getFor: getFor,
    hasFor: hasFor,
    bindDeclared: bindDeclared,
    coreReader: coreReader,
    attachStore: attachStore,
    migrateStore: migrateStore,
    set: set,
    remove: remove,
    list: list,
    health: health,
    describe: describe,
    preloadMask: preloadMask
  };
}

function isWindow(ctx) {
  return !!(ctx && ctx.clientId === WINDOW_ID);
}

function metaOnly(row) {
  const src = row && typeof row === 'object' ? row : {};
  return {
    name: typeof src.name === 'string' ? src.name : '',
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : '',
    size: Number.isFinite(src.size) ? src.size : 0,
    expiresAt: typeof src.expiresAt === 'string' ? src.expiresAt : null,
    tail: typeof src.tail === 'string' ? src.tail : ''
  };
}

function withoutValue(result) {
  if (!result || typeof result !== 'object' || result.ok !== true) {
    return fail(result && result.error);
  }
  return { ok: true };
}

function createSecretApi(provider) {
  const target = provider || null;

  function list() {
    if (!target || typeof target.list !== 'function') return Promise.resolve(fail('unavailable'));
    return Promise.resolve()
      .then(() => target.list())
      .then((result) => {
        if (!result || result.ok !== true || !Array.isArray(result.secrets)) return fail('unavailable');
        return { ok: true, secrets: result.secrets.map(metaOnly) };
      })
      .catch(() => fail('unavailable'));
  }

  function set(params, ctx) {
    if (!isWindow(ctx)) return Promise.resolve(fail('forbidden'));
    if (!target || typeof target.set !== 'function') return Promise.resolve(fail('unavailable'));
    const row = params && typeof params === 'object' ? params : {};
    const actor = typeof ctx.clientId === 'string' ? ctx.clientId : '';
    return Promise.resolve()
      .then(() => target.set(row.name, row.value, actor))
      .then(withoutValue)
      .catch(() => fail('unavailable'));
  }

  function remove(params, ctx) {
    if (!isWindow(ctx)) return Promise.resolve(fail('forbidden'));
    if (!target || typeof target.remove !== 'function') return Promise.resolve(fail('unavailable'));
    const row = params && typeof params === 'object' ? params : {};
    const actor = typeof ctx.clientId === 'string' ? ctx.clientId : '';
    return Promise.resolve()
      .then(() => target.remove(row.name, actor))
      .then(withoutValue)
      .catch(() => fail('unavailable'));
  }

  return { list: list, set: set, remove: remove };
}

module.exports = {
  createSecretProvider,
  createSecretApi,
  selectBackend,
  SECRET_API_SPEC,
  NAME_RE,
  MAX_SECRET_BYTES,
  WINDOW_ID
};
