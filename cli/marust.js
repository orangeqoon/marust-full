#!/usr/bin/env node
'use strict';

/**
 * marust の CLI。Node と依存の ws だけで動く。
 * 接続は Origin を付けない native（Authorization: Bearer）。
 * Host は窓口の許可リストに合わせ、常に 127.0.0.1:18770。
 * 待ち受けポートは --port または MARUST_CLI_PORT（既定 18770）。
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { WebSocket } = require('ws');

const HOST_HEADER = '127.0.0.1:18770';
const USAGE = '使い方: marust pair | status | destinations | start <配信先> | stop <配信先> | go <配信先...> --yes | preflight [配信先...] | halt <配信先...> --yes | session show|start <題名>|pause|resume|end | say <本文> --sites a,b --yes | stop-all | call <メソッド名> [JSON か key=値…] | describe | doctor | shadow-report [--days N] [--site X] [--json] | plugin reload <id>|--all | plugin logs <id> [--n 50] | plugin status <id> | ui reload [all|theme|plugin:<id>] | restart --yes';

function stateDir() {
  if (process.env.SCRIPTS_STATE) return path.resolve(process.env.SCRIPTS_STATE);
  try {
    const { createCore } = require('../host/core');
    return createCore({ local: { preferAppData: true } }).STATE_DIR;
  } catch (_) {
    return '';
  }
}

function tokenFile() {
  const dir = stateDir();
  if (!dir) return '';
  return path.join(dir, 'services', 'marust-cli.json');
}

function loadToken() {
  const file = tokenFile();
  if (!file) return '';
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || typeof data.token !== 'string' || data.token.length < 32) return '';
    return data.token;
  } catch (_) {
    return '';
  }
}

function saveToken(token) {
  const file = tokenFile();
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ token: token, name: 'CLI', savedAt: new Date().toISOString() }) + '\n';
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

function defaultPort() {
  const raw = process.env.MARUST_CLI_PORT;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return 18770;
}

function parseArgs(argv) {
  const flags = { json: false, yes: false, port: defaultPort(), sites: '', days: '', site: '', all: false, n: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--port') {
      flags.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.indexOf('--port=') === 0) flags.port = Number(arg.slice('--port='.length));
    else if (arg === '--sites') {
      flags.sites = argv[i + 1] == null ? '' : String(argv[i + 1]);
      i += 1;
    } else if (arg.indexOf('--sites=') === 0) flags.sites = arg.slice('--sites='.length);
    else if (arg === '--days') {
      flags.days = argv[i + 1] == null ? '' : String(argv[i + 1]);
      i += 1;
    } else if (arg.indexOf('--days=') === 0) flags.days = arg.slice('--days='.length);
    else if (arg === '--all') flags.all = true;
    else if (arg === '--n') {
      flags.n = argv[i + 1] == null ? '' : String(argv[i + 1]);
      i += 1;
    } else if (arg.indexOf('--n=') === 0) flags.n = arg.slice('--n='.length);
    else if (arg === '--site') {
      flags.site = argv[i + 1] == null ? '' : String(argv[i + 1]);
      i += 1;
    } else if (arg.indexOf('--site=') === 0) flags.site = arg.slice('--site='.length);
    else rest.push(arg);
  }
  return { flags: flags, rest: rest };
}

function timeoutFor(method, params) {
  if (method === 'broadcast.start' || method === 'broadcast.stop') {
    const list = params && Array.isArray(params.destinationIds) ? params.destinationIds : [];
    const count = list.length > 0 ? list.length : 1;
    return Math.min(count, 20) * 180000 + 20000;
  }
  return 10000;
}

function postJson(port, pathname, body) {
  const payload = JSON.stringify(body);
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: pathname,
      method: 'POST',
      headers: {
        Host: HOST_HEADER,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(4000, function () { req.destroy(new Error('down')); });
    req.on('error', reject);
    req.end(payload);
  });
}

function connect(port, token) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', {
      handshakeTimeout: 4000,
      headers: {
        Host: HOST_HEADER,
        Authorization: 'Bearer ' + token
      }
    });
    const events = [];
    const waiters = new Map();
    let seq = 0;
    let opened = false;
    const timer = setTimeout(function () {
      try { ws.terminate(); } catch (_) { /* already gone */ }
      reject(Object.assign(new Error('down'), { code: 'down' }));
    }, 4000);

    function doneOpen() {
      if (opened) return;
      opened = true;
      clearTimeout(timer);
    }

    ws.on('message', function (data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.method === 'event') {
        events.push(msg);
        return;
      }
      if (waiters.has(msg.id)) {
        const waiter = waiters.get(msg.id);
        waiters.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg.result);
      }
    });
    ws.once('open', function () {
      doneOpen();
      resolve({
        call: function (method, params) {
          const id = ++seq;
          return new Promise(function (resolveCall, rejectCall) {
            const callTimer = setTimeout(function () { rejectCall(new Error('timeout')); }, timeoutFor(method, params));
            waiters.set(id, { resolve: resolveCall, timer: callTimer });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }));
          });
        },
        waitApproval: function (approvalId, timeoutMs) {
          return new Promise(function (resolveWait) {
            const started = Date.now();
            function look() {
              for (let i = 0; i < events.length; i += 1) {
                const msg = events[i];
                const payload = msg && msg.params && msg.params.payload;
                if (msg.params && msg.params.name === 'approval.resolved' && payload && payload.approvalId === approvalId) {
                  events.splice(i, 1);
                  return payload;
                }
              }
              return null;
            }
            const found = look();
            if (found) {
              resolveWait(found);
              return;
            }
            const poll = setInterval(function () {
              const row = look();
              if (row) {
                clearInterval(poll);
                resolveWait(row);
                return;
              }
              if (Date.now() - started >= timeoutMs) {
                clearInterval(poll);
                resolveWait(null);
              }
            }, 20);
            if (poll.unref) poll.unref();
          });
        },
        close: function () {
          try { ws.terminate(); } catch (_) { /* already gone */ }
        }
      });
    });
    ws.once('unexpected-response', function (_req, res) {
      doneOpen();
      res.resume();
      const err = new Error('status');
      err.status = res.statusCode;
      reject(err);
    });
    ws.once('error', function (err) {
      doneOpen();
      reject(err || new Error('down'));
    });
  });
}

