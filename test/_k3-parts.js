'use strict';

/**
 * K3: 本体から内蔵プラグインへ出した部品（session の createSessions・chat-inlet の createChat）を、
 * 古い試験が今までと同じ呼び方で使えるようにする小さな包み。
 *  - events は本体の EVENTS を渡す（本物のプラグインでは ctx.events.NAMES）。
 *  - bus は、出どころ（source）を本物と同じに付ける（本物では ctx.bus が rec.id を付ける）。
 */

const { EVENTS } = require('../host/core/events');
const sessionsLib = require('../plugins/session/lib/sessions');
const sessionStoreLib = require('../plugins/session/lib/store');
const sessionPlugin = require('../plugins/session');
const chatLib = require('../plugins/chat-inlet/lib/chat');

function asPluginBus(bus, id) {
  if (!bus || typeof bus.publish !== 'function') return bus;
  return {
    publish: (name, payload, info) => bus.publish(name, payload, Object.assign({}, info || {}, { source: id })),
    subscribe: bus.subscribe ? bus.subscribe.bind(bus) : undefined
  };
}

function createSessions(options) {
  const opts = Object.assign({}, options || {});
  opts.events = opts.events || EVENTS;
  opts.bus = asPluginBus(opts.bus, 'session');
  return sessionsLib.createSessions(opts);
}

function createChat(options) {
  const opts = Object.assign({}, options || {});
  opts.events = opts.events || EVENTS;
  opts.bus = asPluginBus(opts.bus, 'chat-inlet');
  return chatLib.createChat(opts);
}

module.exports = Object.assign({}, { createSessions, createChat, asPluginBus, createSessionStore: sessionStoreLib.createSessionStore, sessionPlugin }, {
  DEFAULT_HEARTBEAT_MS: sessionsLib.DEFAULT_HEARTBEAT_MS,
  TEXT_MAX: chatLib.TEXT_MAX,
  NAME_MAX: chatLib.NAME_MAX,
  RECENT_MAX: chatLib.RECENT_MAX,
  DEDUPE_MAX: chatLib.DEDUPE_MAX,
  RATE_MAX: chatLib.RATE_MAX,
  SOURCE_RE: chatLib.SOURCE_RE
});
