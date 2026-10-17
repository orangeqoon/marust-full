'use strict';

/**
 * 画面のソースを文字列で見るテスト用の道具（R15）。
 * hub.js は ui/core/*.js と plugins/ui-standard/shell/panels/*.js に分かれたので、「画面の JS 全体」を 1 つの文字列にして返す。
 * 順番は core → panels → hub.js（hub.html の読み込み順と同じ）。
 */

const fs = require('fs');
const path = require('path');

const UI = path.join(__dirname, '..', 'plugins', 'ui-standard', 'shell');

function listJs(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort().map((n) => path.join(dir, n));
  } catch (_) {
    return [];
  }
}

function hubSource() {
  const files = listJs(path.join(UI, 'core')).concat(listJs(path.join(UI, 'panels')), [path.join(UI, 'hub.js')]);
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

function shellDocument() {
  const manifest = JSON.parse(fs.readFileSync(path.join(UI, '..', 'manifest.json'), 'utf8'));
  const frame = fs.readFileSync(path.join(UI, '..', '..', '..', 'ui', 'hub.html'), 'utf8');
  return fs.readFileSync(path.join(UI, manifest.shell.template), 'utf8') + frame + manifest.shell.scripts.map(name => '<script src="/plugins/ui-standard/shell/' + name + '"></script>').join('\n');
}
module.exports = { hubSource, listJs, UI, shellDocument };
