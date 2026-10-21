'use strict';

/**
 * 窓口のポートの固定と禁止（計画 X・A5。旧 host/core/capture-receiver.js から分けた）。
 * 丸ストは 127.0.0.1:18770 だけで待ち受ける。別のアプリが使う 18766 では待ち受けない。ここは守りなので本体（単位 3）の持ち物。
 */

const RESERVED_PORTS = [18766]; // 別のアプリが使うポート。ここでは待ち受けない
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
  if (RESERVED_PORTS.indexOf(n) !== -1) {
    const err = new Error('refusing to bind ' + n);
    err.code = 'MARUST_PORT_FORBIDDEN';
    throw err;
  }
  return n;
}

module.exports = { RESERVED_PORTS, MARUST_PORT, productPort, assertBindPort };
