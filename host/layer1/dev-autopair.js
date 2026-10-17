'use strict';

/**
 * 開発中の自動ペアリング。
 * 開発者モードがオンのあいだは、ペアリングのコードを使わずに、CLI（node cli/marust.js）と AI（MCP）の合言葉を丸スト自身が作って置く。
 * 置く先は pair と同じ場所（services/marust-cli.json・marust-mcp.json）なので、CLI と MCP は何も変えずにそのまま使える。
 * 承認は要らない（read と write。非常停止は付けない）。
 * 開発者モードを切る、または MARUST_AI_PAIR=1、または DEV_AUTOPAIR を false にすると、自動で作った端末を全部取り消して合言葉も消す
 * → 公開前にペアリングを必須に戻すスイッチはこの 3 つのどれか（コードの変更は DEV_AUTOPAIR の 1 行）。
 */

const fs = require('fs');
const path = require('path');

// リリースの前に false にすると、開発者モードでもペアリング必須に戻る（ペアの仕組み自体は残してある）。
const DEV_AUTOPAIR = true;
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
  if (!DEV_AUTOPAIR) return false;
  if (env.MARUST_AI_PAIR === '1') return false;
  // 配る版（作者用の置き場 plugins-author が無い配り物）では、DEV_AUTOPAIR に頼らず自動ペアリングを作らない（承認を迂回する道なので核の中で守る。計画 X・A6）。authorBuild を渡さない呼び方（試験）は従来どおり
  if (opts && opts.authorBuild === false) return false;
  return !!(opts && typeof opts.devModeOn === 'function' && opts.devModeOn());
}

/**
 * @param {{ clients: any, servicesDir: string, devModeOn: () => boolean, authorBuild?: boolean, env?: object }} opts
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

module.exports = { sync, enabled, DEV_AUTOPAIR, AUTO_SUFFIX };
