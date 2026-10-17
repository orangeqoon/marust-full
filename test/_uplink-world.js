'use strict';

/**
 * V3: 本物の plugins/uplink-estimate を registry で読み込んだ api を作る試験用の部品。
 * 偽のエンジン（readTargetRates）と偽の orchestrator（modeSetting）だけ。本物の OBS には触れない。
 * opts: { rates（配列か Error）, modes（{ id: mode }。既定は uplink-estimate が live）, extraApi（createApi に足す欄）, legacyUi（旧 ui-settings.json の中身）}
 * 戻り: { api, registry, state, core, modes, rates（入れ替えられる）, calls（readTargetRates を呼んだ回数）, done() }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApi } = require('../host/layer1/api');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createCore } = require('../host/core/core-bridge');

const REAL = path.join(__dirname, '..', 'plugins', 'uplink-estimate');

async function createUplinkWorld(options) {
  const opts = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-uplink-'));
  const state = path.join(root, 'state');
  const builtin = path.join(root, 'builtin');
  fs.mkdirSync(path.join(state, 'services'), { recursive: true });
  fs.mkdirSync(path.join(builtin, 'uplink-estimate'), { recursive: true });
  const real = createCore();
  const core = { STATE_DIR: state, SERVICES_DIR: path.join(state, 'services'), COOKIES_DIR: path.join(state, 'cookies'), DATA_DIR: path.join(state, 'data'), ROOT_DIR: root, atomicWriteJsonSync: real.atomicWriteJsonSync };
  if (opts.legacyUi !== undefined) {
    fs.mkdirSync(path.join(state, 'data', 'marust'), { recursive: true });
    fs.writeFileSync(path.join(state, 'data', 'marust', 'ui-settings.json'), JSON.stringify(opts.legacyUi));
  }
  fs.writeFileSync(path.join(builtin, 'uplink-estimate', 'manifest.json'), fs.readFileSync(path.join(REAL, 'manifest.json')));
  // 本物の index.js。ctx は globalThis.__uplinkCtx に控える（api.calls・設定の確かめ用）
  fs.writeFileSync(path.join(builtin, 'uplink-estimate', 'index.js'),
    'const real = require(' + JSON.stringify(path.join(REAL, 'index.js')) + ');\n'
    + 'module.exports = Object.assign({}, real, { load(ctx) { globalThis.__uplinkCtx = ctx; return real.load(ctx); } });\n');
  const modes = Object.assign({ 'uplink-estimate': 'live' }, opts.modes || {});
  const world = { rates: opts.rates || [], calls: 0 };
  const orchestrator = { modeSetting: (id) => modes[id] || 'legacy', modeFor: (id) => modes[id] || 'legacy' };
  const registry = createRegistry({ core, appRoot: root, builtinRoot: builtin, authorRoot: path.join(root, 'no-author'), externalRoot: path.join(state, 'plugins'), logger() {}, modeFor: (id) => modes[id] || 'legacy' });
  const api = createApi(Object.assign({
    core,
    pluginRegistry: registry,
    orchestrator,
    audit: { write() {} },
    engine: {
      readTargetRates: async () => {
        world.calls += 1;
        if (world.rates instanceof Error) throw world.rates;
        return world.rates;
      },
      listTargets: () => [],
      status: () => ({})
    },
    getState: () => ({ product: 'marust', plugins: [], destinations: { liveCount: 0 }, engineStatus: { connected: true } })
  }, opts.extraApi || {}));
  registry.attachApi(api);
  await registry.loadAll();
  Object.assign(world, { root, state, core, registry, api, modes, orchestrator, done() { fs.rmSync(root, { recursive: true, force: true }); } });
  return world;
}

module.exports = { createUplinkWorld };
