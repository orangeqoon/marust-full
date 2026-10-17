'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendJsonl } = require('../host/core/log-writer');
const { createLogRetention } = require('../host/layer1/log-retention');

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

function ymd(date) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
}

function shift(base, days) {
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w30-logs-'));
}

function writeRaw(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body == null ? '{"ok":true}\n' : body, 'utf8');
}

function exists(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

function retention(stateDir, now, extra) {
  const core = Object.assign({ STATE_DIR: stateDir }, extra || {});
  const lines = [];
  const api = createLogRetention({
    core: core,
    logger: function (level, message) { lines.push(level + ' ' + message); },
    now: function () { return now; }
  });
  api.lines = lines;
  return api;
}

function withReadSpies(fn) {
  const calls = [];
  const orig = fs.readFile;
  const origP = fs.promises.readFile;
  const origS = fs.readFileSync;
  function wrap(origFn, owner) {
    return function (file) {
      const text = typeof file === 'string' ? file : String(file);
      calls.push(text);
      if (/\.jsonl$/i.test(text)) throw new Error('read log contents ' + text);
      return origFn.apply(owner, arguments);
    };
  }
  fs.readFile = wrap(orig, fs);
  fs.promises.readFile = wrap(origP, fs.promises);
  fs.readFileSync = wrap(origS, fs);
  try {
    fn(calls);
  } finally {
    fs.readFile = orig;
    fs.promises.readFile = origP;
    fs.readFileSync = origS;
  }
}

async function main() {
  const today = new Date(2026, 9, 5, 15, 30, 0);
  const day30 = ymd(shift(today, -30));
  const day31 = ymd(shift(today, -31));
  const day180 = ymd(shift(today, -180));
  const day181 = ymd(shift(today, -181));
  const todayName = ymd(today);

  await test('ordinary logs drop at 30 days and keep newer', function () {
    const state = tempState();
    try {
      const dir = path.join(state, 'logs', 'marust');
      writeRaw(dir, 'shadow-' + day31 + '.jsonl', '{"a":1}\n');
      writeRaw(dir, 'shadow-' + day31 + '-2.jsonl', '{"a":2}\n');
      writeRaw(dir, 'engine-' + day31 + '.jsonl', '{"a":3}\n');
      writeRaw(dir, 'shadow-' + day30 + '.jsonl', '{"a":4}\n');
      writeRaw(dir, 'engine-' + todayName + '.jsonl', '{"a":5}\n');
      const api = retention(state, today);
      const before = api.status();
      assert.strictEqual(before.files, 5);
      assert.ok(before.bytes > 0);
      const result = api.runOnce();
      assert.strictEqual(result.deleted, 3);
      assert.ok(result.bytes > 0);
      assert.strictEqual(result.kept, 2);
      assert.strictEqual(exists(dir, 'shadow-' + day31 + '.jsonl'), false);
      assert.strictEqual(exists(dir, 'shadow-' + day31 + '-2.jsonl'), false);
      assert.strictEqual(exists(dir, 'engine-' + day31 + '.jsonl'), false);
      assert.strictEqual(exists(dir, 'shadow-' + day30 + '.jsonl'), true);
      assert.strictEqual(exists(dir, 'engine-' + todayName + '.jsonl'), true);
      const logged = api.lines.join('\n');
      assert.ok(logged.indexOf('shadow-' + day31 + '.jsonl') !== -1);
      assert.ok(logged.indexOf('bytes ') !== -1);
    } finally {
      rimraf(state);
    }
  });

  await test('audit logs stay until 180 days', function () {
    const state = tempState();
    try {
      const dir = path.join(state, 'logs', 'marust');
      writeRaw(dir, 'api-' + day31 + '.jsonl');
      writeRaw(dir, 'vault-' + day180 + '.jsonl');
      writeRaw(dir, 'emergency-' + day180 + '-2.jsonl');
      writeRaw(dir, 'api-' + day181 + '.jsonl');
      writeRaw(dir, 'vault-' + day181 + '-3.jsonl');
      writeRaw(dir, 'emergency-' + day181 + '.jsonl');
      const result = retention(state, today).runOnce();
      assert.strictEqual(result.deleted, 3);
      assert.strictEqual(exists(dir, 'api-' + day31 + '.jsonl'), true);
      assert.strictEqual(exists(dir, 'vault-' + day180 + '.jsonl'), true);
      assert.strictEqual(exists(dir, 'emergency-' + day180 + '-2.jsonl'), true);
      assert.strictEqual(exists(dir, 'api-' + day181 + '.jsonl'), false);
      assert.strictEqual(exists(dir, 'vault-' + day181 + '-3.jsonl'), false);
      assert.strictEqual(exists(dir, 'emergency-' + day181 + '.jsonl'), false);
    } finally {
      rimraf(state);
    }
  });

  await test('today and wrong names stay', function () {
    const state = tempState();
    try {
      const dir = path.join(state, 'logs', 'marust');
      const huge = Buffer.alloc(4096, 0x61).toString('utf8');
      writeRaw(dir, 'shadow-' + todayName + '.jsonl', huge);
      writeRaw(dir, 'api-' + todayName + '-2.jsonl', huge);
      writeRaw(dir, 'shadow-notadate.jsonl', 'secret\n');
      writeRaw(dir, 'shadow-' + day31 + '-1.jsonl', 'nope\n');
      writeRaw(dir, 'shadow-20260231.jsonl', 'bad-day\n');
      writeRaw(dir, 'notes.txt', 'keep\n');
      writeRaw(dir, 'other-' + day31 + '.jsonl', 'keep\n');
      const result = retention(state, today).runOnce();
      assert.strictEqual(result.deleted, 0);
      assert.strictEqual(exists(dir, 'shadow-' + todayName + '.jsonl'), true);
      assert.strictEqual(exists(dir, 'api-' + todayName + '-2.jsonl'), true);
      assert.strictEqual(exists(dir, 'shadow-notadate.jsonl'), true);
      assert.strictEqual(exists(dir, 'shadow-' + day31 + '-1.jsonl'), true);
      assert.strictEqual(exists(dir, 'shadow-20260231.jsonl'), true);
      assert.strictEqual(exists(dir, 'notes.txt'), true);
      assert.strictEqual(exists(dir, 'other-' + day31 + '.jsonl'), true);
      const after = fs.statSync(path.join(dir, 'shadow-' + todayName + '.jsonl')).size;
      assert.strictEqual(after, Buffer.byteLength(huge, 'utf8'));
    } finally {
      rimraf(state);
    }
  });

  await test('plugin dataDir shadow logs are targets', function () {
    const state = tempState();
    try {
      const pluginDir = path.join(state, 'data', 'marust', 'plugins', 'gcal');
      const dir = path.join(state, 'logs', 'marust');
      writeRaw(pluginDir, 'shadow-' + day31 + '.jsonl', '{"op":"create"}\n');
      writeRaw(pluginDir, 'shadow-' + todayName + '.jsonl', '{"op":"today"}\n');
      writeRaw(pluginDir, 'config.json', '{"calendarId":"x"}\n');
      writeRaw(pluginDir, 'engine-' + day31 + '.jsonl', '{"keep":true}\n');
      writeRaw(dir, 'shadow-' + day30 + '.jsonl');
      const extra = path.join(state, 'extra-plugin');
      writeRaw(extra, 'shadow-' + day31 + '.jsonl', '{"via":"dataDir"}\n');
      const api = retention(state, today, { plugins: [{ id: 'gcal' }, { dataDir: extra }] });
      const result = api.runOnce();
      assert.strictEqual(exists(pluginDir, 'shadow-' + day31 + '.jsonl'), false);
      assert.strictEqual(exists(pluginDir, 'shadow-' + todayName + '.jsonl'), true);
      assert.strictEqual(exists(pluginDir, 'config.json'), true);
      assert.strictEqual(exists(pluginDir, 'engine-' + day31 + '.jsonl'), true);
      assert.strictEqual(exists(extra, 'shadow-' + day31 + '.jsonl'), false);
      assert.ok(result.deleted >= 2);
      const logged = api.lines.join('\n');
      assert.ok(logged.indexOf('gcal/shadow-' + day31 + '.jsonl') !== -1);
    } finally {
      rimraf(state);
    }
  });

  await test('config days validate 1 and 3650, reject bad values', function () {
    function run(config, age, prefix) {
      const state = tempState();
      try {
        const dir = path.join(state, 'logs', 'marust');
        const name = prefix + '-' + ymd(shift(today, -age)) + '.jsonl';
        writeRaw(dir, name);
        if (config != null) {
          const file = path.join(state, 'data', 'marust', 'log-retention.json');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const body = typeof config === 'string' ? config : JSON.stringify(config);
          fs.writeFileSync(file, body, 'utf8');
        }
        retention(state, today).runOnce();
        return exists(dir, name);
      } finally {
        rimraf(state);
      }
    }

    assert.strictEqual(run({ ordinaryDays: 1 }, 2, 'shadow'), false);
    assert.strictEqual(run({ ordinaryDays: 1 }, 1, 'shadow'), true);
    assert.strictEqual(run({ ordinaryDays: 1 }, 0, 'engine'), true);
    assert.strictEqual(run({ ordinaryDays: 3650 }, 3650, 'shadow'), true);
    assert.strictEqual(run({ ordinaryDays: 3650 }, 3651, 'engine'), false);
    assert.strictEqual(run({ auditDays: 1 }, 2, 'api'), false);
    assert.strictEqual(run({ auditDays: 3650 }, 3651, 'vault'), false);
    assert.strictEqual(run({ auditDays: 3650 }, 3650, 'emergency'), true);

    assert.strictEqual(run({ ordinaryDays: 0 }, 2, 'shadow'), true);
    assert.strictEqual(run({ ordinaryDays: 0 }, 31, 'shadow'), false);
    assert.strictEqual(run({ ordinaryDays: -3 }, 2, 'engine'), true);
    assert.strictEqual(run({ ordinaryDays: 3651 }, 31, 'shadow'), false);
    assert.strictEqual(run({ ordinaryDays: 3651 }, 2, 'shadow'), true);
    assert.strictEqual(run({ ordinaryDays: 1.5 }, 2, 'shadow'), true);
    assert.strictEqual(run({ ordinaryDays: '30' }, 31, 'engine'), false);
    assert.strictEqual(run({ auditDays: 0 }, 31, 'api'), true);
    assert.strictEqual(run({ auditDays: -1 }, 181, 'vault'), false);
    assert.strictEqual(run({ auditDays: 3651 }, 181, 'emergency'), false);
    assert.strictEqual(run({ auditDays: 10.2 }, 31, 'api'), true);
    assert.strictEqual(run('{', 31, 'shadow'), false);
    assert.strictEqual(run(null, 31, 'api'), true);
  });

  await test('appendJsonl rotates at maxBytes without reading logs', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w30-writer-'));
    try {
      withReadSpies(function () {
        const now = new Date(2026, 0, 2, 8, 0, 0);
        const maxBytes = 20;
        const record = { n: 1 };
        const lineBytes = Buffer.byteLength(JSON.stringify(record) + '\n', 'utf8');
        assert.ok(lineBytes < maxBytes);
        assert.strictEqual(appendJsonl(dir, 'shadow', record, { maxBytes: maxBytes, now: now }), true);
        assert.strictEqual(appendJsonl(dir, 'shadow', record, { maxBytes: maxBytes, now: now }), true);
        const first = path.join(dir, 'shadow-20260102.jsonl');
        const size = fs.statSync(first).size;
        assert.ok(size <= maxBytes);
        assert.ok(size + lineBytes > maxBytes);
        assert.strictEqual(appendJsonl(dir, 'shadow', record, { maxBytes: maxBytes, now: now }), true);
        const second = path.join(dir, 'shadow-20260102-2.jsonl');
        assert.strictEqual(fs.existsSync(second), true);
        const blocker = path.join(dir, 'blocked');
        fs.writeFileSync(blocker, 'x');
        assert.strictEqual(appendJsonl(blocker, 'shadow', record, { maxBytes: maxBytes }), false);
        const nested = path.join(dir, 'nested', 'more');
        assert.strictEqual(appendJsonl(nested, 'engine', { ok: true }, { maxBytes: 100, now: now }), true);
        assert.strictEqual(fs.existsSync(path.join(nested, 'engine-20260102.jsonl')), true);
      });
      const firstText = fs.readFileSync(path.join(dir, 'shadow-20260102.jsonl'), 'utf8');
      const secondText = fs.readFileSync(path.join(dir, 'shadow-20260102-2.jsonl'), 'utf8');
      assert.strictEqual(firstText.split('\n').filter(Boolean).length, 2);
      assert.strictEqual(secondText.trim(), JSON.stringify({ n: 1 }));
    } finally {
      rimraf(dir);
    }
  });

  await test('sweep does not read log contents', function () {
    const state = tempState();
    try {
      const dir = path.join(state, 'logs', 'marust');
      const pluginDir = path.join(state, 'data', 'marust', 'plugins', 'notify-discord');
      writeRaw(dir, 'shadow-' + day31 + '.jsonl', '{"secret":"nope"}\n');
      writeRaw(dir, 'api-' + todayName + '.jsonl', '{"secret":"today"}\n');
      writeRaw(pluginDir, 'shadow-' + day181 + '.jsonl', '{"content":"hidden"}\n');
      const cfg = path.join(state, 'data', 'marust', 'log-retention.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ ordinaryDays: 30, auditDays: 180 }), 'utf8');
      withReadSpies(function (calls) {
        const api = retention(state, today);
        const result = api.runOnce();
        const view = api.status();
        assert.strictEqual(result.deleted, 2);
        assert.ok(view.files >= 1);
        assert.ok(view.bytes > 0);
        assert.strictEqual(appendJsonl(dir, 'vault', { ok: true }, { maxBytes: 64, now: today }), true);
        for (let i = 0; i < calls.length; i += 1) {
          assert.ok(!/\.jsonl$/i.test(calls[i]), calls[i]);
        }
        assert.ok(calls.some(function (item) { return item.indexOf('log-retention.json') !== -1; }));
      });
      assert.strictEqual(exists(dir, 'shadow-' + day31 + '.jsonl'), false);
      assert.strictEqual(exists(pluginDir, 'shadow-' + day181 + '.jsonl'), false);
    } finally {
      rimraf(state);
    }
  });

  await test('start runs once and every 24 hours, stop clears', function () {
    const state = tempState();
    const dir = path.join(state, 'logs', 'marust');
    writeRaw(dir, 'shadow-' + day31 + '.jsonl');
    const scheduled = [];
    const cleared = [];
    const origClear = global.clearInterval;
    global.clearInterval = function (handle) { cleared.push(handle); };
    try {
      const api = createLogRetention({
        core: { STATE_DIR: state },
        logger: function () {},
        now: function () { return today; },
        setIntervalFn: function (fn, ms) {
          scheduled.push({ fn: fn, ms: ms });
          return { tag: 'w30-timer' };
        }
      });
      api.start();
      api.start();
      assert.strictEqual(exists(dir, 'shadow-' + day31 + '.jsonl'), false);
      assert.strictEqual(scheduled.length, 1);
      assert.strictEqual(scheduled[0].ms, 24 * 60 * 60 * 1000);
      api.stop();
      assert.deepStrictEqual(cleared, [{ tag: 'w30-timer' }]);
      api.stop();
      assert.strictEqual(cleared.length, 1);
    } finally {
      global.clearInterval = origClear;
      rimraf(state);
    }
  });
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
}).then(function () {
  if (failed) {
    console.error('[marust] w30 log retention tests failed ' + failed);
    process.exit(1);
  }
  console.log('[marust] w30 log retention tests passed');
});
