'use strict';
require('../../../test/_ui-inline');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { report, setRedact, FILE_LIMIT, TOTAL_LIMIT } = require('../lib/report');
setRedact(require('../../../host/core/safe-runner').redact); // 本物では dev-shadow が ctx.redact を渡す
const { createApi } = require('../../../host/layer1/api');
const cli = require('../../../cli/marust');
const { attachDevShadow } = require('../../../test/_dev-shadow');

const CLI = path.join(__dirname, '..', '..', '..', 'cli', 'marust.js');
const NOW = new Date(2026, 9, 5, 15, 0, 0);
const SECRET = 's3cret-value';
const TOKEN = 'abcdef-token';
const HIDDEN = 'hideme';

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

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w35-'));
}

function writeRaw(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function hostFile(root, name) {
  return path.join(root, 'logs', 'marust', name);
}

function pluginFile(root, id, name) {
  return path.join(root, 'data', 'marust', 'plugins', id, name);
}

function line(record) {
  return JSON.stringify(record) + '\n';
}

function baseOptions(root, extra) {
  return Object.assign({ root: root, now: NOW, days: 7 }, extra || {});
}

/**
 * shadow-report の report() は options.now で「今」を外から受け取れる。
 * そのため、report() を直接呼ぶテストは固定の NOW を使う。
 * ただし host/core/api.js の shadow.report は注入された時計を使わず本物の時計で動くので、
 * API 経由のテストだけはファイル名を「今日」から作る。どちらの日付でも同じ結果になる。
 */
function ymdOf(date) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
}

function todayYmd() {
  return ymdOf(new Date());
}

