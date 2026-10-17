'use strict';

/**
 * V1: shadow.report は plugins/dev-shadow が出す。api だけを作る試験が、同じ答えを確かめるための部品。
 * 一時フォルダに dev-shadow の manifest を写し、index.js は本物へ向ける。registry に api を繋いで読み込む。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../host/layer1/plugin-registry');

const REAL = path.join(__dirname, '..', 'plugins', 'dev-shadow');

async function attachDevShadow(api, core) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-shadow-'));
  const builtin = path.join(root, 'builtin');
  const dir = path.join(builtin, 'dev-shadow');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REAL, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = require(' + JSON.stringify(path.join(REAL, 'index.js')) + ');\n');
  // registry は core.STATE_DIR を要る。STATE_DIR の無い core（unavailable の確かめ）は、読み込みのあいだだけ仮の値を入れる
  const ctxCore = core || {};
  const hadState = Object.prototype.hasOwnProperty.call(ctxCore, 'STATE_DIR');
  if (!hadState) ctxCore.STATE_DIR = path.join(root, 'state');
  const registry = createRegistry({
    core: ctxCore,
    appRoot: root,
    builtinRoot: builtin,
    authorRoot: path.join(root, 'no-author'),
    externalRoot: path.join(root, 'external'),
    logger() {}
  });
  registry.attachApi(api);
  await registry.loadAll();
  if (!hadState) delete ctxCore.STATE_DIR;
  return { registry, done() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* 後始末 */ } } };
}

module.exports = { attachDevShadow };
