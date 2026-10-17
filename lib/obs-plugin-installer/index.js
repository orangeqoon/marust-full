'use strict';

/**
 * OBS に丸スト用プラグイン（obs-multi-rtmp の fork）を入れる部品（L5b。決まったこと 14・ADR 0004）。
 * Electron にも marust の核にも頼らない単独の Node モジュール。あとでインストーラ（C 案）もそのまま使う。
 *   - 入れる場所は本家のインストーラと同じ: %ALLUSERSPROFILE%\obs-studio\plugins\obs-multi-rtmp\
 *   - 古い場所（OBS の入っている場所の下 obs-plugins\64bit）にもあるときは知らせるだけ。消さない。
 *   - 普通に写して書けない（EACCES・EPERM）ときだけ、管理者の確認（UAC）を 1 回出して写す。
 *     管理者で動かす処理に渡すのは、同梱の場所と入れる場所のパス 2 つだけ（引数で渡す。文字列をつないでコマンドにしない）。
 * 本物の場所に触るのは既定の動きのときだけ。試験では全部差し替える。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DLL = 'obs-multi-rtmp.dll';
const PROGRAM_FILES_OBS = 'C:\\Program Files\\obs-studio';

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return ''; }
}

/** 同梱の場所の中で写すもの。.pdb と *.before-* は入れない（dll と data\locale\*.ini だけ）。 */
function planFiles(bundleDir, targetDir) {
  const plan = [{ from: path.join(bundleDir, DLL), to: path.join(targetDir, 'bin', '64bit', DLL) }];
  const localeDir = path.join(bundleDir, 'data', 'locale');
  let names = [];
  try { names = fs.readdirSync(localeDir); } catch (_) { names = []; }
  names.filter((n) => /^[A-Za-z0-9_-]+\.ini$/.test(n)).sort().forEach((n) => {
    plan.push({ from: path.join(localeDir, n), to: path.join(targetDir, 'data', 'locale', n) });
  });
  return plan;
}

function copyPlugin(bundleDir, targetDir) {
  planFiles(bundleDir, targetDir).forEach((row) => {
    fs.mkdirSync(path.dirname(row.to), { recursive: true });
    fs.copyFileSync(row.from, row.to);
  });
}

function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') });
      });
    } catch (_) { resolve({ code: 1, stdout: '' }); }
  });
}

function safePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 520 && !/["'`$%\u0000-\u001f]/.test(p) && path.isAbsolute(p);
}

/** 既定の「管理者で写す」。同梱の elevated-copy.ps1 に -Src -Dst だけを渡す。戻り値: { ok } か { ok:false, declined } */
async function defaultElevatedCopy(bundleDir, targetDir) {
  if (!safePath(bundleDir) || !safePath(targetDir)) return { ok: false, declined: false };
  const norm = targetDir.replace(/\//g, '\\').toLowerCase();
  if (!/\\obs-studio\\plugins\\obs-multi-rtmp\\?$/.test(norm)) return { ok: false, declined: false };
  const script = path.join(__dirname, 'elevated-copy.ps1');
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Src', bundleDir, '-Dst', targetDir]);
  if (res.code === 0) return { ok: true };
  return { ok: false, declined: res.code === 2 };
}

async function defaultListProcesses() {
  const res = await run('tasklist.exe', ['/FI', 'IMAGENAME eq obs64.exe', '/NH', '/FO', 'CSV']);
  return res.stdout;
}

async function defaultObsDir() {
  const res = await run('reg.exe', ['query', 'HKLM\\SOFTWARE\\OBS Studio', '/ve']);
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(res.stdout);
  if (m && m[1]) return m[1];
  return PROGRAM_FILES_OBS;
}

function defaultBundleDirs() {
  const list = [];
  // electron-packager の --extra-resource=vendor-obs-plugin は、フォルダ名のまま resources\ の下に入る
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'vendor-obs-plugin'));
  list.push(path.join(__dirname, '..', '..', 'vendor-obs-plugin'));
  list.push(path.join(__dirname, '..', '..', '..', 'obs-multi-rtmp', 'dist'));
  return list;
}

