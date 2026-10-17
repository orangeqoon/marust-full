'use strict';

// L7d: 画面なしで動く（--headless）の試験（Electron は起動しない）
//   - isHeadless の判定が --headless のときだけ真
//   - electron-main.js に openScreens と isHeadless の分かれ道、SIGINT/SIGTERM の受け口がある
//   - package.json の scripts に start:headless がある
//   - cli/marust.js の agentDown に画面なし起動の案内がある

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isHeadless } = require('../host/layer1/tray');

const ROOT = path.join(__dirname, '..');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name + '\n' + (err && err.stack ? err.stack : err));
  }
}

// 1. isHeadless の判定
test('isHeadless: --headless があるときだけ真', () => {
  assert.strictEqual(isHeadless(['--headless']), true);
  assert.strictEqual(isHeadless(['node', 'electron', '--headless']), true);
  assert.strictEqual(isHeadless(['node', 'electron', '--foo', '--headless']), true);
  assert.strictEqual(isHeadless(['node', 'electron']), false);
  assert.strictEqual(isHeadless([]), false);
  assert.strictEqual(isHeadless(['headless']), false);
  assert.strictEqual(isHeadless(['--headless=1']), false);
});

// 2. electron-main.js の文字列検査
test('electron-main.js: --headless のときに openScreens を呼ばない分かれ道がある', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
  assert.ok(src.includes('isHeadless'), 'isHeadless が使われていること');
  assert.ok(/function\s+openScreens\s*\(/.test(src), 'openScreens 関数が定義されていること');
  assert.ok(/!isHeadless\(\)\s*\)\s*\{\s*await\s+openScreens\(\);?\s*\}/.test(src) ||
            /if\s*\(\s*!isHeadless\(/.test(src), 'isHeadless で openScreens を呼ばない分岐があること');
  assert.ok(src.includes('[marust] headless gateway http://127.0.0.1:'), 'headless 時の案内行があること');
  assert.ok(src.includes('[marust] headless gateway not started'), 'headless 失敗時の案内行があること');
});

test('electron-main.js: SIGINT と SIGTERM で app.quit を呼ぶ', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8');
  assert.ok(/process\.on\(\s*['"]SIGINT['"][\s\S]*?app\.quit/.test(src), 'SIGINT で app.quit を呼ぶこと');
  assert.ok(/process\.on\(\s*['"]SIGTERM['"][\s\S]*?app\.quit/.test(src), 'SIGTERM で app.quit を呼ぶこと');
});

// 3. package.json の scripts
test('package.json: scripts に start:headless がある', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['start:headless'], 'electron . --headless');
});

// 4. cli/marust.js の案内
test('cli/marust.js: agentDown に画面なし起動の案内がある', () => {
  const cliSrc = fs.readFileSync(path.join(ROOT, 'cli', 'marust.js'), 'utf8');
  assert.ok(cliSrc.includes('marust.exe --headless'), 'marust.exe --headless が案内されていること');
  assert.ok(cliSrc.includes('npm run start:headless'), 'npm run start:headless が案内されていること');
});

if (failed > 0) {
  process.exit(1);
}
console.log('all ok');
