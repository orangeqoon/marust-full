#!/usr/bin/env node
'use strict';

/**
 * 大きい .js を丸ごと読まずに済ませるための「地図」。関数・クラス・メソッドの名前と開始行-終了行を出す。
 * 使い方: node cli/code-map.js <ファイルかフォルダ> [...] [--min <n>] [--depth <n>] [--big [<n>]] [--json] [--all] [--help]
 *
 * 解析は Node の標準だけで行う自前の字句解析（typescript 7 は JS から使える解析 API を持たないため）。
 * コメント・文字列・テンプレート（${} の入れ子を含む）・正規表現リテラルを読み飛ばして括弧の対応を取り、
 * トークン列から宣言を拾う。完全な精度ではなく「開始行と終了行が狂わない」ことを優先する。
 * 取りこぼす書き方（既知）:
 *   - テンプレート文字列の ${} の中にある関数
 *   - 分割代入の中の既定値の関数、`a = b = function` の 2 つ目、`(x) => y` を持つ三項演算子の途中
 *   - 式だけの arrow 本体（`x => a + b`）は、`,` `;` か閉じ括弧の手前までを終わりとする（セミコロン無しで次の行が続くと長くなる）
 *   - `}` の直後の `/` は正規表現として読む（オブジェクトリテラルの直後の割り算は誤読する）
 *   - 動的な名前（`obj[key] = function`）、`export default () => {}` のような名前の無い関数は拾わない
 */

const fs = require('fs');
const path = require('path');

const KEYWORD_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const NOT_METHOD_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'await', 'yield', 'do', 'else',
  'new', 'delete', 'void', 'in', 'of', 'instanceof', 'throw', 'case', 'super',
]);
const OP_RE = /^(?:=>|===|==|!==|!=|<<=|>>>=|>>=|>>>|>>|<<|<=|>=|\*\*=|\*\*|&&=|\|\|=|\?\?=|&&|\|\||\?\?|\+\+|--|[-+*%&|^]=|[-+*%&|^<>!~=])/;
const ID_START = /[A-Za-z_$#\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_$\u0080-￿]/;

/** ソースをトークン列にする。壊れていれば Error を投げる。 */
function lex(src) {
  let i = 0;
  let line = 1;
  const toks = [];

  function fail(msg) { throw new Error(`${msg}（${line} 行付近）`); }

  function skipLineComment() { while (i < src.length && src[i] !== '\n') i++; }
  function skipBlockComment() {
    const startLine = line;
    i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
      if (src[i] === '\n') line++;
      i++;
    }
    if (i >= src.length) { line = startLine; fail('コメントが閉じていません'); }
    i += 2;
  }
  function scanString(q) {
    const startLine = line;
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        i++;
        if (src[i] === '\r' && src[i + 1] === '\n') i++;
        if (src[i] === '\n') line++;
      } else if (src[i] === '\n') {
        line = startLine; fail('文字列が閉じていません');
      }
      i++;
    }
    if (i >= src.length) { line = startLine; fail('文字列が閉じていません'); }
    i++;
  }
  function scanTemplate() {
    const startLine = line;
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        i++;
        if (src[i] === '\n') line++;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        code([], true);
        continue;
      } else if (src[i] === '\n') {
        line++;
      }
      i++;
    }
    if (i >= src.length) { line = startLine; fail('テンプレートが閉じていません'); }
    i++;
  }
  function scanRegex() {
    const startLine = line;
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { line = startLine; fail('正規表現が閉じていません'); }
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      i++;
    }
    if (i >= src.length) { line = startLine; fail('正規表現が閉じていません'); }
    i++;
    while (i < src.length && ID_PART.test(src[i])) i++;
  }
  function isDivision(prev) {
    if (!prev) return false;
    if (prev.t === 'num' || prev.t === 'str' || prev.t === 'tpl' || prev.t === 're') return true;
    if (prev.t === 'id') return !KEYWORD_BEFORE_REGEX.has(prev.v);
    return prev.v === ')' || prev.v === ']' || prev.v === '++' || prev.v === '--';
  }

  // untilBrace: テンプレートの ${ } の中。対応する } で戻る（そのトークンは捨てる）
  function code(local, untilBrace) {
    let depth = 0;
    const push = (t, from, startLine) => {
      const tok = { t, v: src.slice(from, i), line: startLine, endLine: line };
      local.push(tok);
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { skipLineComment(); continue; }
      if (c === '/' && src[i + 1] === '*') { skipBlockComment(); continue; }
      const from = i;
      const startLine = line;
      if (c === '"' || c === '\'') { scanString(c); push('str', from, startLine); continue; }
      if (c === '`') { scanTemplate(); push('tpl', from, startLine); continue; }
      if (c === '/') {
        if (isDivision(local[local.length - 1])) {
          i += src[i + 1] === '=' ? 2 : 1;
          push('p', from, startLine);
        } else {
          scanRegex();
          push('re', from, startLine);
        }
        continue;
      }
      if (ID_START.test(c)) {
        i++;
        while (i < src.length && ID_PART.test(src[i])) i++;
        push('id', from, startLine);
        continue;
      }
      if (c >= '0' && c <= '9') {
        i++;
        while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) i++;
        push('num', from, startLine);
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (untilBrace && depth === 0) { i++; return; }
        depth--;
      }
      if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { i += 3; push('p', from, startLine); continue; }
      const m = OP_RE.exec(src.slice(i, i + 5));
      if (m) { i += m[0].length; push('p', from, startLine); continue; }
      i++;
      push('p', from, startLine);
    }
    if (untilBrace) fail('テンプレートの ${ } が閉じていません');
  }

  code(toks, false);
  return toks;
}

