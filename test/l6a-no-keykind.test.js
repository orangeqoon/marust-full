'use strict';

// L6a: keyKind・keyPolicy・per-broadcast を本体から外した。古い state.json は壊れず、次の保存で消える。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createEventBus } = require('../host/core/event-bus');
const { createStateStore } = require('../host/core/state-store');

const ROOT = path.join(__dirname, '..');
let failed = 0;

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

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'test') return;
      walk(full, out);
    } else if (/\.(js|html|json)$/.test(ent.name)) out.push(full);
  });
  return out;
}

async function main() {
  await test('本体（host・ui・サイトの manifest）に keyKind・keyPolicy・per-broadcast が残っていない', function () {
    const files = [].concat(
      walk(path.join(ROOT, 'host'), []),
      walk(path.join(ROOT, 'ui'), []),
      walk(path.join(ROOT, 'plugins', 'sites'), []).filter((f) => path.basename(f) === 'manifest.json')
    );
    const hits = [];
    files.forEach((file) => {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        // 古い state.json の読み捨て 1 行だけは名前を書く必要がある
        if (/legacy-drop/.test(line)) return;
        if (/keyKind|keyPolicy|per-broadcast/.test(line)) hits.push(path.relative(ROOT, file) + ':' + (i + 1));
      });
    });
    assert.deepStrictEqual(hits, []);
  });

  await test('古い state.json（keyKind・keyPolicy 入り）を読んでも壊れず、保存し直すと消える', function () {
    const real = createCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l6a-'));
    try {
      const file = path.join(dir, 'data', 'marust', 'state.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        destinations: [
          { id: 'nico', site: 'niconico', accountId: 'nico', enabled: true, keyPolicy: 'per-broadcast', keyKind: 'per-broadcast', engine: { id: 'obs-local', targetId: 't1' }, desired: {}, actual: {} },
          { id: 'yt', site: 'youtube', accountId: 'yt', enabled: false, keyPolicy: 'static', engine: null }
        ],
        session: null
      }));
      const store = createStateStore({ core: { STATE_DIR: dir, atomicWriteJsonSync: real.atomicWriteJsonSync }, bus: createEventBus(), logger: function () {} });
      const rows = store.snapshot().destinations;
      assert.deepStrictEqual(rows.map((r) => r.id), ['nico', 'yt']);
      rows.forEach((r) => {
        assert.ok(!('keyPolicy' in r), r.id);
        assert.ok(!('keyKind' in r), r.id);
      });
      assert.deepStrictEqual(rows[0].engine, { id: 'obs-local', targetId: 't1' });
      store.putDestination({ id: 'nico', enabled: false });
      const saved = fs.readFileSync(file, 'utf8');
      assert.ok(!/keyPolicy|keyKind|per-broadcast/.test(saved), saved);
      assert.ok(saved.indexOf('"nico"') !== -1 && saved.indexOf('"yt"') !== -1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (failed) {
    console.error('[marust] l6a tests failed: ' + failed);
    process.exit(1);
  }
  console.log('[marust] l6a tests passed');
}

main();
