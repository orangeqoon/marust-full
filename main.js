'use strict';

/**
 * marust（丸スト）プロセス入口。
 * 旧いアプリとは別アプリ。user_data も :18766 も触らない。
 * npm start は探索してプラグインを load し、ヘルスを出して終了する。
 * ファンアウトはプラグインごとのモードで決める。live が 1 つでもあれば MARUST_CONFIRM_LIVE=1 が無いと送らない。
 */

const { createCore } = require('./host/core');
const { createLogRetention } = require('./host/layer1/log-retention');
const { createRegistry } = require('./host/layer1/plugin-registry');
const { createEventBus } = require('./host/core');
const { createBootContext } = require('./host/layer1/boot-context');
const { createModeSource } = require('./host/layer1/mode-source');
const { createOrchestrator, createPeersBridge, cliFanoutDecision, formatModeSummary } = require('./host/layer1/orchestrator');

const { createCaptureReceiver } = require('./host/layer1/capture-receiver');
const { productPort } = require('./host/layer1/port-lock');
const { createObsConnection } = require('./host/core');
const { createSecretProvider } = require('./host/core');
const { createChatPort } = require('./host/layer1/chat-port');

function logLine(level, message) {
  const text = '[marust] ' + level + ' ' + (typeof message === 'string' ? message : '');
  if (level === 'error' || level === 'warn') console.error(text);
  else console.log(text);
}

async function main() {
  const core = createCore();
  const retention = createLogRetention({ core: core, logger: logLine });
  if (process.argv.includes('--serve') || process.argv.includes('--obs')) retention.start();
  else retention.runOnce();
  const bus = createEventBus();
  let registry = null;
  const chat = createChatPort(() => registry);
  let orchestrator = null;
  const modeSource = createModeSource();
  const secrets = createSecretProvider({ core: core, logger: logLine });
  secrets.attachStore(() => (registry ? registry.portHit('vault-store@1', 'vaultStore') : null));
  registry = createRegistry({
    core,
    appRoot: __dirname,
    bus,
    bootContext: createBootContext({ core, modeSource, logger: logLine }),
    secrets: secrets,
    peers: createPeersBridge(() => orchestrator),
    modeFor: (id) => (orchestrator ? orchestrator.modeFor(id) : 'legacy')
  });
  orchestrator = createOrchestrator({ registry, core, bus, modeSource });
  const discovered = registry.discover();
  for (const row of discovered) {
    console.log('[marust] plugin id=' + row.id + ' source=' + row.source + ' status=' + row.status + (row.reason ? ' reason=' + row.reason : ''));
  }
  await registry.loadAll();
  const mode = orchestrator.readMode();
  console.log('[marust] 丸スト骨格 mode=' + mode + ' set=' + discovered.filter((p) => p.source === 'set').length + ' user=' + discovered.filter((p) => p.source === 'user').length);
  const summary = orchestrator.summarizeModes();
  console.log('[marust] modes ' + formatModeSummary(summary));
  const health = await orchestrator.health();
  for (const row of health) {
    const detail = row.health && row.health.detail ? row.health.detail : '';
    console.log('[marust] health id=' + row.id + ' result=' + row.result + ' detail=' + detail);
  }
  if ((summary.live + summary.shadow) === 0) {
    console.log('[marust] legacy のためファンアウトは送りません。本番の配信操作は旧いアプリのままです。');
  }

  if (process.argv.includes('--fanout')) {
    const title = process.env.MARUST_DEMO_TITLE || 'marust-demo';
    const category = process.env.MARUST_DEMO_CATEGORY || '';
    const decision = cliFanoutDecision(summary, process.env.MARUST_CONFIRM_LIVE);
    if (!decision.send) {
      if (decision.reason !== 'legacy') {
        console.log('[marust] live のプラグインがあるため送りません。MARUST_CONFIRM_LIVE=1 が必要です。');
      }
    } else {
      const results = await orchestrator.fanout({
        title,
        category,
        source: 'timer-ui',
        allowedLiveIds: summary.liveIds.slice()
      });
      console.log('[marust] fanout ' + JSON.stringify(results));
    }
  }

  if (process.argv.includes('--obs')) {
    const listener = createObsConnection({
      orchestrator,
      core,
      getTitle: () => process.env.MARUST_DEMO_TITLE || ''
    });
    listener.start().catch(() => {
      console.error('[marust] obs connection not started');
    });
    console.log('[marust] obs connection enabled');
  }

  if (process.argv.includes('--serve')) {
    const { createGateway } = require('./host/layer1/gateway');
    const port = productPort(process.env.MARUST_STATUS_PORT);
    const onStatus = async () => ({
      name: 'marust',
      mode: orchestrator.readMode(),
      receiver: '127.0.0.1:18770',
      plugins: registry.snapshot().map((row) => ({
        id: row.id,
        source: row.source,
        siteId: row.siteId || '',
        status: row.status,
        reason: row.reason
      })),
      health: await orchestrator.health()
    });
    const receiver = createCaptureReceiver({ core, onStatus });
    const gateway = createGateway({
      core,
      receiver,
      onStatus,
      plugins: registry,
      overlayHub: registry.overlayHub,
      uiRoot: require('path').join(__dirname, 'ui')
    });
    await gateway.listen(port);
    console.log('[marust] gateway http://127.0.0.1:' + port + '/health');
    return;
  }

  if (process.argv.includes('--obs')) return;
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error('[marust] fatal ' + message);
  process.exit(1);
});
