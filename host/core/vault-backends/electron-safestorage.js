'use strict';

/**
 * Electron safeStorage.encryptString / decryptString。
 * isEncryptionAvailable() が true のときだけ使える。
 * 保存用の戻りは暗号バイト列の base64。平文は返さない。
 */

function loadElectron() {
  try {
    const loaded = require('electron');
    if (!loaded || typeof loaded !== 'object') return null;
    return loaded;
  } catch (_) {
    return null;
  }
}

function coded(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function createElectronSafeStorageBackend(electronModule) {
  const injected = arguments.length > 0;

  function api() {
    const mod = injected ? electronModule : loadElectron();
    if (!mod || typeof mod !== 'object') return null;
    const safe = mod.safeStorage;
    if (!safe || typeof safe.encryptString !== 'function' || typeof safe.decryptString !== 'function') return null;
    return safe;
  }

  function ready() {
    try {
      const safe = api();
      return !!(safe && typeof safe.isEncryptionAvailable === 'function' && safe.isEncryptionAvailable() === true);
    } catch (_) {
      return false;
    }
  }

  return {
    id: 'electron-safestorage',
    production: true,
    available() {
      return ready();
    },
    async encrypt(plain) {
      if (!ready()) throw coded('unavailable');
      const buf = api().encryptString(String(plain));
      if (!Buffer.isBuffer(buf) || buf.length === 0) throw coded('unavailable');
      return buf.toString('base64');
    },
    async decrypt(ciphertext) {
      if (!ready()) throw coded('unavailable');
      if (typeof ciphertext !== 'string' || !ciphertext) throw coded('decrypt-failed');
      const buf = Buffer.from(ciphertext, 'base64');
      const text = api().decryptString(buf);
      if (typeof text !== 'string') throw coded('decrypt-failed');
      return text;
    }
  };
}

module.exports = { createElectronSafeStorageBackend, loadElectron };
