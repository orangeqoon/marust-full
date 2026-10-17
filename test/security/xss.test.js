'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DANGER = 'title|name|text|comment|message|author|userName|displayName';
const DANGER_RE = new RegExp('(?:\\+\\s*|\\.innerHTML\\s*=\\s*|\\$\\{\\s*)(?:[A-Za-z_$][\\w$]*\\.)*(?:' + DANGER + ')\\b');

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

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|html)$/.test(entry.name)) acc.push(full);
  }
}

function uiFiles() {
  const files = [];
  walk(path.join(ROOT, 'ui'), files);
  const plugins = path.join(ROOT, 'plugins');
  const ids = fs.readdirSync(plugins);
  for (let i = 0; i < ids.length; i += 1) {
    walk(path.join(plugins, ids[i], 'ui'), files);
    walk(path.join(plugins, ids[i], 'shell'), files);
  }
  return files;
}

function maskCalls(text, name) {
  const needle = name + '(';
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text.slice(i, i + needle.length) !== needle) { out += text.charAt(i); continue; }
    let depth = 1;
    i += needle.length;
    let quote = '';
    while (i < text.length && depth > 0) {
      const ch = text.charAt(i);
      if (quote) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) quote = '';
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; i += 1; continue; }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      i += 1;
    }
    i -= 1;
    out += "''";
  }
  return out;
}

function maskStrings(text) {
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += "''"; continue; }
    out += ch;
  }
  return out;
}

function statements(text) {
  const out = [];
  let current = '';
  let depth = 0;
  let quote = '';
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\n') line += 1;
    current += ch;
    if (quote) {
      if (ch === '\\') { current += text.charAt(i + 1) || ''; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    if (ch === ';' && depth === 0) {
      out.push({ line: start, text: current });
      current = '';
      start = line;
    }
  }
  if (current.trim()) out.push({ line: start, text: current });
  return out;
}

function unsafeInnerHtml(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const hits = [];
  const rows = statements(raw);
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].text.indexOf('innerHTML') === -1 && rows[i].text.indexOf('insertAdjacentHTML') === -1 && rows[i].text.indexOf('outerHTML') === -1) continue;
    let masked = maskCalls(rows[i].text, 'escapeHtml');
    masked = maskCalls(masked, 'encodeURIComponent');
    masked = maskStrings(masked);
    if (DANGER_RE.test(masked)) hits.push(path.relative(ROOT, file) + ':' + rows[i].line);
  }
  return hits;
}

async function main() {
  await test('chat text, name, and site use textContent', async function () {
    // V7 でコメント送信の画面は plugins/comment-send/ui/panel.js（iframe）へ移った。el() が textContent で入れる
    const hub = fs.readFileSync(path.join(ROOT, 'plugins', 'comment-send', 'ui', 'panel.js'), 'utf8');
    const start = hub.indexOf('function paintChat');
    assert.ok(start !== -1);
    const fn = hub.slice(start, hub.indexOf('stick) list.scrollTop', start));
    assert.ok(hub.indexOf('node.textContent = text') !== -1);
    assert.ok(fn.indexOf("el('span', 'bubble-author'") !== -1 && fn.indexOf("el('div', 'chat-text'") !== -1 && fn.indexOf("el('span', 'bubble-meta'") !== -1);
    assert.strictEqual(fn.indexOf('innerHTML'), -1);
  });

  await test('ui innerHTML interpolations go through an escape helper', async function () {
    const files = uiFiles();
    const hits = [];
    for (let i = 0; i < files.length; i += 1) hits.push.apply(hits, unsafeInnerHtml(files[i]));
    assert.deepStrictEqual(hits, []);
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w36 xss ok (' + skipped.length + ' skipped)');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});