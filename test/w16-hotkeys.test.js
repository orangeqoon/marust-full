'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApi, IPC_PERMISSIONS } = require('../host/layer1/api');
const { createHotkeys } = require('../host/layer1/keys-port');

const LEAK = 'SuperSecretStreamKey/9f3aZZ';
const EVENT_KEYS = ['accelerator', 'error', 'event', 'label', 'message', 'method', 'ok'];

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

function fakeShortcut(options) {
  const opts = options || {};
  const failOn = opts.failOn || new Set();
  const throwOn = opts.throwOn || new Set();
  const regs = new Map();
  const log = [];
  return {
    log: log,
    regs: regs,
    register: function (acc, cb) {
      log.push('register ' + acc);
      if (throwOn.has(acc)) throw new Error('busy');
      if (failOn.has(acc)) return false;
      regs.set(acc, cb);
      return true;
    },
    unregister: function (acc) {
      log.push('unregister ' + acc);
      regs.delete(acc);
    },
    unregisterAll: function () {
      log.push('unregisterAll');
      regs.clear();
    },
    press: function (acc) {
      const cb = regs.get(acc);
      if (!cb) throw new Error('not registered ' + acc);
      return cb();
    }
  };
}

function makeClock(start) {
  let t = start || 0;
  return {
    now: function () { return t; },
    set: function (n) { t = n; }
  };
}

