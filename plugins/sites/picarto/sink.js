'use strict';

const tls = require('tls');
const crypto = require('crypto');

const MAX_SECRET = 64 * 1024;
const MAX_TEXT = 200;
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const HOST = 'chat.picarto.tv';
const SITE = 'picarto';
const SECRET = 'picarto.config';
const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLACE = '\u3053\u3053\u306b';

/**
 * Picarto へのコメント送信（chat.sink@1）。
 * wss://chat.picarto.tv/bot/username=<channel>&password=<token> につなぎ、
 * { type: chat, message } を送る。秘密は picarto.config の token と channel。
 * channel が無ければ no-credentials。リダイレクトは追わない。
 */

function maskFrame(opcode, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = buf[i] ^ mask[i % 4];
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  return Buffer.concat([header, masked]);
}

function allowedWs(value) {
  let parsed;
  try { parsed = new URL(value); } catch (err) { return false; }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;
  if (parsed.hostname.toLowerCase().replace(/\.$/, '') !== HOST) return false;
  return parsed.pathname.indexOf('/bot/username=') === 0;
}

function defaultConnect(spec) {
  if (!allowedWs(spec && spec.url)) {
    return Promise.reject(Object.assign(new Error('domain'), { code: 'domain' }));
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(spec.url);
    let done = false;
    let handshake = false;
    let buf = Buffer.alloc(0);
    const socket = tls.connect({
      host: HOST,
      port: 443,
      servername: HOST
    }, () => {
      const headers = spec.headers || {};
      const lines = [
        'GET ' + parsed.pathname + ' HTTP/1.1',
        'Host: ' + HOST,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + headers['Sec-WebSocket-Key'],
        'Sec-WebSocket-Version: 13',
        'User-Agent: ' + headers['User-Agent'],
        '',
        ''
      ];
      socket.write(lines.join('\r\n'));
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(Object.assign(new Error('http'), { code: 'http' }));
    }, 10000);
    function finish(code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (code) reject(Object.assign(new Error(code), { code: code }));
      else resolve({ status: 101 });
    }
    socket.on('data', (chunk) => {
      if (handshake || done) return;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString('utf8');
      const statusLine = head.split('\r\n')[0] || '';
      if (/^HTTP\/\d(?:\.\d)?\s+101\b/.test(statusLine)) {
        handshake = true;
        socket.write(maskFrame(0x1, spec.body));
        setTimeout(() => finish(''), 400);
        return;
      }
      finish(/^HTTP\/\d(?:\.\d)?\s+30[12378]\b/.test(statusLine) ? 'redirect' : 'http');
    });
    socket.on('error', () => finish('network'));
  });
}