/** ソースを解析して { lines, items } を返す。items は開始順。 */
function analyze(src) {
  const toks = lex(src);
  const n = toks.length;
  const v = (k) => (k >= 0 && k < n ? toks[k].v : undefined);
  const isId = (k) => k >= 0 && k < n && toks[k].t === 'id';

  const match = new Array(n).fill(-1);
  const parent = new Array(n).fill(-1);
  const stack = [];
  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.t !== 'p') { parent[k] = stack.length ? stack[stack.length - 1] : -1; continue; }
    if (t.v === '(' || t.v === '[' || t.v === '{') {
      parent[k] = stack.length ? stack[stack.length - 1] : -1;
      stack.push(k);
    } else if (t.v === ')' || t.v === ']' || t.v === '}') {
      if (!stack.length) throw new Error(`閉じ括弧 ${t.v} に対応する開きが無い（${t.line} 行付近）`);
      const o = stack.pop();
      const want = { '(': ')', '[': ']', '{': '}' }[toks[o].v];
      if (want !== t.v) throw new Error(`括弧の対応が合いません: ${toks[o].line} 行の ${toks[o].v} と ${t.line} 行の ${t.v}`);
      match[o] = k; match[k] = o; parent[k] = parent[o];
    } else {
      parent[k] = stack.length ? stack[stack.length - 1] : -1;
    }
  }
  if (stack.length) throw new Error(`括弧が閉じていません（${toks[stack[stack.length - 1]].line} 行の ${toks[stack[stack.length - 1]].v}）`);

  // クラス
  const classes = [];
  const classBodies = new Set();
  for (let k = 0; k < n; k++) {
    if (!(isId(k) && v(k) === 'class') || v(k - 1) === '.') continue;
    let j = k + 1;
    let name = null;
    if (isId(j) && v(j) !== 'extends') { name = v(j); j++; }
    while (j < n && v(j) !== '{') {
      if (v(j) === '(' || v(j) === '[') j = match[j];
      j++;
    }
    if (j >= n) continue;
    classes.push({ at: k, name, body: j });
    classBodies.add(j);
  }

  const stmtStart = (pv) => pv === undefined || pv === ';' || pv === '}' || pv === '{' || pv === 'export' || pv === 'default';

  // 関数・クラスの文脈から名前と種類を決める。無名なら null。
  function context(startIdx, ownName, fnKind) {
    const p = startIdx - 1;
    const pv = v(p);
    if (pv === '=' ) {
      const k = p - 1;
      if (!isId(k)) return null;
      let first = k;
      while (v(first - 1) === '.' && isId(first - 2)) first -= 2;
      const open = parent[first];
      if (open >= 0 && toks[open].v === '(') return null;
      const name = toks.slice(first, k + 1).map((x) => x.v).join('');
      const kind = classBodies.has(open) ? 'prop' : fnKind;
      return { name, kind, startTok: first };
    }
    if (pv === ':') {
      const k = p - 1;
      const kt = toks[k];
      if (!kt || !(kt.t === 'id' || kt.t === 'str' || kt.t === 'num')) return null;
      const before = v(k - 1);
      const open = parent[p];
      if (!(before === '{' || before === ',') || open < 0 || toks[open].v !== '{') return null;
      const name = kt.t === 'str' ? kt.v.slice(1, -1) : kt.v;
      return { name, kind: 'prop', startTok: k };
    }
    if (ownName && stmtStart(pv)) return { name: ownName, kind: fnKind, startTok: startIdx };
    return null;
  }

  const items = [];
  const add = (name, kind, startTok, endTok) => {
    items.push({ name, kind, startTok, endTok, start: toks[startTok].line, end: toks[endTok].endLine, depth: 0 });
  };

  for (const c of classes) {
    let startIdx = c.at;
    const ctx = context(startIdx, c.name, 'class');
    const endTok = match[c.body];
    if (ctx) add(ctx.name, 'class', ctx.startTok, endTok);
    else if (c.name) add(c.name, 'class', startIdx, endTok);
    else add('(無名)', 'class', startIdx, endTok);
    items[items.length - 1].anon = !ctx && !c.name;
  }

  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.t === 'id' && t.v === 'function' && v(k - 1) !== '.') {
      let startIdx = k;
      if (v(k - 1) === 'async') startIdx = k - 1;
      let j = k + 1;
      if (v(j) === '*') j++;
      let ownName = null;
      if (isId(j)) { ownName = v(j); j++; }
      if (v(j) !== '(') continue;
      const b = match[j] + 1;
      if (v(b) !== '{') continue;
      const endTok = match[b];
      const ctx = context(startIdx, ownName, 'fn');
      if (ctx) add(ctx.name, ctx.kind, ctx.startTok, endTok);
      else { add('(無名)', 'fn', startIdx, endTok); items[items.length - 1].anon = true; }
      continue;
    }
    if (t.t === 'p' && t.v === '=>') {
      let startIdx;
      if (v(k - 1) === ')') startIdx = match[k - 1];
      else if (isId(k - 1)) startIdx = k - 1;
      else continue;
      if (v(startIdx - 1) === 'async') startIdx--;
      let endTok;
      const bs = k + 1;
      if (v(bs) === '{') {
        endTok = match[bs];
      } else {
        let j = bs;
        while (j < n) {
          const x = v(j);
          if (x === ')' || x === ']' || x === '}' || x === ',' || x === ';') break;
          if (toks[j].t === 'p' && (x === '(' || x === '[' || x === '{')) { j = match[j] + 1; continue; }
          j++;
        }
        endTok = Math.max(j - 1, bs);
        if (endTok >= n) endTok = n - 1;
      }
      const ctx = context(startIdx, null, 'arrow');
      if (ctx) add(ctx.name, ctx.kind, ctx.startTok, endTok);
      else { add('(無名)', 'arrow', startIdx, endTok); items[items.length - 1].anon = true; }
      continue;
    }
    if (t.t === 'p' && t.v === '(') {
      const ni = k - 1;
      const nt = toks[ni];
      if (!nt) continue;
      let name;
      let m = ni;
      if (nt.t === 'id') {
        if (NOT_METHOD_NAMES.has(nt.v)) continue;
        name = nt.v;
      } else if (nt.t === 'str') {
        name = nt.v.slice(1, -1);
      } else if (nt.t === 'num') {
        name = nt.v;
      } else if (nt.v === ']') {
        const o = match[ni];
        name = '[' + toks.slice(o + 1, ni).map((x) => x.v).join('') + ']';
        m = o;
      } else {
        continue;
      }
      const close = match[k];
      if (v(close + 1) !== '{') continue;
      let kind = 'method';
      while (true) {
        const pv = v(m - 1);
        if (pv === 'static' || pv === 'async' || pv === '*') { m--; continue; }
        if (pv === 'get' || pv === 'set') { kind = pv; m--; continue; }
        break;
      }
      const prev = v(m - 1);
      if (!(prev === '{' || prev === ',' || prev === ';' || prev === '}')) continue;
      const open = parent[k];
      if (prev === ';' || prev === '}') {
        if (!classBodies.has(open)) continue;
      } else if (open < 0 || toks[open].v !== '{') {
        continue;
      }
      add(name, kind, m, match[close + 1]);
    }
  }

  const text = src.replace(/\r\n/g, '\n');
  const lineCount = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return { lines: lineCount, items };
}

