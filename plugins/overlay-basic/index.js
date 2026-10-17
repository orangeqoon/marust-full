'use strict';

/**
 * 題名と配信中サイトのオーバーレイ。
 * session.* と ctx.sessions.view() で題名、
 * engine.target.changed のあと ctx.destinations.list() で配信中のサイト名を1文字列にする。
 * fields は文字列だけ。秘密は載しない。
 */

const MAX = 200;

function clip(value) {
  if (typeof value !== 'string') return '';
  return value.length > MAX ? value.slice(0, MAX) : value;
}

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function createOverlayBasic() {
  let ctx = null;
  const fallback = new Map();

  function publishTitle(value) {
    if (!ctx || !ctx.overlay || typeof ctx.overlay.publish !== 'function') return;
    ctx.overlay.publish('title', { title: clip(value) });
  }

  function publishSites(value) {
    if (!ctx || !ctx.overlay || typeof ctx.overlay.publish !== 'function') return;
    ctx.overlay.publish('live-sites', { sites: clip(value) });
  }

  function viewSession() {
    if (!ctx || !ctx.sessions || typeof ctx.sessions.view !== 'function') return null;
    try {
      const view = ctx.sessions.view();
      if (!view || typeof view !== 'object') return null;
      return view;
    } catch (err) {
      return null;
    }
  }

  function titleFrom(name, payload) {
    if (name === 'session.ended') return '';
    const view = viewSession();
    if (view && view.active === true && typeof view.title === 'string') return view.title;
    if (view && view.active === false) return '';
    if (payload && typeof payload.title === 'string') return payload.title;
    if (view && typeof view.title === 'string') return view.title;
    return '';
  }

  function listRows() {
    if (!ctx || !ctx.destinations || typeof ctx.destinations.list !== 'function') return null;
    try {
      const listed = ctx.destinations.list();
      if (!listed || listed.ok !== true || !Array.isArray(listed.destinations)) return null;
      return listed.destinations;
    } catch (err) {
      return null;
    }
  }

  function liveText(rows) {
    const names = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;
      const actual = row.actual && typeof row.actual === 'object' ? row.actual : {};
      const live = actual.engineState === 'live' || actual.siteLive === true;
      if (!live) continue;
      const site = typeof row.site === 'string' ? row.site.trim() : '';
      if (!site || site.length > MAX || seen.has(site)) continue;
      seen.add(site);
      names.push(site);
    }
    names.sort(compareText);
    return names.join(' · ');
  }

  function fallbackText(payload) {
    if (payload && typeof payload === 'object') {
      const id = payload.targetId != null ? String(payload.targetId) : '';
      const label = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (id) {
        if (payload.state === 'live' && label && label.length <= MAX) fallback.set(id, label);
        else fallback.delete(id);
      }
    }
    const names = [];
    const seen = new Set();
    for (const label of fallback.values()) {
      if (!label || seen.has(label)) continue;
      seen.add(label);
      names.push(label);
    }
    names.sort(compareText);
    return names.join(' · ');
  }

  function refreshSites(payload) {
    const rows = listRows();
    if (rows) {
      publishSites(liveText(rows));
      return;
    }
    publishSites(fallbackText(payload));
  }

  function load(passed) {
    ctx = passed || null;
    fallback.clear();
    publishTitle(titleFrom('load', null));
    refreshSites(null);
  }

  function start() {}

  function stop() {}

  function destroy() {
    ctx = null;
    fallback.clear();
  }

  function onEvent(name, payload) {
    if (!ctx || typeof name !== 'string') return;
    if (name.indexOf('session.') === 0) publishTitle(titleFrom(name, payload));
    if (name === 'engine.target.changed') refreshSites(payload || {});
  }

  function health() {
    return { ok: true, detail: 'overlay-basic' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    onEvent: onEvent
  };
}

const singleton = createOverlayBasic();
singleton.createOverlayBasic = createOverlayBasic;
module.exports = singleton;