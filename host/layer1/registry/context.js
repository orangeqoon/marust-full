'use strict';

/**
 * 登録簿の部品: 登録簿の ctx（プラグインに渡す口）の組み立て（計画 X・S8b。host/core/plugin-registry.js から機械的に移した。動きは変えていない）。
 * S は host/core/plugin-registry.js の createRegistry が作る道具箱（共有の状態 st・opts・records など）。他の部品の関数は S.fn から呼ぶ。
 */

const path = require('path');
const { run, redact } = require('../../core');
const { appendJsonl } = require('../../core');
const auditFields = require('../audit-fields');
const { EVENTS, ownerOf } = require('../../core');
const { safeSecretError } = require('../../core');
const { checkPluginMethod } = require('../plugin-api-check');
const { subscribeCovered, sanitizeOverlayValues, normalizePanels } = require('../plugin-surface');
const { gateCtx, strictNeeds } = require('./ctx-ports');

function loadPluginLayers() {
  try {
    return require('../plugin-layers.json');
  } catch (_) {
    return { layer1: [], layer2: [] };
  }
}

const pluginLayers = loadPluginLayers();

function isThirdLayer(pluginId, source, community) {
  if (source === 'user' || community === true) return true;
  if (source !== 'set') return true;
  const l1 = Array.isArray(pluginLayers.layer1) ? pluginLayers.layer1 : [];
  const l2 = Array.isArray(pluginLayers.layer2) ? pluginLayers.layer2 : [];
  if (l1.indexOf(pluginId) !== -1 || l2.indexOf(pluginId) !== -1) return false;
  const m = /^(site|sink|slot)-([a-z0-9-]+)$/.exec(pluginId);
  if (m && l1.indexOf(m[2]) !== -1) return false;
  return true;
}

function canStartBroadcast(rec) {
  if (!rec) return false;
  return !isThirdLayer(rec.id, rec.source, rec.community);
}

function isStartBroadcastCall(method, params) {
  if (method === 'broadcast.start' || method === 'engine.start' || method === 'destination.start') return true;
  if (method === 'destination.setMain' && (!params || params.use === true)) return true;
  return false;
}

// site.trouble（サイトの困りごと）の形。{ site, job, kind, code?, at? }。決まった値でなければ断る（L9b）
const TROUBLE_JOBS = ['slot', 'title', 'comment'];
const TROUBLE_KINDS = ['login-expired', 'rate-limited', 'unreachable', 'failed'];
function validSiteTrouble(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.site !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(payload.site)) return false;
  if (TROUBLE_JOBS.indexOf(payload.job) === -1) return false;
  if (TROUBLE_KINDS.indexOf(payload.kind) === -1) return false;
  if (payload.code != null && !(typeof payload.code === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(payload.code))) return false;
  return true;
}

