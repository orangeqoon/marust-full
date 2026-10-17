#!/usr/bin/env node
'use strict';

/**
 * 内蔵プラグインを 1 つずつ zip にする（v3 §5.1「本体だけ」の配り物と一緒に出す。V5）。
 *   node cli/pack-plugins.js [<出力フォルダ>]        既定は dist-plugins/（git の管理外）
 *   node cli/pack-plugins.js --set <フォルダ>        セットの置き場を作る（plugins/ をそのまま写す。配る版の build が exe の横に置く）
 * - 対象: plugins/<id>/ と plugins/sites/<site>/（作者専用 plugins-author/ は入れない）。
 * - 出力: <id>-<version>.zip（zip の直下に manifest.json）と plugins-index.json（id・版・段階・SHA-256・本体の部品への依存）。
 * - zip の作りは入れる側（host/layer1/plugin-install.js）の規則に合わせる: 名前は "/" 区切りの相対・リンクなし・隠しファイルなし。
 * - 注意: 内蔵プラグインは本体の host/・lib/ を相対パスで require するものがある（plugins-index.json の appRequires）。
 *   外から入れる道（plugin-install）は内蔵の権限を渡さないので、この zip は「あとで入れる道ができたとき」の材料（Q-2026-10-10-v5-distribution.md）。
 * 秘密・状態（state/）は読まない。plugins/ の中のファイルだけ。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const APP_ROOT = path.join(__dirname, '..');
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // plugin-install.js の LIMITS と同じ

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data(Buffer) }] → zip の Buffer（deflate・UTF-8 名・時刻は固定で、同じ中身なら同じ zip になる） */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([centralBuf, end]));
}

/** フォルダの中のファイル（相対パス・"/" 区切り・名前順）。リンク・隠しファイルは入れない（入れる側が断る）。 */
function listFiles(dir) {
  const out = [];
  (function walk(rel) {
    const names = fs.readdirSync(path.join(dir, rel)).sort();
    for (const n of names) {
      if (n.charAt(0) === '.') continue;
      if (!rel && n === 'test') continue; // プラグイン自身の試験（plugins/<id>/test/）は配らない（計画 X・P4）
      const relPath = rel ? rel + '/' + n : n;
      const st = fs.lstatSync(path.join(dir, relPath));
      if (st.isSymbolicLink()) throw new Error('symlink-not-allowed ' + relPath);
      if (st.isDirectory()) walk(relPath);
      else if (st.isFile()) out.push(relPath);
    }
  })('');
  return out;
}

/** プラグインのフォルダの外（本体の host/・lib/ など）を相対 require しているファイルと先。 */
function appRequires(dir, files) {
  const found = new Set();
  for (const rel of files) {
    if (!/\.js$/.test(rel)) continue;
    const depth = rel.split('/').length - 1;
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    const re = /require\(\s*['"](\.\.[^'"]*)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const ups = (m[1].match(/\.\.\//g) || []).length;
      if (ups > depth) found.add(m[1].replace(/^(\.\.\/)+/, '').replace(/\.js$/, ''));
    }
  }
  return Array.from(found).sort();
}

function packOne(srcDir, kind) {
  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
  const files = listFiles(srcDir);
  if (files.length > MAX_FILES) throw new Error('too-many-files ' + manifest.id);
  let total = 0;
  const entries = files.map((rel) => {
    const data = fs.readFileSync(path.join(srcDir, rel));
    if (data.length > MAX_FILE_BYTES) throw new Error('file-too-big ' + manifest.id + ' ' + rel);
    total += data.length;
    return { name: rel, data };
  });
  if (total > MAX_TOTAL_BYTES) throw new Error('too-big ' + manifest.id);
  const zip = buildZip(entries);
  return { manifest, kind, files, zip, appRequires: appRequires(srcDir, files) };
}

function packAll(outDir, appRoot) {
  const root = appRoot || APP_ROOT;
  const pluginsDir = path.join(root, 'plugins');
  const jobs = [];
  for (const n of fs.readdirSync(pluginsDir).sort()) {
    if (n === 'sites' || n.charAt(0) === '.') continue;
    const dir = path.join(pluginsDir, n);
    if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'manifest.json'))) jobs.push({ dir, kind: 'plugin', rel: 'plugins/' + n });
  }
  const sitesDir = path.join(pluginsDir, 'sites');
  if (fs.existsSync(sitesDir)) {
    for (const n of fs.readdirSync(sitesDir).sort()) {
      const dir = path.join(sitesDir, n);
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'manifest.json'))) jobs.push({ dir, kind: 'site', rel: 'plugins/sites/' + n });
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const index = [];
  for (const job of jobs) {
    const r = packOne(job.dir, job.kind);
    const id = r.manifest.id;
    const version = String(r.manifest.version || '0');
    const file = (job.kind === 'site' ? 'site-' : '') + id + '-' + version + '.zip';
    fs.writeFileSync(path.join(outDir, file), r.zip);
    index.push({
      id,
      kind: job.kind,
      installPath: job.rel,
      version,
      tier: typeof r.manifest.tier === 'string' ? r.manifest.tier : '',
      file,
      bytes: r.zip.length,
      sha256: crypto.createHash('sha256').update(r.zip).digest('hex'),
      appRequires: r.appRequires
    });
  }
  fs.writeFileSync(path.join(outDir, 'plugins-index.json'), JSON.stringify({ version: 1, plugins: index }, null, 2) + '\n');
  return index;
}

