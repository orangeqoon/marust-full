'use strict';

// cli/code-map.js（関数の地図を出す道具）の試験。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'code-map.js');

function run(args) {
  const r = spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', cwd: ROOT });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function json(args) {
  const r = run(args.concat(['--json']));
  assert.strictEqual(r.code, 0, r.err);
  return JSON.parse(r.out);
}

const SAMPLE = [
  /* 1 */ '\'use strict\';',
  /* 2 */ 'function plain(a) {',
  /* 3 */ '  const s = "}{ ) (";',
  /* 4 */ '  const t = `x ${ { a: 1 }.a } } { ${`}`} y`;',
  /* 5 */ '  const r = /[}{]\\//.test(s); // } {',
  /* 6 */ '  /* } { */',
  /* 7 */ '  const d = a / b / c;',
  /* 8 */ '  return d;',
  /* 9 */ '}',
  /* 10 */ 'const arrow = (x) => {',
  /* 11 */ '  return x;',
  /* 12 */ '};',
  /* 13 */ 'const short = y => y + 1;',
  /* 14 */ 'class Foo extends Bar {',
  /* 15 */ '  constructor() { super(); }',
  /* 16 */ '  get value() {',
  /* 17 */ '    return 1;',
  /* 18 */ '  }',
  /* 19 */ '  static make() {',
  /* 20 */ '    return [1].map((z) => z * 2);',
  /* 21 */ '  }',
  /* 22 */ '}',
  /* 23 */ 'module.exports = {',
  /* 24 */ '  alpha() {',
  /* 25 */ '    return 1;',
  /* 26 */ '  },',
  /* 27 */ '  beta: () => {',
  /* 28 */ '    return 2;',
  /* 29 */ '  },',
  /* 30 */ '  gamma: function () {',
  /* 31 */ '    return 3;',
  /* 32 */ '  },',
  /* 33 */ '};',
  /* 34 */ 'exports.delta = function () {',
  /* 35 */ '  function inner() {',
  /* 36 */ '    return 4;',
  /* 37 */ '  }',
  /* 38 */ '  return inner;',
  /* 39 */ '};',
  /* 40 */ 'setTimeout(function () {',
  /* 41 */ '  return 5;',
  /* 42 */ '}, 1);',
  '',
].join('\n');

function find(items, name) {
  return items.find((it) => it.name === name);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-codemap-'));
  try {
    const file = path.join(dir, 'sample.js');
    fs.writeFileSync(file, SAMPLE);

    // 基本: 種類・開始行・終了行・深さ
    const [res] = json([file]);
    assert.strictEqual(res.lines, 42);
    const items = res.items;
    const expect = [
      ['plain', 'fn', 2, 9, 0],
      ['arrow', 'arrow', 10, 12, 0],
      ['short', 'arrow', 13, 13, 0],
      ['Foo', 'class', 14, 22, 0],
      ['constructor', 'method', 15, 15, 1],
      ['value', 'get', 16, 18, 1],
      ['make', 'method', 19, 21, 1],
      ['alpha', 'method', 24, 26, 0],
      ['beta', 'prop', 27, 29, 0],
      ['gamma', 'prop', 30, 32, 0],
      ['exports.delta', 'fn', 34, 39, 0],
      ['inner', 'fn', 35, 37, 1],
    ];
    for (const [name, kind, start, end, depth] of expect) {
      const it = find(items, name);
      assert.ok(it, name + ' が拾われていない');
      assert.deepStrictEqual([it.kind, it.start, it.end, it.depth], [kind, start, end, depth], name);
    }
    // コールバックは拾わない
    assert.strictEqual(items.some((it) => it.name === '(無名)'), false);
    assert.strictEqual(items.length, expect.length);

    // --all
    const all = json([file, '--all'])[0].items;
    const anon = all.filter((it) => it.name === '(無名)');
    assert.strictEqual(anon.length, 2);
    assert.ok(anon.some((it) => it.start === 40 && it.end === 42));
    const mapCb = anon.find((it) => it.start === 20);
    assert.strictEqual(mapCb.depth, 2);

    // --depth
    const d0 = json([file, '--depth', '0'])[0].items;
    assert.ok(d0.every((it) => it.depth === 0));
    assert.strictEqual(find(d0, 'inner'), undefined);

    // --min: 親は子が出るなら残る
    const m5 = json([file, '--min', '5'])[0].items.map((it) => it.name);
    assert.ok(m5.includes('plain') && m5.includes('exports.delta') && m5.includes('Foo'));
    assert.ok(!m5.includes('short') && !m5.includes('alpha'));
    const m3 = json([file, '--min', '3'])[0].items.map((it) => it.name);
    assert.ok(m3.includes('inner') && m3.includes('exports.delta'));
    const mFoo = json([file, '--min', '4'])[0].items.map((it) => it.name);
    assert.ok(mFoo.includes('Foo') && !mFoo.includes('constructor'));

    // 文字の出力
    const text = run([file, '--depth', '0']);
    assert.strictEqual(text.code, 0);
    assert.ok(/sample\.js {2}\(42 行\)/.test(text.out));
    assert.ok(/2-9 {2}plain {2}fn/.test(text.out));

    // フォルダ・--big・読み飛ばし
    const sub = path.join(dir, 'tree');
    fs.mkdirSync(path.join(sub, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(sub, 'fixtures'), { recursive: true });
    fs.mkdirSync(path.join(sub, 'dist-x'), { recursive: true });
    fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'node_modules', 'n.js'), 'function n() {}\n');
    fs.writeFileSync(path.join(sub, 'fixtures', 'f.js'), 'function f() {}\n');
    fs.writeFileSync(path.join(sub, 'dist-x', 'd.js'), 'function d() {}\n');
    fs.writeFileSync(path.join(sub, 'src', 'small.js'), 'function small() {}\n');
    fs.writeFileSync(path.join(sub, 'src', 'big.js'), 'function big() {\n' + '  // x\n'.repeat(10) + '}\n');
    const folder = json([sub]);
    assert.deepStrictEqual(folder.map((r) => path.basename(r.file)), ['big.js', 'small.js']);
    const big = json([sub, '--big', '5']);
    assert.deepStrictEqual(big.map((r) => path.basename(r.file)), ['big.js']);
    assert.strictEqual(big[0].items[0].end, 12);

    // 壊れたファイルは「解析できません」で終了コード 0
    fs.writeFileSync(path.join(dir, 'broken.js'), 'function x( {\n  const a = "abc\n');
    const broken = run([path.join(dir, 'broken.js')]);
    assert.strictEqual(broken.code, 0);
    assert.ok(broken.out.includes('解析できません'));
    fs.writeFileSync(path.join(dir, 'unclosed.js'), 'function y() {\n  return 1;\n');
    assert.ok(run([path.join(dir, 'unclosed.js')]).out.includes('解析できません'));

    // 引数の誤りは終了コード 2
    assert.strictEqual(run([]).code, 2);
    assert.strictEqual(run([file, '--nope']).code, 2);
    assert.strictEqual(run([path.join(dir, 'missing.js')]).code, 2);
    assert.strictEqual(run(['--help']).code, 0);

    // 実物
    const real = json([path.join(ROOT, 'host', 'layer1', 'api', 'index.js')]);
    assert.ok(real[0].items.length >= 1);
    assert.ok(!real[0].error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('code-map: ok');
}

main();
