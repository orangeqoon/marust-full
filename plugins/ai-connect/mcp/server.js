'use strict';

/**
 * AI 向け MCP サーバー。stdio に JSON-RPC を 1 行ずつ書く（SDK は使わない）。
 * marust へは native（Authorization: Bearer、Origin なし）でつなぐ。
 * token は state/services/marust-mcp.json にだけ書き、画面・ログ・応答には出さない。
 * 非常停止・秘密・端末管理・承認の実行と却下・engine.setKey・chat.publish・windowOnly は道具にしない。
 * api.describe の引数名に key / token / password / secret / cookie を含むメソッドも道具にしない。
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { WebSocket } = require('ws');

const HOST_HEADER = '127.0.0.1:18770';
const PAIR_HINT = 'node plugins/ai-connect/mcp/server.js pair でペアリングしてください';
const OFF_HINT = 'ai-connect が切ってあります。丸ストの「機能」か、開発者の画面で ai-connect を入れてください';
const CLIENT_NAME = 'AI（MCP）';
const USAGE = '使い方: node plugins/ai-connect/mcp/server.js pair [コード] [--port N]';
const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const APPROVAL_MAX_MS = 120000;

const ENGLISH = {
  'hub.getState': 'Return the hub state',
  'hub.fanout': 'Send the title and category to each site',
  'hub.forceLegacy': 'Set every plugin back to legacy',
  'engine.status': 'Return the engine connection status',
  'engine.listTargets': 'List targets on the engine',
  'engine.start': 'Start an engine target',
  'engine.stop': 'Stop an engine target',
  'engine.setEnabled': 'Enable or disable an engine target',
  'engine.create': 'Create an engine target',
  'engine.remove': 'Remove an engine target',
  'engine.link': 'Link a destination to an engine target',
  'engine.unlink': 'Unlink a destination from its engine target',
  'layout.list': 'List layout names',
  'layout.get': 'Read a layout',
  'layout.save': 'Save a layout',
  'layout.remove': 'Remove a layout',
  'destination.list': 'List destinations',
  'destination.start': 'Start a destination',
  'destination.stop': 'Stop a destination',
  'session.view': 'Return the session state',
  'session.start': 'Start a session',
  'session.pause': 'Pause the session',
  'session.resume': 'Resume the session',
  'session.end': 'End the session',
  'session.retitle': 'Change the session title',
  'approval.list': 'List pending approvals',
  'api.describe': 'List operations',
  'broadcast.preflight': 'Return the preflight check',
  'broadcast.start': 'Start a broadcast',
  'broadcast.stop': 'Stop a broadcast',
  'broadcast.status': 'Return whether a broadcast is running and the latest result',
  'chat.recent': 'Return recent comments',
  'chat.publish': 'Publish comments. This does not wait for approval'
};

let currentToken = '';

function redact(text) {
  const token = currentToken;
  const raw = text == null ? '' : String(text);
  if (!token || raw.indexOf(token) === -1) return raw;
  return raw.split(token).join('[redacted]');
}

function installRedaction() {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  function wrap(write) {
    return function (chunk, encoding, cb) {
      let enc = encoding;
      let done = cb;
      if (typeof enc === 'function') {
        done = enc;
        enc = undefined;
      }
      const clean = redact(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (typeof enc === 'string') return write(clean, enc, done);
      return write(clean, done);
    };
  }
  process.stdout.write = wrap(out);
  process.stderr.write = wrap(err);
}

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function logError(message) {
  process.stderr.write(redact(message) + '\n');
}

// 保存場所（K3 でプラグインの中へ移したので、本体のファイルは読まない）。強い順: SCRIPTS_STATE → MARUST_STATE → %APPDATA%\marust（あるとき）。
// 作者の PC のように scripts_core がある環境は、本体側の mcp/server.js（互換の 1 枚）が先に SCRIPTS_STATE を決めてからここへ来る。
function stateDir() {
  if (process.env.SCRIPTS_STATE) return path.resolve(process.env.SCRIPTS_STATE);
  if (process.env.MARUST_STATE) return path.resolve(process.env.MARUST_STATE);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(path.resolve(appData), 'marust');
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch (_) { /* 無ければ空 */ }
  return '';
}

