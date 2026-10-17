'use strict';

const M = require('../../../_marust');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTimer } = require(path.join(__dirname, '..', '..', 'timer'));
const { createRegistry } = require(M.at('host/layer1/plugin-registry'));

const ROOT = M.root; // 丸スト本体
const COMMUNITY = path.join(__dirname, '..', '..'); // みんなのプラグインの plugins/
const MAX_SEC = 24 * 60 * 60;
const LEGACY_NOTICE = 'legacy: 記録・題名送信はしません';

let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marust-timer-'));
}

function clock() {
  let now = 1000000;
  let timer = null;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    setInterval(fn, delay) {
      timer = { fn: fn, delay: delay, id: 1 };
      return 1;
    },
    clearInterval() { timer = null; },
    tick() { if (timer) timer.fn(); },
    delay() { return timer ? timer.delay : null; }
  };
}

function harness(options) {
  const opt = options || {};
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const calls = [];
  const overlays = [];
  let active = !!opt.active;
  const time = clock();
  const ctx = {
    id: 'timer',
    dataDir: dir,
    core: opt.core || {},
    manifest: { id: 'timer' },
    logger() {},
    mode() { return opt.mode || 'live'; },
    sessions: {
      view() {
        if (typeof opt.view === 'function') return opt.view();
        if (!active) return { active: false, title: '', state: 'none', elapsedMs: 0 };
        return { active: true, title: 'other', state: 'running', elapsedMs: 1 };
      },
      start(input) {
        calls.push({ op: 'start', input: input });
        if (typeof opt.onStart === 'function') return opt.onStart(input, active);
        if (active) return { ok: false, reason: 'session-active' };
        active = true;
        return { ok: true, session: { title: input.title } };
      },
      end() {
        calls.push({ op: 'end', argc: arguments.length });
        if (typeof opt.onEnd === 'function') return opt.onEnd();
        active = false;
        return { ok: true };
      }
    },
    overlay: {
      publish(name, values) {
        overlays.push({ name: name, values: Object.assign({}, values) });
        return { ok: true, values: values };
      }
    }
  };
  const timer = createTimer({
    now: time.now,
    setInterval: time.setInterval,
    clearInterval: time.clearInterval
  });
  timer.load(ctx);
  return { dir: dir, ctx: ctx, timer: timer, calls: calls, overlays: overlays, time: time };
}

