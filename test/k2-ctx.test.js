'use strict';

/**
 * K2: ctx.log・ctx.audit・ctx.events（内蔵プラグインが本体のファイルを require しないための口）。
 * 偽のプラグインを 1 つ読み、ctx を取り出して確かめる。
 *  - ctx.audit.append は provides に title.fanout@1 を持つ内蔵だけ。外から入れたもの・持たない内蔵は false（K2 評価 Must 2・Should 2）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { EVENTS } = require('../host/core/events');

const PLUGIN = [
  "'use strict';",
  'module.exports = {',
  '  load(ctx) { global.__k2ctx = global.__k2ctx || {}; global.__k2ctx[ctx.id] = ctx; },',
  '  start() {}, stop() {}, destroy() {}, isConfigured() { return true; }, health() { return { ok: true }; }, updateStream() { return { ok: true }; }, onObsEvent() { return { ok: true }; }',
  '};',
  ''
].join('\n');

async function boot(source, provides) {
  delete global.__k2ctx;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k2-root-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'k2-state-'));
  const external = source === 'user';
  const dir = path.join(external ? path.join(state, 'plugins') : root, 'k2plug');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id: 'k2plug', name: 'K2', version: '0.1.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', kind: 'integration', provides: provides };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), PLUGIN);
  const registry = createRegistry({
    core: { STATE_DIR: state },
    appRoot: root,
    builtinRoot: external ? path.join(root, 'none') : root,
    authorRoot: path.join(root, 'no-author'),
    externalRoot: path.join(state, 'plugins'),
    modeFor: () => 'live',
    logger() {}
  });
  await registry.loadAll();
  const ctx = (global.__k2ctx || {}).k2plug;
  assert.ok(ctx, source + ' の ctx を取れなかった（読み込めていない）');
  return { ctx, state, root };
}

function clean(b) {
  fs.rmSync(b.state, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
}

(async () => {
  // 内蔵（title.fanout@1 を持つ）
  const b = await boot('set', ['title.fanout@1']);
  try {
    const { ctx, state } = b;
    assert.strictEqual(ctx.events.NAMES, EVENTS);
    assert.ok(Object.isFrozen(ctx.events) && Object.isFrozen(ctx.log) && Object.isFrozen(ctx.audit) && Object.isFrozen(ctx.audit.fields));
    // fields を書き換えても効かない（凍結。strict mode なので投げる）
    assert.throws(() => { ctx.audit.fields.summarizeSites = () => []; });
    assert.strictEqual(typeof require('../host/layer1/audit-fields').summarizeSites, 'function');
    // ctx.log: 自分の dataDir にだけ書く。名前の検査
    assert.strictEqual(ctx.log.appendJsonl('shadow', { a: 1 }), true);
    assert.strictEqual(ctx.log.appendJsonl('../x', { a: 1 }), false);
    assert.strictEqual(ctx.log.appendJsonl('a/b', { a: 1 }), false);
    assert.strictEqual(ctx.log.appendJsonl('', { a: 1 }), false);
    assert.strictEqual(fs.readdirSync(ctx.dataDir).filter((n) => /^shadow-\d{8}\.jsonl$/.test(n)).length, 1);
    // maxBytes は受け取らない（1 を渡しても 1 行ごとに次のファイルへ進まない）
    for (let i = 0; i < 5; i += 1) assert.strictEqual(ctx.log.appendJsonl('cap', { i: i }, { maxBytes: 1 }), true);
    assert.strictEqual(fs.readdirSync(ctx.dataDir).filter((n) => /^cap-/.test(n)).length, 1);
    // ctx.audit: 形は核。追記は logs/marust の shadow
    assert.strictEqual(typeof ctx.audit.fields.localIso(), 'string');
    assert.deepStrictEqual(ctx.audit.fields.clipField('abc'), { length: 3, head: 'abc' });
    assert.strictEqual(ctx.audit.append({ kind: 'k2', note: 'ok' }), true);
    assert.ok(fs.readdirSync(path.join(state, 'logs', 'marust')).some((n) => /^shadow-\d{8}\.jsonl$/.test(n)));
    console.log('ok ctx.log・ctx.audit・ctx.events（内蔵・title.fanout@1）');
  } finally { clean(b); }

  // 内蔵だが title.fanout@1 を持たない
  const c = await boot('set', ['ui.panel@1']);
  try {
    assert.strictEqual(c.ctx.audit.append({ kind: 'k2' }), false);
    assert.strictEqual(fs.existsSync(path.join(c.state, 'logs', 'marust')), false);
    console.log('ok ctx.audit.append は title.fanout@1 を持たない内蔵では false');
  } finally { clean(c); }

  // 外から入れたもの（L8d: 出どころ制限解除。title.fanout@1 があれば書ける）
  const e = await boot('user', ['title.fanout@1']);
  try {
    assert.strictEqual(e.ctx.audit.append({ kind: 'k2' }), true, 'L8d: 外から入れたものでも title.fanout@1 があれば書ける');
    assert.strictEqual(fs.existsSync(path.join(e.state, 'logs', 'marust')), true);
    console.log('ok L8d: ctx.audit.append は外から入れたものでも title.fanout@1 があれば書ける');
  } finally { clean(e); }
  console.log('[marust] k2 ctx tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
