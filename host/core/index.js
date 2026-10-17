'use strict';

/**
 * marust 核（host/core）の単一入口。
 *
 * 核の役割:
 * - 配信先の一覧とストリームキーの保持・管理
 * - 配信の開始と停止（メイン出力を含む一括停止）
 * - 送信中（live）状態の読み取りと監視
 * - 状態変化を伝える合図（イベント）の発行
 * - 配信エンジン（OBS 等）との通信・操作
 * ※ 画面（UI）や窓口（Gateway / API / HTTP / WebSocket）は持たない。
 *
 * 核が発行する主な合図（events.js より）:
 * - broadcast.started: 配信を開始した（配信先への送信開始）
 * - broadcast.stopped: 配信を一括停止した（メイン出力を含め全部止めた）
 * - broadcast.result: 配信開始・停止の成否結果
 * - stream.starting / stream.started: 個別配信先の送信準備・開始
 * - stream.stopping / stream.stopped: 個別配信先の送信停止中・停止完了
 * - engine.emergencyStop: 非常停止
 * - engine.target.changed: 配信対象の変更
 * - feature.toggled: 機能の有効/無効切替
 */

const events = require('./events');
const broadcast = require('./engine/broadcast');
const vault = require('./vault');
const safeRunner = require('./safe-runner');
const logWriter = require('./log-writer');
const owners = require('./owners');
const secretProvider = require('./secret-provider');
const obsConnection = require('./engine/obs-connection');
const obsLocal = require('./engine/obs-local');
const emergencyButton = require('./engine/emergency-button');
const coreBridge = require('./core-bridge');
const setDirs = require('./set-dirs');
const obsStreamControl = require('./engine/obs-stream-control');
const eventBus = require('./event-bus');
const stateStore = require('./state-store');
const engineIndex = require('./engine/index');
const preflight = require('./engine/preflight');
const observedBridge = require('./engine/observed-bridge');
const { defaultMask, createSecretMask } = require('./secret-mask');
const { tailOf, BULLETS } = require('./secret-tail');

const secretMask = Object.freeze({
  mask: (text) => defaultMask.mask(text),
  maskDeep: (obj) => defaultMask.maskDeep(obj)
});

module.exports = {
  // セットの置き場（計画 C・D6）
  resolveSetDirs: setDirs.resolveSetDirs,
  isAuthorBuild: setDirs.isAuthorBuild,

  // events
  EVENTS: events.EVENTS,
  CORE_SOURCE: events.CORE_SOURCE,
  EVENT_NAMES: events.EVENT_NAMES,
  ownerOf: events.ownerOf,

  // broadcast
  createBroadcast: broadcast.createBroadcast,
  sanitizePreflight: broadcast.sanitizePreflight,

  // vault
  createSecretProvider: vault.createSecretProvider,
  createSecretApi: vault.createSecretApi,
  selectBackend: vault.selectBackend,
  WINDOW_ID: vault.WINDOW_ID,
  NAME_RE: vault.NAME_RE,
  MAX_SECRET_BYTES: vault.MAX_SECRET_BYTES,

  // safe-runner
  run: safeRunner.run,
  defaultLogger: safeRunner.defaultLogger,
  redact: safeRunner.redact,
  defaultTimeoutMs: safeRunner.defaultTimeoutMs,

  // log-writer
  appendJsonl: logWriter.appendJsonl,

  // owners
  cleanOwns: owners.cleanOwns,
  claim: owners.claim,
  isParentAction: owners.isParentAction,
  resetParentActions: owners.resetParentActions,
  parentActionOwner: owners.parentActionOwner,
  owners: owners,

  // secret-provider
  createUnavailableProvider: secretProvider.createUnavailableProvider,
  safeSecretError: secretProvider.safeSecretError,

  // obs-connection
  createObsConnection: obsConnection.createObsConnection,
  readObsConfigFile: obsConnection.readObsConfigFile,
  normalizeConfig: obsConnection.normalizeConfig,
  DEFAULT_CONFIG: obsConnection.DEFAULT_CONFIG,
  VENDOR_NAME: obsConnection.VENDOR_NAME,

  // obs-local
  REQUIRED: obsLocal.REQUIRED,

  // emergency-button
  emergencyButtonState: emergencyButton.emergencyButtonState,

  // core-bridge
  createCore: coreBridge.createCore,

  // obs-stream-control
  createObsStreamControl: obsStreamControl.createObsStreamControl,

  // event-bus
  createEventBus: eventBus.createEventBus,

  // state-store
  createStateStore: stateStore.createStateStore,

  // engine
  createDefaultRegistry: engineIndex.createDefaultRegistry,

  // preflight
  createPreflight: preflight.createPreflight,

  // observed-bridge
  createObservedBridge: observedBridge.createObservedBridge,

  // secret-mask
  secretMask: secretMask,
  createSecretMask: createSecretMask,

  // secret-tail
  tailOf: tailOf,
  BULLETS: BULLETS
};