const PACK_ORDER = Object.freeze(['basic', 'standard', 'advanced']);

/** 束（K5）: 段階ごとの id の一覧。上の段階は下の段階を含む（段階は積み上げ。v3 §5）。plugins-index.json の tier から作る。 */
function packLists(index) {
  const out = {};
  PACK_ORDER.forEach((name, i) => {
    const ids = index.filter((r) => PACK_ORDER.indexOf(r.tier) !== -1 && PACK_ORDER.indexOf(r.tier) <= i).map((r) => r.id).sort();
    out[name] = { pack: name, version: 1, plugins: ids };
  });
  return out;
}

/** packs/<段階>.json（リポジトリに置く正本。試験が plugins/ の manifest と食い違わないか見張る）と、束の zip（dist-plugins/packs/）を作る。 */
function writePacks(index, outDir, packsDir, appRoot) {
  const root = appRoot || APP_ROOT;
  const lists = packLists(index);
  fs.mkdirSync(packsDir, { recursive: true });
  const bundles = [];
  for (const name of PACK_ORDER) {
    fs.writeFileSync(path.join(packsDir, name + '.json'), JSON.stringify(lists[name], null, 2) + '\n');
    const members = lists[name].plugins.map((id) => index.find((r) => r.id === id));
    // 束の zip は exe の resources/app/ にそのまま展開する木（plugins/<id>/…・plugins/sites/<id>/…）。pack.json は読むだけの目録
    const entries = [];
    for (const r of members) {
      const srcDir = path.join(root, r.installPath);
      for (const rel of listFiles(srcDir)) entries.push({ name: r.installPath + '/' + rel, data: fs.readFileSync(path.join(srcDir, rel)) });
    }
    entries.unshift({ name: 'pack.json', data: Buffer.from(JSON.stringify({ pack: name, version: 1, plugins: members.map((r) => ({ id: r.id, version: r.version, installPath: r.installPath, sha256: r.sha256 })) }, null, 2) + '\n') });
    const zip = buildZip(entries);
    const bundleDir = path.join(outDir, 'packs');
    fs.mkdirSync(bundleDir, { recursive: true });
    const file = 'pack-' + name + '.zip';
    fs.writeFileSync(path.join(bundleDir, file), zip);
    bundles.push({ pack: name, file: 'packs/' + file, plugins: members.length, bytes: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex') });
  }
  fs.writeFileSync(path.join(outDir, 'packs', 'packs-index.json'), JSON.stringify({ version: 1, packs: bundles }, null, 2) + '\n');
  return bundles;
}

/**
 * セットの置き場を作る（計画 C・D6③）。plugins/（試験の test/・node_modules・隠しファイルは除く）を <outDir> にそのまま写す。
 * 配る版の build が exe の横（<exe のフォルダ>/plugins）に置く。差し替え（更新）のときも、これで作った中身を同じ場所に入れ替える。
 * 作者専用 plugins-author・みんなのプラグインは入れない。写した個数（プラグインのフォルダの数。sites/ の中の 1 つずつは別に数える）を返す。
 */
/** セットの .js が require する npm の部品（Node 組み込みと相対パスを除く）の名前。 */
function bareRequires(setDir) {
  const names = new Set();
  const builtin = new Set(require('module').builtinModules);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); return; }
    if (!/\.(js|cjs|mjs)$/.test(e.name)) return;
    const text = fs.readFileSync(full, 'utf8');
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (spec.charAt(0) === '.' || spec.charAt(0) === '/' || spec.indexOf('node:') === 0) continue;
      const name = spec.charAt(0) === '@' ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!builtin.has(name)) names.add(name);
    }
  });
  walk(setDir);
  return Array.from(names).sort();
}