function tokenFile() {
  const dir = stateDir();
  if (!dir) return '';
  return path.join(dir, 'services', 'marust-mcp.json');
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

function rememberToken() {
  currentToken = loadToken();
  return currentToken;
}

function saveToken(token) {
  const file = tokenFile();
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({
    token: token,
    name: CLIENT_NAME,
    savedAt: new Date().toISOString()
  }) + '\n';
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

function defaultPort() {
  const raw = process.env.MARUST_MCP_PORT;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return 18770;
}

function boundedInt(raw, fallback, min, max) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function approvalWaitMs() {
  return boundedInt(process.env.MARUST_MCP_APPROVAL_MS, APPROVAL_MAX_MS, 200, APPROVAL_MAX_MS);
}

function describeEveryMs() {
  return boundedInt(process.env.MARUST_MCP_DESCRIBE_MS, 60000, 50, 600000);
}

function parseArgs(argv) {
  const flags = { port: defaultPort() };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      flags.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.indexOf('--port=') === 0) {
      flags.port = Number(arg.slice('--port='.length));
    } else rest.push(arg);
  }
  if (!Number.isInteger(flags.port) || flags.port <= 0 || flags.port > 65535) flags.port = 0;
  return { flags: flags, rest: rest };
}

function paramsExposeSecret(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const names = Object.keys(params);
  for (let i = 0; i < names.length; i += 1) {
    const folded = String(names[i]).toLowerCase();
    if (folded.indexOf('key') !== -1) return true;
    if (folded.indexOf('token') !== -1) return true;
    if (folded.indexOf('password') !== -1) return true;
    if (folded.indexOf('secret') !== -1) return true;
    if (folded.indexOf('cookie') !== -1) return true;
  }
  return false;
}

function isExcluded(row) {
  if (!row || typeof row.method !== 'string' || !row.method) return true;
  if (row.windowOnly === true) return true;
  if (row.permission === 'emergency' || row.method === 'engine.emergencyStop') return true;
  if (row.method.indexOf('secrets.') === 0) return true;
  if (row.method.indexOf('clients.') === 0) return true;
  if (row.method === 'approval.approve' || row.method === 'approval.deny') return true;
  // engine.link は params に keyPolicy があったので paramsExposeSecret で除かれていた。keyPolicy をなくした後も道具にしない（配信先の結びを AI に任せない）
  if (row.method === 'engine.setKey' || row.method === 'engine.link') return true;
  if (row.method === 'chat.publish') return true;
  if (row.method === 'hub.fanoutReserved' || row.method === 'sites.loginFacts' || row.method === 'sites.loginStates') return true;
  if (paramsExposeSecret(row.params)) return true;
  return false;
}

function toolName(method) {
  return 'marust_' + String(method).replace(/\./g, '_');
}

function methodFromName(name) {
  if (typeof name !== 'string' || name.indexOf('marust_') !== 0) return '';
  return name.slice('marust_'.length).replace(/_/g, '.');
}

function schemaType(type) {
  if (type === 'number' || type === 'boolean' || type === 'array' || type === 'object' || type === 'string') return type;
  return 'string';
}