function createContext(S) {
  const { opts, core, records, byId, events, overlayHub, secretProvider, modeFor, sessionsNow, appInfo, openExternalImpl, keysPort, chatNow, obsRead, obsControl, log, boxLog, recLog, inactiveSession, ensureDataDir, dataDirName, manifestCopy, isController, isChatSource, st } = S;
  const register = (...args) => S.fn.register(...args);
  const registerActions = (...args) => S.fn.registerActions(...args);
  const release = (...args) => S.fn.release(...args);



  function publicDestination(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const engine = row.engine && typeof row.engine === 'object' && !Array.isArray(row.engine) ? row.engine : null;
    const actual = row.actual && typeof row.actual === 'object' && !Array.isArray(row.actual) ? row.actual : {};
    return {
      id: row.id == null ? '' : String(row.id),
      site: row.site == null ? '' : String(row.site),
      accountId: row.accountId == null ? '' : String(row.accountId),
      enabled: row.enabled === true,
      engine: { id: engine && engine.id != null ? String(engine.id) : '' },
      actual: {
        engineState: actual.engineState == null ? '' : String(actual.engineState),
        siteLive: actual.siteLive === true
      },
      keyTail: (typeof row.keyTail === 'string' || row.keyTail === null) ? row.keyTail : null
    };
  }

  function listDestinations() {
    const store = opts.store;
    if (!store || typeof store.snapshot !== 'function') return { ok: false, error: 'unavailable' };
    let snap;
    try {
      snap = store.snapshot();
    } catch (_) {
      return { ok: false, error: 'unavailable' };
    }
    const rows = snap && Array.isArray(snap.destinations) ? snap.destinations : [];
    const destinations = [];
    for (let i = 0; i < rows.length; i += 1) {
      const pub = publicDestination(rows[i]);
      if (pub) destinations.push(pub);
    }
    return { ok: true, destinations: destinations };
  }

  // 読むだけの OBS の口。GetStreamStatus しか渡さず、失敗は null に潰す。
  function makeObsRead() {
    function getStreamStatus() {
      return Promise.resolve()
        .then(() => obsRead('GetStreamStatus'))
        .catch(() => null);
    }
    async function isStreaming() {
      try {
        const status = await getStreamStatus();
        return !!(status && status.outputActive === true);
      } catch (_) {
        return false;
      }
    }
    return Object.freeze({ getStreamStatus, isStreaming });
  }

  let stoppingActive = false;
  if (opts && opts.bus && typeof opts.bus.subscribe === 'function') {
    opts.bus.subscribe(EVENTS.STREAM_STOPPING, () => { stoppingActive = true; });
    opts.bus.subscribe(EVENTS.BROADCAST_STOPPED, () => { stoppingActive = false; });
  }

  function isStoppingNow() {
    if (opts && typeof opts.isStopping === 'function') {
      try { if (opts.isStopping() === true) return true; } catch (_) {}
    }
    if (opts && opts.broadcast && typeof opts.broadcast.isStopping === 'function') {
      try { if (opts.broadcast.isStopping() === true) return true; } catch (_) {}
    }
    return stoppingActive === true;
  }

  // 配信全体の開始・停止。needs に obs.streamControl があり、obsControl が渡っているときだけ。
  // obs.read は要らない。base が無いときは streamControl だけを渡す。
  // さらにそのプラグイン自身が live のときだけ通す（shadow・legacy は止める・始めるをしない）。
  function makeObsStreamControl(rec, base, modeOf) {
    async function streamControl(input) {
      const action = input && input.action;
      // 'check' は OBS を動かさず、今この口が使えるか（プラグインが live で、画面の OBS 操作がオンか）だけを確かめる。
      if (action !== 'start' && action !== 'stop' && action !== 'check') return { ok: false, error: 'bad-action' };
      if (modeOf() !== 'live') return { ok: false, error: 'not-live' };
      if (action === 'start') {
        if (isStoppingNow()) return { ok: false, error: 'stopping' };
        if (!canStartBroadcast(rec)) return { ok: false, error: 'layer3-no-start' };
      }
      try {
        await obsControl(action);
        return { ok: true };
      } catch (err) {
        const code = err && typeof err.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(err.code) ? err.code : '';
        if (err && (err.message === 'obs-control-off' || err.message === 'human-stopped' || err.message === 'stopping')) return { ok: false, error: err.message };
        return { ok: false, error: code === 'OBS_NOT_CONNECTED' ? 'obs-not-connected' : 'failed' };
      }
    }
    const row = { streamControl: streamControl };
    if (base && typeof base.getStreamStatus === 'function') row.getStreamStatus = base.getStreamStatus;
    if (base && typeof base.isStreaming === 'function') row.isStreaming = base.isStreaming;
    return Object.freeze(row);
  }

  function makeCtx(rec) {
    if (rec.ctx) return rec.ctx;
    const generation = {};
    const manifest = manifestCopy(rec.manifest);
    let dataDirPath = '';
    const subscribes = Array.isArray(manifest.subscribes) ? manifest.subscribes : [];
    rec.ctxUnsubs = rec.ctxUnsubs || [];
    const apiDecl = manifest.api ? manifest.api : null;
    const apiNamespaces = apiDecl && Array.isArray(apiDecl.namespaces) ? apiDecl.namespaces : [];
    const apiCalls = apiDecl && Array.isArray(apiDecl.calls) ? apiDecl.calls : [];
    const ctx = {
      id: rec.id,
      core,
      pluginDir: rec.dir,
      manifest,
      get dataDir() {
        if (!dataDirPath) dataDirPath = ensureDataDir(dataDirName(rec));
        return dataDirPath;
      },
      logger: (level, message) => {
        boxLog(rec, level, redact(message));
        log(level, rec.id + ' ' + redact(message));
      },
      // 秘密らしい値を伏せた文字列にする（本体のログと同じ規則。プラグインが本体のファイルを require せずに使う。V6）
      redact: (text) => redact(text),
      // 日付ごとの JSONL 追記（K2）。書く先は核が決める（そのプラグインの dataDir）。プラグインはファイル名の頭だけ渡す。
      // options は now だけ通す（maxBytes は核が決める）
      log: Object.freeze({
        appendJsonl: (name, row, options) => {
          if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) return false;
          let dir = '';
          try { dir = ctx.dataDir; } catch (_) { return false; }
          const now = options && typeof options === 'object' ? options.now : undefined;
          return appendJsonl(dir, name, row, now === undefined ? undefined : { now: now });
        }
      }),
      // 監査の行の形（核が 1 か所で決める。凍結した写し）と、核の記録（logs/marust の shadow）への追記。
      // 追記は内蔵・作者用のうち「題名の一斉変更の係」（provides に title.fanout@1）だけ（K2 評価 Should 2）
      audit: Object.freeze({
        fields: Object.freeze({ localIso: auditFields.localIso, clipField: auditFields.clipField, summarizeSites: auditFields.summarizeSites }),
        append: (record) => {
          if (!core || !core.STATE_DIR) return false;
          if (!Array.isArray(manifest.provides) || manifest.provides.indexOf('title.fanout@1') === -1) return false;
          return appendJsonl(path.join(core.STATE_DIR, 'logs', 'marust'), 'shadow', record);
        }
      }),
      // イベント名の一覧（凍結）
      events: Object.freeze({ NAMES: EVENTS }),
      // 丸ストの版と配布ページ（凍結・読むだけ。K3）。外から入れたものには出さない（下で消す）
      app: Object.freeze({ version: String(appInfo.version || ''), releasesRepo: String(appInfo.releasesRepo || '') }),
      emit: (eventName, payload) => {
        events.push({ id: rec.id, eventName, payload, at: Date.now() });
      },
      mode() {
        let value = '';
        try {
          value = modeFor ? modeFor(rec.id) : (manifest.defaultMode || 'legacy');
        } catch (_) {
          value = 'legacy';
        }
        if (value === 'legacy' || value === 'shadow' || value === 'live') return value;
        return 'legacy';
      },
      bus: {
        publish(name, payload, info) {
          const extra = info && typeof info === 'object' ? info : {};
          const correlationId = extra.correlationId == null ? '' : String(extra.correlationId);
          // site.trouble（サイトの困りごと。ホームの赤い 1 行・Discord 通知の元）は、どのプラグインでも出せる（L9b）。形が決まった値でなければ断る
          if (name === 'site.trouble' && !validSiteTrouble(payload)) {
            log('warn', rec.id + ' site.trouble refused');
            return 0;
          }
          // 持ち主のあるイベント（session.* など）は持ち主のプラグインだけ（K3）。違えば捨てて、そのプラグインのログに 1 行
          const eventOwner = ownerOf(name);
          if (eventOwner && eventOwner !== rec.id) {
            recLog(rec, 'warn', 'event owner refused ' + String(name).slice(0, 60));
            return 0;
          }
          if (!opts.bus || typeof opts.bus.publish !== 'function') return 0;
          return opts.bus.publish(name, payload, { source: rec.id, correlationId: correlationId });
        },
        subscribe(pattern, handler) {
          if (!subscribeCovered(subscribes, pattern) || typeof handler !== 'function') {
            log('warn', rec.id + ' subscribe refused');
            return null;
          }
          if (!opts.bus || typeof opts.bus.subscribe !== 'function') {
            log('warn', rec.id + ' subscribe refused');
            return null;
          }
          const timeoutMs = manifest.timeouts ? manifest.timeouts.onEvent : undefined;
          const unsub = opts.bus.subscribe(pattern, handler, {
            pluginId: rec.id,
            timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined
          });
          rec.ctxUnsubs.push(unsub);
          return unsub;
        }
      },
      sessions: {
        view() {
          const port = sessionsNow();
          if (typeof port.view !== 'function') return inactiveSession();
          return port.view();
        },
        start(input) {
          if (!isController(manifest)) return { ok: false, error: 'not-controller' };
          const port = sessionsNow();
          if (typeof port.start !== 'function') return { ok: false, error: 'unavailable' };
          return port.start(input);
        },
        pause() {
          if (!isController(manifest)) return { ok: false, error: 'not-controller' };
          const port = sessionsNow();
          if (typeof port.pause !== 'function') return { ok: false, error: 'unavailable' };
          return port.pause();
        },
        resume() {
          if (!isController(manifest)) return { ok: false, error: 'not-controller' };
          const port = sessionsNow();
          if (typeof port.resume !== 'function') return { ok: false, error: 'unavailable' };
          return port.resume();
        },
        end(input) {
          if (!isController(manifest)) return { ok: false, error: 'not-controller' };
          const port = sessionsNow();
          if (typeof port.end !== 'function') return { ok: false, error: 'unavailable' };
          return port.end(input);
        },
        retitle(title) {
          if (!isController(manifest)) return { ok: false, error: 'not-controller' };
          const port = sessionsNow();
          if (typeof port.retitle !== 'function') return { ok: false, error: 'unavailable' };
          return port.retitle(title);
        }
      },
      secrets: {
        get(name) {
          // L8g: 宣言していない名前も get できる（悪意への守りは外した。set だけ宣言を見る）
          if (typeof name !== 'string') {
            return Promise.resolve({ ok: false, error: 'bad-name' });
          }
          return Promise.resolve()
            .then(() => secretProvider.getFor(rec.id, name))
            .then((result) => {
              if (!result || result.ok !== true || typeof result.value !== 'string') {
                return { ok: false, error: safeSecretError(result && result.error) };
              }
              return { ok: true, value: result.value };
            })
            .catch(() => ({ ok: false, error: 'unavailable' }));
        },
        has(name) {
          if (typeof name !== 'string') {
            return Promise.resolve({ ok: false, error: 'bad-name' });
          }
          if (typeof secretProvider.hasFor === 'function') {
            return Promise.resolve()
              .then(() => secretProvider.hasFor(rec.id, name))
              .then((result) => {
                if (!result || result.ok !== true) {
                  return { ok: false, error: safeSecretError(result && result.error) };
                }
                return { ok: true, has: result.has === true };
              })
              .catch(() => ({ ok: false, error: 'unavailable' }));
          }
          return Promise.resolve({ ok: false, error: 'unavailable' });
        },
        set(name, value) {
          const allowed = Array.isArray(manifest.secrets) ? manifest.secrets : [];
          if (typeof name !== 'string' || allowed.indexOf(name) === -1) {
            return Promise.resolve({ ok: false, error: 'not-declared' });
          }
          if (typeof secretProvider.set !== 'function') {
            return Promise.resolve({ ok: false, error: 'unavailable' });
          }
          return Promise.resolve()
            .then(() => secretProvider.set(name, value, rec.id))
            .then((result) => {
              if (!result || result.ok !== true) {
                return { ok: false, error: safeSecretError(result && result.error) };
              }
              return { ok: true };
            })
            .catch(() => ({ ok: false, error: 'unavailable' }));
        }
      },
      overlay: {
        publish(name, values) {
          const overlays = Array.isArray(manifest.overlays) ? manifest.overlays : [];
          let found = null;
          for (let i = 0; i < overlays.length; i += 1) {
            if (overlays[i].name === name) found = overlays[i];
          }
          if (!found) {
            log('warn', rec.id + ' overlay unknown');
            return { ok: false, error: 'unknown-overlay' };
          }
          const clean = sanitizeOverlayValues(found.fields, values);
          overlayHub.publish(rec.id, name, clean);
          return { ok: true, values: clean };
        }
      },
      chat: {
        ingest(message) {
          if (!isChatSource(manifest)) return { ok: false, error: 'not-chat-source' };
          const inlet = chatNow();
          if (typeof inlet.ingest !== 'function') return { ok: false, error: 'unavailable' };
          return inlet.ingest(message, { source: rec.id });
        },
        // 「このサイトのコメントは自分が受け取っている」と宣言する（manifest の chatSource に書いたサイトだけ）。
        // 宣言している間、ほかの入り口から来た同じサイトのコメントは取り込まれない。受け取れなくなったら release する。
        claim(site) {
          if (!isChatSource(manifest) || manifest.chatSource !== site) return { ok: false, error: 'not-chat-source' };
          const inlet = chatNow();
          if (typeof inlet.claim !== 'function') return { ok: false, error: 'unavailable' };
          return inlet.claim(site, rec.id);
        },
        release(site) {
          if (!isChatSource(manifest) || manifest.chatSource !== site) return { ok: false, error: 'not-chat-source' };
          const inlet = chatNow();
          if (typeof inlet.release !== 'function') return { ok: false, error: 'unavailable' };
          return inlet.release(site, rec.id);
        }
      },
      destinations: {
        list() {
          return listDestinations();
        },
        // 配信先の集計（読むだけ・凍結した写し）。ready は OBS エンジンが最初の同期を終えたか。セッションが起動時に自分で回復する（K3）
        aggregate() {
          const fn = opts.aggregate;
          let row = null;
          try { row = typeof fn === 'function' ? fn() : null; } catch (_) { row = null; }
          if (!row || typeof row !== 'object') return Object.freeze({ ready: false, known: false, streaming: false, emergency: false, anyOutputLive: false });
          return Object.freeze({
            ready: row.ready === true,
            known: row.known === true,
            streaming: row.streaming === true,
            emergency: row.emergency === true,
            anyOutputLive: row.anyOutputLive === true
          });
        }
      }
    };
    // 読む口は obs.read と obsRead、開始・停止は obs.streamControl と obsControl。片方だけでも渡す。
    const obsNeeds = Array.isArray(manifest.needs) ? manifest.needs : [];
    const wantObsRead = !!(obsRead && obsNeeds.indexOf('obs.read') !== -1);
    const wantObsControl = !!(obsControl && obsNeeds.indexOf('obs.streamControl') !== -1);
    if (wantObsRead || wantObsControl) {
      const read = wantObsRead ? makeObsRead() : null;
      ctx.obs = wantObsControl ? makeObsStreamControl(rec, read, () => ctx.mode()) : read;
    }
    // api.namespaces か api.calls を宣言したプラグインに ctx.api を渡す（V1・V2-1。L8d で出どころ制限解除）。登録は load〜start の間だけ。表に入るのは running になったとき（registerActions）。
    if (apiDecl) {
      ctx.api = {
        // 本体の API を呼ぶ（V2-1）。manifest の api.calls に書いた名前だけ。権限・検査・開発者モードの門・監査は本体の dispatch のまま
        call(method, params) {
          if (apiCalls.indexOf(method) === -1) return Promise.resolve({ ok: false, error: 'not-declared' });
          if (rec.ctxGeneration !== generation || rec.ctx == null || !rec.instance) return Promise.resolve({ ok: false, error: 'plugin-stopped' });
          if (isStartBroadcastCall(method, params)) {
            if (isStoppingNow()) return Promise.resolve({ ok: false, error: 'stopping' });
            if (!canStartBroadcast(rec)) return Promise.resolve({ ok: false, error: 'layer3-no-start' });
          }
          if (!st.apiBind || typeof st.apiBind.callAs !== 'function') return Promise.resolve({ ok: false, error: 'unavailable' });
          return Promise.resolve(st.apiBind.callAs(rec.id, method, params, { titleReserved: reservedHolder() === rec.id })).catch(() => ({ ok: false, error: 'failed' }));
        },
        register(method, handler, options) {
          if (!rec.apiOpen) return { ok: false, error: 'register-closed' };
          const ns = typeof method === 'string' ? method.split('.')[0] : '';
          if (apiNamespaces.indexOf(ns) === -1) return { ok: false, error: 'undeclared-namespace' };
          const checked = checkPluginMethod(rec.id, method, options, handler);
          if (!checked.ok) return { ok: false, error: checked.error };
          if (rec.apiRegs.some((row) => row.method === method)) return { ok: false, error: 'taken' };
          const safe = (err) => redact(String(err && err.message ? err.message : err)).slice(0, 200);
          rec.apiRegs.push({
            method,
            options: Object.assign({}, options),
            handler: async (params, info) => {
              try {
                return await handler.call(rec.instance, params, info);
              } catch (err) {
                boxLog(rec, 'error', 'api-error ' + method + ' ' + safe(err));
                log('error', rec.id + ' api-error ' + method);
                return { ok: false, error: 'failed' };
              }
            }
          });
          return { ok: true };
        }
      };
    }
    // ctx.peers（V2-10）: サイトの決まったメソッドだけ。宣言（manifest の peers.methods）が無ければ list は空・run は peer-denied。
    // 役目の合う相手か・モードで送らないか・列の扱いは本体（opts.peers = orchestrator の peerList / peerRun）が決める。L8d で出どころ制限解除。
    const peerMethods = manifest.peers && Array.isArray(manifest.peers.methods) ? manifest.peers.methods : [];
    const peerHost = opts.peers && typeof opts.peers.list === 'function' && typeof opts.peers.run === 'function' ? opts.peers : null;
    ctx.peers = Object.freeze({
      list() {
        if (!peerMethods.length || !peerHost || rec.ctxGeneration !== generation || rec.ctx == null) return [];
        try { return peerHost.list(rec.id) || []; } catch (_) { return []; }
      },
      run(id, method, args, runOpts) {
        const denied = (message) => Promise.resolve({ id: typeof id === 'string' ? id : '', result: 'error', elapsedMs: 0, message });
        if (peerMethods.indexOf(method) === -1 || rec.ctxGeneration !== generation || rec.ctx == null || !rec.instance) return denied('peer-denied');
        if (!peerHost) return denied('unavailable');
        return Promise.resolve(peerHost.run(rec.id, id, method, Array.isArray(args) ? args : [], runOpts)).catch(() => ({ id: String(id), result: 'error', elapsedMs: 0, message: 'failed' }));
      }
    });
    // 使っているブラウザで URL を開く口（K3）。needs に external.open を書いたものだけ。https で、manifest の external.hosts に書いた名前のどれかのときだけ（他は bad-url）。
    // 開くのは核（shell.openExternal）。丸ストの中では開かない。
    if (coreBuiltin(rec) && Array.isArray(manifest.needs) && manifest.needs.indexOf('external.open') !== -1) {
      const hosts = manifest.external && Array.isArray(manifest.external.hosts)
        ? manifest.external.hosts.filter((h) => typeof h === 'string' && /^[a-z0-9.-]{1,100}$/.test(h)).slice(0, 10)
        : [];
      ctx.external = Object.freeze({
        open(url) {
          let parsed = null;
          try { parsed = new URL(String(url)); } catch (_) { parsed = null; }
          if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || hosts.indexOf(parsed.hostname) === -1) {
            return Promise.reject(Object.assign(new Error('bad-url'), { code: 'bad-url' }));
          }
          if (!openExternalImpl) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
          return Promise.resolve(openExternalImpl(parsed.toString()));
        }
      });
    }
    // プラグインの動いている／モードの読みだけの口（K3）。provides に chat.inlet@1 を持つものだけ
    if (coreBuiltin(rec) && Array.isArray(manifest.provides) && manifest.provides.indexOf('chat.inlet@1') !== -1) {
      ctx.pluginStates = Object.freeze({
        isRunning: (id) => records.some((r) => r.id === id && r.status === 'running'),
        modeOf: (id) => { try { return modeFor ? modeFor(id) : 'legacy'; } catch (_) { return 'legacy'; } }
      });
    }
    // キーの口（K3）。検査も押下の実行も核（host/layer1/keys-port.js）。深く凍結して渡す
    // 持ち主はセットのうち needs に keys を書いた最初の 1 つだけ。自分で足したものは書けても持てない（計画 C・C2-2）
    if (coreBuiltin(rec) && Array.isArray(manifest.needs) && manifest.needs.indexOf('keys') !== -1 && builtinHolder('keys') === rec.id) {
      const gone = () => Promise.resolve({ ok: false, error: 'unavailable' });
      ctx.keys = Object.freeze({
        reload: () => { const p = keysPort(); return p && typeof p.reload === 'function' ? Promise.resolve(p.reload()).catch(() => ({ ok: false, error: 'failed' })) : gone(); },
        save: (bindings) => { const p = keysPort(); return p && typeof p.save === 'function' ? Promise.resolve(p.save(bindings)).catch(() => ({ ok: false, error: 'failed' })) : gone(); },
        list: () => { const p = keysPort(); return p && typeof p.list === 'function' ? p.list() : { ok: false, error: 'unavailable' }; },
        release: () => { const p = keysPort(); return p && typeof p.release === 'function' ? p.release() : { ok: false, error: 'unavailable' }; }
      });
    }
    // 画面を 1 枚足す（C5-3）。manifest の写しは凍ったまま。生きている manifest に足すので、次の一覧で見える。
    ctx.ui = Object.freeze({
      panel(spec) {
        const rows = normalizePanels([spec], (message) => log('warn', rec.id + ' ' + message));
        if (rows.length !== 1) return { ok: false, error: 'bad-panel' };
        const row = rows[0];
        if (!Array.isArray(rec.manifest.panels)) rec.manifest.panels = [];
        if (rec.manifest.panels.some((panel) => panel && panel.name === row.name)) return { ok: false, error: 'taken' };
        rec.manifest.panels.push(row);
        return { ok: true, name: row.name };
      }
    });
    rec.ctxGeneration = generation;
    rec.ctxHostLogger = ctx.logger;
    rec.ctx = gateCtx(ctx, { manifest: manifest, id: rec.id, log: log, strict: strictNeeds(manifest) });
    return rec.ctx;
  }

  // 出どころで渡す力を変える作り（Q14）はやめ、宣言した口は出どころに関係なく渡す（L8d）。
  // ただしひとつしか持てない口（keys・title.reserved）の持ち主はセットだけ（計画 C・C2-2）。
  function coreBuiltin(rec) { return !!rec; }
  function builtinHolder(need) {
    const predicate = (r) => r.source === 'set' && byId.get(r.id) === r && r.manifest && Array.isArray(r.manifest.needs) && r.manifest.needs.indexOf(need) !== -1;
    const holder = records.find(predicate);
    return holder ? holder.id : '';
  }
  function reservedHolder() { return builtinHolder('title.reserved'); }

  return {
    makeCtx
  };
}

module.exports = { createContext, isThirdLayer, canStartBroadcast, isStartBroadcastCall };
