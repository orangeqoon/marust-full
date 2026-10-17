#!/usr/bin/env node
'use strict';

/**
 * docs/public/AI-GUIDE.md の本文を plugins/ui-standard/shell/guide/ai-guide.html に写す（アプリの「ヘルプ → AI に案内してもらう」で開くページ）。
 * ページは「この文を好きな AI に貼って『どうすればいいの？』と聞く」ためのコピー用の枠。本文はこの 1 か所（md）だけを直す。
 * 使い方: node cli/sync-ai-guide.js        （書き換える）
 *         node cli/sync-ai-guide.js --check （合っているかだけ見る。試験が使う）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MD = path.join(ROOT, 'docs', 'public', 'AI-GUIDE.md');
const HTML = path.join(ROOT, 'plugins', 'ui-standard', 'shell', 'guide', 'ai-guide.html');

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(md) {
  const body = escapeHtml(md.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  return [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>AI に案内してもらう</title>',
    '  <link rel="stylesheet" href="guide.css" />',
    '</head>',
    '<body>',
    '<main>',
    '  <h1>AI に案内してもらう</h1>',
    '  <p>下の文をまるごとコピーして、好きな AI（チャットできるもの）に貼り、<b>「どうすればいいの？」</b>と聞いてください。AI が、丸ストを使いはじめる手順を 1 つずつ案内します。</p>',
    '  <div class="note"><b>配信キー・パスワード・トークンは、AI に貼らないでください。</b>丸ストの画面の欄に直接入れます。</div>',
    '  <p><button id="copy" type="button">全文をコピー</button> <span id="copied" role="status"></span></p>',
    '  <pre id="guide">' + body + '</pre>',
    '</main>',
    '<script src="ai-guide.js"></script>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

function main(argv) {
  const want = render(fs.readFileSync(MD, 'utf8'));
  if (argv.indexOf('--check') !== -1) {
    const have = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n') : '';
    if (have !== want) { console.error('plugins/ui-standard/shell/guide/ai-guide.html が docs/public/AI-GUIDE.md と合っていません。node cli/sync-ai-guide.js を流してください'); return 1; }
    return 0;
  }
  fs.writeFileSync(HTML, want);
  console.log('書き換えました: plugins/ui-standard/shell/guide/ai-guide.html');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { render, escapeHtml, MD, HTML };