function schemaFor(params) {
  const properties = {};
  const required = [];
  const source = params && typeof params === 'object' ? params : {};
  const names = Object.keys(source);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    const spec = source[name] || {};
    const type = schemaType(spec.type);
    const prop = { type: type };
    if (type === 'string' && typeof spec.max === 'number') prop.maxLength = spec.max;
    if (type === 'number') {
      if (typeof spec.min === 'number') prop.minimum = spec.min;
      if (typeof spec.max === 'number') prop.maximum = spec.max;
    }
    if (type === 'array') {
      if (typeof spec.min === 'number') prop.minItems = spec.min;
      if (typeof spec.max === 'number') prop.maxItems = spec.max;
    }
    properties[name] = prop;
    if (spec.required === true) required.push(name);
  }
  const schema = { type: 'object', properties: properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function describeTool(row) {
  const jaSrc = String((row && row.description) || '').replace(/[\r\n]+/g, ' ').trim();
  const method = row && row.method ? row.method : '';
  const permission = row && row.permission ? row.permission : '';
  const fallback = permission === 'write' ? 'Write' : (permission === 'read' ? 'Read' : ('Call ' + (permission || 'method')));
  const enSrc = ENGLISH[method] || fallback;
  let ja = jaSrc || method;
  let en = enSrc;
  if (permission === 'write' && row.noApproval !== true) {
    if (ja.indexOf('承認待ちになります') === -1) ja += '（承認待ちになります。開発者モードの自動ペアの端末では承認なし）';
    if (en.indexOf('Waits for approval') === -1) en += '. Waits for approval in the marust window (no approval for the dev-mode auto-paired client)';
  }
  return ja + ' / ' + en;
}

function buildTools(methods) {
  const tools = [];
  const rows = Array.isArray(methods) ? methods : [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (isExcluded(row)) continue;
    tools.push({
      name: toolName(row.method),
      description: describeTool(row),
      inputSchema: schemaFor(row.params),
      method: row.method,
      permission: row.permission,
      windowOnly: row.windowOnly === true,
      noApproval: row.noApproval === true
    });
  }
  return tools;
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}

function toolSignature(list) {
  const parts = [];
  for (let i = 0; i < list.length; i += 1) parts.push(list[i].name + '\n' + list[i].description);
  return parts.join('\n');
}

function unpairedTools() {
  return [{
    name: 'marust_not_paired',
    description: PAIR_HINT,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }];
}

function chooseVersion(clientVersion) {
  if (SUPPORTED_VERSIONS.indexOf(clientVersion) !== -1) return clientVersion;
  return '2025-11-25';
}

function toolContent(text, isError) {
  return {
    content: [{ type: 'text', text: redact(text) }],
    isError: isError === true
  };
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
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

function openSocket(port, token) {
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
    let failed = false;
    const timer = setTimeout(function () {
      failed = true;
      try { ws.terminate(); } catch (_) { /* already gone */ }
      reject(Object.assign(new Error('down'), { code: 'down' }));
    }, 4000);

    function fail(err) {
      if (opened || failed) return;
      failed = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch (_) { /* already gone */ }
      reject(err || new Error('down'));
    }

    function rejectWaiters() {
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('down'));
      }
      waiters.clear();
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
        if (msg.error) waiter.reject(new Error('rpc'));
        else waiter.resolve(msg.result);
      }
    });
    ws.on('error', function () { fail(new Error('down')); });
    ws.once('open', function () {
      if (failed) return;
      opened = true;
      clearTimeout(timer);
      resolve({
        ws: ws,
        call: function (method, params) {
          const id = ++seq;
          return new Promise(function (resolveCall, rejectCall) {
            if (ws.readyState !== 1) {
              rejectCall(new Error('down'));
              return;
            }
            const callTimer = setTimeout(function () {
              waiters.delete(id);
              rejectCall(new Error('timeout'));
            }, 10000);
            waiters.set(id, { resolve: resolveCall, reject: rejectCall, timer: callTimer });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }));
          });
        },
        waitApproval: function (approvalId, timeoutMs, isCancelled) {
          return new Promise(function (resolveWait, rejectWait) {
            const started = Date.now();
            let finished = false;
            let poll = null;
            function finish(value) {
              if (finished) return;
              finished = true;
              if (poll) clearInterval(poll);
              resolveWait(value);
            }
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
            poll = setInterval(function () {
              if (isCancelled && isCancelled()) {
                finish({ cancelled: true });
                return;
              }
              if (ws.readyState !== 1) {
                if (poll) clearInterval(poll);
                if (!finished) {
                  finished = true;
                  rejectWait(new Error('down'));
                }
                return;
              }
              const row = look();
              if (row) {
                finish(row);
                return;
              }
              if (Date.now() - started >= timeoutMs) finish(null);
            }, 20);
            if (poll.unref) poll.unref();
          });
        },
        close: function () {
          rejectWaiters();
          try { ws.terminate(); } catch (_) { /* already gone */ }
        }
      });
    });
    ws.once('unexpected-response', function (_req, res) {
      res.resume();
      const err = new Error('status');
      err.status = res.statusCode;
      fail(err);
    });
    ws.once('close', function () {
      rejectWaiters();
      fail(new Error('down'));
    });
  });
}

