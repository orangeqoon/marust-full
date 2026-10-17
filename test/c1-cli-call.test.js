'use strict';

/** 計画 C・C1-2: marust call <メソッド名> [JSON か key=値…] の引数の組み立て。窓口にはつながない。 */

const assert = require('assert');
const cli = require('../cli/marust');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
const call = (argv) => cli.buildCallCommand(cli.parseArgs(argv).rest.slice(1));

test('メソッド名だけ・JSON・key=値（値は JSON として読めれば型つき）', () => {
  assert.deepStrictEqual(call(['call', 'hub.getState']), { method: 'hub.getState', params: {} });
  assert.deepStrictEqual(call(['call', 'plugin.logs', '{"id":"demo","n":20}']), { method: 'plugin.logs', params: { id: 'demo', n: 20 } });
  assert.deepStrictEqual(call(['call', 'x.y', 'id=youtube-main', 'n=5', 'on=true', 'ids=["a","b"]']), { method: 'x.y', params: { id: 'youtube-main', n: 5, on: true, ids: ['a', 'b'] } });
  assert.deepStrictEqual(call(['call', 'x.y', 'text=a=b']), { method: 'x.y', params: { text: 'a=b' } });
});

test('メソッド名が無い・変な名前・読めない引数は error（窓口に送らない）', () => {
  assert.ok(call(['call']).error);
  assert.ok(call(['call', '../x']).error);
  assert.ok(call(['call', 'x.y', '{bad']).error);
  assert.ok(call(['call', 'x.y', '[1]']).error);
  assert.ok(call(['call', 'x.y', 'novalue']).error);
  assert.ok(call(['call', 'x.y', '__proto__=1']).error);
});

test('--json などのフラグは引数に混ざらない', () => {
  assert.deepStrictEqual(call(['call', 'x.y', '--json', 'a=1']), { method: 'x.y', params: { a: 1 } });
});

if (failed) { console.error('[marust] c1 cli call tests failed ' + failed); process.exit(1); }
console.log('[marust] c1 cli call tests passed');