/** 深さ・--all・--min・--depth を適用した items を返す。 */
function select(items, opts) {
  let list = items.filter((it) => opts.all || !it.anon);
  list = list.slice().sort((a, b) => a.startTok - b.startTok || b.endTok - a.endTok);
  const stack = [];
  list.forEach((it, idx) => {
    while (stack.length && !(list[stack[stack.length - 1]].startTok <= it.startTok && list[stack[stack.length - 1]].endTok >= it.endTok)) stack.pop();
    it.depth = stack.length;
    it.parentIdx = stack.length ? stack[stack.length - 1] : -1;
    stack.push(idx);
  });
  const keep = list.map((it) => !(opts.min > 0) || it.end - it.start + 1 >= opts.min);
  for (let i = list.length - 1; i >= 0; i--) {
    if (keep[i] && list[i].parentIdx >= 0) keep[list[i].parentIdx] = true;
  }
  return list
    .filter((it, i) => keep[i] && (opts.depth === null || it.depth <= opts.depth))
    .map((it) => ({ name: it.name, kind: it.kind, start: it.start, end: it.end, depth: it.depth }));
}

const USAGE = [
  '使い方: node cli/code-map.js <ファイルかフォルダ> [...] [オプション]',
  '  関数・クラス・メソッドの名前と「開始行-終了行」を出す。大きい .js を丸ごと読む前に場所を見るための道具。',
  'オプション:',
  '  --min <n>     n 行未満の関数を出さない（子が出るなら親は出す）',
  '  --depth <n>   深さ n までだけ出す（0 = いちばん外）',
  '  --big [<n>]   フォルダを渡したとき、n 行（既定 500）以上の .js だけを対象にする',
  '  --json        [{ file, lines, items: [{ name, kind, start, end, depth }] }] を出す',
  '  --all         引数で渡した名前の無い関数も (無名) として出す',
  '  --help        この表示',
  '種類: fn / arrow / class / method / get / set / prop',
  'フォルダは .js を再帰で探す（node_modules・dist・dist-*・fixtures・.git とシンボリックリンクは飛ばす）。',
].join('\n');

