'use strict';

/**
 * host/core/gateway.js の「ソースを文字列で見る」試験用の道具（計画 X・S8b で gateway が host/core/gateway/ に割れたため）。
 * 入口の host/core/gateway.js と host/core/gateway/ の中の全部の .js を 1 つの文字列にして返す。
 */

const fs = require('fs');
const path = require('path');

const HOST = path.join(__dirname, '..', 'host', 'layer1');

function read() {
  const dir = path.join(HOST, 'gateway');
  const files = [path.join(HOST, 'gateway.js')].concat(fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort().map((n) => path.join(dir, n)));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

module.exports = { read };