function readCode(given) {
  if (given) return Promise.resolve(String(given).trim());
  if (!process.stdin.isTTY) {
    return new Promise(function (resolve) {
      const chunks = [];
      process.stdin.on('data', function (chunk) { chunks.push(chunk); });
      process.stdin.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8').trim()); });
      process.stdin.on('error', function () { resolve(''); });
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(function (resolve) {
    rl.question('ペアリングコード: ', function (answer) {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

function pairError(error) {
  if (error === 'bad-code') return 'コードが違います';
  if (error === 'expired') return 'コードの期限が切れました';
  if (error === 'locked') return '失敗が続いたため、コードは無効です';
  if (error === 'no-code') return 'ペアリングコードがありません';
  if (error === 'name') return '名前が不正です';
  if (error === 'origin') return 'この操作はブラウザからはできません';
  return 'ペアリングに失敗しました';
}

function failureText(result) {
  const code = result && (result.error || result.reason) || '';
  if (code === 'forbidden') return '権限がありません';
  if (code === 'denied') return '承認が却下されました';
  if (code === 'expired') return '承認の期限が切れました';
  if (code === 'unknown-destination') return '配信先が見つかりません';
  if (code === 'no-engine') return '配信エンジンがありません';
  if (code === 'unavailable') return 'この操作はまだ使えません';
  if (code === 'session-active') return 'すでにセッションが動いています';
  if (code === 'not-running') return '動いているセッションがありません';
  if (code === 'not-paused') return '一時停止中ではありません';
  if (code === 'no-session') return 'セッションがありません';
  if (code === 'legacy') return '表示のみです（legacy）';
  if (code === 'busy') return 'すでに実行中です';
  if (code === 'dev-only') return '開発者モードでだけ使えます';
  if (code === 'streaming') return '配信中はできません';
  if (code === 'streaming-slot') return '配信中は読み直せません（OBS を握る自動枠取り）。配信が終わってから';
  if (code === 'unknown-id') return 'そのプラグインが見つかりません';
  if (code === 'bad-id') return 'プラグインの id が不正です';
  if (code === 'bad-target') return 'target は all、theme、plugin:<id> のどれかです';
  if (code === 'bad-n') return '--n は 1〜200 の整数です';
  if (code === 'confirm') return '確認が必要です';
  if (code === 'preflight') return '配信前チェックで止まりました';
  if (code === 'destination-ids') return '配信先の指定が不正です';
  if (code === 'timeout') return '時間切れです';
  if (code === 'no-slot') return '枠のプラグインがありません';
  if (code) return '失敗しました（' + code + '）';
  return '失敗しました';
}

function printPreflight(result, quietEmpty) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  if (!items.length) {
    if (!quietEmpty) console.log('問題はありません');
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i];
    const where = row.destinationId || row.id || '';
    console.log([row.level || '', where, row.code || '', row.message || ''].join(' ').trim());
  }
}

function printChatSend(result) {
  const rows = result && Array.isArray(result.results) ? result.results : [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    if (row.ok === true) console.log('✓ ' + (row.site || '') + (row.dryRun === true ? ' dry-run' : ''));
    else console.log('✗ ' + (row.site || '') + ' ' + (row.error || ''));
  }
}

function printBroadcast(result) {
  if (result && result.preflight) printPreflight(result.preflight, true);
  const items = result && Array.isArray(result.items) ? result.items : [];
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i];
    if (row && row.ok === true) console.log('✓ ' + (row.destinationId || ''));
    else console.log('✗ ' + (row && row.destinationId || '') + ' ' + (row && row.step || '') + ' ' + (row && row.error || ''));
  }
}

function formatDescribe(result) {
  const methods = result && Array.isArray(result.methods) ? result.methods : [];
  const lines = [USAGE, ''];
  for (let i = 0; i < methods.length; i += 1) {
    const row = methods[i];
    const only = row.windowOnly ? ' ウィンドウ専用' : '';
    lines.push(row.method + ' [' + row.permission + only + '] ' + (row.description || ''));
    const params = row.params || {};
    const names = Object.keys(params);
    for (let p = 0; p < names.length; p += 1) {
      const spec = params[names[p]] || {};
      const bits = [names[p], spec.type || 'string', spec.required ? '必須' : '任意'];
      if (spec.max != null) bits.push('最大' + spec.max);
      lines.push('  ' + bits.join(' '));
    }
  }
  return lines.join('\n');
}

function reloadLine(row) {
  if (!row) return '';
  if (row.result === 'ok') return row.id + ': 読み直しました';
  if (row.result === 'skip') {
    if (row.message === 'streaming-slot') return row.id + ': 配信中なので飛ばしました（OBS を握る自動枠取り）';
    if (row.message === 'legacy-not-loaded') return row.id + ': まだ読み込まれません（legacy）。画面でこのプラグインを入れてください（shadow か live）';
    return row.id + ': 読み直しませんでした（' + row.message + '）';
  }
  const err = row.error || {};
  return row.id + ': 失敗しました ' + (err.message || row.message || '') + (err.where ? ' (' + err.where + ')' : '');
}

function formatPluginLogs(result) {
  const lines = result && Array.isArray(result.lines) ? result.lines : [];
  if (!lines.length) return 'ログはありません';
  return lines.map(function (row) {
    const time = new Date(Number(row.at) || 0).toTimeString().slice(0, 8);
    return time + ' ' + row.level + ' ' + row.text;
  }).join('\n');
}

function formatPluginStatus(result) {
  const out = [result.id + ': ' + result.status + (result.reason ? ' (' + result.reason + ')' : '') + ' / ' + result.mode + ' / ' + result.source];
  if (result.lastError) out.push('直近のエラー: ' + result.lastError.message + (result.lastError.where ? ' (' + result.lastError.where + ')' : ''));
  return out.join('\n');
}

// 開発用のコマンド（plugin / ui / restart）を { method, params } か { error } にする。
// 汎用: marust call <メソッド名> [JSON | key=value ...]。名前は窓口が知っているかを CLI では見ない（知らない名前は窓口が断る）。計画 C・D8。
function buildCallCommand(args) {
  const method = args[0];
  if (!method || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(method)) return { error: 'メソッド名を指定してください（例: marust call hub.getState）' };
  const rest = args.slice(1);
  if (!rest.length) return { method: method, params: {} };
  if (rest.length === 1 && /^\s*\{/.test(rest[0])) {
    let obj;
    try { obj = JSON.parse(rest[0]); } catch (_) { return { error: '引数の JSON が読めません' }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '引数は JSON のオブジェクトか key=値 で指定してください' };
    return { method: method, params: obj };
  }
  const params = {};
  for (const item of rest) {
    const at = item.indexOf('=');
    const key = at > 0 ? item.slice(0, at) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === '__proto__') return { error: '引数は JSON のオブジェクトか key=値 で指定してください' };
    const raw = item.slice(at + 1);
    let value = raw;
    try { value = JSON.parse(raw); } catch (_) { value = raw; }
    params[key] = value;
  }
  return { method: method, params: params };
}

function buildDevCommand(cmd, args, flags) {
  if (cmd === 'plugin') {
    const sub = args[0];
    if (sub === 'reload') {
      if (flags.all) return { method: 'plugins.reloadAll', params: {} };
      if (!args[1]) return { error: 'プラグインの id を指定してください（全部なら --all）' };
      return { method: 'plugin.reload', params: { id: args[1] } };
    }
    if (sub === 'logs' || sub === 'status') {
      if (!args[1]) return { error: 'プラグインの id を指定してください' };
      const params = { id: args[1] };
      if (sub === 'logs' && flags.n !== '') {
        const n = Number(flags.n);
        if (!Number.isInteger(n) || n < 1 || n > 200) return { error: '--n は 1〜200 の整数です' };
        params.n = n;
      }
      return { method: sub === 'logs' ? 'plugin.logs' : 'plugin.status', params: params };
    }
    return { error: 'plugin は reload、logs、status です' };
  }
  if (cmd === 'ui') {
    if (args[0] !== 'reload') return { error: 'ui は reload です' };
    return { method: 'ui.reload', params: { target: args[1] || 'all' } };
  }
  if (cmd === 'restart') {
    if (!flags.yes) return { error: '再起動するには --yes が必要です' };
    return { method: 'app.restart', params: {} };
  }
  return null;
}

function printResult(method, result, flags) {
  if (flags.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (method === 'plugin.reload') {
    console.log(reloadLine(result));
    if (result && result.result === 'error') process.exitCode = 1;
    return;
  }
  if (method === 'plugins.reloadAll') {
    const rows = result && Array.isArray(result.results) ? result.results : [];
    rows.forEach(function (row) { console.log(reloadLine(row)); });
    if (rows.some(function (row) { return row.result === 'error'; })) process.exitCode = 1;
    return;
  }
  if (method === 'plugin.logs') {
    console.log(formatPluginLogs(result));
    return;
  }
  if (method === 'plugin.status') {
    console.log(formatPluginStatus(result));
    return;
  }
  if (method === 'ui.reload') {
    console.log('画面に読み直しを頼みました');
    return;
  }
  if (method === 'app.restart') {
    console.log(result && result.whileStreaming ? '再起動します（配信中です。配信は止まりませんが、自動枠取りは再起動のあと引き継ぎから戻ります）' : '再起動します');
    return;
  }
  if (method === 'api.describe') {
    console.log(formatDescribe(result));
    return;
  }
  if (method === 'destination.list') {
    const rows = result && Array.isArray(result.destinations) ? result.destinations : [];
    if (!rows.length) console.log('配信先はありません');
    else {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        console.log([row.id, row.site, row.account, row.engineId, row.status].join(' '));
      }
    }
    return;
  }
  if (method === 'hub.getState') {
    const mode = result && (result.mode || result.product) || '';
    console.log('状態: ' + (mode || '取得しました'));
    return;
  }
  if (method === 'session.view') {
    const title = result && result.title ? result.title : 'なし';
    console.log('セッション: ' + title + ' / ' + (result && result.state || ''));
    return;
  }
  if (method === 'broadcast.preflight') {
    printPreflight(result);
    return;
  }
  if (method === 'broadcast.start' || method === 'broadcast.stop') {
    printBroadcast(result);
    return;
  }
  if (method === 'broadcast.stopAll') {
    const items = result && Array.isArray(result.items) ? result.items : [];
    if (items.length) {
      printBroadcast(result);
    } else if (result && result.ok !== false) {
      console.log('完了しました');
    }
    return;
  }
  if (method === 'chat.send') {
    printChatSend(result);
    return;
  }
  if (method === 'broadcast.status') {
    const last = result && result.last;
    console.log('実行中: ' + (result && result.running ? 'はい' : 'いいえ'));
    if (last) printBroadcast(last);
    return;
  }
  if (result && result.ok === false) return;
  console.log('完了しました');
}


const AGENT_DOWN_LINE = 'Agent が動いていません';
const AGENT_START_HINT = '起動するには npm run start:app を実行してください。';

function doctorPaint(level, text, color) {
  if (!color) return text;
  const map = { ok: '\u001b[32m', warn: '\u001b[33m', error: '\u001b[31m' };
  const code = map[level] || '';
  if (!code) return text;
  return code + text + '\u001b[0m';
}

function formatDoctor(result, options) {
  const opts = options || {};
  const body = result && typeof result === 'object' ? result : { findings: [] };
  if (opts.json) return JSON.stringify(body);
  const color = opts.color === true || (opts.color !== false && !!process.stdout.isTTY);
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const lines = [];
  if (!findings.length) lines.push('診断項目はありません');
  for (let i = 0; i < findings.length; i += 1) {
    const row = findings[i] || {};
    const level = typeof row.level === 'string' ? row.level : 'ok';
    const code = typeof row.code === 'string' ? row.code : '';
    const label = typeof row.label === 'string' ? row.label : '';
    const detail = typeof row.detail === 'string' ? row.detail : '';
    const parts = [doctorPaint(level, level, color), code, label, detail].filter(Boolean);
    lines.push(parts.join('  '));
  }
  if (Array.isArray(body.recentErrors) && body.recentErrors.length) {
    lines.push('直近のエラー符号: ' + body.recentErrors.join(', '));
  }
  return lines.join('\n');
}

async function runDoctor(options) {
  const opts = options || {};
  const flags = opts.flags || {};
  if (opts.client && typeof opts.client.call === 'function') {
    const result = await opts.client.call('diagnostics.run', {});
    return { down: false, unpaired: false, result: result };
  }
  const load = typeof opts.loadToken === 'function' ? opts.loadToken : loadToken;
  const token = load();
  if (!token) return { down: false, unpaired: true, result: null };
  const connectFn = typeof opts.connect === 'function' ? opts.connect : connect;
  let client;
  try {
    client = await connectFn(flags.port, token);
  } catch (err) {
    if (err && err.status === 401) return { down: false, unpaired: true, result: null };
    return { down: true, unpaired: false, result: null };
  }
  try {
    const result = await client.call('diagnostics.run', {});
    return { down: false, unpaired: false, result: result };
  } catch (_) {
    return { down: true, unpaired: false, result: null };
  } finally {
    if (client && typeof client.close === 'function') client.close();
  }
}

function shadowParams(flags) {
  const params = {};
  const srcFlags = flags || {};
  if (srcFlags.days != null && srcFlags.days !== '') {
    const n = Number(srcFlags.days);
    if (!Number.isInteger(n) || n < 1 || n > 30) return { error: 'bad-days' };
    params.days = n;
  }
  if (srcFlags.site != null && srcFlags.site !== '') params.site = String(srcFlags.site);
  return { params: params };
}

function formatShadowBucket(name, row) {
  const body = row && typeof row === 'object' ? row : {};
  const count = body.count || 0;
  const lastAt = typeof body.lastAt === 'string' ? body.lastAt : '';
  const samples = Array.isArray(body.samples) ? body.samples.filter(function (item) { return typeof item === 'string' && item; }) : [];
  const errors = body.errors && typeof body.errors === 'object' ? body.errors : {};
  const fails = Object.keys(errors).map(function (code) { return code + ' ' + errors[code]; });
  const parts = [name, '回数 ' + String(count)];
  if (lastAt) parts.push('最後 ' + lastAt);
  if (samples.length) parts.push('見本 ' + samples.join('、'));
  parts.push('失敗 ' + (fails.length ? fails.join(', ') : 'なし'));
  return parts.join('  ');
}

function formatShadowReport(result, options) {
  const opts = options || {};
  const body = result && typeof result === 'object' ? result : {};
  if (opts.json) return JSON.stringify(body);
  const lines = [];
  const dayCount = opts.days != null && opts.days !== '' ? String(opts.days) : '';
  lines.push('shadow の報告' + (dayCount ? '（' + dayCount + ' 日）' : ''));
  const sites = body.sites && typeof body.sites === 'object' ? body.sites : {};
  const siteNames = Object.keys(sites);
  if (!siteNames.length) lines.push('サイトの記録はありません');
  for (let i = 0; i < siteNames.length; i += 1) lines.push(formatShadowBucket(siteNames[i], sites[siteNames[i]]));
  lines.push('プラグイン');
  const plugins = body.plugins && typeof body.plugins === 'object' ? body.plugins : {};
  const pluginNames = Object.keys(plugins);
  if (!pluginNames.length) lines.push('プラグインの記録はありません');
  for (let i = 0; i < pluginNames.length; i += 1) lines.push(formatShadowBucket(pluginNames[i], plugins[pluginNames[i]]));
  if (body.truncated === true) lines.push('大きいので途中で打ち切りました');
  if (typeof body.broken === 'number' && body.broken > 0) lines.push('壊れた行: ' + String(body.broken));
  return lines.join('\n');
}

async function runShadowReport(options) {
  const opts = options || {};
  const flags = opts.flags || {};
  const built = shadowParams(flags);
  if (built.error) return { down: false, unpaired: false, result: { ok: false, error: built.error } };
  const params = built.params;
  if (opts.client && typeof opts.client.call === 'function') {
    const result = await opts.client.call('shadow.report', params);
    return { down: false, unpaired: false, result: result };
  }
  const load = typeof opts.loadToken === 'function' ? opts.loadToken : loadToken;
  const token = load();
  if (!token) return { down: false, unpaired: true, result: null };
  const connectFn = typeof opts.connect === 'function' ? opts.connect : connect;
  let client;
  try {
    client = await connectFn(flags.port, token);
  } catch (err) {
    if (err && err.status === 401) return { down: false, unpaired: true, result: null };
    return { down: true, unpaired: false, result: null };
  }
  try {
    const result = await client.call('shadow.report', params);
    return { down: false, unpaired: false, result: result };
  } catch (_) {
    return { down: true, unpaired: false, result: null };
  } finally {
    if (client && typeof client.close === 'function') client.close();
  }
}

async function shadowReportCommand(flags) {
  const built = shadowParams(flags);
  if (built.error) {
    console.error('日数は 1 から 30 です');
    process.exit(1);
    return null;
  }
  const outcome = await runShadowReport({ flags: flags });
  if (outcome.unpaired) unpaired();
  if (outcome.down) {
    console.error(AGENT_DOWN_LINE);
    console.error(AGENT_START_HINT);
    process.exit(1);
  }
  const shown = built.params.days != null ? built.params.days : 7;
  console.log(formatShadowReport(outcome.result, { json: !!(flags && flags.json), days: shown }));
}

async function doctorCommand(flags) {
  const outcome = await runDoctor({ flags: flags });
  if (outcome.unpaired) unpaired();
  if (outcome.down) {
    console.error(AGENT_DOWN_LINE);
    console.error(AGENT_START_HINT);
    process.exit(1);
  }
  console.log(formatDoctor(outcome.result, { json: !!(flags && flags.json) }));
}

function agentDown() {
  console.error('Agent が動いていません');
  console.error('画面なしで動かすときは marust.exe --headless（開発中は npm run start:headless）');
  process.exit(1);
}

function unpaired() {
  console.error('ペアリングされていません。node cli/marust.js pair を実行してください（開発者モードなら自動でつながるので、丸ストの窓の「AI をつなぐ」を見てください）。');
  process.exit(2);
}

async function invoke(method, params, flags) {
  const token = loadToken();
  if (!token) unpaired();
  let client;
  try {
    client = await connect(flags.port, token);
  } catch (err) {
    if (err && err.status === 401) unpaired();
    agentDown();
  }
  try {
    let result = await client.call(method, params);
    if (result && result.pending === true && result.approvalId) {
      console.error('marust のウィンドウで承認してください（' + result.approvalId + '）');
      const payload = await client.waitApproval(result.approvalId, 130000);
      if (!payload) {
        console.error('承認の期限が切れました');
        client.close();
        process.exit(1);
      }
      if (payload.result && typeof payload.result === 'object') result = payload.result;
      else result = { ok: payload.ok === true, error: payload.error || '' };
    }
    if (result == null) {
      console.error('応答がありません');
      client.close();
      process.exit(1);
    }
    printResult(method, result, flags);
    if (result.ok === false) {
      console.error(failureText(result));
      client.close();
      process.exit(result.error === 'forbidden' ? 3 : 1);
    }
    client.close();
  } catch (_) {
    try { client.close(); } catch (err) { /* already closed */ }
    console.error('応答がありません');
    process.exit(1);
  }
}

async function pair(args, flags) {
  const code = await readCode(args[0]);
  if (!code) {
    console.error('コードを指定してください');
    process.exit(1);
  }
  let res;
  try {
    res = await postJson(flags.port, '/pair/native', { code: code, name: 'CLI' });
  } catch (_) {
    agentDown();
  }
  let body = {};
  try { body = JSON.parse(res.body || ''); } catch (_) { body = {}; }
  if (res.status !== 200 || !body || body.ok !== true || typeof body.token !== 'string') {
    console.error(pairError(body && body.error));
    process.exit(1);
  }
  if (!saveToken(body.token)) {
    console.error('トークンを保存できません');
    process.exit(1);
  }
  const out = { ok: true, name: 'CLI' };
  if (flags.json) console.log(JSON.stringify(out));
  else console.log('ペアリングしました');
}

function sessionCommand(args, flags) {
  const sub = args[0];
  if (sub === 'show') return invoke('session.view', {}, flags);
  if (sub === 'start') {
    const title = args.slice(1).join(' ').trim();
    if (!title) {
      console.error('題名を指定してください');
      process.exit(1);
    }
    return invoke('session.start', { title: title }, flags);
  }
  if (sub === 'pause') return invoke('session.pause', {}, flags);
  if (sub === 'resume') return invoke('session.resume', {}, flags);
  if (sub === 'end') return invoke('session.end', {}, flags);
  console.error('session は show、start、pause、resume、end です');
  process.exit(1);
  return null;
}

async function help(flags) {
  const token = loadToken();
  if (!token) {
    console.error(USAGE);
    unpaired();
  }
  try {
    await invoke('api.describe', {}, flags);
  } catch (_) {
    console.error(USAGE);
    agentDown();
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const flags = parsed.flags;
  const rest = parsed.rest;
  const cmd = rest[0] || 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return help(flags);
  if (cmd === 'pair') return pair(rest.slice(1), flags);
  if (cmd === 'status') return invoke('hub.getState', {}, flags);
  if (cmd === 'destinations') return invoke('destination.list', {}, flags);
  if (cmd === 'start') {
    if (!rest[1]) {
      console.error('配信先を指定してください');
      process.exit(1);
    }
    return invoke('destination.start', { id: rest[1] }, flags);
  }
  if (cmd === 'stop') {
    if (!rest[1]) {
      console.error('配信先を指定してください');
      process.exit(1);
    }
    return invoke('destination.stop', { id: rest[1] }, flags);
  }
  if (cmd === 'call') {
    const made = buildCallCommand(rest.slice(1));
    if (made.error) {
      console.error(made.error);
      process.exit(1);
    }
    return invoke(made.method, made.params, Object.assign({}, flags, { json: true }));
  }
  if (cmd === 'session') return sessionCommand(rest.slice(1), flags);
  if (cmd === 'go') {
    const ids = rest.slice(1);
    if (!ids.length) {
      console.error('配信先を指定してください');
      process.exit(1);
    }
    if (!flags.yes) {
      console.error('配信開始するには --yes が必要です');
      process.exit(1);
    }
    return invoke('broadcast.start', {
      destinationIds: ids,
      confirmed: true
    }, flags);
  }
  if (cmd === 'preflight') return invoke('broadcast.preflight', { destinationIds: rest.slice(1) }, flags);
  if (cmd === 'halt') {
    const ids = rest.slice(1);
    if (!ids.length) {
      console.error('配信先を指定してください');
      process.exit(1);
    }
    if (!flags.yes) {
      console.error('配信停止するには --yes が必要です');
      process.exit(1);
    }
    return invoke('broadcast.stop', { destinationIds: ids }, flags);
  }
  if (cmd === 'say') {
    const text = rest.slice(1).join(' ');
    const sites = String(flags.sites || '').split(',').map(function (site) { return site.trim(); }).filter(Boolean);
    if (!text) {
      console.error('本文を指定してください');
      process.exit(1);
    }
    if (!sites.length) {
      console.error('サイトを指定してください');
      process.exit(1);
    }
    if (!flags.yes) {
      console.error('コメントを送るには --yes が必要です');
      process.exit(1);
    }
    return invoke('chat.send', { text: text, sites: sites }, flags);
  }
  if (cmd === 'stop-all' || cmd === 'emergency-stop') {
    return invoke('broadcast.stopAll', {}, flags);
  }
  const dev = buildDevCommand(cmd, rest.slice(1), flags);
  if (dev) {
    if (dev.error) {
      console.error(dev.error);
      process.exit(1);
    }
    return invoke(dev.method, dev.params, flags);
  }
  if (cmd === 'doctor') return doctorCommand(flags);
  if (cmd === 'shadow-report') return shadowReportCommand(flags);
  if (cmd === 'describe') return invoke('api.describe', {}, flags);
  console.error(USAGE);
  process.exit(1);
  return null;
}

if (require.main === module) {
  main().catch(function () {
    console.error('失敗しました');
    process.exit(1);
  });
}

module.exports = {
  buildCallCommand: buildCallCommand,
  buildDevCommand: buildDevCommand,
  parseArgs: parseArgs,
  failureText: failureText,
  reloadLine: reloadLine,
  formatPluginLogs: formatPluginLogs,
  formatPluginStatus: formatPluginStatus,
  formatDoctor: formatDoctor,
  runDoctor: runDoctor,
  formatShadowReport: formatShadowReport,
  runShadowReport: runShadowReport,
  AGENT_DOWN_LINE: AGENT_DOWN_LINE,
  AGENT_START_HINT: AGENT_START_HINT
};
