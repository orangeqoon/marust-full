'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const shell = path.join(__dirname, '..', 'shell');
function world(hidden) {
  let now = 0, serial = 0, rejectRead = false;
  const timers = new Map(), intervals = new Map(), subscriptions = new Set(), observers = new Set();
  const docEvents = {}, winEvents = {}, calls = [], held = [];
  let hold = false;
  function element() {
    return { dataset: {}, offsetParent: {}, isConnected: true, listeners: {},
      textContent: '', innerHTML: '', className: '', disabled: false,
      addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute() {},
      appendChild() {}, insertBefore() {}, querySelector() { return element(); } };
  }
  const roots = Object.fromEntries(['engine-status', 'emergency', 'secrets'].map(id => [id, element()]));
  const button = element();
  roots.emergency.querySelector = id => id === '#emergency-stop' ? button : element();
  const badge = element();
  const api = { subscribe(fn) { subscriptions.add(fn); return () => subscriptions.delete(fn); },
    call(method) {
      calls.push(method);
      const value = method === 'hub.getState' ? { permissions: ['read', 'emergency'], clientId: 'local-window', plugins: [], modeSummary: {} }
        : method === 'engine.status' ? { button: { label: 'Stop', color: 'green' } }
        : method === 'broadcast.stopAll' ? { ok: true } : { ok: true, secrets: [] };
      if (hold) return new Promise(resolve => held.push(() => resolve(value)));
      if (rejectRead) return Promise.reject(new Error('synthetic failure'));
      return Promise.resolve(value);
    }
  };
  const document = { hidden: !!hidden, body: element(),
    getElementById: id => id === 'mode-badge' ? badge : element(),
    querySelector: sel => roots[(sel.match(/data-panel="([^"]+)"/) || [])[1]],
    createElement: element, addEventListener: (n, fn) => { (docEvents[n] || (docEvents[n] = new Set())).add(fn); },
    removeEventListener: (n, fn) => { if (docEvents[n]) docEvents[n].delete(fn); } };
  const window = { marustApi: api, addEventListener: (n, fn) => { (winEvents[n] || (winEvents[n] = new Set())).add(fn); },
    removeEventListener: (n, fn) => { if (winEvents[n]) winEvents[n].delete(fn); } };
  const ctx = { document, window, Promise, console,
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval(fn, ms) { const id = ++serial; intervals.set(id, { fn, ms, at: now + ms }); return id; },
    clearInterval: id => intervals.delete(id),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { observers.add(this); } disconnect() { observers.delete(this); } },
    STR: { topBar: () => 'mode' }, noteDevMode() {}, notePermissions() {},
    confirmLiveWanted: false, devMode: false, obsConnected: false, obsLiveCount: 0,
    can: { emergency: true, write: true }, registerPanel() {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(shell, 'core/util.js'), 'utf8'), ctx);
  let hub = fs.readFileSync(path.join(shell, 'hub.js'), 'utf8');
  vm.runInContext(hub.slice(0, hub.indexOf('function initDevReload')), ctx);
  vm.runInContext(fs.readFileSync(path.join(shell, 'panels/emergency.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(shell, 'panels/secrets.js'), 'utf8'), ctx);
  async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
  async function tick(ms) {
    now += ms;
    for (const timer of intervals.values()) if (timer.at <= now) { timer.at = now + timer.ms; timer.fn(); }
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
  }
  return { ctx, calls, roots, button, badge, document, timers, intervals, subscriptions, observers,
    flush, tick, event(name) { for (const fn of subscriptions) fn({ name }); },
    mutate() { for (const ob of [...observers]) ob.fn(); },
    visibility(value) { document.hidden = value; for (const fn of docEvents.visibilitychange || []) fn(); },
    hold(value) { hold = value; }, release() { for (const fn of held.splice(0)) fn(); },
    fail(value) { rejectRead = value; }, dispose() { for (const fn of [...(winEvents.pagehide || [])]) fn({}); },
    boot() { ctx.initEngineStatus(); ctx.initModeBadge(); ctx.initEmergency(); ctx.initSecrets(); } };
}
async function main() {
  const w = world(false);
  w.boot(); await w.tick(100);
  assert.deepStrictEqual(w.calls.slice().sort(), ['engine.status', 'hub.getState', 'secrets.list'].sort(), 'concurrent display reads shared');
  assert.strictEqual(w.button.textContent, 'Stop');
  assert.strictEqual(Object.keys(w.ctx.displayReads).length, 0, 'responses are not cached after completion');
  const initial = w.calls.length;
  for (let i = 0; i < 100; i++) w.event('chat.message');
  await w.tick(100);
  assert.strictEqual(w.calls.length, initial, 'unrelated events cause no extra requests');
  for (let i = 0; i < 100; i++) w.event('modes.changed');
  await w.tick(100);
  assert.strictEqual(w.calls.length - initial, 3, 'event burst coalesces');
  w.hold(true); w.event('engine.target.changed'); await w.tick(100);
  const busy = w.calls.length;
  for (let i = 0; i < 100; i++) w.event('engine.target.changed');
  await w.tick(100);
  assert.strictEqual(w.calls.length, busy, 'no overlapping refresh');
  w.hold(false); w.release(); await w.flush(); await w.tick(100);
  assert.strictEqual(w.calls.length - busy, 2, 'one catch-up after busy');
  w.visibility(true);
  const beforeHidden = w.calls.length;
  w.event('modes.changed'); await w.tick(15000); await w.tick(100);
  assert.strictEqual(w.calls.length, beforeHidden, 'background has no display API polls');
  w.visibility(false); await w.tick(100);
  assert.strictEqual(w.calls.length - beforeHidden, 3, 'foreground catches up once');
  w.roots.secrets.offsetParent = null;
  const beforePanel = w.calls.filter(m => m === 'secrets.list').length;
  await w.tick(15000); await w.tick(100);
  assert.strictEqual(w.calls.filter(m => m === 'secrets.list').length, beforePanel, 'hidden panel skipped');
  w.roots.secrets.offsetParent = {}; w.mutate(); await w.tick(100);
  assert.strictEqual(w.calls.filter(m => m === 'secrets.list').length, beforePanel + 1, 'panel restore catches up');
  w.fail(true); w.event('modes.changed'); await w.tick(100);
  w.fail(false); w.event('modes.changed'); const beforeRecovery = w.calls.length; await w.tick(100);
  assert.ok(w.calls.length > beforeRecovery, 'failed read does not stick busy');
  // 停止操作は表示用タイマーを待たず直接呼ぶ。隠した窓でも操作経路を変更しない。
  w.visibility(true); const beforeStop = w.calls.length;
  w.button.listeners.click(); await w.flush();
  assert.strictEqual(w.calls[beforeStop], 'broadcast.stopAll');
  w.ctx.can.emergency = false;
  const denied = w.calls.length; w.button.listeners.click(); await w.flush();
  assert.strictEqual(w.calls.length, denied, 'permission check retained');
  w.dispose(); const disposed = w.calls.length;
  assert.strictEqual(w.intervals.size, 0); assert.strictEqual(w.observers.size, 0);
  assert.strictEqual(w.timers.size, 0);
  assert.strictEqual(w.subscriptions.size, 0, 'display subscriptions released');
  await w.tick(30000); w.event('modes.changed'); await w.tick(100);
  assert.strictEqual(w.calls.length, disposed);
  const hidden = world(true); hidden.boot(); await hidden.tick(15100);
  assert.strictEqual(hidden.calls.length, 0, 'initially hidden window does not read');
  hidden.visibility(false); await hidden.tick(100);
  assert.strictEqual(hidden.calls.length, 3);
  hidden.dispose();
  console.log('P2 display refresh: sharing/burst/filter/inflight/visibility/panel/error/stop/cleanup PASS');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