function isoDayOf(ymd) {
  return ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
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

function seed(root) {
  const longTitle = 'あ'.repeat(25);
  writeRaw(hostFile(root, 'shadow-20261005.jsonl'), [
    line({
      ts: '2026-10-05T01:00:00.000+09:00',
      kind: 'fanout',
      title: { length: longTitle.length, head: longTitle },
      sites: [
        { id: 'rumble', result: 'ok', message: '', mode: 'shadow' },
        { id: 'youtube', result: 'error', message: 'rate-limit', mode: 'shadow' },
        { id: 'twitch', result: 'skip', message: 'legacy-mode', mode: 'legacy' },
        { id: 'kick', result: 'ok', message: '', mode: 'live' }
      ]
    }),
    line({
      ts: '2026-10-05T02:00:00.000+09:00',
      kind: 'obs',
      title: { length: 4, head: '夜の配信' },
      sites: [{ id: 'rumble', result: 'ok', message: '', mode: 'shadow' }]
    })
  ].join(''));
  writeRaw(hostFile(root, 'shadow-20261005-2.jsonl'), line({
    ts: '2026-10-05T03:00:00.000+09:00',
    kind: 'fanout',
    title: { length: 2, head: '分割' },
    sites: [{ id: 'rumble', result: 'error', message: 'timeout', mode: 'orchestrator' }]
  }));
  writeRaw(hostFile(root, 'shadow-20261004.jsonl'), line({
    ts: '2026-10-04T09:00:00.000+09:00',
    kind: 'fanout',
    title: { length: 2, head: '昨日' },
    sites: [{ id: 'youtube', result: 'ok', message: '', mode: 'shadow' }]
  }));
  writeRaw(hostFile(root, 'shadow-20260901.jsonl'), line({
    ts: '2026-09-01T09:00:00.000+09:00',
    kind: 'fanout',
    title: { length: 2, head: '古い' },
    sites: [{ id: 'old-site', result: 'ok', message: '', mode: 'shadow' }]
  }));
  writeRaw(hostFile(root, 'engine-20261005.jsonl'), line({
    ts: '2026-10-05T01:00:00.000+09:00',
    sites: [{ id: 'engine-site', result: 'ok', message: '', mode: 'shadow' }]
  }));
  writeRaw(hostFile(root, 'shadow-20261005-1.jsonl'), line({
    ts: '2026-10-05T01:00:00.000+09:00',
    sites: [{ id: 'bad-part', result: 'ok', message: '', mode: 'shadow' }]
  }));
  writeRaw(hostFile(root, 'shadow-20260231.jsonl'), line({
    ts: '2026-02-31T01:00:00.000+09:00',
    sites: [{ id: 'bad-day', result: 'ok', message: '', mode: 'shadow' }]
  }));
  writeRaw(pluginFile(root, 'gcal', 'shadow-20261005.jsonl'), line({
    op: 'create',
    title: '作業配信',
    start: '2026-10-05T01:00:00.000+09:00',
    end: '2026-10-05T02:00:00.000+09:00'
  }));
  writeRaw(pluginFile(root, 'notify-discord', 'shadow-20261005.jsonl'), line({
    at: '2026-10-05T03:00:00.000+09:00',
    kind: 'live',
    content: '配信を開始しました'
  }));
  writeRaw(pluginFile(root, 'raid-twitch', 'shadow-20261005.jsonl'), [
    line({ at: '2026-10-05T04:00:00.000+09:00', skipped: 'legacy', ok: true, login: 'skipme' }),
    line({ at: '2026-10-05T05:00:00.000+09:00', mode: 'shadow', dryRun: true, ok: false, error: 'helix-failed', login: 'someone' })
  ].join(''));
}

async function main() {
  await test('aggregation counts shadow sends, plugins, and skips live or legacy', async function () {
    const root = tempRoot();
    try {
      seed(root);
      const result = report(baseOptions(root));
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.broken, 0);
      assert.strictEqual(result.sites.rumble.count, 3);
      assert.deepStrictEqual(result.sites.rumble.samples, ['あ'.repeat(20), '夜の配信', '分割']);
      assert.strictEqual(result.sites.rumble.lastAt, '2026-10-05T03:00:00.000+09:00');
      assert.strictEqual(result.sites.rumble.errors.timeout, 1);
      assert.strictEqual(result.sites.youtube.count, 2);
      assert.strictEqual(result.sites.youtube.errors['rate-limit'], 1);
      assert.strictEqual(result.sites.twitch, undefined);
      assert.strictEqual(result.sites.kick, undefined);
      assert.strictEqual(result.sites['old-site'], undefined);
      assert.strictEqual(result.sites['engine-site'], undefined);
      assert.strictEqual(result.sites['bad-part'], undefined);
      assert.strictEqual(result.sites['bad-day'], undefined);
      assert.strictEqual(result.plugins.gcal.count, 1);
      assert.deepStrictEqual(result.plugins.gcal.samples, ['作業配信']);
      assert.strictEqual(result.plugins.gcal.lastAt, '2026-10-05T01:00:00.000+09:00');
      assert.strictEqual(result.plugins.notify.count, 1);
      assert.deepStrictEqual(result.plugins.notify.samples, ['配信を開始しました']);
      assert.strictEqual(result.plugins.raid.count, 1);
      assert.deepStrictEqual(result.plugins.raid.samples, ['someone']);
      assert.strictEqual(result.plugins.raid.errors['helix-failed'], 1);
      assert.deepStrictEqual(result.days.map(function (row) { return row.date; }), ['2026-10-04', '2026-10-05']);
      const today = result.days[1];
      assert.strictEqual(today.sites.rumble.count, 3);
      assert.strictEqual(today.plugins.gcal.count, 1);
      assert.strictEqual(FILE_LIMIT, 20 * 1024 * 1024);
      assert.strictEqual(TOTAL_LIMIT, 200 * 1024 * 1024);
    } finally {
      rimraf(root);
    }
  });

  await test('days and site filters limit the window and the sites', async function () {
    const root = tempRoot();
    try {
      seed(root);
      const one = report(baseOptions(root, { days: 1 }));
      assert.strictEqual(one.sites.youtube.count, 1);
      assert.strictEqual(one.sites.youtube.errors['rate-limit'], 1);
      assert.deepStrictEqual(one.days.map(function (row) { return row.date; }), ['2026-10-05']);
      const two = report(baseOptions(root, { days: 2, site: 'rumble' }));
      assert.deepStrictEqual(Object.keys(two.sites), ['rumble']);
      assert.strictEqual(two.sites.rumble.count, 3);
      assert.strictEqual(two.plugins.gcal.count, 1);
      assert.strictEqual(two.plugins.notify.count, 1);
      assert.strictEqual(two.plugins.raid.count, 1);
      const bad = report(baseOptions(root, { days: 0 }));
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.error, 'bad-days');
      const missing = report({ days: 1 });
      assert.strictEqual(missing.ok, false);
      assert.strictEqual(missing.error, 'unavailable');
    } finally {
      rimraf(root);
    }
  });

  await test('oversized file and total budget stop mid-way', async function () {
    const root = tempRoot();
    try {
      const kept = line({
        ts: '2026-10-05T01:00:00.000+09:00',
        kind: 'fanout',
        title: { length: 4, head: '残る' },
        sites: [{ id: 'rumble', result: 'ok', message: '', mode: 'shadow' }]
      });
      const tail = line({
        ts: '2026-10-05T02:00:00.000+09:00',
        kind: 'fanout',
        title: { length: 8, head: 'password=' + SECRET },
        sites: [{ id: 'youtube', result: 'ok', message: '', mode: 'shadow' }]
      });
      writeRaw(hostFile(root, 'shadow-20261005.jsonl'), kept + tail);
      writeRaw(pluginFile(root, 'gcal', 'shadow-20261005.jsonl'), line({
        op: 'create',
        title: 'password=' + SECRET,
        start: '2026-10-05T03:00:00.000+09:00'
      }));
      const fileCut = report(baseOptions(root, { maxFileBytes: Buffer.byteLength(kept) }));
      assert.strictEqual(fileCut.truncated, true);
      assert.strictEqual(fileCut.sites.rumble.count, 1);
      assert.strictEqual(fileCut.sites.youtube, undefined);
      assert.strictEqual(fileCut.plugins.gcal.count, 0);
      assert.strictEqual(JSON.stringify(fileCut).indexOf(SECRET), -1);

      const root2 = tempRoot();
      try {
        const first = line({
          ts: '2026-10-05T01:00:00.000+09:00',
          kind: 'fanout',
          title: { length: 2, head: '先' },
          sites: [{ id: 'rumble', result: 'ok', message: '', mode: 'shadow' }]
        });
        writeRaw(hostFile(root2, 'shadow-20261005.jsonl'), first);
        writeRaw(pluginFile(root2, 'notify-discord', 'shadow-20261005.jsonl'), line({
          at: '2026-10-05T04:00:00.000+09:00',
          kind: 'live',
          content: 'password=' + SECRET
        }));
        const totalCut = report(baseOptions(root2, { maxTotalBytes: Buffer.byteLength(first) }));
        assert.strictEqual(totalCut.truncated, true);
        assert.strictEqual(totalCut.sites.rumble.count, 1);
        assert.strictEqual(totalCut.plugins.notify.count, 0);
        assert.strictEqual(JSON.stringify(totalCut).indexOf(SECRET), -1);
      } finally {
        rimraf(root2);
      }
    } finally {
      rimraf(root);
    }
  });

  await test('broken lines are counted and do not throw', async function () {
    const root = tempRoot();
    try {
      const body = [
        '{bad',
        'not json',
        '',
        line({ op: 'create', title: 'ok', start: '2026-10-05T01:00:00.000Z' }),
        '[]\n'
      ].join('\n');
      writeRaw(pluginFile(root, 'gcal', 'shadow-20261005.jsonl'), body);
      const result = report(baseOptions(root, { days: 1 }));
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.broken, 3);
      assert.strictEqual(result.plugins.gcal.count, 1);
      assert.deepStrictEqual(result.plugins.gcal.samples, ['ok']);
    } finally {
      rimraf(root);
    }
  });

  await test('secret-like strings are redacted', async function () {
    const root = tempRoot();
    try {
      writeRaw(hostFile(root, 'shadow-20261005.jsonl'), line({
        ts: '2026-10-05T01:00:00.000+09:00',
        kind: 'fanout',
        title: { length: 20, head: 'password=' + SECRET },
        sites: [{ id: 'rumble', result: 'error', message: 'token=' + HIDDEN, mode: 'shadow' }]
      }));
      writeRaw(pluginFile(root, 'notify-discord', 'shadow-20261005.jsonl'), line({
        at: '2026-10-05T02:00:00.000+09:00',
        kind: 'live',
        content: 'token: ' + TOKEN
      }));
      const result = report(baseOptions(root, { days: 1 }));
      const text = JSON.stringify(result);
      assert.strictEqual(text.indexOf(SECRET), -1);
      assert.strictEqual(text.indexOf(TOKEN), -1);
      assert.strictEqual(text.indexOf(HIDDEN), -1);
      assert.ok(result.sites.rumble.samples[0].indexOf('password=') === 0);
      assert.ok(result.sites.rumble.errors['token=***'] >= 1 || result.sites.rumble.errors['token=***'] === 1);
      assert.strictEqual(result.plugins.notify.samples[0].indexOf(TOKEN), -1);
      assert.ok(result.plugins.notify.samples[0].indexOf('***') !== -1);
    } finally {
      rimraf(root);
    }
  });

  await test('CLI display and --json', async function () {
    const body = {
      ok: true,
      days: [{ date: '2026-10-05' }],
      sites: {
        rumble: { count: 2, lastAt: '2026-10-05T03:00:00.000+09:00', samples: ['夜の配信'], errors: { 'rate-limit': 1 } }
      },
      plugins: {
        gcal: { count: 1, lastAt: '2026-10-05T01:00:00.000+09:00', samples: ['作業配信'], errors: {} }
      },
      truncated: false,
      broken: 1
    };
    const human = cli.formatShadowReport(body, { days: 7 });
    assert.ok(human.indexOf('shadow の報告') !== -1);
    assert.ok(human.indexOf('rumble') !== -1);
    assert.ok(human.indexOf('回数 2') !== -1);
    assert.ok(human.indexOf('見本 夜の配信') !== -1);
    assert.ok(human.indexOf('rate-limit 1') !== -1);
    assert.ok(human.indexOf('gcal') !== -1);
    assert.ok(human.indexOf('壊れた行: 1') !== -1);
    assert.strictEqual(cli.formatShadowReport(body, { json: true }), JSON.stringify(body));
    let seen = null;
    const outcome = await cli.runShadowReport({
      flags: { days: '3', site: 'rumble', json: true, port: 1 },
      client: {
        call: function (method, params) {
          seen = { method: method, params: params };
          return Promise.resolve(body);
        }
      }
    });
    assert.strictEqual(outcome.down, false);
    assert.strictEqual(seen.method, 'shadow.report');
    assert.strictEqual(seen.params.days, 3);
    assert.strictEqual(seen.params.site, 'rumble');
    assert.strictEqual(cli.formatShadowReport(outcome.result, { json: true }), JSON.stringify(body));
    const bad = await cli.runShadowReport({ flags: { days: '99' }, connect: function () { throw new Error('should-not-connect'); } });
    assert.strictEqual(bad.result.error, 'bad-days');
  });

  await test('CLI command rejects bad days and does not connect without a token', async function () {
    const state = tempRoot();
    try {
      const bad = await runCli(['shadow-report', '--days', '0'], { SCRIPTS_STATE: state });
      assert.notStrictEqual(bad.code, 0);
      assert.ok(bad.stderr.indexOf('1 から 30') !== -1);
      const eq = await runCli(['shadow-report', '--days=99', '--site=rumble'], { SCRIPTS_STATE: state });
      assert.notStrictEqual(eq.code, 0);
      assert.ok(eq.stderr.indexOf('1 から 30') !== -1);
      const down = await runCli(['shadow-report', '--days', '7', '--json'], { SCRIPTS_STATE: state });
      assert.notStrictEqual(down.code, 0);
      assert.ok(down.stderr.indexOf('ペアリング') !== -1);
      assert.strictEqual(down.stdout.indexOf('shadow'), -1);
    } finally {
      rimraf(state);
    }
  });

  await test('shadow.report is a read API over an explicit directory', async function () {
    const root = tempRoot();
    try {
      const today = todayYmd();
      writeRaw(hostFile(root, 'shadow-' + today + '.jsonl'), line({
        ts: isoDayOf(today) + 'T01:00:00.000+09:00',
        kind: 'fanout',
        title: { length: 2, head: 'API' },
        sites: [{ id: 'rumble', result: 'ok', message: '', mode: 'shadow' }]
      }));
      const api = createApi({ core: { STATE_DIR: root }, now: function () { return NOW.getTime(); } });
      const shadow = await attachDevShadow(api, { STATE_DIR: root }); // shadow.report は plugins/dev-shadow が出す（V1）
      assert.strictEqual(api.permissionFor('shadow.report'), 'read');
      const bad = await api.call('shadow.report', { days: 31 }, { permissions: ['read'], kind: 'window', clientId: 'local-window' });
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.error, 'bad-days');
      const result = await api.call('shadow.report', { days: 1, site: 'rumble' }, { permissions: ['read'], kind: 'window', clientId: 'local-window' });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.sites.rumble.count, 1);
      assert.deepStrictEqual(result.sites.rumble.samples, ['API']);
      const bare = createApi({});
      const bareShadow = await attachDevShadow(bare, {});
      const missing = await bare.call('shadow.report', { days: 1 }, { permissions: ['read'] });
      assert.strictEqual(missing.ok, false);
      assert.strictEqual(missing.error, 'unavailable');
      shadow.done();
      bareShadow.done();
    } finally {
      rimraf(root);
    }
  });

  await test('the shadow report panel is a dev-shadow plug-in panel (read-only)', async function () {
    const dir = path.join(__dirname, '..', '..', '..', 'plugins', 'dev-shadow');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.panels.some(function (p) { return p.name === 'shadow-report' && p.file === 'ui/shadow-report.html'; }));
    const js = fs.readFileSync(path.join(dir, 'ui', 'shadow-report.js'), 'utf8');
    const html = fs.readFileSync(path.join(dir, 'ui', 'shadow-report.html'), 'utf8');
    assert.ok(js.indexOf("call('shadow.report'") !== -1);
    assert.ok(html.indexOf('id="days"') !== -1);
    assert.ok(js.indexOf('回数') !== -1);
    assert.ok(fs.readFileSync(path.join(dir, 'ui', 'shadow-report.css'), 'utf8').indexOf('table') !== -1);
    const cliSrc = fs.readFileSync(CLI, 'utf8');
    assert.ok(cliSrc.indexOf('shadow-report') !== -1);
    assert.ok(cliSrc.indexOf('--days') !== -1);
    assert.ok(cliSrc.indexOf('--site') !== -1);
    assert.ok(cliSrc.indexOf('--json') !== -1);
  });

  await test('without ctx.redact the report refuses (never prints unredacted strings)', async function () {
    setRedact(null);
    try {
      const out = report({ days: 1, stateDir: os.tmpdir() });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.error, 'unavailable');
    } finally { setRedact(require('../../../host/core/safe-runner').redact); }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('w35-shadow-report ok');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});