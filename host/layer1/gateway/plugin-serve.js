'use strict';

/**
 * 窓口の部品: プラグインの画面・オーバーレイの配信と SSE（計画 X・S8b。host/core/gateway.js から機械的に移した。動きは変えていない）。
 * S は host/core/gateway/index.js の createGateway が作る道具箱（opts・clients・api など）。
 */

const path = require('path');
const { ID_RE, NAME_RE, UI_EXT: PLUGIN_UI_EXT, PANEL_CSP, OVERLAY_CSP } = require('../plugin-surface');
const { UI_EXT, notFound, safeFile, sendFile, sendJson } = require('./http-util');

function createPluginServe(S) {
  const { pluginSource, overlayHub } = S;

  function pluginById(id) {
    if (!pluginSource || typeof pluginSource.snapshot !== 'function') return null;
    if (!ID_RE.test(id)) return null;
    const rows = pluginSource.snapshot();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.id !== id || !row.manifest || row.status === 'skip') continue;
      return row;
    }
    return null;
  }

  function overlayEntry(plugin, name) {
    const overlays = plugin && plugin.manifest && Array.isArray(plugin.manifest.overlays) ? plugin.manifest.overlays : [];
    for (let i = 0; i < overlays.length; i += 1) {
      if (overlays[i] && overlays[i].name === name) return overlays[i];
    }
    return null;
  }

  function servePluginUi(res, plugin, rel) {
    const root = path.join(plugin.dir, 'ui');
    const file = safeFile(root, rel, PLUGIN_UI_EXT);
    if (!file) {
      notFound(res);
      return;
    }
    sendFile(res, file, path.extname(file).toLowerCase() === '.html', PANEL_CSP);
  }

  function serveOverlayFile(res, plugin, entry) {
    const norm = String(entry.file || '').replace(/\\/g, '/');
    if (norm.indexOf('overlay/') !== 0) {
      notFound(res);
      return;
    }
    const root = path.join(plugin.dir, 'overlay');
    const file = safeFile(root, norm.slice('overlay/'.length), PLUGIN_UI_EXT);
    if (!file) {
      notFound(res);
      return;
    }
    sendFile(res, file, path.extname(file).toLowerCase() === '.html', OVERLAY_CSP);
  }

  function serveOverlayEvents(req, res, plugin, name) {
    if (!overlayHub) {
      notFound(res);
      return;
    }
    const release = overlayHub.acquire(plugin.id, name);
    if (!release) {
      sendJson(res, 429, { ok: false, error: 'too-many' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive'
    });
    let gone = false;
    let unsub = function () {};
    function finish() {
      if (gone) return;
      gone = true;
      unsub();
      release();
    }
    function send(values) {
      if (gone || res.writableEnded) return;
      try {
        res.write('data: ' + JSON.stringify(values || {}) + '\n\n');
      } catch (_) {
        finish();
      }
    }
    send(overlayHub.getLatest(plugin.id, name));
    if (gone) return;
    unsub = overlayHub.subscribe(plugin.id, name, send);
    req.on('close', finish);
    res.on('close', finish);
  }

  function servePluginSurface(req, res, pathname) {
    if (pathname.startsWith('/plugin/')) pathname = '/plugins/' + pathname.slice(8);
    if (pathname === '/overlay' || pathname.indexOf('/overlay/') === 0) {
      if (req.method !== 'GET') {
        notFound(res);
        return true;
      }
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length < 3 || parts[0] !== 'overlay' || !ID_RE.test(parts[1]) || !NAME_RE.test(parts[2])) {
        notFound(res);
        return true;
      }
      const plugin = pluginById(parts[1]);
      const entry = overlayEntry(plugin, parts[2]);
      if (!plugin || !entry) {
        notFound(res);
        return true;
      }
      if (parts.length === 4 && parts[3] === 'events') {
        serveOverlayEvents(req, res, plugin, parts[2]);
        return true;
      }
      if (parts.length === 3) {
        serveOverlayFile(res, plugin, entry);
        return true;
      }
      notFound(res);
      return true;
    }
    if (pathname === '/plugins' || pathname.indexOf('/plugins/') === 0) {
      if (req.method !== 'GET') {
        notFound(res);
        return true;
      }
      const rest = pathname.slice('/plugins/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) {
        notFound(res);
        return true;
      }
      const id = rest.slice(0, slash);
      const tail = rest.slice(slash + 1);
      const shell = tail.indexOf('shell/') === 0;
      if (!shell && tail.indexOf('ui/') !== 0) {
        notFound(res);
        return true;
      }
      const plugin = pluginById(id);
      if (!plugin) {
        notFound(res);
        return true;
      }
      if (shell) {
        if (!plugin.manifest || plugin.manifest.kind !== 'shell') { notFound(res); return true; }
        const file = safeFile(path.join(plugin.dir, 'shell'), tail.slice(6), UI_EXT);
        if (!file) { notFound(res); return true; }
        sendFile(res, file, path.extname(file).toLowerCase() === '.html');
      } else servePluginUi(res, plugin, tail.slice('ui/'.length));
      return true;
    }
    return false;
  }

  return {
    servePluginSurface
  };
}

module.exports = { createPluginServe };
