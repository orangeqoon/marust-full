'use strict';

/**
 * テスト専用。可逆だが暗号ではない（各バイトを 0xA5 で反転してから base64 にするだけ）。
 * selectBackend はこれを返さない。createSecretProvider は allowFake が無い限り拒否する。
 */

const PREFIX = Buffer.from('marust-fake-v1\0');

function createFakeBackend() {
  return {
    id: 'fake',
    production: false,
    available() {
      return true;
    },
    async encrypt(plain) {
      const body = Buffer.from(String(plain), 'utf8');
      const masked = Buffer.alloc(body.length);
      for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ 0xA5;
      return Buffer.concat([PREFIX, masked]).toString('base64');
    },
    async decrypt(ciphertext) {
      const raw = Buffer.from(String(ciphertext), 'base64');
      if (raw.length < PREFIX.length || !raw.subarray(0, PREFIX.length).equals(PREFIX)) {
        const err = new Error('decrypt-failed');
        err.code = 'decrypt-failed';
        throw err;
      }
      const body = raw.subarray(PREFIX.length);
      const masked = Buffer.alloc(body.length);
      for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ 0xA5;
      return masked.toString('utf8');
    }
  };
}

module.exports = { createFakeBackend };
