'use strict';

// V7 C2: manifest の ui（panels・popup・settings・menu・slots・relay）の検査。おかしい項目は捨てて warn、プラグインは落とさない。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeUi, UI_SLOTS } = require('../host/layer1/plugin-surface');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createCore } = require('../host/core/core-bridge');

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

function collect() {
  const warns = [];
  return { warns: warns, warn: function (m) { warns.push(m); } };
}

async function main() {
  await test('normalizeUi: 無い・形が違うときは空', async () => {
    const empty = { panels: [], popup: [], settings: null, menu: [], slots: [], relay: [], parentActions: [] };
    const a = collect();
    assert.deepStrictEqual(normalizeUi(undefined, a.warn), empty);
    assert.deepStrictEqual(a.warns, []);
    const b = collect();
    assert.deepStrictEqual(normalizeUi([1], b.warn), empty);
    assert.deepStrictEqual(b.warns, ['ignore ui']);
  });

  await test('normalizeUi: よい項目は残り、悪い項目は数えて捨てる', async () => {
    const c = collect();
    const ui = normalizeUi({
      panels: [{ name: 'main', title: 'メイン', file: 'ui/main.html' }, { name: 'Bad', title: 'x', file: 'ui/x.html' }],
      popup: [{ name: 'pop', title: '小窓', file: 'ui/pop.html' }, { name: 'pop', title: '二重', file: 'ui/pop2.html' }, { name: 'a'.repeat(23), title: 't', file: 'ui/p.html' }],
      settings: { title: '設定', file: 'ui/settings.html' },
      menu: [
        { label: '開く', openPanel: 'main' },
        { label: '操作', method: 'plugin.demo.go' },
        { label: '両方', method: 'plugin.demo.go', openPanel: 'main' },
        { label: '', openPanel: 'main' },
        { label: '悪い method', method: 'not a method' }
      ],
      slots: [
        { slot: 'home.top', title: '上', file: 'ui/top.html' },
        { slot: 'home.top', file: 'ui/top2.html' },
        { slot: 'nowhere', file: 'ui/n.html' },
        { slot: 'home.siteCard.footer', file: '../escape.html' }
      ],
      relay: ['hub.fanout', 'hub.fanout', 'bad method', 3]
    }, c.warn);
    assert.deepStrictEqual(ui.panels, [{ name: 'main', title: 'メイン', file: 'ui/main.html' }]);
    assert.deepStrictEqual(ui.popup, [{ name: 'pop', title: '小窓', file: 'ui/pop.html' }]);
    assert.deepStrictEqual(ui.settings, { title: '設定', file: 'ui/settings.html' });
    assert.deepStrictEqual(ui.menu, [{ label: '開く', openPanel: 'main' }, { label: '操作', method: 'plugin.demo.go' }]);
    assert.deepStrictEqual(ui.slots, [{ slot: 'home.top', title: '上', file: 'ui/top.html' }]);
    assert.deepStrictEqual(ui.relay, ['hub.fanout']);
    assert.ok(c.warns.some(function (m) { return /ignore panels/.test(m); }));
    assert.ok(c.warns.some(function (m) { return m === 'ignore ui count=11'; }), c.warns.join('|'));
  });

  await test('UI_SLOTS は 2 つから始める', async () => {
    assert.deepStrictEqual(UI_SLOTS, ['home.top', 'home.siteCard.footer']);
  });

  await test('registry: ui.panels は panels に混ざり、ui の残りは検査されて残る', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-v7-ui-'));
    try {
      const builtin = path.join(tmp, 'plugins');
      fs.mkdirSync(path.join(builtin, 'uidemo', 'ui'), { recursive: true });
      fs.writeFileSync(path.join(builtin, 'uidemo', 'index.js'), "'use strict';\nmodule.exports = { load() {}, start() {}, stop() {}, destroy() {} };\n");
      fs.writeFileSync(path.join(builtin, 'uidemo', 'manifest.json'), JSON.stringify({
        id: 'uidemo', name: 'uidemo', version: '0.0.1', manifestVersion: 2, runtime: 'inproc', kind: 'integration', main: 'index.js',
        panels: [{ name: 'main', title: '本体のパネル', file: 'ui/main.html' }],
        ui: {
          panels: [{ name: 'main', title: '重複', file: 'ui/other.html' }, { name: 'extra', title: '追加', file: 'ui/extra.html' }],
          slots: [{ slot: 'home.top', file: 'ui/top.html' }, { slot: 'bad.slot', file: 'ui/top.html' }],
          relay: ['hub.fanout']
        }
      }));
      const logs = [];
      const registry = createRegistry({
        core: createCore(),
        appRoot: tmp,
        builtinRoot: builtin,
        externalRoot: path.join(tmp, 'external'),
        logger: function (level, message) { logs.push(level + ' ' + message); }
      });
      const rows = registry.discover();
      const row = rows.find(function (r) { return r.id === 'uidemo'; });
      assert.ok(row, 'uidemo');
      const manifest = row.manifest;
      assert.deepStrictEqual(manifest.panels.map(function (p) { return p.name + ':' + p.file; }), ['main:ui/main.html', 'extra:ui/extra.html']);
      assert.strictEqual(manifest.ui.panels, undefined);
      assert.deepStrictEqual(manifest.ui.slots, [{ slot: 'home.top', title: 'home.top', file: 'ui/top.html' }]);
      assert.deepStrictEqual(manifest.ui.relay, ['hub.fanout']);
      assert.ok(logs.some(function (l) { return /warn ignore ui count=1 on uidemo|warn ignore ui count=1/.test(l); }), logs.join('|'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  if (failed) {
    console.error('[marust] v7 ui manifest tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] v7 ui manifest tests passed');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
