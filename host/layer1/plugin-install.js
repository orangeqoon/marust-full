'use strict';

/**
 * 外から入れるプラグインの検証・展開・置き換え・戻す・消す（PLAN-plugin-core §7.3。P4a。画面はまだ無い）。
 * - 入れ方は自分の PC にある zip かフォルダだけ。ネットからは落とさない。
 * - まず <STATE_DIR>/plugins/.tmp-<乱数>/ に展開して検証し、合格したら名前を変えて <STATE_DIR>/plugins/<id>/ に置く。
 * - 入れた直後は必ず legacy（動かない）。動かすのは本人が id を入力したとき（api の modes.set。外部は shadow も live も）。
 * - 更新・戻す・消すで外れた版は <STATE_DIR>/plugins-backup/<id>-<版>/ に 1 つだけ残す。
 * - 配信中は入れる・更新・戻す・消すを全部断る。live のあいだは更新・戻す・消すを断る。
 * - legacy はファイルを動かす前に書く。書けなければ何もしない（mode-write-failed）。
 * - 入れるのは inspect で見せたものと同じ中身だけ（install(source, { expectSha256 })。違えば changed-since-inspect）。
 * 秘密の値・フォルダの中身はログ・戻り値に出さない（監査には id・版・ハッシュの先頭 12 文字だけ）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');
const { externalGuard, externalIdProblem, EXT_PROVIDES_NOT_ALLOWED } = require('./plugin-registry');
const { coreApiProblem } = require('./registry/manifest');

const LIMITS = Object.freeze({
  totalBytes: 20 * 1024 * 1024,
  files: 2000,
  fileBytes: 10 * 1024 * 1024,
  manifestBytes: 256 * 1024,
  pathChars: 200,
  segmentChars: 64
});

const EXT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
// 末尾も英数字（「1.」は Windows で点が落ちて別の名前のフォルダになる。★2 M9）
const VERSION_RE = /^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,30}[0-9A-Za-z])?$/;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
const BAD_CHARS_RE = /[\u0000-\u001f\u007f<>:"|?*\\]/;
const HIDDEN_CHARS_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u061c]/;
const INSTALL_FILE = '.install.json';

function fail(error) {
  return { ok: false, error: error };
}

class InstallError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** 画面・ログに出す文字から、制御文字と向きを変える文字（bidi）を除く。 */
function safeText(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u061c]/g, '').slice(0, max || 80);
}

/** 展開先の相対パス 1 本（"/" 区切り）を調べる。問題があればエラーコード、なければ ''。 */
function checkRelPath(rel, isDir) {
  if (typeof rel !== 'string' || rel === '') return 'bad-path';
  if (rel.length > LIMITS.pathChars) return 'bad-path';
  if (rel.charAt(0) === '/' || /^[a-zA-Z]:/.test(rel)) return 'bad-path';
  if (BAD_CHARS_RE.test(rel) || HIDDEN_CHARS_RE.test(rel)) return 'bad-path';
  const parts = rel.split('/');
  if (isDir && parts[parts.length - 1] === '') parts.pop();
  if (!parts.length) return 'bad-path';
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return 'bad-path';
    if (part.length > LIMITS.segmentChars) return 'bad-path';
    if (/[. ]$/.test(part)) return 'bad-path'; // Windows は末尾の点・空白を落とす（別の名前に化ける）
    if (WIN_RESERVED_RE.test(part.split('.')[0].replace(/ +$/, ''))) return 'bad-path';
  }
  return '';
}

function dupKey(rel) {
  return rel.normalize('NFC').toLowerCase();
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* 消せなくても続ける */ }
}

// 実際に流れたバイト数を数え、宣言（と全体の上限）を超えたら止める（zip 爆弾）。
function countingStream(limitFile, budget) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      budget.used += chunk.length;
      if (n > limitFile || budget.used > LIMITS.totalBytes) return cb(new InstallError('too-big'));
      return cb(null, chunk);
    }
  });
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
      if (err) reject(new InstallError('zip-invalid'));
      else resolve(zip);
    });
  });
}

