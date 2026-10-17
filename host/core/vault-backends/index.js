'use strict';

/**
 * 暗号化の選び方。Electron の中なら electron-safestorage だけ。
 * 使えなければ null（金庫は使えない状態で起動する。health の reason は 'no-backend'）。
 * Electron の外（node main.js）の予備は持たない（K6。平文を受ける手段は置き場に渡せないため）。
 * テスト用の可逆変換はここから返さない。
 */

const { createElectronSafeStorageBackend, loadElectron } = require('./electron-safestorage');

function selectBackend(options) {
  const opts = options || {};
  const electron = Object.prototype.hasOwnProperty.call(opts, 'electron') ? opts.electron : loadElectron();
  const safe = createElectronSafeStorageBackend(electron);
  if (safe.available()) return safe;
  return null;
}

module.exports = {
  selectBackend,
  createElectronSafeStorageBackend
};
