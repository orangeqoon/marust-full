'use strict';

/**
 * destination.observed を、同じ site の配信先の actual.siteLive へ反映する。
 * site があり siteLive が真偽値の行だけ書く。空の観測や、出ていないサイトは変えない。
 * 配信先は自動では作らない。
 */

const { EVENTS } = require('../events');

function createObservedBridge(options) {
  const opts = options || {};
  const bus = opts.bus;
  const store = opts.stateStore || opts.store;
  if (!bus || typeof bus.subscribe !== 'function') {
    throw new Error('observed bridge requires bus');
  }
  if (!store || typeof store.updateActual !== 'function' || typeof store.snapshot !== 'function') {
    throw new Error('observed bridge requires stateStore');
  }

  function apply(payload) {
    const body = payload && typeof payload === 'object' ? payload : {};
    const readings = Array.isArray(body.readings) ? body.readings : [];
    const observedAt = typeof body.at === 'string' ? body.at : '';
    const snap = store.snapshot();
    const rows = snap && Array.isArray(snap.destinations) ? snap.destinations : [];
    for (let i = 0; i < readings.length; i += 1) {
      const reading = readings[i];
      if (!reading || typeof reading !== 'object') continue;
      const site = typeof reading.site === 'string' ? reading.site : '';
      if (!site || typeof reading.siteLive !== 'boolean') continue;
      const meta = { source: 'site-observed' };
      if (observedAt) meta.observedAt = observedAt;
      for (let j = 0; j < rows.length; j += 1) {
        const dest = rows[j];
        if (!dest || dest.site !== site || typeof dest.id !== 'string' || !dest.id) continue;
        store.updateActual(dest.id, { siteLive: reading.siteLive }, meta);
      }
    }
  }

  const unsubscribe = bus.subscribe(EVENTS.DESTINATION_OBSERVED, function (_name, payload) {
    apply(payload);
  });

  return {
    unsubscribe: typeof unsubscribe === 'function' ? unsubscribe : function () {}
  };
}

module.exports = { createObservedBridge };
