'use strict';

/**
 * V0.5 S4: marust plugin reload / logs / status・ui reload・restart の引数の組み立てと表示。
 * 実際の丸ストにはつながない。
 */

const assert = require('assert');
const cli = require('../cli/marust');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
const build = (argv) => {
  const parsed = cli.parseArgs(argv);
  return cli.buildDevCommand(parsed.rest[0], parsed.rest.slice(1), parsed.flags);
};

test('plugin reload <id> / --all', () => {
  assert.deepStrictEqual(build(['plugin', 'reload', 'demo']), { method: 'plugin.reload', params: { id: 'demo' } });
  assert.deepStrictEqual(build(['plugin', 'reload', '--all']), { method: 'plugins.reloadAll', params: {} });
  assert.ok(build(['plugin', 'reload']).error);
});

test('plugin logs <id> [--n N] / status <id>', () => {
  assert.deepStrictEqual(build(['plugin', 'logs', 'demo']), { method: 'plugin.logs', params: { id: 'demo' } });
  assert.deepStrictEqual(build(['plugin', 'logs', 'demo', '--n', '20']), { method: 'plugin.logs', params: { id: 'demo', n: 20 } });
  assert.deepStrictEqual(build(['plugin', 'logs', 'demo', '--n=5']), { method: 'plugin.logs', params: { id: 'demo', n: 5 } });
  assert.ok(build(['plugin', 'logs', 'demo', '--n', '0']).error);
  assert.ok(build(['plugin', 'logs', 'demo', '--n', '201']).error);
  assert.ok(build(['plugin', 'logs', 'demo', '--n', 'x']).error);
  assert.deepStrictEqual(build(['plugin', 'status', 'demo']), { method: 'plugin.status', params: { id: 'demo' } });
  assert.ok(build(['plugin', 'status']).error);
  assert.ok(build(['plugin', 'nope']).error);
});

test('ui reload は target の既定が all', () => {
  assert.deepStrictEqual(build(['ui', 'reload']), { method: 'ui.reload', params: { target: 'all' } });
  assert.deepStrictEqual(build(['ui', 'reload', 'theme']), { method: 'ui.reload', params: { target: 'theme' } });
  assert.deepStrictEqual(build(['ui', 'reload', 'plugin:demo']), { method: 'ui.reload', params: { target: 'plugin:demo' } });
  assert.ok(build(['ui', 'foo']).error);
});

test('restart は --yes が要る', () => {
  assert.ok(build(['restart']).error);
  assert.deepStrictEqual(build(['restart', '--yes']), { method: 'app.restart', params: {} });
});

test('ほかのコマンドは触らない', () => {
  assert.strictEqual(build(['status']), null);
  assert.strictEqual(build(['doctor']), null);
});

test('エラーの言葉と表示', () => {
  assert.strictEqual(cli.failureText({ error: 'dev-only' }), '開発者モードでだけ使えます');
  assert.strictEqual(cli.failureText({ error: 'streaming' }), '配信中はできません');
  assert.strictEqual(cli.failureText({ error: 'busy' }), 'すでに実行中です');
  assert.ok(cli.reloadLine({ id: 'demo', result: 'ok' }).includes('読み直しました'));
  assert.ok(cli.reloadLine({ id: 'demo', result: 'skip', message: 'legacy-not-loaded' }).includes('画面でこのプラグインを入れて'));
  const failedLine = cli.reloadLine({ id: 'demo', result: 'error', message: 'load-failed', error: { message: 'boom', where: 'index.js:3' } });
  assert.ok(failedLine.includes('boom') && failedLine.includes('index.js:3'));
  assert.strictEqual(cli.formatPluginLogs({ lines: [] }), 'ログはありません');
  const logs = cli.formatPluginLogs({ lines: [{ at: 0, level: 'info', text: 'hello' }, { at: 1000, level: 'error', text: 'bad' }] });
  assert.strictEqual(logs.split('\n').length, 2);
  assert.ok(logs.includes('error bad'));
  const status = cli.formatPluginStatus({ id: 'demo', status: 'load-failed', reason: 'error', mode: 'live', source: 'set', lastError: { message: 'boom', where: 'index.js:3' } });
  assert.ok(status.includes('load-failed') && status.includes('index.js:3'));
});

if (failed) { console.error('\n[v05-cli] ' + failed + ' failed'); process.exit(1); }
console.log('\n[marust] v05 cli tests passed');