function readAllEntries(zip) {
  return new Promise((resolve, reject) => {
    const out = [];
    if (zip.entryCount > LIMITS.files * 2) return reject(new InstallError('too-many-files'));
    zip.on('error', (err) => reject(new InstallError(/relative path|absolute path|invalid characters|backslash/i.test(String(err && err.message)) ? 'bad-path' : 'zip-invalid')));
    zip.on('end', () => resolve(out));
    zip.on('entry', (entry) => {
      out.push(entry);
      if (out.length > LIMITS.files * 2) return reject(new InstallError('too-many-files'));
      return zip.readEntry();
    });
    zip.readEntry();
  });
}

function entryType(entry) {
  const attrs = entry.externalFileAttributes >>> 0;
  if (attrs & 0x400) return 'link'; // Windows の再解析ポイント
  const unix = (attrs >>> 16) & 0o170000;
  if (unix === 0o120000) return 'link';
  if (unix !== 0 && unix !== 0o100000 && unix !== 0o040000) return 'special';
  return unix === 0o040000 || /\/$/.test(entry.fileName) ? 'dir' : 'file';
}

/** zip の中身の一覧を検査して、取り出す計画 [{ rel, entry }] を返す。展開はしない。 */
function planZip(entries) {
  const rows = [];
  for (const entry of entries) {
    const name = entry.fileName;
    if (/^__MACOSX\//.test(name)) continue;
    const type = entryType(entry);
    if (type === 'link' || type === 'special') throw new InstallError('link-not-allowed');
    if (entry.isEncrypted()) throw new InstallError('zip-invalid');
    const bad = checkRelPath(name, type === 'dir');
    if (bad) throw new InstallError(bad);
    rows.push({ name: type === 'dir' ? name.replace(/\/$/, '') : name, type, entry });
  }
  // manifest.json が先頭にあるか、全部が 1 つのフォルダの下にあるか
  let prefix = '';
  if (!rows.some((r) => r.type === 'file' && r.name === 'manifest.json')) {
    const tops = new Set(rows.map((r) => r.name.split('/')[0]));
    if (tops.size === 1) {
      const top = Array.from(tops)[0];
      if (rows.some((r) => r.type === 'file' && r.name === top + '/manifest.json')) prefix = top + '/';
    }
    if (!prefix) throw new InstallError('no-manifest');
  }
  const plan = [];
  const seen = new Set();
  let files = 0;
  let total = 0;
  for (const row of rows) {
    if (prefix) {
      if (row.type === 'dir' && row.name === prefix.slice(0, -1)) continue;
      if (row.name.indexOf(prefix) !== 0) throw new InstallError('bad-layout');
    }
    const rel = prefix ? row.name.slice(prefix.length) : row.name;
    if (rel === INSTALL_FILE || rel.indexOf('.tmp-') === 0) throw new InstallError('bad-path');
    const key = dupKey(rel);
    if (seen.has(key)) throw new InstallError('duplicate-path');
    seen.add(key);
    if (row.type === 'file') {
      files += 1;
      const size = row.entry.uncompressedSize;
      if (size > LIMITS.fileBytes) throw new InstallError('too-big');
      total += size;
      if (total > LIMITS.totalBytes) throw new InstallError('too-big');
      if (files > LIMITS.files) throw new InstallError('too-many-files');
    } else if (row.entry.uncompressedSize !== 0) {
      throw new InstallError('bad-path');
    }
    plan.push({ rel, type: row.type, entry: row.entry });
  }
  return plan;
}

function destOf(tmp, rel) {
  const dest = path.resolve(tmp, ...rel.split('/'));
  const back = path.relative(tmp, dest);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new InstallError('bad-path');
  return dest;
}

async function extractZip(file, tmp) {
  const zip = await openZip(file);
  try {
    const entries = await readAllEntries(zip);
    const plan = planZip(entries);
    const budget = { used: 0 };
    for (const row of plan) {
      const dest = destOf(tmp, row.rel);
      if (row.type === 'dir') {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const stream = await new Promise((resolve, reject) => {
        zip.openReadStream(row.entry, (err, s) => (err ? reject(new InstallError('zip-invalid')) : resolve(s)));
      });
      try {
        await pipeline(stream, countingStream(row.entry.uncompressedSize, budget), fs.createWriteStream(dest, { flags: 'wx' }));
      } catch (err) {
        throw err instanceof InstallError ? err : new InstallError('zip-invalid');
      }
    }
  } finally {
    try { zip.close(); } catch (_) { /* 閉じられなくても続ける */ }
  }
}

function copyFolder(srcDir, tmp) {
  const st = fs.lstatSync(srcDir);
  if (!st.isDirectory()) throw new InstallError('not-found');
  const seen = new Set();
  const budget = { files: 0, bytes: 0 };
  function walk(dir, relDir) {
    for (const name of fs.readdirSync(dir)) {
      const rel = relDir ? relDir + '/' + name : name;
      const full = path.join(dir, name);
      const info = fs.lstatSync(full); // リンク・ジャンクションを辿らない
      if (info.isSymbolicLink()) throw new InstallError('link-not-allowed');
      if (!info.isDirectory() && !info.isFile()) throw new InstallError('link-not-allowed');
      const bad = checkRelPath(rel, info.isDirectory());
      if (bad) throw new InstallError(bad);
      if (rel === INSTALL_FILE || rel.indexOf('.tmp-') === 0) throw new InstallError('bad-path');
      const key = dupKey(rel);
      if (seen.has(key)) throw new InstallError('duplicate-path');
      seen.add(key);
      const dest = destOf(tmp, rel);
      if (info.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        walk(full, rel);
      } else {
        budget.files += 1;
        budget.bytes += info.size;
        if (info.size > LIMITS.fileBytes || budget.bytes > LIMITS.totalBytes) throw new InstallError('too-big');
        if (budget.files > LIMITS.files) throw new InstallError('too-many-files');
        fs.copyFileSync(full, dest, fs.constants.COPYFILE_EXCL);
      }
    }
  }
  walk(srcDir, '');
}

/** 展開した木を調べ直す（リンク・特殊ファイルが無いか、数と大きさ）。ファイル数・合計・各ファイルの相対パスと内容のハッシュを返す。 */
function auditTree(tmp) {
  const files = [];
  let bytes = 0;
  function walk(dir, relDir) {
    for (const name of fs.readdirSync(dir)) {
      const rel = relDir ? relDir + '/' + name : name;
      const info = fs.lstatSync(path.join(dir, name));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new InstallError('link-not-allowed');
      if (info.isDirectory()) { walk(path.join(dir, name), rel); continue; }
      if (info.size > LIMITS.fileBytes) throw new InstallError('too-big');
      bytes += info.size;
      files.push(rel);
    }
  }
  walk(tmp, '');
  if (files.length > LIMITS.files) throw new InstallError('too-many-files');
  if (bytes > LIMITS.totalBytes) throw new InstallError('too-big');
  return { files, bytes };
}

function treeHash(tmp, files) {
  const h = crypto.createHash('sha256');
  files.slice().sort().forEach((rel) => {
    h.update(rel + '\0');
    h.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, ...rel.split('/')))).digest());
  });
  return h.digest('hex');
}

