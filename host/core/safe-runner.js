'use strict';

/**
 * プラグイン呼び出しを例外とタイムアウトで隔離する。
 * 既定 8000ms。MARUST_PLUGIN_TIMEOUT_MS が 1000〜60000 の整数のときだけ上書き。
 * 呼び出し側が timeoutMs を渡したときはそれを使う（manifest の上限は orchestrator 側）。
 * タイムアウトしても本体の Promise は止めない。戻り値の settled がその完了を待つ。
 * この関数は投げない。
 */

function defaultTimeoutMs() {
  const raw = process.env.MARUST_PLUGIN_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return 8000;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return 8000;
  const n = Number(text);
  if (n >= 1000 && n <= 60000) return n;
  return 8000;
}

const { defaultMask } = require('./secret-mask');

function redact(message) {
  const rawText = message == null ? '' : String(message);
  const text = defaultMask.mask(rawText);
  const core = 'password|passwd|api[_-]?key|stream[_-]?key|token|cookie|authorization|secret|bearer';
  let replaced = rawText !== text;

  function splitCookieValue(rest) {
    const source = rest == null ? '' : String(rest);
    const match = source.match(/,\s*[A-Za-z][A-Za-z0-9_-]*\s*[:=]/);
    if (!match || match.index == null) return { head: source, tail: '' };
    return { head: source.slice(0, match.index), tail: source.slice(match.index) };
  }

  const cookieRe = /(^|[^A-Za-z0-9_-])(["']?)((?:set[-_])?cookie)\2(\s*[=:]\s*)([^\r\n]*)/gi;
  let out = text.replace(cookieRe, (full, boundary, nameQ, nameText, sep, rest) => {
    const parts = splitCookieValue(rest);
    const head = parts.head;
    if (head.trim() === '') return full;
    const quoted = head.match(/^(\s*)(["'])([\s\S]*?)\2/);
    replaced = true;
    if (quoted) {
      const after = head.slice(quoted[0].length);
      return boundary + nameQ + nameText + nameQ + sep + quoted[1] + quoted[2] + '***' + quoted[2] + after + parts.tail;
    }
    return boundary + nameQ + nameText + nameQ + sep + '***' + parts.tail;
  });

  const assignRe = new RegExp(
    '(["\']?)([A-Za-z0-9_-]*?(?:' + core + '))\\1(\\s*[=:]\\s*)(?:(["\'])([\\s\\S]*?)\\4|(bearer\\s+\\S+)|([^\\s&"\'`,}]+))?',
    'gi'
  );
  out = out.replace(assignRe, (full, nameQ, nameText, sep, valQ, quotedVal, bearerVal, bareVal) => {
    if (valQ) {
      replaced = true;
      return nameQ + nameText + nameQ + sep + valQ + '***' + valQ;
    }
    if (bearerVal) {
      replaced = true;
      return nameQ + nameText + nameQ + sep + 'Bearer ***';
    }
    if (bareVal) {
      replaced = true;
      return nameQ + nameText + nameQ + sep + '***';
    }
    return full;
  });
  const queryRe = /([?&])(["']?)(key)\2(\s*=\s*)(?:(["'])([\s\S]*?)\5|([^\s&"']+))?/gi;
  out = out.replace(queryRe, (full, lead, nameQ, nameText, sep, valQ, quotedVal, bareVal) => {
    if (valQ) {
      replaced = true;
      return lead + nameQ + nameText + nameQ + sep + valQ + '***' + valQ;
    }
    if (bareVal) {
      replaced = true;
      return lead + nameQ + nameText + nameQ + sep + '***';
    }
    return full;
  });
  out = out.replace(/\bBearer\s+(?!\*\*\*)(\S+)/gi, () => {
    replaced = true;
    return 'Bearer ***';
  });
  if (replaced) return out.slice(0, 300);
  const emptyAssign = new RegExp(
    '(?:^|[^A-Za-z0-9_])["\']?[A-Za-z0-9_-]*?(?:' + core + ')["\']?\\s*[=:]\\s*(?:$|\\s)',
    'i'
  );
  const emptyKey = /[?&]["']?key["']?\s*=\s*(?:$|\s|&)/i;
  const hiddenValue = new RegExp(
    '(?:^|[^A-Za-z0-9_])["\']?[A-Za-z0-9_-]*?(?:' + core + ')["\']?\\s*[=:]\\s*\\S',
    'i'
  );
  const hiddenKey = /[?&]["']?key["']?\s*=\s*\S/i;
  if (emptyAssign.test(text) || emptyKey.test(text) || hiddenValue.test(text) || hiddenKey.test(text)) {
    return '[redacted]';
  }
  return text.slice(0, 300);
}
function defaultLogger(level, message) {
  const line = `[marust] ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/**
 * @param {object} plugin
 * @param {string} methodName
 * @param {Array} args
 * @param {{ timeoutMs?: number, logger?: Function }} [options]
 * @returns {Promise<{result:string, code?:string, value?:*, elapsedMs:number, message:string, settled:Promise}>}
 */
function run(plugin, methodName, args, options) {
  const opts = options || {};
  const logger = typeof opts.logger === 'function' ? opts.logger : defaultLogger;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : defaultTimeoutMs();
  const started = Date.now();
  const fn = plugin && plugin[methodName];

  if (typeof fn !== 'function') {
    return Promise.resolve({
      result: 'skip',
      code: 'no-method',
      elapsedMs: 0,
      message: 'no-method',
      settled: Promise.resolve()
    });
  }

  let resolveSettled;
  const settled = new Promise((resolve) => {
    resolveSettled = resolve;
  });

  return new Promise((resolve) => {
    let returned = false;
    const finish = (out) => {
      if (returned) return;
      returned = true;
      clearTimeout(timer);
      out.settled = settled;
      out.timeoutMs = timeoutMs;
      resolve(out);
    };

    const timer = setTimeout(() => {
      logger('warn', `timeout method=${methodName} after ${timeoutMs}ms`);
      finish({
        result: 'timeout',
        elapsedMs: Date.now() - started,
        message: 'timeout'
      });
    }, timeoutMs);

    const succeed = (value) => {
      const late = {
        result: 'ok',
        value,
        elapsedMs: Date.now() - started,
        message: ''
      };
      resolveSettled(late);
      if (!returned) finish(late);
    };

    const fail = (err) => {
      const message = redact(err && err.message != null ? err.message : err);
      const late = {
        result: 'error',
        elapsedMs: Date.now() - started,
        message
      };
      // スタックは外へ出さない。registry が where（相対パス:行）に変えるためだけに持つ
      if (err && typeof err.stack === 'string') late.stack = err.stack;
      if (!returned) logger('error', `error method=${methodName} ${message}`);
      resolveSettled(late);
      if (!returned) finish(late);
    };

    try {
      const ret = fn.apply(plugin, Array.isArray(args) ? args : []);
      Promise.resolve(ret).then(succeed, fail);
    } catch (err) {
      fail(err);
    }
  });
}

module.exports = {
  run,
  defaultTimeoutMs,
  redact,
  defaultLogger
};