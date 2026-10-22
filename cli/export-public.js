#!/usr/bin/env node
'use strict';

/**
 * 公開用の書き出し（PLAN-v2-roadmap §4.1・N4）。
 *   node cli/export-public.js <出力フォルダ>        書き出して、秘密・作者のパスの検査をかける
 *   node cli/export-public.js --scan <フォルダ>     フォルダの検査だけ
 * - 書き出すのは git が追跡しているファイルだけ（未追跡の秘密・作業中のファイルは入らない）。履歴は持ち出さない。
 * - 入れないもの: plugins-author/・docs/history/・docs/reviews/・開発の引き継ぎ・計画の文書・AGENTS.md・dev-state/ など。
 * - README.md・README.en.md・LICENSE・.gitignore・AI-GUIDE.md は docs/public/ のものを置く（CORE.md は docs/CORE.md へ）。コミットしていない変更があれば断る（作業ツリーをコピーするため）。package.json は公開用に直す（作者の PC 用の検査の入口を外す）。
 * - 出力フォルダは空か存在しないこと。git のリポジトリの中には書かない。公開（push）は、これでは行わない。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');

// 公開しない（先頭が一致）。docs は許可リスト方式（下）。
const DENY_PREFIX = [
  'plugins-author/', 'dev-state/', 'dist/', 'dist-author/', 'node_modules/', '.claude/', '.agents/',
  'docs/history/', 'docs/reviews/', 'docs/claude-project/', 'docs/design/', 'docs/research/', 'docs/integration-notes/', 'docs/devlog/', 'docs/tasks/'
];
const DENY_FILE = ['README.md', 'README.en.md', 'marust.zip']; // README は docs/public/ のものに差し替える
const DENY_BASENAME = ['AGENTS.md', 'CLAUDE.md']; // どの階層でも出さない
const DOCS_ALLOW = ['docs/GUIDE.md', 'docs/ARCHITECTURE.md', 'docs/PLUGIN-API.md', 'docs/RELEASE.md'];
const DENY_NAME_RE = /(^|\/)(\.env[^/]*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.bak|.*\.db|.*\.sqlite3?|.*cookies?[^/]*\.(json|txt)|.*_captured\.json|marust-modes\.json|state\.json|vault[^/]*\.(json|dat|bin|enc)|token[s]?[^/]*\.json|credentials?[^/]*\.json|client[_-]?secret[^/]*\.json)$/i;

// 公開リポジトリだけでは動かない試験（作者の PC・plugins-author・内部の文書・git を前提にするもの）。
// 書き出したフォルダで `npm test` を流して落ちたものを、名前で列挙している（文字列の一致では決めない。守りの試験を巻き込まないため）。
const EXPORT_SKIP_TESTS = Object.freeze([
  'm4b-feedback', 'n4-export-public', 'p1-skeleton', 'r10-local-core', 'r18-author-split', 'w-integrate-wave5', 'w0-plugin-api',
  'w13-daemon-connectors', 'w21-packaging', 'w23-site-cookie-a', 'w25-import-dedupe', 'w37-a11y',
  // 計画 L（L2a）: 作者用のモード（plugins-author/author-modes）で試す試験
  'modes', 'p4a-external-restrictions', 'v2-peers', 'v3-summary', 'w-integrate-wave3', 'w20-modes-ui',
  // 計画 X（S10・S11）以降: 横の marust-plugins・plugins-author・docs の計画書を読む試験
  'favorites', 'k3-plugins', 'k6-vault-store', 'overlay-guide', 'p1-features', 'p2-feature-plugins', 'plugin-host-panel', 'r16-sites',
  'v0-core-boundary', 'v3-timer-link', 'v4-gcal-login', 'v6-boot', 'v6-legacy-import', 'v7-panels', 'v8-data-plugins', 'w67-ui-simplify',
  'x0-core-numbers', 'x1-pitch', 'x5-unit-folders',
  // 作者用 chat-*・除外済みの modes 試験・作者用を含む役割数を前提にする
  'r8-home', 'w-integrate-wave7', 'w18-chat', 'x5-contracts'
].map((n) => 'test/' + n + '.test.js'));
const EXPORT_SKIP_PLUGIN_TESTS = Object.freeze([
  'plugins/bulk-title/test/v2-bulk-title.test.js',
  'plugins/comment-send/test/w26-chat-send.test.js'
]);
function authorOnlyTest(srcRoot, rel) {
  void srcRoot;
  return EXPORT_SKIP_TESTS.indexOf(rel) !== -1 ||
         EXPORT_SKIP_PLUGIN_TESTS.indexOf(rel) !== -1 ||
         rel === 'test/helpers/author-modes.js';
}

function listTracked(root) {
  const res = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '.'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error('git ls-files failed');
  const prefix = spawnSync('git', ['-C', root, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).stdout.trim();
  return res.stdout.split('\0').filter(Boolean).map((f) => (prefix && f.indexOf(prefix) === 0 ? f.slice(prefix.length) : f));
}

/** 追跡中のファイルに、まだコミットしていない変更があるか（書き出しは作業ツリーのファイルをコピーするため、あれば断る）。 */
function dirtyTracked(root) {
  const res = spawnSync('git', ['-C', root, 'status', '--porcelain', '-uno', '--', '.'], { encoding: 'utf8' });
  return res.status !== 0 || res.stdout.trim() !== '';
}