function keysOf(values) {
  return Object.keys(values);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(COMMUNITY, 'timer', 'manifest.json'), 'utf8'));
  const fields = manifest.overlays[0].fields.slice();

  await test('manifest v2 declares controller, panel, overlay, actions', async () => {
    assert.strictEqual(manifest.id, 'timer');
    assert.strictEqual(manifest.version, '1.0.0');
    assert.strictEqual(manifest.manifestVersion, 2);
    assert.strictEqual(manifest.runtime, 'inproc');
    assert.strictEqual(manifest.kind, 'ui');
    assert.strictEqual(manifest.defaultMode, 'legacy');
    assert.deepStrictEqual(manifest.provides, ['session.controller@1', 'ui.panel@1']);
    assert.deepStrictEqual(manifest.actions, {
      getState: 'read',
      setMode: 'write',
      setDuration: 'write',
      setPreset: 'write',
      start: 'write',
      startPreset: 'write',
      stop: 'write',
      reset: 'write',
      setTitle: 'write'
    });
    assert.strictEqual(manifest.panels[0].name, 'clock');
    assert.strictEqual(manifest.panels[0].file, 'ui/clock.html');
    assert.strictEqual(manifest.overlays[0].name, 'clock');
    assert.strictEqual(manifest.overlays[0].file, 'overlay/clock.html');
    assert.deepStrictEqual(fields, ['display', 'remainingSec', 'elapsedSec', 'mode', 'state', 'title']);
  });

  await test('live start and stop call sessions; legacy does not', async () => {
    const live = harness({ mode: 'live' });
    try {
      live.timer.actions.setTitle({ title: '配信', category: 'games' }, live.ctx);
      live.timer.actions.setDuration({ seconds: 90 }, live.ctx);
      const started = live.timer.actions.start({}, live.ctx);
      assert.strictEqual(started.ok, true);
      assert.strictEqual(started.running, true);
      assert.strictEqual(live.calls.length, 1);
      assert.strictEqual(live.calls[0].op, 'start');
      assert.deepStrictEqual(live.calls[0].input, {
        title: '配信',
        category: 'games',
        plannedSec: 90,
        source: 'timer'
      });
      live.time.advance(2000);
      live.timer.actions.stop({}, live.ctx);
      assert.strictEqual(live.calls.length, 2);
      assert.strictEqual(live.calls[1].op, 'end');
      assert.strictEqual(live.calls[1].argc, 0);
      const again = live.timer.actions.start({}, live.ctx);
      assert.strictEqual(again.elapsedSec, 2);
      assert.strictEqual(live.calls[2].input.plannedSec, 88);
      assert.strictEqual(live.calls[2].input.source, 'timer');
    } finally {
      rimraf(live.dir);
    }

    const shadow = harness({ mode: 'shadow' });
    try {
      shadow.timer.actions.start({ title: '影', category: '' }, shadow.ctx);
      assert.strictEqual(shadow.calls[0].input.source, 'timer');
      assert.strictEqual(shadow.calls[0].input.title, '影');
      shadow.timer.actions.stop({}, shadow.ctx);
      assert.strictEqual(shadow.calls[1].op, 'end');
    } finally {
      rimraf(shadow.dir);
    }

    const legacy = harness({ mode: 'legacy' });
    try {
      const started = legacy.timer.actions.start({ title: '記録しない', category: 'x' }, legacy.ctx);
      assert.strictEqual(started.ok, true);
      assert.strictEqual(started.running, true);
      assert.strictEqual(started.notice, LEGACY_NOTICE);
      legacy.time.advance(3000);
      const mid = legacy.timer.actions.getState({}, legacy.ctx);
      assert.strictEqual(mid.elapsedSec, 3);
      legacy.timer.actions.stop({}, legacy.ctx);
      assert.strictEqual(legacy.calls.length, 0);
      legacy.timer.actions.setDuration({ seconds: 4 }, legacy.ctx);
      legacy.timer.actions.start({}, legacy.ctx);
      legacy.time.advance(4000);
      const rolled = legacy.timer.actions.getState({}, legacy.ctx);
      assert.strictEqual(rolled.mode, 'countup');
      assert.strictEqual(rolled.running, true);
      assert.strictEqual(legacy.calls.length, 0);
    } finally {
      rimraf(legacy.dir);
    }
  });

  await test('countdown zero switches to countup with end then start', async () => {
    const bag = harness({ mode: 'live' });
    try {
      bag.timer.actions.setDuration({ seconds: 10 }, bag.ctx);
      bag.timer.actions.setTitle({ title: '元', category: 'cat' }, bag.ctx);
      bag.timer.actions.start({}, bag.ctx);
      bag.timer.actions.setTitle({ title: '別', category: 'next' }, bag.ctx);
      bag.time.advance(10000);
      const state = bag.timer.actions.getState({}, bag.ctx);
      assert.strictEqual(state.mode, 'countup');
      assert.strictEqual(state.running, true);
      assert.strictEqual(state.elapsedSec, 0);
      assert.strictEqual(state.display, '00:00:00');
      assert.strictEqual(state.title, '別');
      assert.deepStrictEqual(bag.calls.map((row) => row.op), ['start', 'end', 'start']);
      assert.strictEqual(bag.calls[2].input.plannedSec, 3600);
      assert.strictEqual(bag.calls[2].input.source, 'timer');
      assert.strictEqual(bag.calls[2].input.title, '元');
      assert.strictEqual(bag.calls[2].input.category, 'cat');
      const last = bag.overlays[bag.overlays.length - 1];
      assert.strictEqual(last.values.mode, 'countup');
      assert.strictEqual(last.values.title, '元');
      assert.strictEqual(last.values.state, 'running');
    } finally {
      rimraf(bag.dir);
    }

    const over = harness({ mode: 'live' });
    try {
      over.timer.actions.setDuration({ seconds: 10 }, over.ctx);
      over.timer.actions.start({ title: '飛び', category: '' }, over.ctx);
      over.time.advance(15000);
      const state = over.timer.actions.getState({}, over.ctx);
      assert.strictEqual(state.mode, 'countup');
      assert.strictEqual(state.running, true);
      assert.strictEqual(state.elapsedSec, 5);
      assert.strictEqual(state.display, '00:00:05');
      assert.strictEqual(over.calls[2].input.plannedSec, 3600);
      assert.strictEqual(over.calls[2].input.title, '飛び');
    } finally {
      rimraf(over.dir);
    }
  });

  await test('start is refused while another session is active', async () => {
    const foreign = harness({ mode: 'live', active: true });
    try {
      const result = foreign.timer.actions.start({ title: 'だめ', category: '' }, foreign.ctx);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'session-active');
      assert.strictEqual(foreign.calls.length, 0);
      const state = foreign.timer.actions.getState({}, foreign.ctx);
      assert.strictEqual(state.running, false);
    } finally {
      rimraf(foreign.dir);
    }

    let active = false;
    const race = harness({
      mode: 'live',
      view() {
        return active
          ? { active: true, title: 'other', state: 'running', elapsedMs: 1 }
          : { active: false, title: '', state: 'none', elapsedMs: 0 };
      },
      onStart() {
        return { ok: false, reason: 'session-active' };
      }
    });
    try {
      const result = race.timer.actions.start({}, race.ctx);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'session-active');
      assert.strictEqual(race.calls.length, 1);
      assert.strictEqual(race.calls[0].op, 'start');
      assert.strictEqual(race.timer.actions.getState({}, race.ctx).running, false);
    } finally {
      rimraf(race.dir);
    }
  });

  await test('elapsed time follows the clock, not the tick count', async () => {
    const bag = harness({ mode: 'live' });
    try {
      bag.timer.actions.setDuration({ seconds: 120 }, bag.ctx);
      bag.timer.actions.start({}, bag.ctx);
      assert.strictEqual(bag.time.delay(), 1000);
      bag.time.advance(10000);
      const jumped = bag.timer.actions.getState({}, bag.ctx);
      assert.strictEqual(jumped.elapsedSec, 10);
      assert.strictEqual(jumped.remainingSec, 110);
      assert.strictEqual(jumped.display, '00:01:50');
      bag.time.tick();
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).elapsedSec, 10);
      bag.time.advance(50000);
      const later = bag.timer.actions.getState({}, bag.ctx);
      assert.strictEqual(later.elapsedSec, 60);
      assert.strictEqual(later.remainingSec, 60);
      bag.timer.actions.stop({}, bag.ctx);
      assert.strictEqual(bag.time.delay(), null);
      const held = bag.timer.actions.getState({}, bag.ctx).elapsedSec;
      bag.time.advance(20000);
      bag.time.tick();
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).elapsedSec, held);
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).running, false);
    } finally {
      rimraf(bag.dir);
    }

    const capped = harness({ mode: 'live' });
    try {
      capped.timer.actions.setMode({ mode: 'countup' }, capped.ctx);
      capped.timer.actions.start({}, capped.ctx);
      capped.time.advance((MAX_SEC * 1000) + 5000);
      const state = capped.timer.actions.getState({}, capped.ctx);
      assert.strictEqual(state.running, false);
      assert.strictEqual(state.elapsedSec, MAX_SEC);
      assert.strictEqual(state.display, '24:00:00');
      assert.deepStrictEqual(capped.calls.map((row) => row.op), ['start', 'end']);
      assert.strictEqual(capped.calls[0].input.plannedSec, 3600);
    } finally {
      rimraf(capped.dir);
    }
  });

  await test('actions reject values outside the declared range', async () => {
    const bag = harness({ mode: 'live' });
    try {
      assert.strictEqual(bag.timer.actions.setMode({ mode: 'nope' }, bag.ctx).error, 'bad-mode');
      assert.strictEqual(bag.timer.actions.setMode({}, bag.ctx).error, 'bad-mode');
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).mode, 'countdown');
      assert.strictEqual(bag.timer.actions.setDuration({}, bag.ctx).error, 'bad-duration');
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: 0 }, bag.ctx).error, 'bad-duration');
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: -1 }, bag.ctx).error, 'bad-duration');
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: 1.5 }, bag.ctx).error, 'bad-duration');
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: '30' }, bag.ctx).error, 'bad-duration');
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: MAX_SEC + 1 }, bag.ctx).error, 'bad-duration');
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).durationSec, 300);
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: 1 }, bag.ctx).ok, true);
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: MAX_SEC }, bag.ctx).durationSec, MAX_SEC);
      const longTitle = 'a'.repeat(201);
      assert.strictEqual(bag.timer.actions.setTitle({ title: longTitle, category: 'ok' }, bag.ctx).error, 'bad-title');
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).title, '');
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).category, '');
      assert.strictEqual(bag.timer.actions.setTitle({ title: 'a'.repeat(200), category: 'b'.repeat(100) }, bag.ctx).ok, true);
      assert.strictEqual(bag.timer.actions.setTitle({ category: 'c'.repeat(101) }, bag.ctx).error, 'bad-category');
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).category, 'b'.repeat(100));
      assert.strictEqual(bag.timer.actions.setTitle({ title: 1 }, bag.ctx).error, 'bad-title');
      assert.strictEqual(bag.timer.actions.setTitle({ category: 2 }, bag.ctx).error, 'bad-category');
      bag.timer.actions.setDuration({ seconds: 30 }, bag.ctx);
      bag.timer.actions.start({}, bag.ctx);
      bag.time.advance(2000);
      const same = bag.timer.actions.setMode({ mode: 'countdown' }, bag.ctx);
      assert.strictEqual(same.running, true);
      assert.strictEqual(same.elapsedSec, 2);
      assert.strictEqual(bag.calls.length, 1);
      assert.strictEqual(bag.timer.actions.setDuration({ seconds: 10 }, bag.ctx).error, 'running');
      assert.strictEqual(bag.timer.actions.getState({}, bag.ctx).durationSec, 30);
      const reset = bag.timer.actions.reset({}, bag.ctx);
      assert.strictEqual(reset.running, false);
      assert.strictEqual(reset.elapsedSec, 0);
      assert.strictEqual(bag.calls[bag.calls.length - 1].op, 'end');
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('settings migrate once from the old file and keep only mode and duration', async () => {
    const dirs = [];
    const root = tempDir();
    dirs.push(root);
    try {
      const dataDir = path.join(root, 'data', 'marust', 'plugins', 'timer');
      const legacyFile = path.join(root, 'data', 'marust_timer_settings.json');
      const legacyBody = JSON.stringify({ version: 1, mode: 'countup', durationMs: 125000, title: '残さない' });
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, legacyBody);
      const userData = path.join(root, 'data', 'user_data.json');
      fs.writeFileSync(userData, '{"keep":true}');
      const time = clock();
      const ctx = {
        id: 'timer',
        dataDir: dataDir,
        core: {},
        logger() {},
        mode() { return 'legacy'; },
        sessions: { view() { return { active: false }; }, start() { throw new Error('no'); }, end() { throw new Error('no'); } },
        overlay: { publish() { return { ok: true, values: {} }; } }
      };
      const timer = createTimer({ now: time.now, setInterval: time.setInterval, clearInterval: time.clearInterval });
      timer.load(ctx);
      const settingsFile = path.join(dataDir, 'settings.json');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
        version: 1,
        mode: 'countup',
        durationSec: 125,
        presets: [300, 900, 1800, 3600, 7200, 10800]
      });
      assert.strictEqual(fs.readFileSync(legacyFile, 'utf8'), legacyBody);
      assert.strictEqual(fs.readFileSync(userData, 'utf8'), '{"keep":true}');
      assert.strictEqual(timer.actions.getState({}, ctx).mode, 'countup');
      assert.strictEqual(timer.actions.getState({}, ctx).durationSec, 125);

      fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, mode: 'countdown', durationMs: 9000 }));
      const again = createTimer({ now: time.now, setInterval: time.setInterval, clearInterval: time.clearInterval });
      again.load(ctx);
      assert.strictEqual(again.actions.getState({}, ctx).mode, 'countup');
      assert.strictEqual(again.actions.getState({}, ctx).durationSec, 125);

      const viaCore = tempDir();
      dirs.push(viaCore);
      // K3: ctx.core を使わない。旧い置き場は dataDir（<data>/marust/plugins/timer）の 3 つ上
      const pluginDir = path.join(viaCore, 'data', 'marust', 'plugins', 'timer');
      const oldDir = path.join(viaCore, 'data');
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'marust_timer_settings.json'), '\uFEFF{"mode":"countdown","durationMs":5000}');
      const coreCtx = {
        id: 'timer',
        dataDir: pluginDir,
        core: {},
        logger() {},
        mode() { return 'legacy'; },
        sessions: { view() { return { active: false }; }, start() {}, end() {} },
        overlay: { publish() { return { ok: true, values: {} }; } }
      };
      const migrated = createTimer({ now: () => 0, setInterval() { return 0; }, clearInterval() {} });
      migrated.load(coreCtx);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(pluginDir, 'settings.json'), 'utf8')), {
        version: 1,
        mode: 'countdown',
        durationSec: 5,
        presets: [300, 900, 1800, 3600, 7200, 10800]
      });
      assert.ok(fs.existsSync(path.join(oldDir, 'marust_timer_settings.json')));

      const zeroRoot = tempDir();
      dirs.push(zeroRoot);
      const zeroDir = path.join(zeroRoot, 'data', 'marust', 'plugins', 'timer');
      const zeroOld = path.join(zeroRoot, 'data');
      fs.mkdirSync(zeroOld, { recursive: true });
      fs.writeFileSync(path.join(zeroOld, 'marust_timer_settings.json'), JSON.stringify({ mode: 'countup', durationMs: 0 }));
      const zeroCtx = {
        id: 'timer',
        dataDir: zeroDir,
        core: {},
        logger() {},
        mode() { return 'legacy'; },
        sessions: { view() { return { active: false }; }, start() {}, end() {} },
        overlay: { publish() { return { ok: true, values: {} }; } }
      };
      const zeroTimer = createTimer({ now: () => 0, setInterval() { return 0; }, clearInterval() {} });
      zeroTimer.load(zeroCtx);
      assert.strictEqual(zeroTimer.actions.getState({}, zeroCtx).mode, 'countup');
      assert.strictEqual(zeroTimer.actions.getState({}, zeroCtx).durationSec, 300);

      bagWrite(dataDir);
      function bagWrite(folder) {
        const owner = createTimer({ now: () => 0, setInterval() { return 0; }, clearInterval() {} });
        const local = {
          id: 'timer',
          dataDir: folder,
          core: {},
          logger() {},
          mode() { return 'live'; },
          sessions: {
            view() { return { active: false, title: '', state: 'none', elapsedMs: 0 }; },
            start() { return { ok: true }; },
            end() { return { ok: true }; }
          },
          overlay: { publish() { return { ok: true, values: {} }; } }
        };
        owner.load(local);
        owner.actions.setTitle({ title: '秘密にしない題名', category: 'cat' }, local);
        owner.actions.setMode({ mode: 'countdown' }, local);
        owner.actions.setDuration({ seconds: 42 }, local);
        const saved = JSON.parse(fs.readFileSync(path.join(folder, 'settings.json'), 'utf8'));
        assert.deepStrictEqual(Object.keys(saved).sort(), ['durationSec', 'mode', 'presets', 'version']);
        assert.strictEqual(saved.durationSec, 42);
        assert.strictEqual(JSON.stringify(saved).includes('秘密にしない題名'), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(saved, 'running'), false);
      }
    } finally {
      for (const dir of dirs) rimraf(dir);
    }
  });

  await test('overlay publish stays inside manifest fields', async () => {
    const bag = harness({ mode: 'live' });
    try {
      bag.timer.actions.setTitle({ title: '見本', category: '隠す' }, bag.ctx);
      bag.timer.actions.setDuration({ seconds: 8 }, bag.ctx);
      bag.timer.actions.start({}, bag.ctx);
      const beforeTick = bag.overlays.length;
      bag.time.advance(1000);
      bag.time.tick();
      assert.ok(bag.overlays.length > beforeTick);
      bag.timer.actions.stop({}, bag.ctx);
      assert.ok(bag.overlays.length >= 4);
      for (const row of bag.overlays) {
        assert.strictEqual(row.name, 'clock');
        assert.deepStrictEqual(keysOf(row.values), fields);
        assert.strictEqual(typeof row.values.display, 'string');
        assert.strictEqual(typeof row.values.remainingSec, 'number');
        assert.strictEqual(typeof row.values.elapsedSec, 'number');
        assert.strictEqual(typeof row.values.title, 'string');
        assert.ok(!Object.prototype.hasOwnProperty.call(row.values, 'category'));
        assert.ok(!Object.prototype.hasOwnProperty.call(row.values, 'durationSec'));
        assert.ok(!Object.prototype.hasOwnProperty.call(row.values, 'notice'));
      }
    } finally {
      rimraf(bag.dir);
    }
  });

  await test('panel and overlay files follow the postMessage and SSE contract', async () => {
    const html = fs.readFileSync(path.join(COMMUNITY, 'timer', 'ui', 'clock.html'), 'utf8');
    const js = fs.readFileSync(path.join(COMMUNITY, 'timer', 'ui', 'clock.js'), 'utf8');
    const css = fs.readFileSync(path.join(COMMUNITY, 'timer', 'ui', 'clock.css'), 'utf8');
    const overlay = fs.readFileSync(path.join(COMMUNITY, 'timer', 'overlay', 'clock.html'), 'utf8');
    const src = fs.readFileSync(path.join(COMMUNITY, 'timer', 'index.js'), 'utf8');
    assert.ok(html.includes(LEGACY_NOTICE));
    assert.ok(html.includes('clock.js'));
    assert.ok(html.includes('clock.css'));
    assert.ok(!html.includes('<style'));
    assert.strictEqual(html.match(/<script/g).length, 2);
    assert.ok(html.includes('<script src="theme-apply.js"></script>'));
    assert.ok(html.includes('<script src="clock.js"></script>'));
    for (const name of ['getState', 'setMode', 'setDuration', 'start', 'stop', 'reset', 'setTitle']) {
      assert.ok(js.includes('plugin.timer.' + name), name);
    }
    assert.ok(js.includes("type: 'marust:call'") || js.includes('type: "marust:call"'));
    assert.ok(css.includes('color-scheme: light') || css.includes('color-scheme: dark'));
    assert.ok(overlay.includes('transparent'));
    assert.ok(overlay.includes('/overlay/timer/clock/events'));
    assert.ok(!src.includes('user_data.json'));
    assert.ok(!src.includes('neon_timer_user_data'));
  });

  await test('registry starts the v2 timer and migrates from STATE_DIR/data', async () => {
    const state = tempDir();
    try {
      const legacyFile = path.join(state, 'data', 'marust_timer_settings.json');
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      const legacyBody = JSON.stringify({ version: 1, mode: 'countup', durationMs: 90000 });
      fs.writeFileSync(legacyFile, legacyBody);
      const registry = createRegistry({
        core: { STATE_DIR: state },
        appRoot: ROOT,
        externalRoot: path.join(state, 'no-external'),
        logger() {}
      });
      const rows = await registry.loadAll();
      const timer = rows.find((row) => row.id === 'timer');
      assert.ok(timer);
      assert.strictEqual(timer.status, 'running');
      assert.strictEqual(timer.manifest.runtime, 'inproc');
      assert.ok(timer.manifest.provides.indexOf('session.controller@1') !== -1);
      const settingsFile = path.join(state, 'data', 'marust', 'plugins', 'timer', 'settings.json');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
        version: 1,
        mode: 'countup',
        durationSec: 90,
        presets: [300, 900, 1800, 3600, 7200, 10800]
      });
      assert.strictEqual(fs.readFileSync(legacyFile, 'utf8'), legacyBody);
    } finally {
      rimraf(state);
    }
  });

  await test('startPreset restarts a running timer with the new seconds and records a new session', async () => {
    const h = harness();
    try {
      h.timer.actions.setDuration({ seconds: 600 });
      h.timer.actions.start({ title: 'a', category: 'c' });
      h.time.advance(30000);
      const st = h.timer.actions.startPreset({ seconds: 900, title: 'b', category: 'd' });
      assert.strictEqual(st.ok, true);
      assert.strictEqual(st.running, true);
      assert.strictEqual(st.mode, 'countdown');
      assert.strictEqual(st.durationSec, 900);
      assert.strictEqual(st.remainingSec, 900);
      const ops = h.calls.map((c) => c.op);
      assert.deepStrictEqual(ops, ['start', 'end', 'start']);
      assert.strictEqual(h.calls[2].input.title, 'b');
      assert.strictEqual(h.calls[2].input.plannedSec, 900);
      // 数字の範囲外
      assert.strictEqual(h.timer.actions.startPreset({ seconds: 0 }).error, 'bad-duration');
      assert.strictEqual(h.timer.actions.startPreset({ seconds: MAX_SEC + 1 }).error, 'bad-duration');
      assert.strictEqual(h.timer.actions.startPreset({ seconds: 60, title: 5 }).error, 'bad-title');
    } finally {
      rimraf(h.dir);
    }
  });

  await test('startPreset works from the countup mode and from stopped', async () => {
    const h = harness();
    try {
      h.timer.actions.setMode({ mode: 'countup' });
      h.timer.actions.start({});
      h.time.advance(5000);
      const st = h.timer.actions.startPreset({ seconds: 300 });
      assert.strictEqual(st.mode, 'countdown');
      assert.strictEqual(st.remainingSec, 300);
      h.timer.actions.stop({});
      const again = h.timer.actions.startPreset({ seconds: 120 });
      assert.strictEqual(again.running, true);
      assert.strictEqual(again.remainingSec, 120);
    } finally {
      rimraf(h.dir);
    }
  });

  await test('pausedSec counts up after stop and clears on start and reset', async () => {
    const h = harness();
    try {
      assert.strictEqual(h.timer.actions.getState({}).pausedSec, 0);
      h.timer.actions.start({});
      assert.strictEqual(h.timer.actions.getState({}).pausedSec, 0);
      h.time.advance(10000);
      h.timer.actions.stop({});
      h.time.advance(12500);
      assert.strictEqual(h.timer.actions.getState({}).pausedSec, 12);
      h.timer.actions.start({});
      assert.strictEqual(h.timer.actions.getState({}).pausedSec, 0);
      h.timer.actions.stop({});
      h.time.advance(3000);
      h.timer.actions.reset({});
      assert.strictEqual(h.timer.actions.getState({}).pausedSec, 0);
    } finally {
      rimraf(h.dir);
    }
  });

  if (failed) {
    console.error('[marust] timer tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] timer tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
