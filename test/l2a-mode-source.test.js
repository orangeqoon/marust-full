'use strict';

/**
 * L2a: モードの決め方を作者用プラグインへ移す（無いときは配信が live）。
 * mode-source の基本と、resolver 無し／resolver ありの orchestrator の答え、boot.js の ctx、boot-context の provideResolver を確かめる。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createModeSource } = require('../host/layer1/mode-source');
const { createOrchestrator } = require('../host/layer1/orchestrator');
const { createBootContext } = require('../host/layer1/boot-context');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2a-mode-source-'));
fs.mkdirSync(path.join(dir, 'services'), { recursive: true });

function core() {
  return { STATE_DIR: dir, SERVICES_DIR: path.join(dir, 'services') };
}

function writeModes(modes) {
  fs.writeFileSync(path.join(dir, 'services', 'marust-modes.json'), JSON.stringify(modes));
}

function writeFanout(mode) {
  fs.writeFileSync(path.join(dir, 'services', 'marust-fanout.json'), JSON.stringify({ mode }));
}

function rec(id, manifest) {
  return { id, manifest: Object.assign({ id, manifestVersion: 2 }, manifest) };
}

function registry(rows, externalIds) {
  const list = Array.isArray(rows) ? rows : [];
  const ext = Array.isArray(externalIds) ? externalIds : [];
  return {
    getRunning: () => list,
    snapshot: () => list,
    sourceOf: (id) => (ext.indexOf(id) !== -1 ? 'user' : 'set'),
    isLoaded: () => true
  };
}

const runningCommon = [
  rec('broadcast', { provides: ['stream.lifecycle@1'] }),
  rec('obs-engine', { provides: ['stream.lifecycle@1'] }),
  rec('site-twitch', { provides: ['stream.site@1'] }),
  rec('site-youtube', { provides: ['stream.site@1'] }),
  rec('old-v1', { manifestVersion: 1, fanout: { requires: 'title', method: 'updateTitle' } })
];

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failures += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function removeFile(file) {
  try { fs.rmSync(file, { force: true }); } catch (_) { /* ignore */ }
}

function cleanServices() {
  removeFile(path.join(dir, 'services', 'marust-modes.json'));
  removeFile(path.join(dir, 'services', 'marust-fanout.json'));
}

// 1. mode-source の基本
test('mode-source set / get / has', () => {
  cleanServices();
  const source = createModeSource();
  const goodResolver = { modeFor() {} };
  const badResolver = {};
  assert.deepStrictEqual(source.set(goodResolver), { ok: true });
  assert.deepStrictEqual(source.set(goodResolver), { ok: false, error: 'already-set' });
  assert.deepStrictEqual(source.get(), goodResolver);
  assert.strictEqual(source.has(), true);

  const fresh = createModeSource();
  assert.deepStrictEqual(fresh.set(badResolver), { ok: false, error: 'bad-resolver' });
  assert.strictEqual(fresh.has(), false);
});

// 2. resolver 無し（公開版）
test('resolver 無し: broadcast/obs-engine は live、他は modes に従う', () => {
  cleanServices();
  writeModes({ plugins: { broadcast: 'legacy' }, default: 'legacy' });
  const orch = createOrchestrator({ registry: registry(runningCommon), core: core() });

  assert.strictEqual(orch.modeFor('broadcast'), 'live', 'broadcast は常に live');
  assert.strictEqual(orch.modeFor('obs-engine'), 'live', 'obs-engine は常に live');
  assert.strictEqual(orch.modeFor('site-twitch'), 'legacy', 'site は modes の値に従う（legacy）');
  assert.strictEqual(orch.modeFor('site-youtube'), 'legacy', 'site は default の legacy');
  assert.deepStrictEqual(orch.forceLegacy('x'), { ok: false, error: 'unavailable' }, 'resolver 無しは forceLegacy 不可');
  assert.strictEqual(orch.readMode(), 'orchestrator', 'resolver 無しの readMode は orchestrator');
});

// 3. resolver 無し: shadow は legacy に落ちる・defaultMode live は live・external は legacy
test('resolver 無し: shadow は legacy、live は live、external は legacy', () => {
  cleanServices();
  writeModes({ plugins: { 'site-twitch': 'shadow', 'site-youtube': 'live' } });
  const rows = [
    rec('site-twitch', { provides: ['stream.site@1'] }),
    rec('site-youtube', { provides: ['stream.site@1'] }),
    rec('site-external', { provides: ['stream.site@1'], defaultMode: 'live' })
  ];
  const orch = createOrchestrator({ registry: registry(rows, ['site-external']), core: core() });
  assert.strictEqual(orch.modeFor('site-twitch'), 'legacy', 'shadow は legacy');
  assert.strictEqual(orch.modeFor('site-youtube'), 'live', 'live は live');
  assert.strictEqual(orch.modeFor('site-external'), 'legacy', 'external は defaultMode live でも legacy');
});

// 4. resolver 無し: v1 fanout は manifest の既定（legacy）
test('resolver 無し: v1 fanout は manifest の既定（legacy）', () => {
  cleanServices();
  writeModes({ plugins: {} });
  writeFanout('orchestrator');
  const rows = [
    rec('old-v1', { manifestVersion: 1, fanout: { requires: 'title', method: 'updateTitle' } })
  ];
  const orch = createOrchestrator({ registry: registry(rows), core: core() });
  assert.strictEqual(orch.modeFor('old-v1'), 'legacy', 'fanout ファイルは読まない');
});





// 7. createBootContext の provideResolver が modeSource.set に届く
test('createBootContext の provideResolver が modeSource.set に届く', () => {
  cleanServices();
  const source = createModeSource();
  const bootContext = createBootContext({ core: core(), modeSource: source, logger: () => {} });
  const fakeResolver = { modeFor() {} };
  const ctx = bootContext('test-id', () => []);
  const result = ctx.modes.provideResolver(fakeResolver);
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(source.get(), fakeResolver);

  const ctxNoSource = createBootContext({ core: core(), logger: () => {} })('test-id', () => []);
  assert.deepStrictEqual(ctxNoSource.modes.provideResolver(fakeResolver), { ok: false, error: 'unavailable' });
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures > 0) {
  process.exit(1);
} else {
  console.log('[marust] l2a mode-source tests passed');
}