/**
 * exe の横のセットからは resources/app/node_modules が見えない（Node は上のフォルダの node_modules しか探さない）ので、
 * セットが使う npm の部品（と、その dependencies）を <セット>/node_modules に写す（計画 C・C2 評価 Must 2。今は ws だけ）。
 */
function copyNpmParts(setDir, appRoot) {
  const want = bareRequires(setDir);
  const done = new Set();
  const copy = (name) => {
    if (done.has(name)) return;
    done.add(name);
    const from = path.join(appRoot, 'node_modules', name);
    if (!fs.existsSync(path.join(from, 'package.json'))) throw new Error('セットが使う npm の部品が node_modules に無い: ' + name);
    fs.cpSync(from, path.join(setDir, 'node_modules', name), { recursive: true });
    const deps = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')).dependencies || {};
    Object.keys(deps).forEach(copy);
  };
  want.forEach(copy);
  return Array.from(done).sort();
}

function writeSetDir(outDir, appRoot) {
  const root = appRoot || APP_ROOT;
  const src = path.join(root, 'plugins');
  const dest = path.resolve(outDir);
  if (!fs.existsSync(src)) throw new Error('plugins/ が無い: ' + src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const name = path.basename(from);
      return name !== 'test' && name !== 'node_modules' && name.charAt(0) !== '.';
    }
  });
  copyNpmParts(dest, root);
  let count = 0;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (!e.isDirectory()) return;
    if (fs.existsSync(path.join(dir, e.name, 'manifest.json'))) count += 1;
    else if (dir === dest && e.name === 'sites') walk(path.join(dir, e.name));
  });
  walk(dest);
  return count;
}

if (require.main === module) {
  const setAt = process.argv.indexOf('--set');
  if (setAt !== -1) {
    const target = process.argv[setAt + 1];
    if (!target) { console.error('使い方: node cli/pack-plugins.js --set <出力フォルダ>'); process.exit(1); }
    console.log('[pack-plugins] セット ' + writeSetDir(target) + ' 個 -> ' + path.relative(process.cwd(), path.resolve(target)));
    process.exit(0);
  }
  const out = path.resolve(process.argv[2] || path.join(APP_ROOT, 'dist-plugins'));
  const index = packAll(out);
  const bundles = writePacks(index, out, path.join(APP_ROOT, 'packs'));
  console.log('[pack-plugins] 束 ' + bundles.map((b) => b.pack + '(' + b.plugins + ')').join(' / '));
  console.log('[pack-plugins] ' + index.length + ' zip -> ' + path.relative(process.cwd(), out));
  const needApp = index.filter((r) => r.appRequires.length);
  if (needApp.length) console.log('[pack-plugins] 本体の部品を相対 require している: ' + needApp.map((r) => r.id).join(', '));
}

module.exports = { buildZip, listFiles, appRequires, packAll, packLists, writePacks, writeSetDir, bareRequires, copyNpmParts, PACK_ORDER };
