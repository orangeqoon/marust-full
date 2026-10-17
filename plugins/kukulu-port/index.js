'use strict';

/**
 * Acquire the Kukulu slot the way NeonTimer ensureBroadcastActive does:
 * port_get then port_status=1 (kukulu.js lines 57 and 76).
 * Triggers: stream start when the title is not a sleep title, and a change
 * from a sleep title back to a non-sleep title. One acquire per stream start.
 * Sleep detection matches kukulu.js isSleepTitle (lines 131-146). This plugin
 * does not require kukulu-sleep.
 * legacy: no network and no shadow log. shadow: appendJsonl only. live: HTTP.
 * Connects only to https://live.erinn.biz and does not follow redirects.
 * provides stream.lifecycle@1 so the host may also call onObsEvent.
 */

const fs = require('fs');
const path = require('path');


const SECRET = 'kukulu.config';
const PLACEHOLDER = 'YOUR_KUKULU_APIKEY_HERE';
const ORIGIN = 'https://live.erinn.biz';
const MAX_SECRET = 262144;
const DEFAULT_SLEEP_WORDS = ['\u5bdd\u308b', '\u663c\u5bdd', 'sleeping', 'nap'];

function isSleepTitle(title, words) {
  if (!title || typeof title !== 'string') return false;
  const list = Array.isArray(words) ? words : DEFAULT_SLEEP_WORDS;
  const lower = title.toLowerCase();
  for (let i = 0; i < list.length; i += 1) {
    const kw = list[i];
    if (kw === 'nap') {
      if (/\b(nap|naps|napping)\b/i.test(title)) return true;
    } else if (kw === 'sleeping') {
      if (/sleep(ing)?/i.test(lower)) return true;
    } else if (typeof kw === 'string' && kw) {
      if (lower.includes(kw.toLowerCase())) return true;
    }
  }
  return false;
}

function normalizeWords(raw) {
  if (!Array.isArray(raw)) return DEFAULT_SLEEP_WORDS.slice();
  const out = [];
  for (let i = 0; i < raw.length && out.length < 32; i += 1) {
    if (typeof raw[i] !== 'string') continue;
    const word = raw[i].trim();
    if (!word || word.length > 40) continue;
    if (out.indexOf(word) === -1) out.push(word);
  }
  return out;
}