function createSinkPicarto(deps) {
  const options = deps || {};
  const connectImpl = typeof options.connect === 'function' ? options.connect : defaultConnect;
  const nowFn = typeof options.now === 'function' ? options.now : function defaultNow() { return Date.now(); };
  let ctx = null;
  let nextAt = 0;
  const last = { result: '', at: '', configured: false };

  function fail(code) {
    const err = new Error('sink');
    err.code = code;
    return err;
  }

  function nowMs() {
    try {
      const value = nowFn();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isFinite(date.getTime())) return date.getTime();
    } catch (err) { /* 時計が壊れていても続ける */ }
    return Date.now();
  }

  function log(kind) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    try { ctx.logger('info', kind === 'ok' ? 'ok 1' : 'fail 1'); } catch (err) { /* ログで止めない */ }
  }

  function modeOf() {
    if (!ctx || typeof ctx.mode !== 'function') return 'legacy';
    try {
      const value = ctx.mode();
      if (value === 'live' || value === 'shadow' || value === 'legacy') return value;
    } catch (err) { /* legacy */ }
    return 'legacy';
  }

  function textError(text) {
    if (typeof text !== 'string') return 'empty';
    const n = Array.from(text).length;
    if (n < 1) return 'empty';
    if (n > MAX_TEXT) return 'too-long';
    return '';
  }

  function wsKey() {
    if (typeof options.wsKey === 'function') {
      const value = options.wsKey();
      if (typeof value === 'string' && /^[A-Za-z0-9+/=]{8,64}$/.test(value)) return value;
    }
    return crypto.randomBytes(16).toString('base64');
  }

  async function readRaw(name) {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return '';
    let result;
    try { result = await ctx.secrets.get(name); } catch (err) { return ''; }
    if (!result || result.ok !== true || typeof result.value !== 'string') return '';
    if (!result.value || result.value.length > MAX_SECRET || result.value.indexOf('\u0000') !== -1) return '';
    return result.value;
  }

  function configOf(text) {
    if (!text) return null;
    let data;
    try { data = JSON.parse(text); } catch (err) { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const token = typeof data.token === 'string' ? data.token.trim() : '';
    if (!token || token.indexOf(PLACE) !== -1 || token.length > 2000 || /[\r\n\u0000]/.test(token)) return null;
    const channel = typeof data.channel === 'string' ? data.channel.trim() : '';
    if (!CHANNEL_RE.test(channel)) return null;
    return { token: token, channel: channel };
  }

  function socketUrl(channel, token) {
    return 'wss://' + HOST + '/bot/username=' + encodeURIComponent(channel) + '&password=' + encodeURIComponent(token);
  }

  async function connectSend(spec) {
    if (!allowedWs(spec.url)) throw fail('domain');
    let result;
    try { result = await connectImpl(spec); } catch (err) {
      if (err && CODE_RE.test(err.code)) throw err;
      throw fail('network');
    }
    const status = result && typeof result.status === 'number' ? result.status : 101;
    if (REDIRECT.has(status) || status === 0) throw fail('redirect');
    if (status !== 101 && (status < 200 || status >= 300)) throw fail('http');
  }

  async function perform(config, text) {
    const url = socketUrl(config.channel, config.token);
    const body = JSON.stringify({ type: 'chat', message: String(text) });
    await connectSend({
      method: 'GET',
      url: url,
      headers: {
        Host: HOST,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': wsKey(),
        'Sec-WebSocket-Version': '13',
        'User-Agent': 'PTV-BOT-' + config.channel
      },
      body: body
    });
  }

  function takeSlot() {
    const now = nowMs();
    if (now < nextAt) return false;
    nextAt = now + 1000;
    return true;
  }

  function note(ok, configured) {
    last.result = ok ? 'ok' : 'ng';
    last.at = new Date(nowMs()).toISOString();
    if (configured === true || configured === false) last.configured = configured;
  }

  async function sendComment(input, meta) {
    if (!input || input.site !== SITE) {
      log('fail');
      return { ok: false, error: 'wrong-site' };
    }
    const problem = textError(input.text);
    if (problem) {
      log('fail');
      return { ok: false, error: problem };
    }
    if (meta && meta.dryRun === true) return { ok: true, dryRun: true };
    const mode = modeOf();
    if (mode === 'legacy') {
      log('fail');
      return { ok: false, error: 'legacy' };
    }
    if (mode === 'shadow') return { ok: true, dryRun: true };
    const config = configOf(await readRaw(SECRET));
    if (!config) {
      note(false, false);
      log('fail');
      return { ok: false, error: 'no-credentials' };
    }
    if (!takeSlot()) {
      log('fail');
      return { ok: false, error: 'rate-limit' };
    }
    try {
      await perform(config, input.text);
      note(true, true);
      log('ok');
      return { ok: true };
    } catch (err) {
      note(false, true);
      log('fail');
      const code = err && CODE_RE.test(err.code) ? err.code : 'http';
      return { ok: false, error: code };
    }
  }

  function getStatus() {
    return { ok: true, configured: last.configured, result: last.result, at: last.at };
  }

  return {
    load(passed) { ctx = passed || null; },
    start() {},
    stop() {},
    destroy() { ctx = null; },
    health() { return { ok: true, detail: 'sink-picarto' }; },
    sendComment: sendComment,
    getStatus: getStatus,
    actions: { getStatus: getStatus }
  };
}

const singleton = createSinkPicarto();
singleton.createSinkPicarto = createSinkPicarto;
module.exports = singleton;