function allowed(rel) {
  if (DENY_FILE.indexOf(rel) !== -1) return false;
  if (DENY_BASENAME.indexOf(rel.split('/').pop()) !== -1) return false;
  if (DENY_PREFIX.some((p) => rel.indexOf(p) === 0)) return false;
  if (DENY_NAME_RE.test(rel)) return false;
  if (rel.indexOf('docs/') === 0) return DOCS_ALLOW.indexOf(rel) !== -1 || rel.indexOf('docs/images/') === 0;
  return true;
}

function publicPackageJson(text) {
  const pkg = JSON.parse(text);
  delete pkg.scripts['test:ext'];
  delete pkg.scripts['test:onecomme'];
  pkg.license = 'MIT';
  pkg.private = false;
  pkg.description = 'marust (丸スト): OBS から複数の配信サイトへ同時に配信するときの操作をまとめる Windows のアプリ';
  // 配る exe に入れないもの（公開リポジトリには無いが、念のため）
  return JSON.stringify(pkg, null, 2) + '\n';
}

// ---- 検査 ----
const SCAN_SKIP_DIR = new Set(['node_modules', '.git']);
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const PATTERNS = [
  ['作者の PC の絶対パス（scripts フォルダ）',/[a-z]:[\\/]+scripts[\\/]/i],
  ['利用者フォルダの絶対パス', /[a-z]:[\\/]+users[\\/]+[a-z0-9 _.-]+/i],
  ['Google API キー', /AIza[0-9A-Za-z_-]{35}/],
  ['Google OAuth シークレット', /GOCSPX-[0-9A-Za-z_-]{20,}/],
  ['GitHub トークン', /\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}\b|github_pat_[0-9A-Za-z_]{40,}/],
  ['Slack トークン', /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ['秘密鍵', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Discord webhook', /discord(app)?\.com\/api\/webhooks\/\d{5,}\/[0-9A-Za-z_-]{20,}/],
  ['sk- 形式の鍵', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['メールアドレス（作者）', new RegExp(['orange', 'qoon@'].join(''), 'i')]
];

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.isDirectory()) { if (!SCAN_SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), out); } else out.push(path.join(dir, e.name));
  });
  return out;
}

/** フォルダの中を検査する。戻り: [{ file, rule, line }]（値そのものは返さない） */
function scanDir(dir) {
  const found = [];
  walk(dir, []).forEach((file) => {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    if (DENY_NAME_RE.test(rel)) { found.push({ file: rel, rule: '秘密になりうるファイル名', line: 0 }); return; }
    let buf;
    try { if (fs.statSync(file).size > MAX_SCAN_BYTES) { found.push({ file: rel, rule: '大きすぎて検査できない', line: 0 }); return; } buf = fs.readFileSync(file); } catch (_) { return; }
    if (buf.indexOf(0) !== -1) return; // バイナリ（画像など）は文字として見ない
    const text = buf.toString('utf8');
    text.split('\n').forEach((line, i) => {
      PATTERNS.forEach(([rule, re]) => { if (re.test(line)) found.push({ file: rel, rule: rule, line: i + 1 }); });
    });
  });
  return found;
}

