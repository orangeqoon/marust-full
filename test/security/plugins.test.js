'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PLUGINS = path.join(ROOT, 'plugins');

let failed = 0;
const skipped = [];

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function skip(name, reason) {
  skipped.push(name);
  console.log('skip ' + name);
  console.log('  ' + reason);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function pluginIds() {
  return fs.readdirSync(PLUGINS).filter(function (name) {
    return fs.existsSync(path.join(PLUGINS, name, 'manifest.json'));
  });
}

function constsOf(text) {
  const map = Object.create(null);
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(text))) map[match[1]] = match[2];
  return map;
}

function splitArgs(text) {
  const args = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote) {
      current += ch;
      if (ch === '\\') { current += text.charAt(i + 1); i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function resolveArg(arg, consts) {
  const literal = /^['"]([^'"]+)['"]$/.exec(arg);
  if (literal) return literal[1];
  if (/^[A-Za-z_$][\w$]*$/.test(arg) && consts[arg]) return consts[arg];
  return '';
}

function ownerFunction(text, index) {
  const before = text.slice(0, index);
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  let match;
  let found = null;
  while ((match = re.exec(before))) {
    const slice = text.slice(match.index, index);
    const opens = (slice.match(/\{/g) || []).length;
    const closes = (slice.match(/\}/g) || []).length;
    if (opens > closes) found = match;
  }
  return found;
}

function secretGets(text, declared) {
  const consts = constsOf(text);
  const problems = [];
  const re = /secrets\.get\s*\(\s*([^)]*)\)/g;
  let match;
  while ((match = re.exec(text))) {
    const arg = match[1].trim();
    const direct = resolveArg(arg, consts);
    if (direct) {
      if (!declared.has(direct)) problems.push(direct + ' (undeclared)');
      continue;
    }
    const owner = ownerFunction(text, match.index);
    if (!owner) { problems.push('unresolved ' + arg); continue; }
    const params = owner[2].split(',').map(function (item) { return item.trim(); });
    const paramIndex = params.indexOf(arg);
    if (paramIndex === -1) { problems.push('unresolved ' + arg); continue; }
    const callRe = new RegExp('\\b' + owner[1] + '\\s*\\(([^;]*?)\\)', 'g');
    let call;
    let saw = false;
    while ((call = callRe.exec(text))) {
      if (call.index >= owner.index && call.index < match.index) continue;
      const args = splitArgs(call[1]);
      if (args.length <= paramIndex) continue;
      saw = true;
      const resolved = resolveArg(args[paramIndex], consts);
      if (!resolved) problems.push('unresolved ' + owner[1] + '(' + args[paramIndex] + ')');
      else if (!declared.has(resolved)) problems.push(resolved + ' (undeclared)');
    }
    if (!saw) problems.push('unresolved ' + owner[1]);
  }
  return problems;
}

const K3_KEEP_ON = ['session', 'chat-inlet', 'update-check', 'tips', 'diagnostics', 'ai-connect', 'site-login'];

async function main() {
  await test('v2 manifests default to legacy', async function () {
    const ids = pluginIds();
    const bad = [];
    for (let i = 0; i < ids.length; i += 1) {
      const manifest = JSON.parse(read(path.join(PLUGINS, ids[i], 'manifest.json')));
      if (manifest.manifestVersion !== 2) continue;
      const mode = Object.prototype.hasOwnProperty.call(manifest, 'defaultMode') ? manifest.defaultMode : 'legacy';
      // K3: 今まで核が常に持っていた動き（セッション・コメントの受け口・更新の確認・紹介・診断・AI の窓口・ログイン）を出した内蔵は、束を入れた人で切れないよう既定 live。外へ書く機能ではない
      if (mode !== 'legacy' && K3_KEEP_ON.indexOf(ids[i]) === -1) bad.push(ids[i] + '=' + mode);
    }
    assert.deepStrictEqual(bad, []);
  });

  await test('plugins only read declared secrets', async function () {
    const ids = pluginIds();
    const bad = [];
    for (let i = 0; i < ids.length; i += 1) {
      const manifest = JSON.parse(read(path.join(PLUGINS, ids[i], 'manifest.json')));
      const declared = new Set(Array.isArray(manifest.secrets) ? manifest.secrets : []);
      const file = path.join(PLUGINS, ids[i], 'index.js');
      if (!fs.existsSync(file)) continue;
      const problems = secretGets(read(file), declared);
      for (let j = 0; j < problems.length; j += 1) bad.push(ids[i] + ' ' + problems[j]);
    }
    assert.deepStrictEqual(bad, []);
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w36 plugins ok (' + skipped.length + ' skipped)');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});