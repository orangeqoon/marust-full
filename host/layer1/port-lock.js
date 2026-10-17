'use strict';

/**
 * 窓口のポートの固定と禁止（計画 X・A5。旧 host/core/capture-receiver.js から分けた）。
 * 丸ストは 127.0.0.1:18770 だけで待ち受ける。NeonTimer の 18766 では待ち受けない。ここは守りなので本体（単位 3）の持ち物。
 */

const NEON_PORT = 18766;
const MARUST_PORT = 18770;

function productPort(envValue) {
  if (envValue == null || envValue === '') return MARUST_PORT;
  if (String(envValue) === String(MARUST_PORT)) return MARUST_PORT;
  const err = new Error('marust listens on 127.0.0.1:18770 only');
  err.code = 'MARUST_PORT_LOCKED';
  throw err;
}

function assertBindPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error('invalid port');
  }
  if (n === NEON_PORT) {
    const err = new Error('refusing to bind 18766');
    err.code = 'MARUST_PORT_FORBIDDEN';
    throw err;
  }
  return n;
}

module.exports = { NEON_PORT, MARUST_PORT, productPort, assertBindPort };
