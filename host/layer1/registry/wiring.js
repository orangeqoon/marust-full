'use strict';

/**
 * 登録簿の部品: API の名前空間・action・購読の登録と後始末（計画 X・S8b。host/core/plugin-registry.js から機械的に移した。動きは変えていない）。
 * S は host/core/plugin-registry.js の createRegistry が作る道具箱（共有の状態 st・opts・records など）。他の部品の関数は S.fn から呼ぶ。
 */


function createWiring(S) {
  const { opts, records, log, recLog, st } = S;
  const reload = (...args) => S.fn.reload(...args);

  function requiredMethods(rec) {
    const manifest = rec.manifest || {};
    const names = ['load', 'start', 'stop', 'destroy'];
    const provides = Array.isArray(manifest.provides) ? manifest.provides : [];
    const site = manifest.kind === 'site' || provides.indexOf('stream.site@1') !== -1;
    if (site || manifest.manifestVersion !== 2) {
      names.push('isConfigured', 'health');
    }
    const method = manifest.fanout && manifest.fanout.method;
    if (method) names.push(method);
    if (manifest.manifestVersion === 2 && provides.indexOf('stream.site@1') !== -1 && names.indexOf('updateMetadata') === -1) {
      names.push('updateMetadata');
    }
    const caps = manifest.capabilities || [];
    if (caps.includes('obs-start') || caps.includes('obs-stop')) names.push('onObsEvent');
    if (Array.isArray(manifest.subscribes) && manifest.subscribes.length) names.push('onEvent');
    return names;
  }

  function dropUnsubs(list) {
    for (let i = 0; i < list.length; i += 1) {
      try { list[i](); } catch (err) { /* one subscriber must not stop reload */ }
    }
  }

  function clearHostSubs(rec) {
    const list = rec.unsubs || [];
    rec.unsubs = [];
    dropUnsubs(list);
  }

  function clearCtxSubs(rec) {
    const list = rec.ctxUnsubs || [];
    rec.ctxUnsubs = [];
    dropUnsubs(list);
  }

  function clearSubs(rec) {
    clearHostSubs(rec);
    clearCtxSubs(rec);
  }

  function dropActions(rec) {
    if (st.apiBind && typeof st.apiBind.unregisterPlugin === 'function') st.apiBind.unregisterPlugin(rec.id);
  }

  // ctx.api.register で預かった API を表へ入れる（先に入れた方が勝つ）
  function registerApiMethods(rec) {
    if (!st.apiBind || typeof st.apiBind.registerPluginMethod !== 'function' || !Array.isArray(rec.apiRegs)) return;
    const audience = rec.manifest && typeof rec.manifest.audience === 'string' ? rec.manifest.audience : 'public';
    for (const reg of rec.apiRegs) {
      const out = st.apiBind.registerPluginMethod(rec.id, reg.method, reg.options, reg.handler, { audience, modeGated: !!(rec.manifest && (rec.manifest.feature || (rec.manifest.api && rec.manifest.api.modeGated === true))), builtin: rec.source === 'set', roles: rec.manifest && Array.isArray(rec.manifest.provides) ? rec.manifest.provides.slice() : [] });
      if (!out || out.ok !== true) recLog(rec, 'warn', (out && out.error === 'taken' ? 'api-taken ' : 'api-rejected ' + (out && out.error ? out.error + ' ' : '')) + reg.method);
    }
  }

  function registerActions(rec) {
    if (!st.apiBind || typeof st.apiBind.registerPluginAction !== 'function') return;
    dropActions(rec);
    registerApiMethods(rec);
    const declared = rec.manifest && rec.manifest.actions;
    const exported = rec.instance && rec.instance.actions;
    if (!declared || typeof declared !== 'object' || !exported || typeof exported !== 'object') return;
    const names = Object.keys(declared);
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const fn = exported[name];
      if (typeof fn !== 'function') {
        log('warn', rec.id + ' action missing');
        continue;
      }
      st.apiBind.registerPluginAction(rec.id, name, declared[name], (params) => fn.call(rec.instance, params, rec.ctx));
    }
  }

  function attachApi(api) {
    st.apiBind = api || null;
    if (!st.apiBind) return;
    for (let i = 0; i < records.length; i += 1) {
      if (records[i].status === 'running') registerActions(records[i]);
    }
  }

  function registerSubscriptions(rec) {
    clearHostSubs(rec);
    const bus = opts.bus;
    if (!bus || rec.status !== 'running' || !rec.instance) return;
    const patterns = rec.manifest && Array.isArray(rec.manifest.subscribes) ? rec.manifest.subscribes : [];
    const timeoutMs = rec.manifest && rec.manifest.timeouts ? rec.manifest.timeouts.onEvent : undefined;
    rec.unsubs = [];
    for (const pattern of patterns) {
      const unsub = bus.subscribe(pattern, (name, payload, meta) => {
        if (!rec.instance || typeof rec.instance.onEvent !== 'function') return undefined;
        return rec.instance.onEvent(name, payload, meta);
      }, {
        pluginId: rec.id,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined
      });
      rec.unsubs.push(unsub);
    }
  }

  return {
    requiredMethods,
    clearSubs,
    dropActions,
    registerActions,
    attachApi,
    registerSubscriptions
  };
}

module.exports = { createWiring };
