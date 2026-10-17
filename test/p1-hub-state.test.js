'use strict';
// 実モジュールを偽の文書読取・登録簿で動かす。本物の保存先や配信APIは使わない。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { summarizeSite } = require('../host/layer1/site-info');
const { lookupPluginMode } = require('../host/layer1/modes');
const root = path.join(__dirname, '..');
const orchPath = path.join(root, 'host/layer1/orchestrator.js');
const localRequire = createRequire(orchPath);
const source = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
const displayCode = section('function summarizePlugin(', 'function logLine(') +
  section('function currentHubState(', 'function getUiSettings(');
const plain = (value) => JSON.parse(JSON.stringify(value));
for (const count of [0, 30, 75, 150]) {
  for (const author of [false, true]) {
    let reads = 0;
    let doc = { plugins: { 'site-fake-0': 'live', 'site-fake-1': 'shadow' } };
    let forced = false;
    const rows = Array.from({ length: count }, (_, i) => ({
      id: 'site-fake-' + i, status: i % 4 === 0 ? 'stopped' : 'running', source: 'set',
      manifest: { name: 'Fake ' + i, manifestVersion: 2, defaultMode: 'live',
        provides: ['stream.site@1'], site: { id: 'fake-' + i, name: 'Fake' } }
    }));
    const registry = { snapshot: () => rows, getRunning: () => rows.filter(r => r.status === 'running'), sourceOf: () => 'set' };
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(orchPath, 'utf8'), {
      module: mod, exports: mod.exports, require(name) {
        if (name === './modes') return { lookupPluginMode, readModesDocument() {
          reads++;
          return doc ? { ok: true, data: plain(doc) } : { ok: false, reason: 'parse' };
        } };
        return localRequire(name);
      }, process, console, Buffer, setTimeout, clearTimeout, setImmediate
    });
    const resolver = { forced: () => forced, modeFor: (id, info) =>
      forced ? 'legacy' : info.specific || info.manifest.defaultMode };
    const orchestrator = mod.exports.createOrchestrator({ registry, core: {}, logger() {},
      modeSource: author ? { get: () => resolver } : undefined });
    const ctx = { orchestrator, registry, hubState: { plugins: [], marker: 'preserve' },
      sessions: { view: () => ({ state: 'idle' }) }, stateStore: null, engines: null,
      fanoutReserved: null, hiddenPluginIds: () => [], summarizeSite,
      formatModeSummary: mod.exports.formatModeSummary };
    vm.createContext(ctx);
    vm.runInContext(displayCode, ctx);
    for (const nextDoc of [doc, { plugins: { 'site-fake-0': 'legacy', 'site-fake-1': 'live' } }, null]) {
      doc = nextDoc;
      // 比較元は従来の要求内非共有の呼び方。モード欄・サイト欄を含め応答全体を照合。
      const expectedSummary = orchestrator.summarizeModes();
      const expectedPlugins = rows.map(row => ctx.summarizePlugin(row));
      reads = 0;
      const result = plain(ctx.currentHubState());
      assert.strictEqual(reads, 1, 'one read per request, rows=' + count);
      assert.deepStrictEqual(result.modeSummary, plain(expectedSummary));
      assert.deepStrictEqual(result.plugins, plain(expectedPlugins));
      assert.strictEqual(result.marker, 'preserve');
    }
    forced = true;
    const result = plain(ctx.currentHubState());
    if (author) assert.ok(result.plugins.every(row => row.mode === 'legacy'));
    // 操作経路のmodeFor/設定用modeSettingは要求の後でも最新文書を読む。
    doc = { plugins: { 'site-fake-0': 'legacy' } };
    forced = false;
    reads = 0;
    assert.strictEqual(orchestrator.modeFor('site-fake-0'), 'legacy');
    assert.strictEqual(reads, 1);
    doc.plugins['site-fake-0'] = 'live';
    assert.strictEqual(orchestrator.modeSetting('site-fake-0'), 'live');
    assert.strictEqual(reads, 2);
    ctx.orchestrator = null;
    assert.ok(plain(ctx.currentHubState()).plugins.every(row => row.mode === 'legacy'));
    ctx.hubState = null;
    assert.strictEqual(ctx.currentHubState(), null);
  }
}
console.log('P1 hub state: 0/30/75/150 rows, public/author, fresh/invalid modes, forced and standalone checks PASS; reads=1/request');
