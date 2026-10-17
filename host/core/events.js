'use strict';

/**
 * ARCHITECTURE §5.4 のイベント名。publish は一覧に無くても捨てない。
 * version の既定は全部 1。
 */

const EVENTS = Object.freeze({
  SESSION_STARTED: 'session.started',
  SESSION_PAUSED: 'session.paused',
  SESSION_RESUMED: 'session.resumed',
  SESSION_ENDED: 'session.ended',
  SESSION_RETITLED: 'session.retitled',
  STREAM_PREFLIGHT_RESULT: 'stream.preflight.result',
  STREAM_STARTING: 'stream.starting',
  STREAM_STARTED: 'stream.started',
  STREAM_STOPPING: 'stream.stopping',
  STREAM_STOPPED: 'stream.stopped',
  ENGINE_TARGET_CHANGED: 'engine.target.changed',
  ENGINE_EMERGENCY_STOP: 'engine.emergencyStop',
  DESTINATION_OBSERVED: 'destination.observed',
  CHAT_MESSAGE: 'chat.message',
  CHAT_SENT: 'chat.sent',
  AUTH_UPDATED: 'auth.updated',
  VIEWER_COUNT: 'viewer.count',
  APPROVAL_RESOLVED: 'approval.resolved',
  BROADCAST_STARTED: 'broadcast.started',
  BROADCAST_RESULT: 'broadcast.result',
  BROADCAST_STOPPED: 'broadcast.stopped',
  HOTKEY_RESULT: 'hotkey.result',
  FEATURE_TOGGLED: 'feature.toggled',
  STREAM_METADATA_CHANGED: 'stream.metadata.changed',
  SIGNAL_STATE_CHANGED: 'signal.stateChanged',
  MODES_CHANGED: 'modes.changed',
  SLOT_ACQUIRED: 'slot.acquired',
  SITE_TROUBLE: 'site.trouble',
  SLOT_SWITCHING: 'slot.switching',
  PLUGIN_RELOADED: 'plugin.reloaded',
  UI_RELOAD_REQUESTED: 'ui.reloadRequested',
  UI_THEME_CHANGED: 'ui.themeChanged',
  UI_SHELL_CHANGED: 'ui.shellChanged'
});

const owners = require('./owners');

const EVENT_VERSION = 1;

// 持ち主のあるイベント（K3）。持ち主以外の source が出したら event-bus が捨てる（source は registry が rec.id で付ける）。
// 核が持ち主のものだけここに書く（'feature.toggled'。'#core' はプラグイン id になれない名前）。プラグインが持ち主のもの
// （session.*・chat.message など）は、内蔵プラグインが manifest の owns.events で名乗り、登録簿が host/core/owners.js へ入れる（計画 X・P1）。
const CORE_SOURCE = '#core';
const OWNERS = Object.freeze({
  'feature.toggled': CORE_SOURCE
});

function ownerOf(name) {
  const text = typeof name === 'string' ? name : '';
  const keys = Object.keys(OWNERS);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key.charAt(key.length - 1) === '.' ? text.indexOf(key) === 0 : text === key) return OWNERS[key];
  }
  return owners.eventOwner(text);
}
const EVENT_NAMES = new Set(Object.values(EVENTS));

function isKnownEvent(name) {
  return EVENT_NAMES.has(name);
}

function eventVersion() {
  return EVENT_VERSION;
}

module.exports = {
  CORE_SOURCE,
  OWNERS,
  ownerOf,
  EVENTS,
  EVENT_NAMES,
  EVENT_VERSION,
  isKnownEvent,
  eventVersion
};
