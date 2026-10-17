'use strict';

/**
 * 診断の文（K3 で host/diagnostics.js から出した）。材料は核が作る平らな表（host/core/diagnostics-facts.js。read の API diagnostics.facts）。
 * ここは表を読んで findings にするだけ。ファイル・ネットワーク・金庫には触らない。値・秘密・トークンは返さない。
 */

const LOG_LIMIT_BYTES = 500 * 1024 * 1024;

const CODE_LABELS = Object.freeze({
  'agent-uptime': 'Agent の稼働時間',
  'gateway-listening': '窓口の待ち受け',
  'plugin-start-failed': 'プラグインの起動に失敗',
  'plugin-stuck': 'プラグインが止まっている',
  'plugin-status': 'プラグインの状態',
  'engine-disconnected': 'OBS エンジンが未接続',
  'engine-unsupported': 'OBS エンジンが非対応',
  'engine-status': 'OBS エンジン',
  'vault-unavailable': '金庫が使えない',
  'vault-status': '金庫',
  'logs-large': 'ログの容量が大きい',
  'logs-volume': 'ログの容量',
  'state-read-only': '状態ファイルが新しい版',
  'modes-unreadable': 'モード設定を読めない',
  'diagnostics-timeout': '診断を打ち切った',
  'recent-errors': '直近のエラー符号'
});

function redact(value) {
  let text = String(value == null ? '' : value);
  text = text.replace(/(bearer)\s+\S+/gi, '$1 [redacted]');
  text = text.replace(/(token|cookie|secret|password|authorization)(\s*[:=]\s*|\s+)(["']?)[^\s"',}]*/gi, '$1$2$3[redacted]');
  text = text.replace(/("(?:token|cookie|secret|password|authorization|set-cookie)"\s*:\s*")[^"]*/gi, '$1[redacted]');
  if (text.length > 240) text = text.slice(0, 240);
  return text;
}

function safeCode(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(text)) return '';
  if (/token|cookie|secret|password|bearer|authorization/i.test(text)) return '';
  return text;
}

function publicId(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(text)) return 'plugin';
  if (/token|cookie|secret|password|bearer|authorization/i.test(text)) return 'plugin';
  return text;
}

function finding(area, level, code, detail) {
  const levels = { ok: 'ok', warn: 'warn', error: 'error' };
  const safeLevel = levels[level] || 'warn';
  const safe = safeCode(code);
  if (!safe) return null;
  const areaText = /^[a-z-]{1,24}$/.test(area) ? area : 'diagnostics';
  const label = CODE_LABELS[safe] || '';
  return { area: areaText, level: safeLevel, code: safe, label: label, detail: redact(detail) };
}

function pluginDetail(id, status, mode, reason) {
  const parts = [id];
  if (status) parts.push('status=' + status);
  if (mode) parts.push('mode=' + mode);
  if (reason) parts.push('reason=' + reason);
  return parts.join(' ');
}

function agentFindings(facts) {
  const ms = typeof facts.uptimeMs === 'number' && Number.isFinite(facts.uptimeMs) && facts.uptimeMs >= 0 ? facts.uptimeMs : null;
  if (ms == null) return [finding('agent', 'warn', 'agent-uptime', '稼働時間は不明です')];
  return [finding('agent', 'ok', 'agent-uptime', '稼働 ' + Math.floor(ms / 1000) + ' 秒')];
}

function gatewayFindings(facts) {
  if (facts.gateway === true) return [finding('gateway', 'ok', 'gateway-listening', '待ち受け中')];
  return [finding('gateway', 'warn', 'gateway-listening', '待ち受けていません')];
}

function pluginFindings(facts) {
  const rows = Array.isArray(facts.plugins) ? facts.plugins : [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || !row.id) continue;
    const id = publicId(row.id);
    const status = safeCode(row.status) || 'unknown';
    const mode = row.mode === 'legacy' || row.mode === 'shadow' || row.mode === 'live' ? row.mode : '';
    const reason = safeCode(row.reason);
    const failed = row.startFailed === true || row.status === 'start-failed';
    const isStuck = row.stuck === true;
    if (failed) out.push(finding('plugin', 'error', 'plugin-start-failed', pluginDetail(id, 'start-failed', mode, reason)));
    if (isStuck) out.push(finding('plugin', 'warn', 'plugin-stuck', pluginDetail(id, status, mode, '')));
    if (!failed && !isStuck) out.push(finding('plugin', 'ok', 'plugin-status', pluginDetail(id, status, mode, '')));
  }
  return out;
}

