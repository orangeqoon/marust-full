'use strict';

/**
 * キーの口（K3。host/hotkeys.js から名前を変えた）。内蔵プラグイン hotkeys が ctx.keys（reload・save・list・release）として使う。
 * 検査（キーの形・method・件数・大きさ・表にある名前か）と、押下を窓と同じ権限で api.call する実行は、全部ここ（核）。プラグインは権限の identity を持たない。
 * 設定の置き場は今までどおり STATE_DIR/data/marust/hotkeys.json（バックアップ・引っ越しの settings-export が同じファイルを読み書きするため動かさない）。
 * グローバルホットキー。設定は STATE_DIR/data/marust/hotkeys.json（配列。無いときは空）。
 * Electron の globalShortcut は注入する。生成時は登録しない。reload() か save() で登録する。
 * 押下は api.call(method, params, { permissions: ウィンドウと同じ, via: 'hotkey' })。
 * ホットキーは 1 回押しですぐ実行する（初めは何も割り当てない）。
 * notify には引数も API の戻り値も入れない。登録に失敗したキーは警告して次へ進む。
 * unregisterAll() はここで登録したキーだけを外す。設定ファイルは消さない。
 * deps.enabled（関数。無ければ常に true）が true でないあいだ（内蔵プラグイン hotkeys を切っている）は、何も登録せず、
 * 登録済みのキーも外す。設定ファイルは消さない（V3）。
 * 表に無いメソッド（その機能を切っている）のキーは、読み込みでは捨てずに「切ってある」行（off: true）として残す。登録はしない。
 * 保存では、deps.knownMethod（どこかのプラグインが持つ名前か）が真のものだけ同じ扱い。打ち間違いは unknown-method で断る。
 */

const fs = require('fs');
const path = require('path');
const { IPC_PERMISSIONS } = require('./api');

const MAX_BINDINGS = 32;
const MAX_BYTES = 64 * 1024;
const MAX_LABEL = 80;
const MAX_PARAMS = 8192;
const METHOD_RE = /^[a-z][a-z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9_-]*)+$/;

const MODIFIER_ORDER = [
  'CommandOrControl', 'Command', 'Control', 'Alt', 'Option', 'AltGr', 'Shift', 'Super'
];

const MODIFIERS = {
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  alt: 'Alt',
  option: 'Option',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super'
};

const NAMED_KEYS = {
  plus: 'Plus',
  space: 'Space',
  tab: 'Tab',
  capslock: 'Capslock',
  numlock: 'Numlock',
  scrolllock: 'Scrolllock',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause',
  printscreen: 'PrintScreen'
};

const PUNCT = new Set([
  ')', '!', '@', '#', '$', '%', '^', '&', '*', '(',
  ':', ';', '=', '<', ',', '_', '-', '>', '.', '?',
  '/', '~', '`', '{', ']', '[', '|', '\\', '}', '"'
]);

function resolveFile(store) {
  const src = store && typeof store === 'object' ? store : null;
  if (!src) throw new Error('hotkeys require STATE_DIR');
  const root = typeof src.STATE_DIR === 'string' && src.STATE_DIR
    ? src.STATE_DIR
    : (typeof src.stateDir === 'string' ? src.stateDir : '');
  if (!root) throw new Error('hotkeys require STATE_DIR');
  return path.join(root, 'data', 'marust', 'hotkeys.json');
}

function keyOf(token) {
  const lower = token.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  const func = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (func) return 'F' + String(Number(func[1]));
  const num = /^num(?:([0-9])|(dec|add|sub|mult|div))$/i.exec(token);
  if (num) return 'num' + (num[1] != null ? num[1] : num[2].toLowerCase());
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (token.length === 1 && PUNCT.has(token)) return token;
  return '';
}

function canonicalAccelerator(value) {
  if (typeof value !== 'string') return '';
  if (value.length < 1 || value.length > 100) return '';
  if (/\s/.test(value)) return '';
  const parts = value.split('+');
  const seenMod = new Set();
  let key = '';
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    if (!token) return '';
    const mod = MODIFIERS[token.toLowerCase()];
    if (mod) {
      if (seenMod.has(mod)) return '';
      seenMod.add(mod);
      continue;
    }
    if (key) return '';
    key = keyOf(token);
    if (!key) return '';
  }
  if (!key) return '';
  if (seenMod.has('CommandOrControl') && (seenMod.has('Command') || seenMod.has('Control'))) return '';
  const ordered = [];
  for (let i = 0; i < MODIFIER_ORDER.length; i += 1) {
    if (seenMod.has(MODIFIER_ORDER[i])) ordered.push(MODIFIER_ORDER[i]);
  }
  ordered.push(key);
  return ordered.join('+');
}

