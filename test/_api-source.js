'use strict';

/**
 * host/core/api.js の「ソースを文字列で見る」試験用の道具（計画 X・S8a で api.js が host/core/api/ に割れたため）。
 * 入口の host/core/api.js と host/core/api/ の中の全部の .js を 1 つの文字列にして返す。
 */

const fs = require('fs');
const path = require('path');

const HOST = path.join(__dirname, '..', 'host', 'layer1');

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else if (entry.name.endsWith('.js')) out.push(full);
  });
  return out;
}

function files() {
  return [path.join(HOST, 'api.js')].concat(walk(path.join(HOST, 'api'), []).sort());
}

function read() {
  return files().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

module.exports = { read, files };
