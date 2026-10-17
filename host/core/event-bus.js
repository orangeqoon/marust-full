'use strict';

/**
 * 名前付きイベントを配る。publish は投げない・待たない。
 * 受け手ごとに順番を保つキュー。呼び出しは Safe-Runner 経由。
 * キュー上限 1000。超えたら古いものを捨てて件数だけ warn する。
 * タイムアウトしても settled まで次を渡さない。max(timeout*3, 60秒) を過ぎたら stuck。
 */

const crypto = require('crypto');
const { isKnownEvent, eventVersion, ownerOf } = require('./events');
const { run, defaultLogger, defaultTimeoutMs } = require('./safe-runner');

const QUEUE_CAP = 1000;
const STUCK_FLOOR_MS = 60000;

function matches(pattern, name) {
  if (typeof pattern !== 'string' || typeof name !== 'string') return false;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

function createEventBus(options) {
  const opts = options || {};
  const logger = typeof opts.logger === 'function' ? opts.logger : defaultLogger;
  const runner = opts.run || run;
  const subscribers = [];
  let seq = 0;

  function clonePayload(payload) {
    if (payload === undefined) return undefined;
    try {
      return structuredClone(payload);
    } catch (err) {
      logger('warn', 'event clone failed count=1');
      return undefined;
    }
  }

  function stuckLimitMs(sub, out) {
    if (Number.isFinite(opts.stuckAfterMs) && opts.stuckAfterMs >= 0) return opts.stuckAfterMs;
    const timeoutMs = out && Number.isFinite(out.timeoutMs)
      ? out.timeoutMs
      : (Number.isFinite(sub.timeoutMs) ? sub.timeoutMs : defaultTimeoutMs());
    return Math.max(timeoutMs * 3, STUCK_FLOOR_MS);
  }

  function holdSettled(sub, out) {
    if (!out || out.result !== 'timeout' || !out.settled || typeof out.settled.then !== 'function') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished || sub.stuck) return;
        sub.stuck = true;
        const dropped = sub.queue.length;
        sub.queue.length = 0;
        logger('warn', 'event-bus stuck count=' + dropped);
      }, stuckLimitMs(sub, out));
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        sub.stuck = false;
        resolve();
      };
      Promise.resolve(out.settled).then(done, done);
    });
  }

  function pump(sub) {
    if (sub.pumping || sub.removed) return;
    sub.pumping = true;
    const kick = () => {
      if (sub.removed || sub.stuck || !sub.queue.length) {
        sub.pumping = false;
        return;
      }
      const item = sub.queue.shift();
      const plugin = {
        onEvent() {
          return sub.handler(item.name, item.payload, item.meta);
        }
      };
      const callOpts = { logger };
      if (Number.isFinite(sub.timeoutMs)) callOpts.timeoutMs = sub.timeoutMs;
      Promise.resolve()
        .then(() => runner(plugin, 'onEvent', [], callOpts))
        .then((out) => holdSettled(sub, out))
        .then(() => kick(), () => kick());
    };
    setImmediate(kick);
  }

  function subscribe(pattern, handler, options) {
    const subOpts = options || {};
    if (typeof pattern !== 'string' || typeof handler !== 'function') {
      return function unsubscribe() {};
    }
    const sub = {
      id: ++seq,
      pattern,
      handler,
      pluginId: subOpts.pluginId == null ? '' : String(subOpts.pluginId),
      timeoutMs: Number.isFinite(subOpts.timeoutMs) ? subOpts.timeoutMs : undefined,
      queue: [],
      pumping: false,
      removed: false,
      stuck: false
    };
    subscribers.push(sub);
    return function unsubscribe() {
      sub.removed = true;
      sub.queue.length = 0;
      const index = subscribers.indexOf(sub);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'e-' + crypto.randomBytes(8).toString('hex');
  }

  function publish(name, payload, info) {
    try {
      const eventName = typeof name === 'string' ? name : '';
      if (!isKnownEvent(eventName)) logger('warn', 'unknown event count=1');
      const extra = info && typeof info === 'object' ? info : {};
      const version = Number.isFinite(extra.version) ? extra.version : eventVersion(eventName);
      const id = extra.id ? String(extra.id) : newId();
      const occurredAt = typeof extra.occurredAt === 'string' && extra.occurredAt ? extra.occurredAt : new Date().toISOString();
      const source = extra.source == null ? '' : String(extra.source);
      // 持ち主のあるイベント（events.js の OWNERS）は、持ち主以外の source からは出せない（source の無い核の内側の呼び出しは通す）
      const owner = ownerOf(eventName);
      if (owner && source && source !== owner) {
        logger('warn', 'event owner refused ' + source + ' ' + eventName);
        return 0;
      }
      const correlationId = extra.correlationId == null ? '' : String(extra.correlationId);
      let handed = 0;
      for (const sub of subscribers.slice()) {
        if (sub.removed || sub.stuck || !matches(sub.pattern, eventName)) continue;
        sub.queue.push({
          name: eventName,
          payload: clonePayload(payload),
          meta: {
            id: id,
            version: version,
            occurredAt: occurredAt,
            source: source,
            correlationId: correlationId,
            pluginId: sub.pluginId
          }
        });
        handed += 1;
        if (sub.queue.length > QUEUE_CAP) {
          const overflow = sub.queue.length - QUEUE_CAP;
          sub.queue.splice(0, overflow);
          logger('warn', 'event-bus drop count=' + overflow);
        }
        pump(sub);
      }
      return handed;
    } catch (err) {
      logger('warn', 'publish failed count=1');
      return 0;
    }
  }

  function flush() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const busy = subscribers.some((sub) => sub.pumping || sub.queue.length);
        if (!busy) {
          resolve();
          return;
        }
        if (Date.now() - started > 5000) {
          reject(new Error('event-bus flush timeout'));
          return;
        }
        setImmediate(check);
      };
      setImmediate(check);
    });
  }

  return { publish, subscribe, flush, QUEUE_CAP };
}

module.exports = { createEventBus, QUEUE_CAP };
