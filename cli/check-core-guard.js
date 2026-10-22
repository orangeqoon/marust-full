#!/usr/bin/env node
'use strict';

/**
 * コア門番チェッカー (Core Guard Checker)
 *
 * 【目的】
 * 丸ストの核（host/core/）をなるべく作り直さず、高い信頼性と不変性を守るための門番ツール。
 * 1. コア純粋性検査: サイト依存なし、UIコードなし、上位層requireなし、絶対パスなし（0件必須）
 * 2. 上限ロック（Ceiling Ratchet）: 28ファイル以下、総行数5,650行以下
 * 3. Git変更検知: host/core/ に変更がある場合、docs/CORE-CHANGELOG.md への記録を必須とする
 *
 * 使用法:
 *   node cli/check-core-guard.js
 *   node cli/check-core-guard.js --verbose
 *   node cli/check-core-guard.js --json
 *   node cli/check-core-guard.js --dump-ledger
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(APP_ROOT, 'host', 'core');
const CHANGELOG_PATH = path.join(APP_ROOT, 'docs', 'CORE-CHANGELOG.md');

// 厳格なコア上限ロック (Ceiling Ratchet / 不変ガード)
const MAX_CORE_FILES = 28;
const MAX_CORE_LINES = 5650;
const BASELINE_FILE_COUNT = 28;

// 禁止パターン定義
const SITE_NAMES = [
  'youtube', 'niconico', 'twitch', 'twitcasting',
  'kick', 'fc2', 'kukulu', 'picarto', 'rumble', 'soop'
];
// 文字列リテラルとしてのサイト名禁止（例: 'youtube', "twitch"）
const SITE_LITERAL_REGEX = new RegExp(`['"](?:${SITE_NAMES.join('|')})['"]`, 'i');

// UI / DOM 依存コードの禁止
const UI_REGEX = /\b(?:document\.|window\.|dockview|BrowserWindow|localStorage)\b/;

// 上位層・外側モジュールの require 禁止
const LAYER_VIOLATION_REGEX = /require\s*\(\s*['"][^'"]*(?:layer1|plugins|ui)[^'"]*['"]\s*\)/;

// ハードコード絶対パスの検出（Windows ドライブ文字または /Users/ 等。URL スキーム :// は除外）
const ABS_PATH_REGEX = /(?<!https?:|wss?:|file:)(?:^|[^a-zA-Z0-9_])(?:[A-Za-z]:[/\\]|\/(?:Users|home)\/)/;

/**
 * ファイル一覧を再帰的に取得
 */
function walkFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, fileList);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * 静的コードスキャン（純粋性検査）
 */
function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const violations = [];

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmed = line.trim();

    // コメント行・免除行の除外
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (line.includes('// allow-hardcode') || line.includes('/* allow-hardcode */')) return;

    // 1. サイト名リテラルの混入
    if (SITE_LITERAL_REGEX.test(line)) {
      violations.push({
        line: lineNum,
        type: 'SITE_DEPENDENCY',
        detail: `特定サイト名のリテラルが検出されました: "${trimmed}"`
      });
    }

    // 2. UI / DOM コードの混入
    if (UI_REGEX.test(line)) {
      violations.push({
        line: lineNum,
        type: 'UI_DEPENDENCY',
        detail: `UI/DOM依存コードが検出されました: "${trimmed}"`
      });
    }

    // 3. 上位層の require
    if (LAYER_VIOLATION_REGEX.test(line)) {
      violations.push({
        line: lineNum,
        type: 'LAYER_VIOLATION',
        detail: `上位層 (layer1/plugins/ui) への依存 require が検出されました: "${trimmed}"`
      });
    }

    // 4. ハードコード絶対パス
    if (ABS_PATH_REGEX.test(line)) {
      violations.push({
        line: lineNum,
        type: 'HARDCODED_PATH',
        detail: `絶対パスが検出されました: "${trimmed}"`
      });
    }
  });

  return {
    filePath,
    relPath: path.relative(APP_ROOT, filePath).replace(/\\/g, '/'),
    linesCount: lines.length,
    violations
  };
}

/**
 * docs/CORE-CHANGELOG.md のベースライン台帳テーブルをパース
 */