function formatApproval(approvalId, payload) {
  if (payload && payload.cancelled) {
    return toolContent('中断されました', true);
  }
  let outcome = '期限切れ';
  let body = { ok: false, error: 'expired' };
  if (payload && typeof payload === 'object') {
    const settlement = typeof payload.settlement === 'string' ? payload.settlement : '';
    const error = typeof payload.error === 'string' ? payload.error : '';
    if (settlement === 'approved') outcome = '承認された';
    else if (settlement === 'denied' || error === 'denied') outcome = '却下された';
    else outcome = '期限切れ';
    if (payload.result && typeof payload.result === 'object') body = payload.result;
    else body = { ok: payload.ok === true, error: error || (outcome === '期限切れ' ? 'expired' : 'failed') };
  }
  const label = approvalId ? '（' + approvalId + '）' : '';
  return toolContent('marust のウィンドウで承認待ちです' + label + '。' + outcome + '。 ' + JSON.stringify(body), !(body && body.ok === true));
}

function startStdio(flags) {
  const state = {
    tools: [],
    down: false,
    rejected: false,
    off: false,
    clientReady: false,
    didInitialize: false,
    socketApi: null,
    connecting: null,
    refreshChain: Promise.resolve(),
    cancelled: new Set(),
    timer: null,
    stopped: false
  };

  function closeSocket() {
    const api = state.socketApi;
    state.socketApi = null;
    state.connecting = null;
    if (api) api.close();
  }

  function connect() {
    if (state.rejected) return Promise.reject(Object.assign(new Error('status'), { status: 401 }));
    if (state.socketApi) return Promise.resolve(state.socketApi);
    if (state.connecting) return state.connecting;
    const token = rememberToken();
    if (!token) return Promise.reject(new Error('unpaired'));
    state.connecting = openSocket(flags.port, token).then(function (api) {
      state.socketApi = api;
      state.connecting = null;
      api.ws.on('close', function () {
        if (state.socketApi === api) state.socketApi = null;
      });
      return api;
    }, function (err) {
      state.connecting = null;
      if (err && err.status === 401) state.rejected = true;
      throw err;
    });
    return state.connecting;
  }

  function notifyListChanged() {
    if (!state.clientReady) return;
    writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  async function refreshDescribe() {
    const token = rememberToken();
    if (!token || state.rejected) {
      if (toolSignature(state.tools) !== '') {
        state.tools = [];
        notifyListChanged();
      } else state.tools = [];
      state.down = false;
      closeSocket();
      return;
    }
    let api;
    try {
      api = await connect();
    } catch (err) {
      state.down = state.tools.length === 0;
      if (err && err.status === 401) state.rejected = true;
      return;
    }
    let result;
    try {
      result = await api.call('api.describe', {});
    } catch (_) {
      state.down = state.tools.length === 0;
      return;
    }
    if (!result || result.ok === false || !Array.isArray(result.methods)) {
      state.down = state.tools.length === 0;
      return;
    }
    // ai-connect（このプラグイン）が切のときは「切ってある」と答える。ai.status が無い・読めない・enabled でないとき
    let enabled = false;
    if (result.methods.some(function (row) { return row && row.method === 'ai.status'; })) {
      try {
        const status = await api.call('ai.status', {});
        enabled = !!(status && status.ok !== false && status.enabled === true);
      } catch (_) { enabled = false; }
    }
    const next = enabled ? buildTools(result.methods) : [];
    const changed = toolSignature(state.tools) !== toolSignature(next) || state.off === enabled;
    state.off = !enabled;
    state.tools = next;
    state.down = false;
    if (changed) notifyListChanged();
  }

  function kickRefresh() {
    state.refreshChain = state.refreshChain.then(function () {
      return refreshDescribe();
    }, function () {
      return refreshDescribe();
    }).catch(function () {});
    return state.refreshChain;
  }

  function findTool(name) {
    for (let i = 0; i < state.tools.length; i += 1) {
      if (state.tools[i].name === name) return state.tools[i];
    }
    return null;
  }

  function reply(id, result, error) {
    if (error) {
      writeMessage({ jsonrpc: '2.0', id: id, error: error });
      return;
    }
    writeMessage({ jsonrpc: '2.0', id: id, result: result });
  }

  async function handleToolsList(id) {
    await state.refreshChain;
    if (!rememberToken() || state.rejected) {
      reply(id, { tools: unpairedTools(), guidance: PAIR_HINT });
      return;
    }
    if (state.off) {
      reply(id, { tools: [], guidance: OFF_HINT });
      return;
    }
    if (state.down && !state.tools.length) {
      reply(id, null, { code: -32000, message: 'Agent が動いていません' });
      return;
    }
    const listed = [];
    for (let i = 0; i < state.tools.length; i += 1) listed.push(publicTool(state.tools[i]));
    reply(id, { tools: listed });
  }

  async function handleToolsCall(id, params) {
    await state.refreshChain;
    const name = params && typeof params.name === 'string' ? params.name : '';
    const args = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    if (!rememberToken() || state.rejected) {
      reply(id, toolContent(PAIR_HINT, true));
      return;
    }
    if (state.off) {
      reply(id, toolContent(OFF_HINT, true));
      return;
    }
    if (name === 'marust_not_paired') {
      reply(id, toolContent('道具がありません', true));
      return;
    }
    const known = findTool(name);
    const guessed = methodFromName(name);
    if (!known || isExcluded({ method: known.method, permission: known.permission, windowOnly: known.windowOnly })) {
      if (guessed && isExcluded({ method: guessed, permission: guessed === 'engine.emergencyStop' ? 'emergency' : '' })) {
        reply(id, toolContent('この操作は AI の道具にしていません', true));
        return;
      }
      reply(id, toolContent(known ? 'この操作は AI の道具にしていません' : '道具がありません', true));
      return;
    }
    let api;
    try {
      api = await connect();
    } catch (_) {
      reply(id, toolContent('Agent が動いていません', true));
      return;
    }
    let result;
    try {
      result = await api.call(known.method, args);
    } catch (_) {
      reply(id, toolContent('Agent が動いていません', true));
      return;
    }
    if (result && result.pending === true) {
      if (!result.approvalId) {
        reply(id, formatApproval('', null));
        return;
      }
      let payload;
      try {
        payload = await api.waitApproval(result.approvalId, approvalWaitMs(), function () {
          return state.cancelled.has(id);
        });
      } catch (_) {
        reply(id, toolContent('Agent が動いていません', true));
        return;
      }
      state.cancelled.delete(id);
      reply(id, formatApproval(result.approvalId, payload));
      return;
    }
    const body = result == null ? { ok: false, error: 'failed' } : result;
    reply(id, toolContent(JSON.stringify(body), !!(body && body.ok === false)));
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      reply(null, null, { code: -32600, message: 'Invalid Request' });
      return;
    }
    if (typeof msg.method !== 'string') {
      reply(Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null, null, { code: -32600, message: 'Invalid Request' });
      return;
    }
    if (msg.method.indexOf('notifications/') === 0) {
      if (msg.method === 'notifications/initialized') state.clientReady = true;
      if (msg.method === 'notifications/cancelled') {
        const requestId = msg.params && (msg.params.requestId != null ? msg.params.requestId : msg.params.id);
        if (requestId != null) state.cancelled.add(requestId);
      }
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(msg, 'id')) return;
    if (msg.method === 'initialize') {
      state.didInitialize = true;
      const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
      reply(msg.id, {
        protocolVersion: chooseVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'marust', version: '0.1.0' },
        instructions: 'marust の操作窓口。write は marust のウィンドウで承認待ちになる（開発者モードだけの一部の開発用 write ＝プラグインや画面の読み直しは承認なし）。非常停止・秘密・端末管理はできない。'
      });
      return;
    }
    if (msg.method === 'ping') {
      reply(msg.id, {});
      return;
    }
    if (msg.method === 'tools/list' || msg.method === 'tools/call') {
      if (!state.didInitialize) {
        reply(msg.id, null, { code: -32002, message: 'Server not initialized' });
        return;
      }
      const run = msg.method === 'tools/list' ? handleToolsList(msg.id) : handleToolsCall(msg.id, msg.params || {});
      Promise.resolve(run).catch(function () {
        reply(msg.id, null, { code: -32603, message: 'Internal error' });
      });
      return;
    }
    reply(msg.id, null, { code: -32601, message: 'Method not found' });
  }

  rememberToken();
  kickRefresh();
  state.timer = setInterval(function () { kickRefresh(); }, describeEveryMs());
  if (state.timer.unref) state.timer.unref();

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', function (line) {
    const text = String(line || '').trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch (_) {
      reply(null, null, { code: -32700, message: 'Parse error' });
      return;
    }
    onMessage(msg);
  });

  function shutdown() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    closeSocket();
    process.exit(0);
  }
  rl.on('close', shutdown);
  process.stdin.on('end', shutdown);
}

