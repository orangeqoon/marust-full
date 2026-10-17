'use strict';

/**
 * 窓口の部品: WebSocket の端末の追跡・イベントの配り・端末の取り消しで閉じる（計画 X・S8b。host/core/gateway.js から機械的に移した。動きは変えていない）。
 * S は host/core/gateway/index.js の createGateway が作る道具箱（opts・clients・api など）。
 */

const { secretMask } = require('../../core');

function createSockets(S) {
  const { clients, bus, sockets, socketGrants } = S;

  function closeClient(id) {
    const set = sockets.get(id);
    if (!set) return;
    for (const ws of set) {
      try { ws.close(4001, 'revoked'); } catch (_) { /* ignore */ }
    }
    sockets.delete(id);
  }

  if (typeof clients.setOnRevoke === 'function') clients.setOnRevoke(closeClient);

  function track(clientId, ws, permissions) {
    socketGrants.set(ws, Array.isArray(permissions) ? permissions.slice() : []);
    let set = sockets.get(clientId);
    if (!set) {
      set = new Set();
      sockets.set(clientId, set);
    }
    set.add(ws);
    ws.on('close', function () {
      set.delete(ws);
      if (set.size === 0) sockets.delete(clientId);
    });
  }

  function broadcast(name, payload, meta) {
    let text;
    for (const set of sockets.values()) {
      for (const ws of set) {
        if (ws.readyState !== 1) continue;
        const granted = socketGrants.get(ws);
        if (!granted || granted.indexOf('read') === -1) continue;
        if (text === undefined) text = JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { name: name, payload: secretMask.maskDeep(payload), meta: secretMask.maskDeep(meta) }
        });
        try { ws.send(text); } catch (_) { /* drop */ }
      }
    }
  }

  if (bus && typeof bus.subscribe === 'function') {
    bus.subscribe('*', function (name, payload, meta) {
      broadcast(name, payload, meta);
    });
  }

  return {
    closeClient,
    track,
    broadcast
  };
}

module.exports = { createSockets };