function parseChangelogLedger(changelogPath) {
  if (!fs.existsSync(changelogPath)) {
    return { error: `台帳ファイルが見つかりません: ${changelogPath}`, ledger: new Map() };
  }

  const content = fs.readFileSync(changelogPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const ledger = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    if (trimmed.includes('---')) continue;
    if (trimmed.includes('ディレクトリ / ファイル') || trimmed.includes('役割と責務')) continue;

    const rawCells = trimmed.split('|');
    const cells = rawCells.slice(1, rawCells.length - 1).map((c) => c.trim());
    if (cells.length < 2) continue;

    const pathMatch = cells[0].match(/host\/core\/[a-zA-Z0-9_\-\./]+\.js/);
    if (!pathMatch) continue;
    const relPath = pathMatch[0];

    let expectedLines = null;
    let role = '';

    for (let i = 1; i < cells.length; i++) {
      const cellClean = cells[i].replace(/[`*]/g, '').trim();
      if (!expectedLines && /^\d+$/.test(cellClean)) {
        expectedLines = parseInt(cellClean, 10);
      } else if (cellClean.length > 0 && isNaN(cellClean) && !role) {
        role = cellClean;
      }
    }

    if (relPath) {
      ledger.set(relPath, {
        relPath,
        expectedLines,
        role
      });
    }
  }

  return { error: null, ledger };
}

/**
 * Git 状態チェック（フェイルセーフ対応）
 */
function checkGitStatus() {
  try {
    const coreStatus = execSync('git status --porcelain host/core', {
      cwd: APP_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    const changelogStatus = execSync('git status --porcelain docs/CORE-CHANGELOG.md', {
      cwd: APP_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    return {
      hasGit: true,
      coreChanged: coreStatus.length > 0,
      coreChanges: coreStatus ? coreStatus.split('\n').map((l) => l.trim()) : [],
      changelogChanged: changelogStatus.length > 0,
      error: null
    };
  } catch (err) {
    return {
      hasGit: false,
      coreChanged: false,
      coreChanges: [],
      changelogChanged: false,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const jsonMode = args.includes('--json');
  const dumpLedger = args.includes('--dump-ledger');

  const files = walkFiles(CORE_DIR).sort();
  const results = files.map(scanFile);

  const totalLines = results.reduce((acc, r) => acc + r.linesCount, 0);
  const allViolations = results.flatMap((r) => r.violations.map((v) => ({ file: r.relPath, ...v })));
  const git = checkGitStatus();

  // 台帳パース
  const { error: ledgerError, ledger } = parseChangelogLedger(CHANGELOG_PATH);

  // --dump-ledger: 現在のファイル構成を台帳 Markdown テーブルとして出力
  if (dumpLedger) {
    console.log('| ディレクトリ / ファイル | 行数 | 役割と責務 |');
    console.log('| :--- | :---: | :--- |');
    results.forEach((r) => {
      const existing = ledger.get(r.relPath);
      const role = existing ? existing.role : 'コア中枢モジュール';
      console.log(`| **\`${r.relPath}\`** | ${r.linesCount} | ${role} |`);
    });
    process.exit(0);
  }

  // 合否判定フラグ
  const purityOk = allViolations.length === 0;
  const ceilingFilesOk = results.length <= MAX_CORE_FILES;
  const ceilingLinesOk = totalLines <= MAX_CORE_LINES;
  const countMatchesBaseline = results.length === BASELINE_FILE_COUNT;
  const structureOk = ceilingFilesOk && ceilingLinesOk && countMatchesBaseline;

  // コア変更判定（Git による検知）
  const isCoreModified = git.hasGit && git.coreChanged;
  let changeTriageOk = true;
  if (isCoreModified) {
    changeTriageOk = git.changelogChanged;
  }

  // 総合判定
  const isPassed = purityOk && structureOk && changeTriageOk;

  // --json モード
  if (jsonMode) {
    console.log(JSON.stringify({
      ok: isPassed,
      timestamp: new Date().toISOString(),
      summary: {
        fileCount: results.length,
        baselineFileCount: BASELINE_FILE_COUNT,
        maxFiles: MAX_CORE_FILES,
        totalLines,
        maxLines: MAX_CORE_LINES,
        purityOk,
        structureOk,
        isCoreModified,
        changeTriageOk,
        violationsCount: allViolations.length
      },
      violations: allViolations,
      git,
      files: results.map((r) => ({
        path: r.relPath,
        lines: r.linesCount
      }))
    }, null, 2));
    process.exit(isPassed ? 0 : 1);
  }

  // 通常コンソール出力
  console.log('='.repeat(70));
  console.log('🛡️  丸スト コア門番チェッカー (Core Guard Checker)');
  console.log('='.repeat(70));
  console.log(`- コア対象: host/core/ (${results.length} files / ${totalLines} lines)`);
  console.log(`- 基準ファイル数: ${BASELINE_FILE_COUNT} files (上限: ${MAX_CORE_FILES})`);
  console.log(`- 基準総行数上限: ${MAX_CORE_LINES} lines`);

  if (!git.hasGit) {
    console.warn(`  ⚠️ Git 情報が取得できませんでした (${git.error || 'unknown'})。`);
  }

  if (verbose) {
    console.log('\n[実ファイル構成一覧]');
    results.forEach((r) => {
      console.log(`  ✅ ${String(r.linesCount).padStart(5, ' ')} lines | ${r.relPath}`);
    });
  }

  // 1. 静的純粋性検査
  console.log('\n[1/3] コア純粋性検査 (禁止コードスキャン)...');
  if (purityOk) {
    console.log('  ✅ 禁止コード混入 0件 (サイト依存なし・UI依存なし・上位層requireなし・絶対パスなし)');
  } else {
    console.error(`  ❌ 違反が ${allViolations.length} 件検出されました:`);
    allViolations.forEach((v) => {
      console.error(`    - [${v.type}] ${v.file}:${v.line} -> ${v.detail}`);
    });
  }

  // 2. ファイル数・総行数上限ロック検査 (Ceiling Ratchet)
  console.log('\n[2/3] コアファイル数・総行数上限ロック検査 (Ceiling Ratchet)...');
  if (results.length > MAX_CORE_FILES) {
    console.error(`  ❌ コアファイル数が上限を超過しています: 現在 ${results.length} (上限 ${MAX_CORE_FILES})`);
  } else if (results.length !== BASELINE_FILE_COUNT) {
    console.warn(`  ⚠️ ファイル数がベースラインと異なります: 現在 ${results.length} (基準 ${BASELINE_FILE_COUNT})`);
  } else {
    console.log(`  ✅ コアファイル数上限ロック合格 (${results.length} / 上限 ${MAX_CORE_FILES} files)`);
  }

  if (totalLines > MAX_CORE_LINES) {
    console.error(`  ❌ コア総行数が上限を超過しています: 現在 ${totalLines} 行 (上限 ${MAX_CORE_LINES} 行)`);
  } else {
    console.log(`  ✅ コア総行数上限ロック合格 (${totalLines} / 上限 ${MAX_CORE_LINES} lines)`);
  }

  // 3. Git変更検知 & CORE-CHANGELOG.md 記録検査
  console.log('\n[3/3] コア変更検知 & 根本解決Triage記録検査...');
  if (isCoreModified) {
    console.log('  ⚠️  【核（host/core/）の変更を検知】根本解決の審査を開始します');
    if (git.hasGit && git.coreChanged) {
      console.log('  Git変更ファイル:');
      git.coreChanges.forEach((c) => console.log(`    ${c}`));
    }

    console.log('\n  -------------------------------------------------------------');
    console.log('  【ステップ 1: 根本原因の3択審査 (Root-Cause Triage)】');
    console.log('  その問題は本当にコアを直すべき課題か？（対症療法 vs 根本解決）');
    console.log('   ① プラグインの責務 (Layer 2)       -> プラグインを直すべき（コア変更禁止）');
    console.log('   ② 窓口・起動器の責務 (Layer 1)     -> Gateway/ホストを直すべき（コア変更不可）');
    console.log('   ③ コアの構造的欠陥 (Layer 0)       -> 外側の対症療法（強制終了やラッパー）に');
    console.log('                                         頼らず、コア自身を直すことが真の根本解決');
    console.log('  -------------------------------------------------------------');
    console.log('  【ステップ 2: コア改修の5原則 チェック】');
    console.log('  1. 外側の対症療法よりコア修正の方がシンプル・根本的であることが証明されたか？');
    console.log('  2. 窓口層（Layer 1）やプラグインの責務をコアに侵入させていないか？');
    console.log('  3. OBS独立性・配信無停止を脅かさないか？（Safe-Runner / エラー隔離）');
    console.log('  4. 特定サイトや特定UIへの依存が一切混入していないか？');
    console.log('  5. 金庫（Vault）の秘密情報保護ルールに違反していないか？');
    console.log('  -------------------------------------------------------------');

    if (!changeTriageOk) {
      console.error('\n  ❌ docs/CORE-CHANGELOG.md に根本解決の審査理由と改善内容が記録されていません！');
      console.error('     「なぜプラグインやLayer 1の対症療法ではなくコア修正が根本解決なのか」の判定理由、');
      console.error('     および改善効果・境界テスト結果を docs/CORE-CHANGELOG.md に必ず追記してください。');
    } else {
      console.log('\n  ✅ docs/CORE-CHANGELOG.md に根本解決の審査記録が検出されました。');
    }
  } else {
    console.log('  ✅ host/core/ は不変です（未コミット変更なし）');
  }

  console.log('\n' + '='.repeat(70));
  if (isPassed) {
    console.log('✅ [core-guard] 合格: host/core/ は不変・純粋性を維持しています');
    console.log('   （違反0件 / ファイル数・行数上限遵守 / コア再構築不要）');
    console.log('='.repeat(70));
    process.exit(0);
  } else {
    console.error('❌ [core-guard] 門番チェック不合格: 指摘事項を解消してください');
    console.log('='.repeat(70));
    process.exit(1);
  }
}

main();