function createKukuluPort(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : function defaultFetch(url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return new Date(); };
  const gapMs = Number.isFinite(options.gapMs) && options.gapMs >= 0 ? options.gapMs : 1000;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;

  let ctx = null;
  let chain = Promise.resolve();
  let lastOp = 'none';
  let lastAt = '';
  let lastResult = 'none';
  let sleep = null;
  let words = DEFAULT_SLEEP_WORDS.slice();
  let phase = 'idle';
  let decided = false;
  let holding = false;
  let sawSleep = false;
  let currentId = '';

  function nowDate() {
    try {
      const value = nowFn();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date;
    } catch (err) { /* clock failure must not stop the judgment */ }
    return new Date();
  }

  function nowIso() {
    return nowDate().toISOString();
  }

  function say(level, message) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    try { ctx.logger(level, message); } catch (err) { /* ignore */ }
  }

  function modeOf() {
    try {
      const mode = ctx && typeof ctx.mode === 'function' ? ctx.mode() : 'legacy';
      if (mode === 'live' || mode === 'shadow' || mode === 'legacy') return mode;
    } catch (err) { /* unknown mode stays inside */ }
    return 'legacy';
  }

  function enqueue(work) {
    const job = chain.then(function () { return work(); });
    chain = job.then(function () {}, function () {});
    return job;
  }

  function wait(ms) {
    if (!ms) return Promise.resolve();
    return new Promise(function (resolve) { setTimer(resolve, ms); });
  }

  function resetStream() {
    phase = 'idle';
    decided = false;
    holding = false;
    sawSleep = false;
    currentId = '';
  }

  function readJson(file) {
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      if (text.length > 65536) return null;
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function reloadWords() {
    let config = null;
    try {
      if (ctx && ctx.config && typeof ctx.config === 'object' && !Array.isArray(ctx.config)) config = ctx.config;
    } catch (err) {
      config = null;
    }
    if (!config) {
      let dir = '';
      try { dir = ctx && ctx.dataDir ? ctx.dataDir : ''; } catch (err) { dir = ''; }
      if (typeof dir === 'string' && dir) config = readJson(path.join(dir, 'config.json'));
    }
    if (config && Object.prototype.hasOwnProperty.call(config, 'sleepWords')) words = normalizeWords(config.sleepWords);
    else words = DEFAULT_SLEEP_WORDS.slice();
  }

  function parseConfig(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_SECRET) return null;
    let data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (err) { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const apikey = typeof data.apikey === 'string' ? data.apikey.trim() : '';
    if (!apikey || apikey === PLACEHOLDER || apikey.length > 500 || /[\r\n\u0000]/.test(apikey)) return null;
    return { apikey: apikey };
  }

  async function readConfig() {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return null;
    let result;
    try { result = await ctx.secrets.get(SECRET); } catch (err) { return null; }
    if (!result || result.ok !== true || typeof result.value !== 'string') return null;
    return parseConfig(result.value);
  }

  function explicitTitle(payload) {
    const box = payload || {};
    if (typeof box.title === 'string') return box.title;
    if (box.metadata && typeof box.metadata.title === 'string') return box.metadata.title;
    return null;
  }

  function sessionTitle() {
    try {
      const view = ctx && ctx.sessions && typeof ctx.sessions.view === 'function' ? ctx.sessions.view() : null;
      if (view && typeof view.title === 'string') return view.title;
    } catch (err) { /* no session */ }
    return '';
  }

  function titleOf(payload) {
    const found = explicitTitle(payload);
    return found == null ? sessionTitle() : found;
  }

  function streamIdOf(payload) {
    const box = payload || {};
    if (typeof box.streamId === 'string' && box.streamId) return box.streamId;
    return '';
  }

  function noteStream(id) {
    if (id && currentId && id !== currentId) resetStream();
    if (id) currentId = id;
  }

  function endpoint(apikey, req) {
    const key = encodeURIComponent(apikey);
    if (req.type === 'port_get') {
      return ORIGIN + '/api/?category=mylive&type=port_get&apikey=' + key + '&eula=1';
    }
    return ORIGIN + '/api/?category=mylive&type=port_status&apikey=' + key + '&status=' + req.status;
  }

  async function call(url) {
    let parsed;
    try { parsed = new URL(url); } catch (err) { return { error: 'network' }; }
    const host = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || host !== 'live.erinn.biz') {
      return { error: 'network' };
    }
    const init = { method: 'GET', redirect: 'manual', cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(15000);
    }
    let res;
    try { res = await fetchImpl(url, init); } catch (err) { return { error: 'network' }; }
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (res && res.type === 'opaqueredirect') return { error: 'redirect', status: status };
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      return { error: 'redirect', status: status };
    }
    let text = '';
    try { if (res && typeof res.text === 'function') text = await res.text(); } catch (err) { text = ''; }
    if (typeof text !== 'string' || text.length > 1048576) return { error: 'network', status: status };
    return { status: status, text: text };
  }

  function note(op, ok) {
    lastOp = op;
    lastResult = ok ? 'ok' : 'ng';
    lastAt = nowIso();
  }

  async function perform(op, requests, title, isSleep) {
    sleep = isSleep;
    const mode = modeOf();
    if (mode === 'legacy') return { ok: true, skipped: 'legacy' };
    const config = await readConfig();
    if (!config) return { ok: true, skipped: 'not-configured' };
    if (mode === 'shadow') {
      let dir = '';
      try { dir = ctx.dataDir; } catch (err) { dir = ''; }
      const record = {
        at: nowIso(),
        op: op,
        sleep: isSleep === true,
        title: title,
        requests: requests.map(function (req) {
          const row = { category: 'mylive', type: req.type };
          if (req.type === 'port_get') row.eula = '1';
          if (req.status != null) row.status = req.status;
          return row;
        })
      };
      const wrote = ctx && ctx.log && typeof ctx.log.appendJsonl === 'function'
        ? ctx.log.appendJsonl('shadow', record, { now: nowDate() })
        : false;
      if (!wrote) {
        note(op, false);
        say('warn', 'shadow failed');
        return { ok: false, error: 'shadow' };
      }
      note(op, true);
      say('info', 'shadow ' + op);
      return { ok: true, dryRun: true };
    }
    for (let i = 0; i < requests.length; i += 1) {
      if (i > 0) await wait(gapMs);
      const res = await call(endpoint(config.apikey, requests[i]));
      if (res.error) {
        note(op, false);
        say('warn', 'failed ' + res.error);
        return { ok: false, error: res.error };
      }
      if (res.status !== 200) {
        note(op, false);
        say('warn', 'failed http');
        return { ok: false, error: 'http' };
      }
      let body = null;
      try { body = JSON.parse(res.text); } catch (err) { body = null; }
      if (!body || body.success !== 1) {
        note(op, false);
        say('warn', 'failed bad-response');
        return { ok: false, error: 'bad-response' };
      }
    }
    note(op, true);
    say('info', op);
    return { ok: true };
  }

  function held(result) {
    return !!(result && result.ok === true && result.skipped == null);
  }

  async function acquire(title) {
    const result = await perform('acquire', [
      { type: 'port_get' },
      { type: 'port_status', status: '1' }
    ], title, false);
    if (held(result)) holding = true;
    return result;
  }

  function begin(id) {
    if (id && currentId && id !== currentId) resetStream();
    if (phase === 'idle') {
      phase = 'live';
      if (id) currentId = id;
      decided = false;
      holding = false;
      sawSleep = false;
      return 'new';
    }
    return 'same';
  }

  async function handleStart(payload) {
    const id = streamIdOf(payload);
    const kind = begin(id);
    if (kind === 'same' && decided) return { ok: true };
    const title = titleOf(payload);
    const isSleep = isSleepTitle(title, words);
    sleep = isSleep;
    decided = true;
    if (isSleep) {
      sawSleep = true;
      return { ok: true };
    }
    if (holding) return { ok: true };
    sawSleep = false;
    return acquire(title);
  }

  async function handleTitle(payload) {
    noteStream(streamIdOf(payload));
    const title = titleOf(payload);
    const isSleep = isSleepTitle(title, words);
    const prev = payload && typeof payload.previousTitle === 'string' ? payload.previousTitle : '';
    if (!isSleep && prev && isSleepTitle(prev, words)) sawSleep = true;
    sleep = isSleep;
    if (isSleep) {
      sawSleep = true;
      holding = false;
      return { ok: true };
    }
    if (!sawSleep || holding) return { ok: true };
    const result = await acquire(title);
    if (holding) {
      sawSleep = false;
      decided = true;
      if (phase === 'idle') phase = 'live';
    }
    return result;
  }

  async function handle(name, payload) {
    if (!ctx) return { ok: true, skipped: 'not-ready' };
    reloadWords();
    if (name === 'stream.stopped') {
      resetStream();
      return { ok: true };
    }
    if (name === 'stream.starting' || name === 'stream.started') return handleStart(payload);
    if (name === 'stream.metadata.changed' || name === 'session.retitled') return handleTitle(payload);
    return { ok: true };
  }

  function onEvent(name, payload, meta) {
    void meta;
    return enqueue(function () { return handle(name, payload); });
  }

  function onObsEvent(output, titleBag, meta) {
    const state = output && output.outputState != null ? String(output.outputState) : '';
    if (state === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      return enqueue(function () {
        resetStream();
        return { ok: true };
      });
    }
    if (state !== 'OBS_WEBSOCKET_OUTPUT_STARTING' && state !== 'OBS_WEBSOCKET_OUTPUT_STARTED') {
      return { ok: true };
    }
    const payload = {};
    if (titleBag && typeof titleBag.title === 'string') payload.title = titleBag.title;
    return enqueue(function () { return handleStart(payload); });
  }

  async function panelStatus(params, passed) {
    void params;
    const previous = ctx;
    ctx = passed || ctx || null;
    try {
      reloadWords();
      const config = await readConfig();
      return {
        ok: true,
        configured: !!config,
        lastOp: lastOp,
        lastAt: lastAt,
        lastResult: lastResult,
        sleep: sleep,
        mode: modeOf()
      };
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    } finally {
      ctx = previous;
    }
  }

  function load(passed) {
    ctx = passed || null;
    resetStream();
    lastOp = 'none';
    lastAt = '';
    lastResult = 'none';
    sleep = null;
    reloadWords();
  }

  function start() {}

  function stop() {}

  function destroy() {
    ctx = null;
    resetStream();
    lastOp = 'none';
    lastAt = '';
    lastResult = 'none';
    sleep = null;
    words = DEFAULT_SLEEP_WORDS.slice();
  }

  function health() {
    return { ok: true, detail: 'kukulu-port' };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,
    onEvent: onEvent,
    onObsEvent: onObsEvent,
    isSleepTitle: function (title, list) {
      if (arguments.length >= 2) return isSleepTitle(title, list);
      return isSleepTitle(title, words);
    },
    actions: { getStatus: panelStatus }
  };
}

const singleton = createKukuluPort();
singleton.createKukuluPort = createKukuluPort;
singleton.isSleepTitle = isSleepTitle;
singleton.DEFAULT_SLEEP_WORDS = DEFAULT_SLEEP_WORDS.slice();
module.exports = singleton;