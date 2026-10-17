'use strict';
require('../../../test/_ui-inline');
const { hubSource } = require('../../../test/_ui-source');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { analyze, LOG_LIMIT_BYTES } = require('../lib/diagnose');
const { collectFacts } = require('../../../host/layer1/diagnostics-facts');
// K3: 材料は核（diagnostics-facts）、文はプラグイン（diagnose）。今までの試験は 2 つをつないで流す
async function run(deps) { return analyze(await collectFacts(deps)); }
const { createApi } = require('../../../host/layer1/api');
const cli = require('../../../cli/marust');

const TOKEN = 'PLANTED_TOKEN_VALUE_9f3a';
const COOKIE = 'PLANTED_COOKIE_VALUE_9f3a';
const PASSWORD = 'PLANTED_PASSWORD_VALUE_9f3a';
const CLI = path.join(__dirname, '..', '..', '..', 'cli', 'marust.js');

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

function codes(result) {
  return result.findings.map(function (row) { return row.code; });
}

function one(result, code) {
  return result.findings.find(function (row) { return row.code === code; });
}

function base(extra) {
  return Object.assign({
    uptimeMs: 1500,
    gateway: { listening: true },
    plugins: [],
    engine: {
      id: 'obs-local',
      status: function () { return { connected: true, supported: true, mode: 'live' }; }
    },
    vault: { usable: true },
    logStat: function () { return { totalBytes: 10, recentErrors: [] }; },
    stateReader: function () { return { readOnly: false, schemaVersion: 1 }; },
    modesReader: function () { return { ok: true, missing: true }; },
    skipDisk: true,
    skipNetwork: true
  }, extra || {});
}