function insideGit(dir) {
  const res = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() === 'true';
}

function exportPublic(options) {
  const o = options || {};
  const srcRoot = o.srcRoot || APP_ROOT;
  const outDir = path.resolve(String(o.outDir || ''));
  if (!o.outDir) throw new Error('out-dir-required');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error('out-dir-not-empty');
  fs.mkdirSync(outDir, { recursive: true });
  if (insideGit(outDir)) throw new Error('out-dir-inside-git');
  if (!o.files && !o.allowDirty && dirtyTracked(srcRoot)) throw new Error('working-tree-dirty');
  const files = (o.files || listTracked(srcRoot)).filter((rel) => allowed(rel) && (o.keepAllTests || !authorOnlyTest(srcRoot, rel)));
  const wrote = [];
  files.forEach((rel) => {
    const from = path.join(srcRoot, rel);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return;
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (rel === 'package.json') fs.writeFileSync(to, publicPackageJson(fs.readFileSync(from, 'utf8')));
    else fs.copyFileSync(from, to);
    wrote.push(rel);
  });
  // docs/public/ の中身を公開リポジトリの決まった場所へ置く（AI-GUIDE.md は入口の隣・CORE.md は docs/）
  [['README.md', 'README.md'], ['README.en.md', 'README.en.md'], ['LICENSE', 'LICENSE'], ['.gitignore', '.gitignore'], ['AI-GUIDE.md', 'AI-GUIDE.md'], ['CORE.md', 'docs/CORE.md']].forEach((pair) => {
    const from = path.join(srcRoot, 'docs', 'public', pair[0]);
    if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(path.join(outDir, pair[1])), { recursive: true }); fs.copyFileSync(from, path.join(outDir, pair[1])); wrote.push(pair[1]); }
  });
  // docs/images/ の図解画像を公開リポジトリへコピーする
  const imagesDir = path.join(srcRoot, 'docs', 'images');
  if (fs.existsSync(imagesDir)) {
    fs.readdirSync(imagesDir).forEach((file) => {
      const from = path.join(imagesDir, file);
      if (fs.statSync(from).isFile()) {
        const to = path.join(outDir, 'docs', 'images', file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        if (wrote.indexOf('docs/images/' + file) === -1) wrote.push('docs/images/' + file);
      }
    });
  }
  return { outDir: outDir, files: wrote, findings: scanDir(outDir) };
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--scan') {
    if (!args[1]) { console.error('使い方: node cli/export-public.js --scan <フォルダ>'); return 2; }
    const findings = scanDir(path.resolve(args[1]));
    findings.forEach((f) => console.log(f.file + (f.line ? ':' + f.line : '') + '  ' + f.rule));
    console.log(findings.length ? '検査: ' + findings.length + ' 件' : '検査: 合格（0 件）');
    return findings.length ? 1 : 0;
  }
  if (!args[0]) { console.error('使い方: node cli/export-public.js <出力フォルダ>（空か存在しないフォルダ。git の中は不可）'); return 2; }
  let res;
  try { res = exportPublic({ outDir: args[0] }); } catch (err) { console.error('書き出せません: ' + err.message); return 1; }
  console.log('書き出したファイル: ' + res.files.length + ' 個');
  res.findings.forEach((f) => console.log('  要確認 ' + f.file + (f.line ? ':' + f.line : '') + '  ' + f.rule));
  console.log(res.findings.length ? '検査: ' + res.findings.length + ' 件。公開の前に直してください' : '検査: 合格（0 件）');
  return res.findings.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { EXPORT_SKIP_TESTS, exportPublic, scanDir, allowed, publicPackageJson, authorOnlyTest, listTracked, PATTERNS };
