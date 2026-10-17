'use strict';
require('./_ui-inline');

/**
 * 計画 X S5・S5b: 名乗り（category・for・tags・owns・パネルの aliases／dock／menu・site.order／autoSlot）の検査と、
 * 内蔵が全部名乗っていること。本体はプラグインの名前を知らない（P1）・名乗りで集めて見せる（P8）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('./_core-x');
const owners = require('../host/core/owners');
const { CATEGORY_WORDS, normalizeClaims, cleanFor, cleanTags } = require('../host/layer1/manifest-claims');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { eventAllowed } = require('../host/layer1/plugin-surface');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

const dirs = X.pluginDirs();
const builtin = Object.keys(dirs).filter((k) => dirs[k].base !== 'plugins-author' && dirs[k].manifest);
const siteIds = Object.keys(dirs).filter((k) => dirs[k].base === 'plugins/sites').map((k) => dirs[k].id);

(async () => {
  await test('category: 内蔵は全部、決まった語の category を名乗る（データだけのプラグインは kind から決まる）', () => {
    builtin.forEach((k) => {
      const m = dirs[k].manifest;
      if (['theme', 'layout', 'set', 'shell'].indexOf(m.kind) !== -1) return;
      assert.ok(Object.prototype.hasOwnProperty.call(CATEGORY_WORDS, m.category), k + ' の category: ' + m.category);
    });
    assert.deepStrictEqual(Object.keys(CATEGORY_WORDS).sort(), ['comment', 'connect', 'destination', 'dev', 'layout', 'login', 'look', 'set', 'slot', 'title', 'tool'].sort());
  });

  await test('for: 内蔵の for は「*」か、実在するサイトの id だけ', () => {
    builtin.forEach((k) => (dirs[k].manifest.for || []).forEach((id) => assert.ok(id === '*' || siteIds.indexOf(id) !== -1, k + ' の for: ' + id)));
  });

  await test('サイトのプラグインは site.order を名乗り、順番は重ならない・自動枠取りは slot の役目を持つサイトだけ', () => {
    const orders = [];
    Object.keys(dirs).filter((k) => dirs[k].base === 'plugins/sites').forEach((k) => {
      const m = dirs[k].manifest;
      assert.ok(Number.isInteger(m.site.order), k + ' の site.order');
      orders.push(m.site.order);
      if (m.site.autoSlot === true) assert.ok(m.roles && m.roles.slot, k + ' の autoSlot は slot の役目が要る');
    });
    assert.strictEqual(new Set(orders).size, orders.length);
  });

  await test('normalizeClaims: 壊れた欄は捨てて warn。for と tags は整える', () => {
    const logs = [];
    const m = { category: 'nope', for: ['youtube', 'BAD ID', '*', 'youtube'], tags: ['a b', 'ok', 'ok'] };
    normalizeClaims(m, 'x', (level, msg) => logs.push(msg));
    assert.strictEqual(m.category, undefined);
    assert.deepStrictEqual(m.for, ['youtube', '*']);
    assert.deepStrictEqual(m.tags, ['ok']);
    assert.ok(logs.some((l) => /ignore category/.test(l)));
    assert.deepStrictEqual(cleanFor('x'), []);
    assert.deepStrictEqual(cleanTags(null), []);
  });

  await test('owns: 内蔵だけ名乗れる。先に名乗ったものが勝つ。持ち主以外は断られる', () => {
    owners.reset();
    assert.deepStrictEqual(owners.claim('a', { events: ['x.*', 'y.one'], parentActions: ['p.go'] }), []);
    assert.deepStrictEqual(owners.claim('b', { events: ['x.*'] }), ['x.*']);
    assert.strictEqual(owners.eventOwner('x.started'), 'a');
    assert.strictEqual(owners.eventOwner('y.one'), 'a');
    assert.strictEqual(owners.eventOwner('y.two'), '');
    assert.strictEqual(owners.parentActionOwner('p.go'), 'a');
    owners.release('a');
    assert.strictEqual(owners.eventOwner('x.started'), '');
    owners.reset();
  });

  await test('registry: 外から入れたプラグインの owns は捨てられ、内蔵の名乗りだけが表に入る', async () => {
    owners.reset();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-reg-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-state-'));
    try {
      const mk = (base, id, extra) => {
        const dir = path.join(base, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0', manifestVersion: 2, runtime: 'inproc', main: 'index.js', provides: [], defaultMode: 'legacy' }, extra)));
        fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n");
      };
      const builtinRoot = path.join(root, 'b');
      const externalRoot = path.join(state, 'plugins');
      mk(builtinRoot, 'mine', { owns: { events: ['mine.*'], parentActions: ['mine.act'] }, category: 'tool', for: ['*'] });
      mk(externalRoot, 'theirs', { owns: { events: ['theirs.*'] }, category: 'bogus' });
      const registry = createRegistry({ core: { STATE_DIR: state }, appRoot: root, builtinRoot: builtinRoot, externalRoot: externalRoot, logger: () => {} });
      await registry.loadAll();
      assert.strictEqual(owners.eventOwner('mine.x'), 'mine');
      assert.strictEqual(owners.parentActionOwner('mine.act'), 'mine');
      assert.strictEqual(owners.eventOwner('theirs.x'), '');
      const snap = registry.snapshot();
      const mine = snap.find((r) => r.id === 'mine');
      const theirs = snap.find((r) => r.id === 'theirs');
      assert.strictEqual(mine.manifest.category, 'tool');
      assert.deepStrictEqual(mine.manifest.for, ['*']);
      assert.ok(!theirs || (!theirs.manifest.owns && !theirs.manifest.category));
    } finally { owners.reset(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
  });

  await test('パネルの名乗り（aliases・dock・menu）は形が検査され、本体はプラグインの id を持たない', () => {
    const { normalizeUi } = require('../host/layer1/plugin-surface');
    assert.ok(typeof normalizeUi === 'function');
    const reg = fs.readFileSync(path.join(X.ROOT, 'plugins/ui-standard/shell/core/dock.js'), 'utf8') + fs.readFileSync(path.join(X.ROOT, 'plugins/ui-standard/shell/menubar.js'), 'utf8');
    X.pluginIds().filter((id) => ['bulk-title', 'comment-send', 'overlay-basic', 'uplink-estimate', 'diagnostics'].indexOf(id) !== -1)
      .forEach((id) => assert.ok(reg.indexOf('plugin:' + id + ':') === -1, id + ' が dock／menubar に直書きされている'));
  });

  await test('eventAllowed など既存の口は変わらない', () => {
    assert.strictEqual(eventAllowed(['session.*'], 'session.started'), true);
  });

  if (failed) { console.error('[x2] ' + failed + ' failed'); process.exit(1); }
  console.log('[marust] x2 claims tests passed');
})();