async function pair(args, flags) {
  if (!flags.port) {
    logError('ポートが不正です');
    process.exit(1);
  }
  const code = await readCode(args[0]);
  if (!code) {
    logError('コードを指定してください');
    process.exit(1);
  }
  let res;
  try {
    res = await postJson(flags.port, '/pair/native', { code: code, name: CLIENT_NAME });
  } catch (_) {
    logError('Agent が動いていません');
    process.exit(1);
  }
  let body = {};
  try { body = JSON.parse(res.body || ''); } catch (_) { body = {}; }
  if (res.status !== 200 || !body || body.ok !== true || typeof body.token !== 'string') {
    logError(pairError(body && body.error));
    process.exit(1);
  }
  currentToken = body.token;
  if (!saveToken(body.token)) {
    logError('トークンを保存できません');
    process.exit(1);
  }
  process.stdout.write('ペアリングしました\n');
}

async function main() {
  installRedaction();
  process.stdout.on('error', function () {});
  process.stdin.on('error', function () {});
  const parsed = parseArgs(process.argv.slice(2));
  const flags = parsed.flags;
  const rest = parsed.rest;
  if (rest[0] === 'pair') return pair(rest.slice(1), flags);
  if (rest.length) {
    logError(USAGE);
    process.exit(1);
  }
  if (!flags.port) {
    logError('ポートが不正です');
    process.exit(1);
  }
  startStdio(flags);
  return null;
}

if (require.main === module) {
  main().catch(function () {
    logError('失敗しました');
    process.exit(1);
  });
}

module.exports = {
  main: main,
  OFF_HINT: OFF_HINT,
  isExcluded: isExcluded,
  toolName: toolName,
  schemaFor: schemaFor,
  describeTool: describeTool,
  buildTools: buildTools,
  PAIR_HINT: PAIR_HINT,
  SUPPORTED_VERSIONS: SUPPORTED_VERSIONS
};