function readJsonFile(file, maxBytes) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > maxBytes) throw new InstallError('bad-manifest');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
  } catch (_) {
    throw new InstallError('bad-manifest');
  }
}

function createPluginInstaller(options) {
  const opts = options || {};
  if (!opts.stateDir) throw new Error('installer requires stateDir');
  const pluginsRoot = path.join(opts.stateDir, 'plugins');
  const backupRoot = path.join(opts.stateDir, 'plugins-backup');
  const builtinRoots = Array.isArray(opts.builtinRoots) ? opts.builtinRoots : [];
  const reservedIds = typeof opts.reservedIds === 'function' ? opts.reservedIds : () => [];
  // 配信中かどうか・モード・legacy を書く・読み直す は必須（無ければ「配信していない」扱いにせず、作らない。★2 M5）
  ['isStreaming', 'modeOf', 'setLegacy', 'rescan'].forEach((k) => {
    if (typeof opts[k] !== 'function') throw new Error('installer requires ' + k);
  });
  const isStreaming = opts.isStreaming;
  const modeOf = opts.modeOf;
  const setLegacy = opts.setLegacy;
  const rescan = opts.rescan;
  const audit = typeof opts.audit === 'function' ? opts.audit : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const random = typeof opts.random === 'function' ? opts.random : () => crypto.randomBytes(8).toString('hex');

  let chain = Promise.resolve();
  function serialize(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  function builtinIds() {
    const set = new Set();
    builtinRoots.forEach((root) => {
      try {
        fs.readdirSync(root, { withFileTypes: true }).forEach((e) => { if (e.isDirectory() && e.name.charAt(0) !== '.') set.add(e.name); });
      } catch (_) { /* 置き場が無ければ何もない */ }
    });
    try { reservedIds().forEach((id) => set.add(String(id))); } catch (_) { /* 取れなければ上の分だけ */ }
    return set;
  }

  function cleanupTemp() {
    try {
      fs.readdirSync(pluginsRoot, { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory() && e.name.indexOf('.tmp-') === 0) rmrf(path.join(pluginsRoot, e.name));
      });
    } catch (_) { /* 置き場がまだ無い */ }
  }

  function checkManifest(tmp, files) {
    const manifest = readJsonFile(path.join(tmp, 'manifest.json'), LIMITS.manifestBytes);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new InstallError('bad-manifest');
    if (manifest.manifestVersion !== 2) throw new InstallError('bad-manifest');
    if (manifest.runtime !== 'inproc') throw new InstallError('bad-runtime');
    // つなぎ口の版（計画 C・D2）。この丸ストより新しい口を要るものは入れない（動いている古い版を、読めない新しい版で置き換えない）。
    const apiProblem = coreApiProblem(manifest);
    if (apiProblem) throw new InstallError(apiProblem);
    const id = manifest.id;
    const idProblem = externalIdProblem(id); // registry と同じ規則（★2 M4）
    if (idProblem) throw new InstallError(idProblem === 'reserved-name' ? 'id-reserved' : 'bad-id');
    if (builtinIds().has(id)) throw new InstallError('id-reserved');
    if (typeof manifest.name !== 'string' || manifest.name.trim() === '' || manifest.name.length > 80) throw new InstallError('bad-manifest');
    if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) throw new InstallError('bad-version');
    if (manifest.roles !== undefined || manifest.site !== undefined) throw new InstallError('site-format-not-allowed');
    if (Array.isArray(manifest.needs) && manifest.needs.indexOf('obs.streamControl') !== -1) throw new InstallError('needs-not-allowed');
    if (Array.isArray(manifest.provides) && manifest.provides.some((p) => EXT_PROVIDES_NOT_ALLOWED.indexOf(p) !== -1)) throw new InstallError('provides-not-allowed');
    const guard = externalGuard(JSON.parse(JSON.stringify(manifest)), id);
    if (guard) throw new InstallError(guard === 'secret-namespace' ? 'secret-namespace' : 'bad-manifest');
    const main = manifest.main == null || manifest.main === '' ? 'index.js' : manifest.main;
    if (typeof main !== 'string' || checkRelPath(main.replace(/\\/g, '/'), false) || main.indexOf('\\') !== -1 || files.indexOf(main) === -1) throw new InstallError('bad-main');
    return manifest;
  }

  function summaryOf(manifest, extra) {
    const names = (list, re) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && re.test(x)).slice(0, 40) : []);
    return Object.assign({
      id: manifest.id,
      name: safeText(manifest.name, 80),
      version: manifest.version,
      // 承認画面に出す「使う力」（申告。閉じ込める仕組みではない）
      uses: {
        secrets: names(manifest.secrets, /^[a-z0-9.-]{1,80}$/),
        needs: names(manifest.needs, /^[A-Za-z0-9.:_-]{1,40}$/),
        provides: names(manifest.provides, /^[a-z0-9.@-]{1,40}$/),
        // 画面の差し込み口（V7-6）。本体の画面の決まった場所に出す・メニューに足すものは承認のとき見せる
        slots: names(manifest.ui && Array.isArray(manifest.ui.slots) ? manifest.ui.slots.map((s) => s && s.slot) : [], /^[a-zA-Z.]{1,40}$/),
        menu: names(manifest.ui && Array.isArray(manifest.ui.menu) ? manifest.ui.menu.map((m) => m && m.label) : [], /^.{1,40}$/)
      }
    }, extra || {});
  }

  /** 検証して .tmp-<乱数> に展開する。成功したら { tmp, info }。失敗したら tmp を消して InstallError。 */
  async function stage(source) {
    if (typeof source !== 'string' || source === '' || source.indexOf('\0') !== -1) throw new InstallError('not-found');
    let st;
    try { st = fs.lstatSync(source); } catch (_) { throw new InstallError('not-found'); }
    if (st.isSymbolicLink()) throw new InstallError('link-not-allowed');
    fs.mkdirSync(pluginsRoot, { recursive: true });
    cleanupTemp();
    const tmp = path.join(pluginsRoot, '.tmp-' + random());
    fs.mkdirSync(tmp);
    try {
      let format;
      let sha;
      if (st.isDirectory()) {
        format = 'folder';
        copyFolder(source, tmp);
      } else if (st.isFile()) {
        format = 'zip';
        if (st.size > LIMITS.totalBytes) throw new InstallError('too-big');
        sha = await hashFile(source);
        await extractZip(source, tmp);
      } else {
        throw new InstallError('not-found');
      }
      const tree = auditTree(tmp);
      if (tree.files.indexOf('manifest.json') === -1) throw new InstallError('no-manifest');
      const manifest = checkManifest(tmp, tree.files);
      if (!sha) sha = treeHash(tmp, tree.files);
      const info = summaryOf(manifest, {
        format: format,
        sha256: sha,
        fileCount: tree.files.length,
        bytes: tree.bytes,
        sourceName: safeText(path.basename(source), 80)
      });
      return { tmp, info };
    } catch (err) {
      rmrf(tmp);
      throw err;
    }
  }

  function currentVersion(dir) {
    try {
      const m = readJsonFile(path.join(dir, 'manifest.json'), LIMITS.manifestBytes);
      if (m && typeof m.version === 'string' && VERSION_RE.test(m.version)) return m.version;
    } catch (_) { /* 読めなければ unknown */ }
    return 'unknown';
  }

  function backupsOf(id) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(backupRoot, { withFileTypes: true }); } catch (_) { return out; }
    names.forEach((e) => {
      if (!e.isDirectory() || e.name.indexOf(id + '-') !== 0) return;
      const dir = path.join(backupRoot, e.name);
      try {
        const m = readJsonFile(path.join(dir, 'manifest.json'), LIMITS.manifestBytes);
        if (m && m.id === id) out.push({ dir, version: typeof m.version === 'string' ? m.version : 'unknown' });
      } catch (_) { /* 読めないものは戻せない */ }
    });
    return out;
  }

  /** ファイルを動かす前に: 配信中なら断る・（すでにあるものは）live なら断る・legacy を書く。書けなければ止める。 */
  async function beforeMove(id, existed) {
    if (await isStreaming()) throw new InstallError('streaming');
    if (existed && modeOf(id) === 'live') throw new InstallError('live');
    let wrote;
    try { wrote = await setLegacy(id); } catch (_) { wrote = null; }
    if (!wrote || wrote.ok !== true) throw new InstallError('mode-write-failed');
  }

  /** 検証済みの .tmp を <id> に置く。すでにあれば古い版を plugins-backup へ 1 つだけ残す。 */
  async function commit(tmp, info, how, prepared) {
    const id = info.id;
    const dest = path.join(pluginsRoot, id);
    const existed = fs.existsSync(dest);
    let previousVersion = '';
    let movedTo = '';
    if (!prepared) await beforeMove(id, existed);
    if (existed) {
      previousVersion = currentVersion(dest);
      fs.mkdirSync(backupRoot, { recursive: true });
      backupsOf(id).forEach((b) => rmrf(b.dir)); // 残すのは 1 つだけ
      movedTo = path.join(backupRoot, id + '-' + previousVersion);
      rmrf(movedTo);
      try { fs.renameSync(dest, movedTo); } catch (_) { throw new InstallError('rename-failed'); }
    }
    try {
      fs.writeFileSync(path.join(tmp, INSTALL_FILE), JSON.stringify({
        id: id,
        version: info.version,
        sourceName: info.sourceName,
        sha256: info.sha256,
        format: info.format,
        installedAt: new Date(now()).toISOString(),
        how: how
      }, null, 2));
      fs.renameSync(tmp, dest);
    } catch (_) {
      if (movedTo) { try { fs.renameSync(movedTo, dest); } catch (_) { /* 戻せなければ backup に残る */ } }
      throw new InstallError('rename-failed');
    }
    await rescan(id);
    audit({ action: 'plugin.' + how, id: id, version: info.version, sha: String(info.sha256 || '').slice(0, 12) });
    return Object.assign({ ok: true }, info, { updated: existed, previousVersion: previousVersion });
  }

  function wrap(fn) {
    return serialize(async () => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof InstallError) return fail(err.code);
        return fail('failed');
      }
    });
  }

  return {
    LIMITS,
    /** 承認画面の材料。展開して検証したあと、何も残さない。 */
    inspect(source) {
      return wrap(async () => {
        const staged = await stage(source);
        rmrf(staged.tmp);
        const dest = path.join(pluginsRoot, staged.info.id);
        const existed = fs.existsSync(dest);
        return Object.assign({ ok: true }, staged.info, { updates: existed, previousVersion: existed ? currentVersion(dest) : '' });
      });
    },
    /** 入れる（同じ id が外部にあれば更新）。expectSha256 は inspect が返した sha256（承認したものと同じ中身だけ入れる）。 */
    install(source, installOpts) {
      return wrap(async () => {
        const expect = installOpts && typeof installOpts.expectSha256 === 'string' ? installOpts.expectSha256 : '';
        if (!/^[0-9a-f]{64}$/.test(expect)) throw new InstallError('expect-sha256-required');
        const staged = await stage(source);
        try {
          if (staged.info.sha256 !== expect) throw new InstallError('changed-since-inspect');
          const existed = fs.existsSync(path.join(pluginsRoot, staged.info.id));
          return await commit(staged.tmp, staged.info, existed ? 'update' : 'install');
        } catch (err) {
          rmrf(staged.tmp);
          throw err;
        }
      });
    },
    /** 1 つ前の版に戻す（今の版と入れ替わる）。 */
    restore(id) {
      return wrap(async () => {
        if (typeof id !== 'string' || !EXT_ID_RE.test(id)) throw new InstallError('bad-id');
        const found = backupsOf(id)[0];
        if (!found) throw new InstallError('no-backup');
        await beforeMove(id, fs.existsSync(path.join(pluginsRoot, id)));
        fs.mkdirSync(pluginsRoot, { recursive: true });
        cleanupTemp();
        const tmp = path.join(pluginsRoot, '.tmp-' + random());
        try { fs.renameSync(found.dir, tmp); } catch (_) { throw new InstallError('rename-failed'); }
        try {
          const tree = auditTree(tmp);
          const manifest = checkManifest(tmp, tree.files);
          let sha = '';
          try { sha = JSON.parse(fs.readFileSync(path.join(tmp, INSTALL_FILE), 'utf8')).sha256 || ''; } catch (_) { sha = treeHash(tmp, tree.files.filter((f) => f !== INSTALL_FILE)); }
          const info = summaryOf(manifest, { format: 'backup', sha256: sha, fileCount: tree.files.length, bytes: tree.bytes, sourceName: '' });
          return await commit(tmp, info, 'restore', true);
        } catch (err) {
          // 戻せなかったら、バックアップを元の場所へ
          if (fs.existsSync(tmp)) { try { fs.renameSync(tmp, found.dir); } catch (_) { rmrf(tmp); } }
          throw err;
        }
      });
    },
    /** 消す＝ plugins-backup へ移す（すぐには消さない）。配信中・live のあいだは断る。 */
    remove(id) {
      return wrap(async () => {
        if (typeof id !== 'string' || !EXT_ID_RE.test(id)) throw new InstallError('bad-id');
        const dest = path.join(pluginsRoot, id);
        let info;
        try { info = fs.lstatSync(dest); } catch (_) { throw new InstallError('not-installed'); }
        if (!info.isDirectory()) throw new InstallError('not-installed');
        await beforeMove(id, true);
        const version = currentVersion(dest);
        fs.mkdirSync(backupRoot, { recursive: true });
        backupsOf(id).forEach((b) => rmrf(b.dir));
        const to = path.join(backupRoot, id + '-' + version);
        rmrf(to);
        try { fs.renameSync(dest, to); } catch (_) { throw new InstallError('rename-failed'); }
        await rescan(id);
        audit({ action: 'plugin.remove', id: id, version: version, sha: '' });
        return { ok: true, id: id, version: version };
      });
    },
    /**
     * P5「作る」: ひな形のファイル（相対パス → 文章）から、空いている id の新しい外部プラグインを作る。
     * すでにある id（外部・内蔵・作者用・戻せるバックアップ）は何も書かずに断る。上書きしない。作ったあとも legacy。
     */
    scaffold(id, files) {
      return wrap(async () => {
        const problem = externalIdProblem(id);
        if (problem) throw new InstallError(problem === 'reserved-name' ? 'id-reserved' : 'bad-id');
        if (builtinIds().has(id)) throw new InstallError('id-reserved');
        const rels = files && typeof files === 'object' ? Object.keys(files) : [];
        if (!rels.length || rels.length > 20) throw new InstallError('bad-files');
        rels.forEach((rel) => {
          if (checkRelPath(rel, false) || typeof files[rel] !== 'string' || Buffer.byteLength(files[rel]) > LIMITS.fileBytes) throw new InstallError('bad-files');
        });
        const dest = path.join(pluginsRoot, id);
        let taken = false;
        try { fs.lstatSync(dest); taken = true; } catch (_) { taken = false; }
        if (taken || backupsOf(id).length) throw new InstallError('exists');
        await beforeMove(id, false);
        fs.mkdirSync(pluginsRoot, { recursive: true });
        cleanupTemp();
        const tmp = path.join(pluginsRoot, '.tmp-' + random());
        try {
          rels.forEach((rel) => {
            const file = path.join(tmp, rel);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, files[rel], { encoding: 'utf8', flag: 'wx' });
          });
          fs.renameSync(tmp, dest);
        } catch (_) {
          rmrf(tmp);
          throw new InstallError('rename-failed');
        }
        await rescan(id);
        audit({ action: 'plugin.create', id: id, version: '', sha: '' });
        return { ok: true, id: id, files: rels.slice() };
      });
    },
    /** 入れたもの・戻せるもの（名前と版だけ）。 */
    list() {
      const installed = [];
      try {
        fs.readdirSync(pluginsRoot, { withFileTypes: true }).forEach((e) => {
          if (!e.isDirectory() || e.name.charAt(0) === '.' || !EXT_ID_RE.test(e.name)) return;
          const dir = path.join(pluginsRoot, e.name);
          let sha = '';
          try { sha = String(JSON.parse(fs.readFileSync(path.join(dir, INSTALL_FILE), 'utf8')).sha256 || ''); } catch (_) { sha = ''; }
          installed.push({ id: e.name, version: currentVersion(dir), sha256: sha, backupVersion: (backupsOf(e.name)[0] || {}).version || '' });
        });
      } catch (_) { /* まだ何も入れていない */ }
      return { ok: true, installed: installed };
    }
  };
}

module.exports = { createPluginInstaller, safeText, checkRelPath, LIMITS };