function world(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-hotkeys-'));
  try {
    const calls = [];
    const notes = [];
    const logs = [];
    const clock = opts.clock || makeClock(0);
    const shortcut = opts.shortcut || fakeShortcut();
    const real = createApi({ getState: function () { return { ok: true }; }, orchestrator: opts.orchestrator });
    const store = { STATE_DIR: dir };
    if (typeof opts.atomicWriteJsonSync === 'function') store.atomicWriteJsonSync = opts.atomicWriteJsonSync;
    const hotkeys = createHotkeys({
      api: {
        call: function (method, params, ctx) {
          if (method === 'api.describe') return real.call(method, params, ctx);
          calls.push({ method: method, params: params, ctx: ctx });
          if (opts.onCall) return opts.onCall(method, params, ctx);
          return { ok: true };
        }
      },
      globalShortcut: shortcut,
      store: store,
      logger: function (level, message) { logs.push(String(level) + ' ' + String(message)); },
      notify: function (event) { notes.push(event); },
      now: function () { return clock.now(); },
      enabled: opts.enabled,
      knownMethod: opts.knownMethod
    });
    return {
      dir: dir,
      file: path.join(dir, 'data', 'marust', 'hotkeys.json'),
      calls: calls,
      notes: notes,
      logs: logs,
      clock: clock,
      shortcut: shortcut,
      real: real,
      hotkeys: hotkeys
    };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function cleanup(box) {
  if (box && box.dir) fs.rmSync(box.dir, { recursive: true, force: true });
}

function assertEvent(event) {
  assert.deepStrictEqual(Object.keys(event).sort(), EVENT_KEYS);
  assert.strictEqual(event.event, 'hotkey.result');
  assert.strictEqual(typeof event.ok, 'boolean');
  assert.strictEqual(typeof event.error, 'string');
  assert.strictEqual(typeof event.message, 'string');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

async function main() {
  await test('missing-file-registers-nothing', async function () {
    const box = world();
    try {
      const result = await box.hotkeys.reload();
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.registered, 0);
      assert.deepStrictEqual(box.hotkeys.list().bindings, []);
      assert.strictEqual(fs.existsSync(box.file), false);
      assert.strictEqual(box.shortcut.log.length, 0);

      fs.mkdirSync(path.dirname(box.file), { recursive: true });
      fs.writeFileSync(box.file, '[]\n', 'utf8');
      const again = await box.hotkeys.reload();
      assert.strictEqual(again.ok, true);
      assert.strictEqual(again.count, 0);
      assert.ok(!box.shortcut.log.some(function (line) { return line.indexOf('register ') === 0; }));
    } finally {
      cleanup(box);
    }
  });

  await test('save-rejects-forbidden-methods', async function () {
    const box = world();
    try {
      const first = await box.hotkeys.save([
        { accelerator: 'Ctrl+Shift+A', method: 'hub.getState', label: '状態' }
      ]);
      assert.strictEqual(first.ok, true);
      const before = fs.readFileSync(box.file, 'utf8');
      const rows = [
        ['secrets.list', 'forbidden'],
        ['secrets.set', 'forbidden'],
        ['clients.list', 'forbidden'],
        ['clients.revoke', 'forbidden'],
        ['clients.beginPairing', 'forbidden'],
        ['approval.approve', 'forbidden'],
        ['chat.publish', 'forbidden']
      ];
      for (let i = 0; i < rows.length; i += 1) {
        const saved = await box.hotkeys.save([
          { accelerator: 'Ctrl+Shift+A', method: 'hub.getState' },
          { accelerator: 'Ctrl+Shift+B', method: rows[i][0], params: { key: LEAK } }
        ]);
        assert.strictEqual(saved.ok, false, rows[i][0]);
        assert.strictEqual(saved.error, rows[i][1], rows[i][0]);
        assert.strictEqual(saved.index, 1, rows[i][0]);
        assert.strictEqual(fs.readFileSync(box.file, 'utf8'), before);
      }
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+B'), false);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+A'), true);
      const emptyMethod = await box.hotkeys.save([{ accelerator: 'F8', method: '' }]);
      assert.strictEqual(emptyMethod.ok, false);
      assert.strictEqual(emptyMethod.error, 'bad-method');
      const notArray = await box.hotkeys.save({ bindings: [] });
      assert.strictEqual(notArray.ok, false);
      assert.strictEqual(notArray.error, 'bad-config');
      assert.strictEqual(notArray.index, undefined);
      const params = await box.hotkeys.save([{ accelerator: 'F8', method: 'hub.getState', params: ['x'] }]);
      assert.strictEqual(params.error, 'bad-params');
      const label = await box.hotkeys.save([{ accelerator: 'F8', method: 'hub.getState', label: 'あ'.repeat(81) }]);
      assert.strictEqual(label.error, 'bad-label');
      const many = [];
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (let i = 0; i < 33; i += 1) {
        const mod = i < 26 ? 'Control' : 'Alt';
        many.push({ accelerator: mod + '+' + letters[i % 26], method: 'hub.getState' });
      }
      const tooMany = await box.hotkeys.save(many);
      assert.strictEqual(tooMany.ok, false);
      assert.strictEqual(tooMany.error, 'bad-config');
      assert.ok(box.logs.join('\n').indexOf(LEAK) === -1);
    } finally {
      cleanup(box);
    }
  });

  await test('save-rejects-bad-accelerator', async function () {
    const box = world();
    try {
      const bad = [
        '',
        'Ctrl+',
        'Ctrl++',
        'Ctrl+Shift',
        'Ctrl+A+B',
        'Nope',
        'Ctrl+F25',
        'Ctrl+F0',
        'Ctrl + A',
        'CommandOrControl+Ctrl+A',
        'Ctrl+Ctrl+A'
      ];
      for (let i = 0; i < bad.length; i += 1) {
        const saved = await box.hotkeys.save([{ accelerator: bad[i], method: 'hub.getState' }]);
        assert.strictEqual(saved.ok, false, JSON.stringify(bad[i]));
        assert.strictEqual(saved.error, 'bad-accelerator', JSON.stringify(bad[i]));
        assert.strictEqual(saved.index, 0);
      }
      const typed = await box.hotkeys.save([{ accelerator: 12, method: 'hub.getState' }]);
      assert.strictEqual(typed.error, 'bad-accelerator');
      const dup = await box.hotkeys.save([
        { accelerator: 'Ctrl+A', method: 'hub.getState' },
        { accelerator: 'Control+A', method: 'destination.list' }
      ]);
      assert.strictEqual(dup.ok, false);
      assert.strictEqual(dup.error, 'duplicate');
      assert.strictEqual(dup.index, 1);
      assert.strictEqual(fs.existsSync(box.file), false);
      assert.strictEqual(box.shortcut.regs.size, 0);
    } finally {
      cleanup(box);
    }
  });

  await test('save-accepts-electron-accelerators', async function () {
    const box = world();
    try {
      const saved = await box.hotkeys.save([
        { accelerator: 'cmdorctrl+shift+z', method: 'hub.getState', label: '状態' },
        { accelerator: 'MediaPlayPause', method: 'destination.list' },
        { accelerator: 'Ctrl+Alt+F12', method: 'destination.start', params: { id: 'youtube-main' }, label: '開始' },
        { accelerator: 'Ctrl+Plus', method: 'hub.getState' },
        { accelerator: 'F8', method: 'layout.list' },
        { accelerator: 'ctrl+f24', method: 'hub.getState' },
        { accelerator: 'Control+numadd', method: 'hub.getState' },
        { accelerator: 'AltGr+1', method: 'hub.getState' }
      ]);
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(saved.registered, 8);
      assert.deepStrictEqual(saved.failed, []);
      const names = box.hotkeys.list().bindings.map(function (row) { return row.accelerator; });
      assert.deepStrictEqual(names, [
        'CommandOrControl+Shift+Z',
        'MediaPlayPause',
        'Control+Alt+F12',
        'Control+Plus',
        'F8',
        'Control+F24',
        'Control+numadd',
        'AltGr+1'
      ]);
      const stored = readJson(box.file);
      assert.deepStrictEqual(Object.keys(stored[2]).sort(), ['accelerator', 'label', 'method', 'params']);
      assert.deepStrictEqual(stored[2].params, { id: 'youtube-main' });
      assert.strictEqual(box.hotkeys.list().bindings[2].registered, true);
    } finally {
      cleanup(box);
    }
  });

  await test('press-calls-api-with-window-permissions', async function () {
    const box = world();
    try {
      const saved = await box.hotkeys.save([
        { accelerator: 'Ctrl+Shift+S', method: 'destination.start', params: { id: 'youtube-main' }, label: '開始' }
      ]);
      assert.strictEqual(saved.ok, true);
      const listed = box.hotkeys.list();
      listed.bindings[0].params.id = 'mutated';
      await box.shortcut.press('Control+Shift+S');
      assert.strictEqual(box.calls.length, 1);
      assert.strictEqual(box.calls[0].method, 'destination.start');
      assert.deepStrictEqual(box.calls[0].params, { id: 'youtube-main' });
      assert.deepStrictEqual(Object.keys(box.calls[0].ctx).sort(), ['permissions', 'via']);
      assert.deepStrictEqual(box.calls[0].ctx.permissions, IPC_PERMISSIONS.slice());
      assert.deepStrictEqual(box.calls[0].ctx.permissions, ['read', 'write', 'emergency']);
      assert.strictEqual(box.calls[0].ctx.via, 'hotkey');
      assert.strictEqual(box.notes.length, 1);
      assertEvent(box.notes[0]);
      assert.strictEqual(box.notes[0].ok, true);
      assert.strictEqual(box.notes[0].method, 'destination.start');
      assert.strictEqual(box.notes[0].label, '開始');
      assert.strictEqual(box.notes[0].message, '');
    } finally {
      cleanup(box);
    }
  });

  await test('emergency-single-press', async function () {
    const box = world({ clock: makeClock(0) });
    try {
      const saved = await box.hotkeys.save([
        { accelerator: 'Ctrl+Shift+E', method: 'engine.emergencyStop', label: '停止' },
        { accelerator: 'Ctrl+Shift+F', method: 'engine.emergencyStop', params: { source: 'deck' }, label: '停止2' }
      ]);
      assert.strictEqual(saved.ok, true);

      await box.shortcut.press('Control+Shift+E');
      assert.strictEqual(box.calls.length, 1);
      assert.strictEqual(box.calls[0].method, 'engine.emergencyStop');
      assert.strictEqual(box.notes.length, 1);
      assertEvent(box.notes[0]);
      assert.strictEqual(box.notes[0].ok, true);
      assert.strictEqual(box.notes[0].message, '');

      await box.shortcut.press('Control+Shift+F');
      assert.strictEqual(box.calls.length, 2);
      assert.strictEqual(box.calls[1].method, 'engine.emergencyStop');
      assert.deepStrictEqual(box.calls[1].params, { source: 'deck' });
      assert.deepStrictEqual(box.calls[1].ctx.permissions, ['read', 'write', 'emergency']);
      assert.strictEqual(box.calls[1].ctx.via, 'hotkey');
      assert.strictEqual(box.notes[1].message, '');
      assert.strictEqual(box.notes[1].ok, true);
    } finally {
      cleanup(box);
    }
  });

  await test('register-failure-continues', async function () {
    const box = world({
      shortcut: fakeShortcut({
        failOn: new Set(['Control+Alt+F13']),
        throwOn: new Set(['Control+Alt+F14'])
      })
    });
    try {
      const saved = await box.hotkeys.save([
        { accelerator: 'Ctrl+Alt+F13', method: 'hub.getState', label: 'a' },
        { accelerator: 'Ctrl+Alt+F14', method: 'hub.getState', label: 'b' },
        { accelerator: 'Ctrl+Alt+F15', method: 'destination.list', label: 'c' }
      ]);
      assert.strictEqual(saved.ok, true);
      assert.deepStrictEqual(saved.failed, ['Control+Alt+F13', 'Control+Alt+F14']);
      assert.strictEqual(saved.registered, 1);
      assert.strictEqual(box.shortcut.regs.has('Control+Alt+F13'), false);
      assert.strictEqual(box.shortcut.regs.has('Control+Alt+F14'), false);
      assert.strictEqual(box.shortcut.regs.has('Control+Alt+F15'), true);
      assert.ok(box.logs.some(function (line) { return line.indexOf('warn hotkey register failed') === 0; }));
      const listed = box.hotkeys.list().bindings;
      assert.strictEqual(listed[0].registered, false);
      assert.strictEqual(listed[2].registered, true);
      await box.shortcut.press('Control+Alt+F15');
      assert.strictEqual(box.calls.length, 1);
      assert.strictEqual(box.calls[0].method, 'destination.list');
    } finally {
      cleanup(box);
    }
  });

  await test('reload-and-unregisterAll', async function () {
    const box = world();
    try {
      const saved = await box.hotkeys.save([
        { accelerator: 'Ctrl+Shift+A', method: 'hub.getState', label: 'A' }
      ]);
      assert.strictEqual(saved.ok, true);
      await box.shortcut.press('Control+Shift+A');
      assert.strictEqual(box.calls.length, 1);

      fs.writeFileSync(box.file, JSON.stringify([
        { accelerator: 'Ctrl+Shift+B', method: 'destination.list', label: 'B' }
      ]), 'utf8');
      box.shortcut.log.length = 0;
      const reloaded = await box.hotkeys.reload();
      assert.strictEqual(reloaded.ok, true);
      assert.ok(box.shortcut.log.indexOf('unregister Control+Shift+A') !== -1);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+A'), false);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+B'), true);
      await box.shortcut.press('Control+Shift+B');
      assert.strictEqual(box.calls[box.calls.length - 1].method, 'destination.list');

      box.shortcut.regs.set('FOREIGN', function () {});
      const cleared = box.hotkeys.unregisterAll();
      assert.strictEqual(cleared.ok, true);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+B'), false);
      assert.strictEqual(box.shortcut.regs.has('FOREIGN'), true);
      assert.ok(box.shortcut.log.indexOf('unregisterAll') === -1);
      const after = box.hotkeys.list();
      assert.strictEqual(after.bindings.length, 1);
      assert.strictEqual(after.bindings[0].accelerator, 'Control+Shift+B');
      assert.strictEqual(after.bindings[0].registered, false);
      assert.ok(fs.existsSync(box.file));

      await box.hotkeys.reload();
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+B'), true);
      assert.strictEqual(box.shortcut.regs.has('FOREIGN'), true);

      const emptied = await box.hotkeys.save([]);
      assert.strictEqual(emptied.ok, true);
      assert.strictEqual(emptied.count, 0);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+B'), false);
      assert.deepStrictEqual(readJson(box.file), []);

      fs.writeFileSync(box.file, '{', 'utf8');
      const broken = await box.hotkeys.reload();
      assert.strictEqual(broken.ok, false);
      assert.strictEqual(broken.error, 'parse-failed');
      assert.deepStrictEqual(box.hotkeys.list().bindings, []);
    } finally {
      cleanup(box);
    }
  });

  await test('load-skips-invalid-rows', async function () {
    const box = world();
    try {
      fs.mkdirSync(path.dirname(box.file), { recursive: true });
      fs.writeFileSync(box.file, JSON.stringify([
        { accelerator: 'Ctrl+Shift+A', method: 'hub.getState', label: 'ok' },
        { accelerator: 'nope', method: 'hub.getState' },
        { accelerator: 'Ctrl+Shift+B', method: 'secrets.list' },
        { accelerator: 'Ctrl+Shift+C', method: 'destination.list', label: 'c' }
      ]), 'utf8');
      const loaded = await box.hotkeys.reload();
      assert.strictEqual(loaded.ok, true);
      assert.strictEqual(loaded.count, 2);
      assert.strictEqual(loaded.skipped, 2);
      const names = box.hotkeys.list().bindings.map(function (row) { return row.accelerator; });
      assert.deepStrictEqual(names, ['Control+Shift+A', 'Control+Shift+C']);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+A'), true);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+C'), true);
      assert.ok(box.logs.some(function (line) { return line.indexOf('error=bad-accelerator') !== -1; }));
      assert.ok(box.logs.some(function (line) { return line.indexOf('error=forbidden') !== -1; }));
    } finally {
      cleanup(box);
    }
  });

  await test('plugin-write-from-describe', async function () {
    const box = world();
    try {
      const added = box.real.registerPluginAction('timer', 'start', 'write', function () {
        return { ok: true };
      });
      assert.strictEqual(added.ok, true);
      const saved = await box.hotkeys.save([
        { accelerator: 'Control+F8', method: 'plugin.timer.start', label: 'タイマー' }
      ]);
      assert.strictEqual(saved.ok, true);
      await box.shortcut.press('Control+F8');
      assert.strictEqual(box.calls.length, 1);
      assert.strictEqual(box.calls[0].method, 'plugin.timer.start');
      assert.strictEqual(box.calls[0].ctx.via, 'hotkey');
    } finally {
      cleanup(box);
    }
  });

  await test('hotkey-result-has-no-values', async function () {
    const box = world({
      onCall: function (method, params) {
        if (method === 'hub.getState') return { ok: false, error: LEAK, detail: LEAK };
        return { ok: true, key: params && params.key, value: { token: LEAK }, nested: LEAK };
      }
    });
    try {
      fs.mkdirSync(path.dirname(box.file), { recursive: true });
      fs.writeFileSync(box.file, JSON.stringify([
        { accelerator: LEAK, method: 'hub.getState', params: { key: LEAK } },
        {
          accelerator: 'Control+F2',
          method: 'engine.setKey',
          params: { id: 'yt', key: LEAK },
          label: '鍵',
          token: LEAK
        },
        { accelerator: 'Control+F3', method: 'hub.getState', label: '状態' }
      ]), 'utf8');
      const loaded = await box.hotkeys.reload();
      assert.strictEqual(loaded.ok, true);
      assert.strictEqual(loaded.skipped, 1);
      const listed = box.hotkeys.list().bindings;
      assert.deepStrictEqual(Object.keys(listed[0]).sort(), ['accelerator', 'label', 'method', 'params', 'registered']);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(listed[0].params, 'key'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(listed[0], 'token'), false);

      await box.shortcut.press('Control+F2');
      await box.shortcut.press('Control+F3');
      assert.strictEqual(box.calls.length, 2);
      assert.strictEqual(box.calls[0].method, 'engine.setKey');
      assert.strictEqual(box.calls[0].params.key, LEAK);
      assert.strictEqual(box.notes.length, 2);
      assertEvent(box.notes[0]);
      assertEvent(box.notes[1]);
      assert.strictEqual(box.notes[0].ok, true);
      assert.strictEqual(box.notes[0].error, '');
      assert.strictEqual(box.notes[0].label, '鍵');
      assert.strictEqual(box.notes[1].ok, false);
      assert.strictEqual(box.notes[1].error, 'failed');
      const blob = JSON.stringify(box.notes) + '\n' + box.logs.join('\n');
      assert.ok(blob.indexOf(LEAK) === -1, blob);
      assert.ok(blob.indexOf('token') === -1, blob);
    } finally {
      cleanup(box);
    }
  });

  await test('save-uses-store-atomic-write', async function () {
    let seen = '';
    const box = world({
      atomicWriteJsonSync: function (target, data) {
        seen = target;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(data), 'utf8');
      }
    });
    try {
      const saved = await box.hotkeys.save([{ accelerator: 'F8', method: 'hub.getState', label: '状態' }]);
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(seen, box.file);
      const body = readJson(box.file);
      assert.strictEqual(body[0].accelerator, 'F8');
      assert.strictEqual(body[0].label, '状態');
      assert.ok(box.file.endsWith(path.join('data', 'marust', 'hotkeys.json')));
    } finally {
      cleanup(box);
    }
  });

  await test('unregisterAll-cancels-inflight-reload', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-hotkeys-'));
    try {
      let release;
      const gate = new Promise(function (resolve) { release = resolve; });
      const real = createApi({ getState: function () { return { ok: true }; } });
      const shortcut = fakeShortcut();
      const file = path.join(dir, 'data', 'marust', 'hotkeys.json');
      const hotkeys = createHotkeys({
        api: {
          call: function (method, params, ctx) {
            if (method !== 'api.describe') return { ok: true };
            return gate.then(function () { return real.call(method, params, ctx); });
          }
        },
        globalShortcut: shortcut,
        store: { STATE_DIR: dir },
        logger: function () {},
        notify: function () {}
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([{ accelerator: 'F8', method: 'hub.getState' }]), 'utf8');
      const pending = hotkeys.reload();
      const cleared = hotkeys.unregisterAll();
      assert.strictEqual(cleared.ok, true);
      release();
      const result = await pending;
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'cancelled');
      assert.strictEqual(shortcut.regs.has('F8'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('cmd-has-no-absolute-path', async function () {
    const cmdPath = path.join(__dirname, '..', 'cli', 'marust.cmd');
    const cmd = fs.readFileSync(cmdPath, 'utf8');
    assert.ok(cmd.indexOf('node "%~dp0marust.js" %*') !== -1);
    for (let i = 0; i < cmd.length; i += 1) {
      assert.ok(cmd.charCodeAt(i) < 128, 'non-ascii at ' + i);
    }
    assert.ok(!/[A-Za-z]:/.test(cmd));
    assert.ok(cmd.indexOf('\\\\') === -1);
    assert.ok(cmd.indexOf('/Users/') === -1);
    assert.ok(cmd.indexOf('/home/') === -1);
    assert.ok(cmd.indexOf('scripts-worktrees') === -1);

    const readme = fs.readFileSync(path.join(__dirname, '..', 'cli', 'README.md'), 'utf8');
    assert.ok(readme.indexOf('marust.cmd') !== -1);
    assert.ok(readme.indexOf('システム') !== -1);
    assert.ok(readme.indexOf('開く') !== -1);
    assert.ok(readme.indexOf('go youtube-main --title "朝の配信" --yes') !== -1);
    assert.ok(readme.indexOf('--yes') !== -1);
    assert.ok(!/[A-Za-z]:\\/.test(readme));
    assert.ok(!/[A-Za-z]:\//.test(readme));
  });


  // ---- V3 C4: 内蔵プラグイン hotkeys の入／切・「切ってある」行・hub.fanout の確認済みの印 ----
  const SAVED = [
    { accelerator: 'Ctrl+Shift+A', method: 'hub.getState', label: '状態' },
    { accelerator: 'Ctrl+Shift+B', method: 'nofeature.ping', label: '切った機能', params: { x: 1 } }
  ];
  const wireFile = function (box, rows) {
    fs.mkdirSync(path.dirname(box.file), { recursive: true });
    fs.writeFileSync(box.file, JSON.stringify(rows), 'utf8');
  };

  await test('V3 enabled が false: reload は 1 つも登録せず、登録済みのキーも外す。設定ファイルは消さず、入れたら戻る', async function () {
    const flag = { on: true };
    const box = world({ enabled: function () { return flag.on; } });
    try {
      wireFile(box, [SAVED[0]]);
      assert.strictEqual((await box.hotkeys.reload()).registered, 1);
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+A'), true);
      flag.on = false;
      const off = await box.hotkeys.reload();
      assert.deepStrictEqual([off.ok, off.registered, off.failed, off.skipped, off.off], [true, 0, [], 0, true]);
      assert.strictEqual(box.shortcut.regs.size, 0, '登録済みも外す');
      assert.deepStrictEqual(readJson(box.file), [SAVED[0]], '設定ファイルは消さない');
      const logLen = box.shortcut.log.length;
      await box.hotkeys.reload();
      assert.ok(!box.shortcut.log.slice(logLen).some(function (l) { return l.indexOf('register ') === 0; }), '切っているあいだは何も登録しない');
      flag.on = true;
      assert.strictEqual((await box.hotkeys.reload()).registered, 1, '入れたら戻る');
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+A'), true);
    } finally { cleanup(box); }
  });

  await test('V3 knownMethod が無ければ、表に無い名前は保存で全部 unknown-method（今までどおり）', async function () {
    const box = world();
    try {
      const r = await box.hotkeys.save([{ accelerator: 'F9', method: 'no.such' }]);
      assert.deepStrictEqual([r.ok, r.error], [false, 'unknown-method']);
    } finally { cleanup(box); }
  });

  await test('V3 enabled が false のときの save: 書くが登録しない（list には出る）。enabled が投げたら切として扱う', async function () {
    const box = world({ enabled: function () { return false; } });
    try {
      const saved = await box.hotkeys.save([SAVED[0]]);
      assert.deepStrictEqual([saved.ok, saved.registered, saved.off], [true, 0, true]);
      assert.deepStrictEqual(readJson(box.file), [{ accelerator: 'Control+Shift+A', method: 'hub.getState', params: {}, label: '状態' }]);
      assert.strictEqual(box.shortcut.regs.size, 0);
      assert.deepStrictEqual(box.hotkeys.list().bindings.map(function (r) { return [r.accelerator, r.registered]; }), [['Control+Shift+A', false]]);
    } finally { cleanup(box); }
    const thrower = world({ enabled: function () { throw new Error('x'); } });
    try {
      assert.strictEqual((await thrower.hotkeys.reload()).off, true);
    } finally { cleanup(thrower); }
  });

  await test('V3 enabled が無いときは今までどおり（常に入）', async function () {
    const box = world();
    try {
      wireFile(box, [SAVED[0]]);
      const r = await box.hotkeys.reload();
      assert.strictEqual(r.registered, 1);
      assert.ok(!('off' in r));
    } finally { cleanup(box); }
  });

  await test('V3 表に無いメソッド（機能を切った）のキーは list に off:true で残り、save で消えない。登録はしない。打ち間違い（持ち主がいない名前）は保存で unknown-method', async function () {
    const box = world({ knownMethod: function (m) { return m.indexOf('nofeature.') === 0; } });
    try {
      wireFile(box, SAVED);
      const r = await box.hotkeys.reload();
      assert.deepStrictEqual([r.ok, r.count, r.registered, r.skipped], [true, 2, 1, 0]);
      const rows = box.hotkeys.list().bindings;
      assert.deepStrictEqual(rows.map(function (x) { return [x.accelerator, x.registered, x.off === true]; }), [['Control+Shift+A', true, false], ['Control+Shift+B', false, true]]);
      assert.ok(!('off' in rows[0]), '切っていない行に off の欄は付けない');
      assert.strictEqual(box.shortcut.regs.has('Control+Shift+B'), false);
      // 画面の「保存」は list の行をそのまま送ってくる（off の欄つき）。切ってある行も保存で消えない
      const saved = await box.hotkeys.save(rows.map(function (x) { return { accelerator: x.accelerator, method: x.method, params: x.params, label: x.label }; }));
      assert.strictEqual(saved.ok, true);
      assert.deepStrictEqual(readJson(box.file).map(function (x) { return x.method; }), ['hub.getState', 'nofeature.ping']);
      assert.ok(!JSON.stringify(readJson(box.file)).includes('"off"'), '設定ファイルには off を書かない');
      assert.strictEqual(box.hotkeys.list().bindings[1].off, true);
      // 形の検査は切ってある行にも効く
      assert.strictEqual((await box.hotkeys.save([{ accelerator: 'Ctrl+Shift+B', method: 'nofeature.ping', params: ['x'] }])).error, 'bad-params');
      assert.strictEqual((await box.hotkeys.save([{ accelerator: 'Ctrl+Shift+A', method: 'hub.getState' }, { accelerator: 'Ctrl+Shift+A', method: 'nofeature.ping' }])).error, 'duplicate');
      assert.strictEqual((await box.hotkeys.save([{ accelerator: 'F9', method: 'secrets.nofeature' }])).error, 'forbidden', 'secrets. は切ってある行でも拒否');
      const typo = await box.hotkeys.save([{ accelerator: 'Ctrl+Shift+A', method: 'hub.getState' }, { accelerator: 'F9', method: 'no.such' }]);
      assert.deepStrictEqual([typo.ok, typo.error, typo.index], [false, 'unknown-method', 1], '打ち間違いは保存で断る');
      assert.deepStrictEqual(readJson(box.file).map(function (x) { return x.method; }), ['hub.getState', 'nofeature.ping'], '断ったら書かない');
      // 読み込みでは、持ち主が分からなくても捨てない（ファイルにあるものは残す）
      wireFile(box, [{ accelerator: 'F9', method: 'no.such' }]);
      assert.strictEqual((await box.hotkeys.reload()).skipped, 0);
      assert.strictEqual(box.hotkeys.list().bindings[0].off, true);
    } finally { cleanup(box); }
  });

  await test('V3 あとで表にメソッドが出たら（機能を入れたら）reload で登録される', async function () {
    const modes = { fav: 'legacy' };
    const orchestrator = { modeSetting: function (id) { return modes[id] || 'legacy'; }, modeFor: function (id) { return modes[id] || 'legacy'; } };
    const box = world({ orchestrator: orchestrator });
    try {
      box.real.registerPluginMethod('fav', 'favns.go', { access: 'write', description: 'x', params: {} }, function () { return { ok: true }; }, { audience: 'public', modeGated: true });
      wireFile(box, [{ accelerator: 'Ctrl+Shift+F', method: 'favns.go', label: 'お気に入り' }]);
      let r = await box.hotkeys.reload();
      assert.deepStrictEqual([r.registered, box.hotkeys.list().bindings[0].off], [0, true], '切っているあいだは「切ってある」');
      modes.fav = 'live';
      r = await box.hotkeys.reload();
      assert.strictEqual(r.registered, 1);
      const row = box.hotkeys.list().bindings[0];
      assert.deepStrictEqual([row.registered, 'off' in row], [true, false]);
    } finally { cleanup(box); }
  });

  await test('V3 押したときの答えが unknown-method なら、hotkey.result の error はそのまま unknown-method', async function () {
    const box = world({ onCall: function () { return { ok: false, error: 'unknown-method' }; } });
    try {
      wireFile(box, [SAVED[0]]);
      await box.hotkeys.reload();
      await box.shortcut.press('Control+Shift+A');
      assert.strictEqual(box.notes.length, 1);
      assertEvent(box.notes[0]);
      assert.deepStrictEqual([box.notes[0].ok, box.notes[0].error], [false, 'unknown-method']);
    } finally { cleanup(box); }
  });

  await test('V3 hub.fanout に confirmed・allowedLiveIds を割り当てられない（読み込み・保存の両方）。ほかの引数は通る', async function () {
    const box = world();
    try {
      const bad = [{ confirmed: true }, { confirmed: false }, { allowedLiveIds: [] }, { title: 't', confirmed: true, allowedLiveIds: ['x'] }];
      for (let i = 0; i < bad.length; i += 1) {
        const saved = await box.hotkeys.save([{ accelerator: 'F7', method: 'hub.fanout', params: Object.assign({ title: 't' }, bad[i]) }]);
        assert.deepStrictEqual([saved.ok, saved.error], [false, 'forbidden'], JSON.stringify(bad[i]));
      }
      assert.strictEqual(fs.existsSync(box.file), false, '書かれない');
      assert.strictEqual((await box.hotkeys.save([{ accelerator: 'F7', method: 'hub.fanout', params: { title: 't', category: 'c' } }])).ok, true);
      // 設定ファイルに手で書かれた場合も、読み込みで捨てる
      wireFile(box, [{ accelerator: 'F8', method: 'hub.fanout', params: { title: 't', confirmed: true } }, { accelerator: 'F9', method: 'hub.getState' }]);
      const r = await box.hotkeys.reload();
      assert.deepStrictEqual([r.registered, r.skipped], [1, 1]);
      assert.strictEqual(box.shortcut.regs.has('F8'), false);
    } finally { cleanup(box); }
  });

  await test('V3 electron-main の配線: hotkeys.reload は attachApi より後・modes.changed と plugin.reloaded で reload・enabled は featureOn', function () {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
    const attach = src.indexOf('registry.attachApi(api)');
    const first = src.indexOf('hotkeys.reload()');
    assert.ok(attach !== -1 && first !== -1 && attach < first, 'attachApi の後で最初の reload');
    // K3: 機能の入／切・読み直しでの reload はプラグイン hotkeys が ctx.keys.reload() で行う（核の electron-main は購読しない）
    assert.ok(/createKeysPort\(\{[\s\S]{0,300}enabled: \(\) => \{[\s\S]{0,400}featureOn\(holder\.id\)/.test(src));
    const plugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'hotkeys', 'index.js'), 'utf8');
    assert.ok(plugin.includes('NAMES.MODES_CHANGED') && plugin.includes('NAMES.PLUGIN_RELOADED') && plugin.includes('keys.reload()'));
  });

  await test('V3 本体の行 hotkeys.list / hotkeys.save は、プラグイン hotkeys が legacy なら無い（featurePlugin）。forceLegacy では隠れない', async function () {
    const modes = { hotkeys: 'legacy' };
    let reads = 0;
    const orchestrator = { modeSetting: function (id) { if (id === 'hotkeys') reads += 1; return modes[id] || 'legacy'; }, modeFor: function () { return 'legacy'; } };
    // K3: hotkeys.list / hotkeys.save はプラグイン hotkeys が出す（feature を持つので、切のあいだ無いものとして扱われる = modeGated）
    const real = createApi({ getState: function () { return { ok: true }; }, orchestrator: orchestrator });
    real.registerPluginMethod('hotkeys', 'hotkeys.list', { access: 'read', params: {} }, function () { return { ok: true, bindings: [] }; }, { audience: 'public', modeGated: true });
    real.registerPluginMethod('hotkeys', 'hotkeys.save', { access: 'write', windowOnly: true, params: { bindings: { type: 'array', required: true, max: 32 } } }, function () { return { ok: true }; }, { audience: 'public', modeGated: true });
    const win = { clientId: 'window', kind: 'window', permissions: ['read', 'write'] };
    const names = async function () { return (await real.call('api.describe', {}, win)).methods.map(function (m) { return m.method; }); };
    assert.ok(!(await names()).some(function (n) { return n.indexOf('hotkeys.') === 0; }));
    assert.deepStrictEqual(await real.call('hotkeys.list', {}, win), { ok: false, error: 'unknown-method' });
    assert.deepStrictEqual(await real.call('hotkeys.save', { bindings: [] }, win), { ok: false, error: 'unknown-method' });
    modes.hotkeys = 'live';
    reads = 0;
    const listed = (await names()).filter(function (n) { return n.indexOf('hotkeys.') === 0; }).sort();
    assert.deepStrictEqual(listed, ['hotkeys.list', 'hotkeys.save']);
    assert.strictEqual(reads, 1, 'describe 1 回で hotkeys のモードは 1 回だけ読む');
    assert.deepStrictEqual(await real.call('hotkeys.list', {}, win), { ok: true, bindings: [] });
  });

  if (failed) {
    console.error('[marust] w16 hotkeys tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] w16 hotkeys tests passed');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