function assertNoSecrets(result) {
  const text = JSON.stringify(result);
  assert.strictEqual(text.indexOf(TOKEN), -1);
  assert.strictEqual(text.indexOf(COOKIE), -1);
  assert.strictEqual(text.indexOf(PASSWORD), -1);
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [CLI].concat(args), {
      cwd: path.join(__dirname, '..', '..', '..'),
      env: Object.assign({}, process.env, env || {}),
      windowsHide: true
    });
    const out = [];
    const err = [];
    child.stdout.on('data', function (chunk) { out.push(chunk); });
    child.stderr.on('data', function (chunk) { err.push(chunk); });
    child.on('error', reject);
    child.on('close', function (code) {
      resolve({ code: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

async function main() {
  await test('agent-uptime is ok when uptime is known', async function () {
    const result = await run(base({ uptimeMs: 2500 }));
    const row = one(result, 'agent-uptime');
    assert.ok(row);
    assert.strictEqual(row.level, 'ok');
    assert.ok(row.detail.indexOf('2') !== -1);
  });

  await test('gateway-listening warns when the window is not listening', async function () {
    const up = await run(base({ gateway: { listening: true } }));
    assert.strictEqual(one(up, 'gateway-listening').level, 'ok');
    const down = await run(base({ gateway: { listening: false } }));
    const row = one(down, 'gateway-listening');
    assert.ok(row.level === 'warn' || row.level === 'error');
  });

  await test('plugin-start-failed includes the plugin id', async function () {
    const result = await run(base({
      plugins: [{ id: 'alpha', status: 'start-failed', mode: 'legacy', reason: 'timeout' }]
    }));
    const row = one(result, 'plugin-start-failed');
    assert.strictEqual(row.level, 'error');
    assert.ok(row.detail.indexOf('alpha') !== -1);
    assert.ok(codes(result).indexOf('plugin-status') === -1);
  });

  await test('plugin-stuck when a plugin is stuck', async function () {
    const result = await run(base({
      plugins: [{ id: 'beta', status: 'running', mode: 'shadow', stuck: true }]
    }));
    const row = one(result, 'plugin-stuck');
    assert.strictEqual(row.level, 'warn');
    assert.ok(row.detail.indexOf('beta') !== -1);
    assert.ok(row.detail.indexOf('shadow') !== -1);
  });

  await test('plugin-stuck from orchestrator health without copying health values', async function () {
    const result = await run(base({
      plugins: [{ id: 'gamma', status: 'running', mode: 'live' }],
      orchestrator: {
        health: function () {
          return [{ id: 'gamma', stuck: true, health: { token: TOKEN }, message: 'cookie=' + COOKIE }];
        }
      }
    }));
    assert.ok(one(result, 'plugin-stuck'));
    assertNoSecrets(result);
  });

  await test('healthy plugin reports status and mode', async function () {
    const result = await run(base({
      plugins: [{ id: 'delta', status: 'running', mode: 'live' }]
    }));
    const row = one(result, 'plugin-status');
    assert.strictEqual(row.level, 'ok');
    assert.ok(row.detail.indexOf('delta') !== -1);
    assert.ok(row.detail.indexOf('live') !== -1);
  });

  await test('engine-disconnected and engine-unsupported', async function () {
    const result = await run(base({
      engine: {
        id: 'obs-local',
        status: function () { return { connected: false, supported: false, detail: 'token=' + TOKEN }; }
      }
    }));
    assert.strictEqual(one(result, 'engine-disconnected').level, 'error');
    assert.strictEqual(one(result, 'engine-unsupported').level, 'error');
    assert.ok(!one(result, 'engine-status'));
    assertNoSecrets(result);
  });

  await test('connected supported engine is ok', async function () {
    const result = await run(base());
    assert.strictEqual(one(result, 'engine-status').level, 'ok');
    assert.ok(!one(result, 'engine-disconnected'));
  });

  await test('vault-unavailable when the vault cannot be used', async function () {
    const result = await run(base({
      vault: {
        usable: false,
        describe: function () { return { secret: { value: TOKEN, cookie: COOKIE } }; },
        get: function () { throw new Error('opened ' + PASSWORD); }
      }
    }));
    assert.strictEqual(one(result, 'vault-unavailable').level, 'error');
    assertNoSecrets(result);
  });

  await test('vault describe body is not copied', async function () {
    const result = await run(base({
      vault: {
        describe: function () { return { ok: true, secret: { value: TOKEN }, note: 'cookie=' + COOKIE }; },
        get: function () { throw new Error('opened ' + PASSWORD); },
        list: function () { return { secrets: [{ value: TOKEN }] }; },
        usable: true
      }
    }));
    assert.strictEqual(one(result, 'vault-status').level, 'ok');
    assertNoSecrets(result);
  });

  await test('logs-large when total size exceeds 500 MB', async function () {
    const under = await run(base({ logStat: function () { return { totalBytes: LOG_LIMIT_BYTES, recentErrors: [] }; } }));
    assert.ok(!one(under, 'logs-large'));
    const over = await run(base({
      logStat: function () {
        return {
          totalBytes: LOG_LIMIT_BYTES + 1,
          names: ['shadow-' + TOKEN + '.jsonl'],
          note: 'password=' + PASSWORD,
          recentErrors: ['token=' + TOKEN, 'cookie=' + COOKIE, 'start-failed']
        };
      }
    }));
    assert.strictEqual(one(over, 'logs-large').level, 'warn');
    assert.deepStrictEqual(over.recentErrors, ['start-failed']);
    assertNoSecrets(over);
  });

  await test('state-read-only when the state file is a newer version', async function () {
    const current = await run(base({ stateReader: function () { return { schemaVersion: 1, readOnly: false, note: TOKEN }; } }));
    assert.ok(!one(current, 'state-read-only'));
    const newer = await run(base({ stateReader: function () { return { schemaVersion: 2, blob: COOKIE }; } }));
    assert.strictEqual(one(newer, 'state-read-only').level, 'warn');
    assertNoSecrets(newer);
  });

  await test('modes-unreadable when marust-modes cannot be read', async function () {
    const missing = await run(base({ modesReader: function () { return { ok: true, missing: true, detail: TOKEN }; } }));
    assert.ok(!one(missing, 'modes-unreadable'));
    const bad = await run(base({ modesReader: function () { return { ok: false, error: 'unreadable', password: PASSWORD }; } }));
    assert.strictEqual(one(bad, 'modes-unreadable').level, 'error');
    assertNoSecrets(bad);
  });

  await test('disk log names and bodies do not leak', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w32-logs-'));
    try {
      const logDir = path.join(dir, 'logs', 'marust');
      fs.mkdirSync(logDir, { recursive: true });
      const body = '{"error":"load-failed","token":"' + TOKEN + '","cookie":"' + COOKIE + '"}\n';
      fs.writeFileSync(path.join(logDir, 'api-' + TOKEN + '.jsonl'), body);
      const result = await run(base({
        logStat: undefined,
        core: { STATE_DIR: dir },
        skipDisk: false
      }));
      assert.ok(result.recentErrors.indexOf('load-failed') !== -1);
      assertNoSecrets(result);
    } finally {
      rimraf(dir);
    }
  });

  await test('a hanging dependency still resolves within 5 seconds', async function () {
    const started = Date.now();
    const result = await run(base({
      registry: { snapshot: function () { return new Promise(function () {}); } },
      plugins: undefined,
      logStat: function () { return new Promise(function () {}); },
      vault: { usable: function () { return new Promise(function () {}); } },
      gateway: { listening: function () { return new Promise(function () {}); } }
    }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, 'elapsed ' + elapsed);
    assert.ok(result && Array.isArray(result.findings));
    assert.ok(one(result, 'agent-uptime'));
  });

  await test('diagnostics.facts is a read method; diagnostics.run is the plugin\'s (read, same name as before)', async function () {
    const api = createApi({
      startedAt: Date.now() - 4000,
      gateway: { listening: true },
      engine: { id: 'obs-local', status: function () { return { connected: true, supported: true, mode: 'shadow' }; } },
      secrets: { usable: true },
      store: { isReadOnly: function () { return false; } },
      getState: function () { return { plugins: [{ id: 'alpha', status: 'running', mode: 'live' }] }; },
      logStat: function () { return { totalBytes: 4, recentErrors: [] }; },
      modesReader: function () { return { ok: true, missing: true }; },
      skipDisk: true,
      skipNetwork: true
    });
    assert.strictEqual(api.permissionFor('diagnostics.facts'), 'read');
    assert.strictEqual(api.permissionFor('diagnostics.run'), '', 'diagnostics.run は本体には無い（プラグインが出す）');
    const described = await api.call('api.describe', {});
    const row = described.methods.find(function (item) { return item.method === 'diagnostics.facts'; });
    assert.strictEqual(row.permission, 'read');
    assert.strictEqual(row.windowOnly, false);
    const facts = await api.call('diagnostics.facts', {}, { permissions: ['read'], kind: 'native', clientId: 'cli' });
    assert.strictEqual(facts.ok, true);
    const result = analyze(facts);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(one(result, 'plugin-status').detail.indexOf('alpha') !== -1, true);
    assert.strictEqual(one(result, 'gateway-listening').level, 'ok');
    assertNoSecrets(result);
  });

  await test('formatDoctor prints a colored list and json', async function () {
    const body = {
      ok: false,
      findings: [
        { area: 'agent', level: 'ok', code: 'agent-uptime', label: 'Agent の稼働時間', detail: '\u7a3c\u50cd 1 \u79d2' },
        { area: 'plugin', level: 'error', code: 'plugin-start-failed', label: 'プラグインの起動に失敗', detail: 'alpha' }
      ],
      recentErrors: ['start-failed']
    };
    const human = cli.formatDoctor(body, { color: true });
    assert.ok(human.indexOf('\u001b[32m') !== -1);
    assert.ok(human.indexOf('\u001b[31m') !== -1);
    assert.ok(human.indexOf('agent-uptime') !== -1);
    assert.ok(human.indexOf('Agent \u306e\u7a3c\u50cd\u6642\u9593') !== -1);
    assert.ok(human.indexOf('plugin-start-failed') !== -1);
    assert.ok(human.indexOf('\u30d7\u30e9\u30b0\u30a4\u30f3\u306e\u8d77\u52d5\u306b\u5931\u6557') !== -1);
    assert.strictEqual(cli.formatDoctor(body, { json: true }), JSON.stringify(body));
  });

  await test('runDoctor uses an injected client', async function () {
    const outcome = await cli.runDoctor({
      client: {
        call: async function (method) {
          assert.strictEqual(method, 'diagnostics.run');
          return { ok: true, findings: [{ area: 'agent', level: 'ok', code: 'agent-uptime', detail: 'x' }], recentErrors: [] };
        }
      }
    });
    assert.strictEqual(outcome.down, false);
    assert.strictEqual(outcome.result.findings[0].code, 'agent-uptime');
  });

  await test('runDoctor reports not running without hanging', async function () {
    const started = Date.now();
    const outcome = await cli.runDoctor({
      flags: { port: 1 },
      loadToken: function () { return 'abc'; },
      connect: function () { return Promise.reject(new Error('down')); }
    });
    assert.strictEqual(outcome.down, true);
    assert.ok(Date.now() - started < 1000);
    assert.strictEqual(cli.AGENT_DOWN_LINE, 'Agent \u304c\u52d5\u3044\u3066\u3044\u307e\u305b\u3093');
    assert.ok(cli.AGENT_START_HINT.indexOf('npm run start:app') !== -1);
  });

  await test('doctor says the agent is not running', async function () {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w32-cli-'));
    try {
      fs.mkdirSync(path.join(state, 'services'), { recursive: true });
      fs.writeFileSync(path.join(state, 'services', 'marust-cli.json'), JSON.stringify({ token: 'ab'.repeat(32), name: 'CLI' }));
      const downPort = await new Promise(function (resolve) {
        const net = require('net');
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1', function () {
          const n = probe.address().port;
          probe.close(function () { resolve(n); });
        });
      });
      const started = Date.now();
      const down = await runCli(['doctor', '--port', String(downPort)], { SCRIPTS_STATE: state });
      assert.ok(Date.now() - started < 5000, 'elapsed');
      assert.notStrictEqual(down.code, 0);
      assert.ok(down.stderr.indexOf('Agent \u304c\u52d5\u3044\u3066\u3044\u307e\u305b\u3093') !== -1);
      assert.ok(down.stderr.indexOf('npm run start:app') !== -1);
      assert.strictEqual(down.stdout.indexOf('ab'.repeat(32)), -1);
      assert.strictEqual(down.stderr.indexOf('ab'.repeat(32)), -1);
      const json = cli.formatDoctor({ ok: true, findings: [], recentErrors: [] }, { json: true });
      assert.strictEqual(json, '{"ok":true,"findings":[],"recentErrors":[]}');
    } finally {
      rimraf(state);
    }
  });

  await test('the diagnostics panel is the plugin\'s iframe panel (K3), not the hub\'s', async function () {
    const hub = hubSource();
    const dir = path.join(__dirname, '..', '..', '..', 'plugins', 'diagnostics', 'ui');
    const panel = fs.readFileSync(path.join(dir, 'panel.js'), 'utf8');
    const css = fs.readFileSync(path.join(dir, 'panel.css'), 'utf8');
    assert.ok(hub.indexOf("call('diagnostics.run')") === -1, 'hub には診断のパネルの旧い実装は無い');
    assert.ok(panel.indexOf("'diagnostics.run'") !== -1);
    assert.ok(fs.readFileSync(path.join(dir, 'panel.html'), 'utf8').indexOf('diagnostics-run') !== -1);
    assert.ok(css.indexOf('.diag-ok') !== -1);
    assert.ok(css.indexOf('.diag-warn') !== -1);
    assert.ok(css.indexOf('.diag-error') !== -1);
    // 画面の言葉は旧い strings.js と同じ（コピーのずれを防ぐ）
    const STR = require('../../../plugins/ui-standard/shell/strings');
    const labels = require('../lib/diagnose').CODE_LABELS;
    Object.keys(labels).forEach(function (code) { assert.ok(panel.indexOf("'" + labels[code] + "'") !== -1, code); });
    void STR;
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w32-diagnostics ok');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});