function engineFindings(facts) {
  const engines = Array.isArray(facts.engines) ? facts.engines : [];
  if (!engines.length) return [finding('engine', 'error', 'engine-disconnected', 'エンジンがありません')];
  const out = [];
  for (let i = 0; i < engines.length; i += 1) {
    const item = engines[i] || {};
    const id = publicId(item.id);
    const status = item.status && typeof item.status === 'object' ? item.status : null;
    const connected = !!(status && status.connected === true);
    const unsupported = !!(status && status.supported === false);
    const mode = status && (status.mode === 'legacy' || status.mode === 'shadow' || status.mode === 'live') ? status.mode : '';
    if (!connected) out.push(finding('engine', 'error', 'engine-disconnected', id + ' 未接続'));
    if (unsupported) out.push(finding('engine', 'error', 'engine-unsupported', id + ' 非対応'));
    if (connected && !unsupported) out.push(finding('engine', 'ok', 'engine-status', id + ' 接続中' + (mode ? ' mode=' + mode : '')));
  }
  return out;
}

function vaultFindings(facts) {
  const state = facts.vault && typeof facts.vault === 'object' ? facts.vault : { known: false, usable: true };
  if (state.known && state.usable === false) return [finding('vault', 'error', 'vault-unavailable', '金庫は使えません')];
  if (state.usable === true) return [finding('vault', 'ok', 'vault-status', '金庫は使えます')];
  return [finding('vault', 'warn', 'vault-status', '金庫の状態は不明です')];
}

function logFindings(facts, bucket) {
  const logs = facts.logs && typeof facts.logs === 'object' ? facts.logs : { known: false, totalBytes: 0, recentErrors: [] };
  (Array.isArray(logs.recentErrors) ? logs.recentErrors : []).forEach(function (code) {
    const safe = safeCode(code);
    if (safe && bucket.indexOf(safe) === -1 && bucket.length < 20) bucket.push(safe);
  });
  if (logs.known !== true) return [finding('logs', 'ok', 'logs-volume', '計測なし')];
  const total = Number(logs.totalBytes);
  const bytes = Number.isFinite(total) && total >= 0 ? total : 0;
  const mb = Math.round(bytes / (1024 * 1024));
  const large = bytes > LOG_LIMIT_BYTES;
  const out = [finding('logs', large ? 'warn' : 'ok', 'logs-volume', '合計 ' + mb + ' MB')];
  if (large) out.push(finding('logs', 'warn', 'logs-large', '合計 ' + mb + ' MB'));
  if (bucket.length) out.push(finding('logs', 'warn', 'recent-errors', bucket.join(' ')));
  return out;
}

function stateFindings(facts) {
  if (facts.state && facts.state.readOnly === true) return [finding('state', 'warn', 'state-read-only', 'このビルドより新しい版です')];
  return [];
}

function modesFindings(facts) {
  if (facts.modes && facts.modes.unreadable === true) return [finding('modes', 'error', 'modes-unreadable', 'モード設定を読めません')];
  return [];
}

/** 核の diagnostics.facts の答えから診断の結果を作る。表が読めなければ ok:false。 */
function analyze(facts) {
  if (!facts || typeof facts !== 'object' || facts.ok === false) return { ok: false, error: 'unavailable' };
  const recentErrors = [];
  const all = [
    agentFindings(facts),
    gatewayFindings(facts),
    pluginFindings(facts),
    engineFindings(facts),
    vaultFindings(facts),
    logFindings(facts, recentErrors),
    stateFindings(facts),
    modesFindings(facts)
  ];
  const findings = [];
  all.forEach(function (rows) { rows.forEach(function (row) { if (row) findings.push(row); }); });
  if (facts.timedOut === true) {
    const row = finding('diagnostics', 'warn', 'diagnostics-timeout', '5 秒で打ち切りました');
    if (row) findings.push(row);
  }
  return {
    ok: !findings.some(function (row) { return row.level === 'error'; }),
    findings: findings,
    recentErrors: recentErrors.slice(0, 20)
  };
}

module.exports = { analyze, CODE_LABELS, LOG_LIMIT_BYTES };