function validMethodName(method) {
  return typeof method === 'string' && method.length <= 120 && METHOD_RE.test(method);
}

function validLabel(label) {
  if (label == null || label === '') return '';
  if (typeof label !== 'string') return null;
  if (label.length > MAX_LABEL) return null;
  if (/[\u0000-\u001f\u007f]/.test(label)) return null;
  return label;
}

const SECRET_FIELD = /^(key|token|password|secret|cookie)s?$/i;

function dropSecretFields(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) out.push(dropSecretFields(value[i]));
    return out;
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (SECRET_FIELD.test(key)) continue;
    out[key] = dropSecretFields(value[key]);
  }
  return out;
}

function cloneParams(params) {
  try {
    const text = JSON.stringify(params == null ? {} : params);
    if (typeof text !== 'string' || text.length > MAX_PARAMS) return null;
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function checkEntry(entry, table, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: 'bad-entry' };
  const accelerator = canonicalAccelerator(entry.accelerator);
  if (!accelerator) return { ok: false, error: 'bad-accelerator' };
  if (!validMethodName(entry.method)) return { ok: false, error: 'bad-method' };
  const method = entry.method;
  if (method.indexOf('secrets.') === 0 || method.indexOf('clients.') === 0) {
    return { ok: false, error: 'forbidden' };
  }
  const row = table.get(method);
  // 表に無い＝その機能（プラグイン）を切っている。捨てずに「切ってある」行にする（V3-12）。ほかの検査は下で今までどおり行う
  const off = !row;
  if (row) {
    if (row.windowOnly === true) return { ok: false, error: 'forbidden' };
    const allowed = row.permission === 'read' || row.permission === 'write' || method === 'engine.emergencyStop';
    if (!allowed) return { ok: false, error: 'forbidden' };
  }
  const params = cloneParams(entry.params == null ? {} : entry.params);
  if (!params) return { ok: false, error: 'bad-params' };
  // ホットキーの押下は確認なしで動くので、題名の一斉変更の「確認済み」の印は書かせない（V2 の評価 Must 2 と同じ理由）
  if (method === 'hub.fanout' && (Object.prototype.hasOwnProperty.call(params, 'confirmed') || Object.prototype.hasOwnProperty.call(params, 'allowedLiveIds'))) {
    return { ok: false, error: 'forbidden' };
  }
  const label = validLabel(entry.label);
  if (label == null) return { ok: false, error: 'bad-label' };
  if (seen.has(accelerator)) return { ok: false, error: 'duplicate' };
  const binding = {
    accelerator: accelerator,
    method: method,
    params: params,
    label: label
  };
  if (off) binding.off = true;
  return { ok: true, binding: binding };
}

// known(method): その名前をどこかのプラグインが持っているか。保存では、持ち主が見つからない名前（打ち間違い）は今までどおり unknown-method で断る。
// 持ち主はいるが表に無い（その機能を切っている）ものだけ「切ってある」行で保存する。known が無ければ、表に無い名前は全部断る
function validateAll(input, table, known) {
  if (!Array.isArray(input) || input.length > MAX_BINDINGS) return { ok: false, error: 'bad-config' };
  const seen = new Set();
  const bindings = [];
  for (let i = 0; i < input.length; i += 1) {
    const checked = checkEntry(input[i], table, seen);
    if (!checked.ok) return { ok: false, error: checked.error, index: i };
    if (checked.binding.off === true && !(known && known(checked.binding.method))) return { ok: false, error: 'unknown-method', index: i };
    seen.add(checked.binding.accelerator);
    bindings.push(checked.binding);
  }
  return { ok: true, bindings: bindings };
}

function safeError(error, ok) {
  if (ok) return '';
  if (typeof error === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(error)) return error;
  return 'failed';
}

function createKeysPort(deps) {
  const src = deps || {};
  const api = src.api;
  const globalShortcut = src.globalShortcut;
  if (!api || typeof api.call !== 'function') throw new Error('hotkeys require api');
  if (!globalShortcut || typeof globalShortcut.register !== 'function' || typeof globalShortcut.unregister !== 'function') {
    throw new Error('hotkeys require globalShortcut');
  }
  const file = resolveFile(src.store);
  const writeJson = src.store && typeof src.store.atomicWriteJsonSync === 'function'
    ? src.store.atomicWriteJsonSync
    : null;
  const logger = typeof src.logger === 'function' ? src.logger : function () {};
  const notify = typeof src.notify === 'function' ? src.notify : function () {};
  const knownMethod = typeof src.knownMethod === 'function'
    ? function (method) { try { return src.knownMethod(method) === true; } catch (_) { return false; } }
    : null;
  const now = typeof src.now === 'function' ? src.now : function () { return Date.now(); };
  // 内蔵プラグイン hotkeys の入／切。関数が無ければ常に入
  const isEnabled = typeof src.enabled === 'function'
    ? function () { try { return src.enabled() === true; } catch (_) { return false; } }
    : function () { return true; };

  let generation = 0;
  let configured = [];
  const active = new Map();

  function emit(binding, fields) {
    const ok = fields.ok === true;
    const event = {
      event: 'hotkey.result',
      accelerator: binding.accelerator,
      method: binding.method,
      label: binding.label,
      ok: ok,
      error: safeError(fields.error, ok),
      message: ''
    };
    try {
      notify(event);
    } catch (_) {
      logger('warn', 'hotkey notify failed');
    }
  }

  function clearRegistrations() {
    const names = Array.from(active.keys());
    active.clear();
    for (let i = 0; i < names.length; i += 1) {
      try {
        globalShortcut.unregister(names[i]);
      } catch (_) {
        logger('warn', 'hotkey unregister failed');
      }
    }
  }

  function registerList(bindings) {
    clearRegistrations();
    const failed = [];
    configured = [];
    for (let i = 0; i < bindings.length; i += 1) {
      const binding = {
        accelerator: bindings[i].accelerator,
        method: bindings[i].method,
        params: cloneParams(bindings[i].params) || {},
        label: bindings[i].label
      };
      if (bindings[i].off === true) binding.off = true;
      configured.push(binding);
      if (binding.off === true) continue; // 切ってある機能のキーは、残すだけで登録しない
      let registered = false;
      try {
        registered = globalShortcut.register(binding.accelerator, function () {
          return handlePress(binding.accelerator);
        }) === true;
      } catch (_) {
        registered = false;
      }
      if (!registered) {
        failed.push(binding.accelerator);
        logger('warn', 'hotkey register failed accelerator=' + binding.accelerator);
        continue;
      }
      active.set(binding.accelerator, binding);
    }
    return {
      ok: true,
      count: configured.length,
      registered: active.size,
      failed: failed,
      skipped: 0
    };
  }

  // 内蔵プラグイン hotkeys を切っているあいだ: 登録を全部外す（unregisterAll と同じ）。設定（ファイル）は変えない。save のあとだけ list 用に configured を入れ替える
  function standDown(bindings) {
    generation += 1;
    clearRegistrations();
    if (Array.isArray(bindings)) {
      configured = bindings.map(function (row) {
        const own = { accelerator: row.accelerator, method: row.method, params: cloneParams(row.params) || {}, label: row.label };
        if (row.off === true) own.off = true;
        return own;
      });
    }
    return { ok: true, count: configured.length, registered: 0, failed: [], skipped: 0, off: true };
  }

  function handlePress(accelerator) {
    const binding = active.get(accelerator);
    if (!binding) return Promise.resolve();
    const params = cloneParams(binding.params) || {};
    const ctx = { permissions: IPC_PERMISSIONS.slice(), via: 'hotkey' };
    return Promise.resolve()
      .then(function () { return api.call(binding.method, params, ctx); })
      .then(function (result) {
        emit(binding, { ok: !!(result && result.ok === true), error: result && result.error });
      }, function () {
        emit(binding, { ok: false, error: 'failed' });
      });
  }

  function readConfig() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, entries: [] };
      logger('warn', 'hotkey read failed');
      return { ok: false, error: 'read-failed' };
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      logger('warn', 'hotkey read failed');
      return { ok: false, error: 'read-failed' };
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (_) {
      logger('warn', 'hotkey read failed');
      return { ok: false, error: 'read-failed' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      logger('warn', 'hotkey parse failed');
      return { ok: false, error: 'parse-failed' };
    }
    if (!Array.isArray(data) || data.length > MAX_BINDINGS) {
      logger('warn', 'hotkey parse failed');
      return { ok: false, error: 'parse-failed' };
    }
    return { ok: true, entries: data };
  }

  function writeConfig(bindings) {
    const body = [];
    for (let i = 0; i < bindings.length; i += 1) {
      const row = bindings[i];
      body.push({
        accelerator: row.accelerator,
        method: row.method,
        params: row.params,
        label: row.label
      });
    }
    if (writeJson) {
      writeJson(file, body);
      return;
    }
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, path.basename(file) + '.tmp-' + process.pid);
    try {
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } finally {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch (_) { /* rename 済み */ }
      }
    }
  }

  async function loadDescribe() {
    const result = await api.call('api.describe', {}, { permissions: ['read'], via: 'hotkey' });
    if (!result || result.ok !== true || !Array.isArray(result.methods)) {
      throw new Error('describe');
    }
    const table = new Map();
    for (let i = 0; i < result.methods.length; i += 1) {
      const row = result.methods[i];
      if (!row || typeof row.method !== 'string') continue;
      table.set(row.method, {
        permission: typeof row.permission === 'string' ? row.permission : '',
        windowOnly: row.windowOnly === true
      });
    }
    return table;
  }

  function acceptLoose(entries, table) {
    const seen = new Set();
    const bindings = [];
    let skipped = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const checked = checkEntry(entries[i], table, seen);
      if (!checked.ok) {
        skipped += 1;
        logger('warn', 'hotkey skip error=' + checked.error);
        continue;
      }
      seen.add(checked.binding.accelerator);
      bindings.push(checked.binding);
    }
    return { bindings: bindings, skipped: skipped };
  }

  async function reload() {
    if (!isEnabled()) return standDown();
    const gen = ++generation;
    let table;
    try {
      table = await loadDescribe();
    } catch (_) {
      if (gen !== generation) return { ok: false, error: 'cancelled' };
      logger('warn', 'hotkey describe failed');
      return { ok: false, error: 'describe-failed' };
    }
    if (gen !== generation) return { ok: false, error: 'cancelled' };
    const read = readConfig();
    if (gen !== generation) return { ok: false, error: 'cancelled' };
    if (!read.ok) {
      registerList([]);
      return { ok: false, error: read.error };
    }
    const loose = acceptLoose(read.entries, table);
    if (gen !== generation) return { ok: false, error: 'cancelled' };
    const applied = registerList(loose.bindings);
    applied.skipped = loose.skipped;
    return applied;
  }

  async function save(input) {
    let table;
    try {
      table = await loadDescribe();
    } catch (_) {
      logger('warn', 'hotkey describe failed');
      return { ok: false, error: 'describe-failed' };
    }
    const checked = validateAll(input, table, knownMethod);
    if (!checked.ok) return checked;
    const gen = ++generation;
    try {
      writeConfig(checked.bindings);
    } catch (_) {
      logger('warn', 'hotkey write failed');
      return { ok: false, error: 'write-failed' };
    }
    if (gen !== generation) return { ok: false, error: 'cancelled' };
    // 書けたが機能を切っているときは、登録はせず list にだけ出す
    if (!isEnabled()) return standDown(checked.bindings);
    return registerList(checked.bindings);
  }

  function unregisterAll() {
    generation += 1;
    clearRegistrations();
    return { ok: true };
  }

  function list() {
    const bindings = [];
    for (let i = 0; i < configured.length; i += 1) {
      const row = configured[i];
      const out = {
        accelerator: row.accelerator,
        method: row.method,
        params: dropSecretFields(cloneParams(row.params) || {}),
        label: row.label,
        registered: active.has(row.accelerator)
      };
      if (row.off === true) out.off = true;
      bindings.push(out);
    }
    return { ok: true, bindings: bindings };
  }

  return {
    reload: reload,
    save: save,
    unregisterAll: unregisterAll,
    release: unregisterAll,
    list: list
  };
}

module.exports = {
  createKeysPort,
  createHotkeys: createKeysPort
};