function usageError(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { min: 0, depth: null, big: null, json: false, all: false, paths: [] };
  const intArg = (name, k) => {
    const x = argv[k];
    if (x === undefined || !/^\d+$/.test(x)) usageError(`${name} には 0 以上の整数が要ります`);
    return Number(x);
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--help' || a === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    else if (a === '--min') opts.min = intArg('--min', ++k);
    else if (a === '--depth') opts.depth = intArg('--depth', ++k);
    else if (a === '--big') {
      if (/^\d+$/.test(argv[k + 1] || '')) opts.big = Number(argv[++k]);
      else opts.big = 500;
    }
    else if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a.startsWith('--')) usageError(`知らないオプション: ${a}`);
    else opts.paths.push(a);
  }
  if (!opts.paths.length) usageError('ファイルかフォルダを 1 つ以上渡してください');
  return opts;
}

function isSkippedDir(name) {
  return name === 'node_modules' || name === 'dist' || name.startsWith('dist-') || name === 'fixtures' || name === '.git';
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!isSkippedDir(e.name)) walk(full, out);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(full);
    }
  }
}

function displayName(abs) {
  const rel = path.relative(process.cwd(), abs);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs).replace(/\\/g, '/');
}

function mapFile(abs, opts) {
  const file = displayName(abs);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return { file, lines: 0, items: [], error: e.message }; }
  try {
    const r = analyze(src);
    return { file, lines: r.lines, items: select(r.items, opts) };
  } catch (e) {
    const text = src.replace(/\r\n/g, '\n');
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { file, lines, items: [], error: e.message };
  }
}

function countLines(abs) {
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch (_) { return 0; }
}

function main(argv) {
  const opts = parseArgs(argv);
  const files = [];
  for (const p of opts.paths) {
    const abs = path.resolve(p);
    let st;
    try { st = fs.statSync(abs); } catch (_) { usageError(`見つかりません: ${p}`); }
    if (st.isDirectory()) {
      const found = [];
      walk(abs, found);
      for (const f of found) {
        if (opts.big === null || countLines(f) >= opts.big) files.push(f);
      }
    } else {
      files.push(abs);
    }
  }
  const results = files.map((f) => mapFile(f, opts));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(results.map((r) => (r.error ? r : { file: r.file, lines: r.lines, items: r.items })), null, 2)}\n`);
    return;
  }
  const out = [];
  for (const r of results) {
    out.push(`${r.file}  (${r.lines} 行)`);
    if (r.error) { out.push(`  （解析できません: ${r.error}）`); continue; }
    for (const it of r.items) {
      out.push(`  ${`${it.start}-${it.end}`.padStart(10)}  ${'  '.repeat(it.depth)}${it.name}  ${it.kind}`);
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

if (require.main === module) {
  process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
  main(process.argv.slice(2));
}

module.exports = { analyze, lex, select };