/**
 * opts（試験では全部差し替える）:
 *   allUsersProfile, bundleDirs（探す順の一覧）, getObsDir(): Promise<string>, listProcesses(): Promise<string>,
 *   copy(bundleDir, targetDir)（同期。書けなければ throw）, elevatedCopy(bundleDir, targetDir): Promise<{ok, declined?}>
 */
function createPluginInstaller(opts) {
  const o = opts || {};
  const profile = () => (o.allUsersProfile != null ? o.allUsersProfile : (process.env.ALLUSERSPROFILE || 'C:\\ProgramData'));
  const target = () => path.join(profile(), 'obs-studio', 'plugins', 'obs-multi-rtmp');
  const listProcesses = o.listProcesses || defaultListProcesses;
  const getObsDir = o.getObsDir || defaultObsDir;
  const copy = o.copy || copyPlugin;
  const elevatedCopy = o.elevatedCopy || defaultElevatedCopy;
  let busy = false;

  function findBundle() {
    const dirs = Array.isArray(o.bundleDirs) ? o.bundleDirs : defaultBundleDirs();
    for (let i = 0; i < dirs.length; i += 1) {
      try { if (fs.statSync(path.join(dirs[i], DLL)).isFile()) return dirs[i]; } catch (_) { /* 次へ */ }
    }
    return '';
  }

  // 古い場所: OBS の入っている場所（レジストリ → 無ければ Program Files）の下。試験で getObsDir を差し替えたときは、その場所だけ見る。
  async function legacyPath() {
    let dir = '';
    try { dir = await getObsDir(); } catch (_) { dir = ''; }
    const candidates = o.getObsDir ? [dir] : [dir, PROGRAM_FILES_OBS];
    for (let i = 0; i < candidates.length; i += 1) {
      if (!candidates[i]) continue;
      const file = path.join(candidates[i], 'obs-plugins', '64bit', DLL);
      if (fs.existsSync(file)) return file;
    }
    return '';
  }

  async function obsRunning() {
    try { return /obs64\.exe/i.test(String(await listProcesses())); } catch (_) { return false; }
  }

  function stateOf(bundleDir) {
    const placed = path.join(target(), 'bin', '64bit', DLL);
    if (!fs.existsSync(placed)) return 'missing';
    return bundleDir && sha256(placed) === sha256(path.join(bundleDir, DLL)) ? 'same' : 'different';
  }

  async function info() {
    const bundleDir = findBundle();
    const legacy = await legacyPath();
    return {
      ok: true,
      bundled: bundleDir !== '',
      target: target(),
      state: stateOf(bundleDir),
      legacyCopy: legacy !== '',
      legacyPath: legacy,
      obsRunning: await obsRunning()
    };
  }

  async function install(params) {
    if (busy) return { ok: false, error: 'busy' };
    busy = true;
    try {
      const overwrite = !!(params && params.overwrite === true);
      const bundleDir = findBundle();
      if (!bundleDir) return { ok: false, error: 'no-bundle' };
      if (await obsRunning()) return { ok: false, error: 'obs-running' };
      if (stateOf(bundleDir) === 'different' && !overwrite) return { ok: false, error: 'needs-overwrite' };
      const dest = target();
      try {
        copy(bundleDir, dest);
      } catch (err) {
        if (!err || (err.code !== 'EACCES' && err.code !== 'EPERM')) return { ok: false, error: 'copy-failed' };
        let done;
        try { done = await elevatedCopy(bundleDir, dest); } catch (_) { done = { ok: false }; }
        if (!done || done.ok !== true) return { ok: false, error: done && done.declined ? 'elevation-declined' : 'copy-failed' };
      }
      if (stateOf(bundleDir) !== 'same') return { ok: false, error: 'verify-failed' };
      return { ok: true, state: 'same' };
    } finally {
      busy = false;
    }
  }

  return { info, install, target };
}

module.exports = { createPluginInstaller, planFiles, copyPlugin, sha256 };
