'use strict';

/**
 * 開発中の自動ペアリング。本体では常に無効（承認を迂回する道なので、置き場のフォルダの有無などでは開けない）。
 * 開発する人が、起動の環境変数 MARUST_DEV_AUTOPAIR=1 を付け、かつ開発者モードがオンのときだけ、
 * ペアリングのコードを使わずに、CLI（node cli/marust.js）と AI（MCP）の合言葉を丸スト自身が作って置く。
 * 置く先は pair と同じ場所（services/marust-cli.json・marust-mcp.json）なので、CLI と MCP は何も変えずにそのまま使える。
 * 承認は要らない（read と write。非常停止は付けない）。MARUST_AI_PAIR=1 のときは作らない。
 */

const fs = require('fs');
const path = require('path');

const AUTO_SUFFIX = '（自動）';
const TARGETS = Object.freeze([
  { file: 'marust-cli.json', name: 'CLI' + AUTO_SUFFIX },
  { file: 'marust-mcp.json', name: 'AI（MCP）' + AUTO_SUFFIX }
]);

function readToken(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data.token === 'string' && data.token.length >= 32 ? data.token : '';
  } catch (_) {
    return '';
  }
}

function writeToken(file, token, name) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ token: token, name: name, savedAt: new Date().toISOString(), auto: true }) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function enabled(opts) {
  const env = opts && opts.env ? opts.env : process.env;
  if (env.MARUST_DEV_AUTOPAIR !== '1') return false;
  if (env.MARUST_AI_PAIR === '1') return false;
  return !!(opts && typeof opts.devModeOn === 'function' && opts.devModeOn());
}

/**
 * @param {{ clients: any, servicesDir: string, devModeOn: () => boolean, env?: object }} opts
 * @returns {{ on: boolean, made: string[], revoked: number }}
 */
function sync(opts) {
  const o = opts || {};
  const out = { on: enabled(o), made: [], revoked: 0 };
  if (!o.clients || !o.servicesDir) return out;
  if (!out.on) {
    // 開発者モードを切っても、自動で作った端末を取り消さない（L7e。手でペアしたものにも触らない）
    return out;
  }
  for (const target of TARGETS) {
    const file = path.join(o.servicesDir, target.file);
    const token = readToken(file);
    const client = token ? o.clients.authenticate(token) : null;
    if (client && client.kind === 'native' && client.requiresApproval === false && client.permissions.indexOf('write') !== -1) continue;
    const made = o.clients.issueNative({ name: target.name, permissions: ['read', 'write'], requiresApproval: false });
    if (!made.ok) continue;
    writeToken(file, made.token, target.name);
    out.made.push(target.name);
  }
  return out;
}

module.exports = { sync, enabled, AUTO_SUFFIX };
