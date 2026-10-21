'use strict';
const { hubSource } = require('../../../test/_ui-source');
// M1 の評価（docs/reviews/M1-result.md）で直した所の検査
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STR = require('../../../plugins/ui-standard/shell/strings.js');

let pending = Promise.resolve();
function test(name, fn) {
  pending = pending.then(async () => {
    try { await fn(); console.log('ok ' + name); } catch (err) { console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); process.exit(1); }
  });
}

test('dev panels are only dropped from a saved layout once devMode is known', () => {
  const hub = hubSource();
  assert.ok(hub.indexOf('var devModeKnown = false;') !== -1);
  assert.ok(/function dropDevPanels\(\) \{\s*if \(devMode \|\| !devModeKnown/.test(hub));
  assert.ok(hub.indexOf('devModeKnown = true;') !== -1);
});

test('the MCP pairing button follows dev mode', () => {
  const hub = hubSource();
  assert.ok(hub.indexOf('mcpButton.hidden = !devMode') !== -1);
  assert.ok(hub.indexOf("document.getElementById('pair-mcp')") !== -1);
});

test('a dev panel opened by ?panel= falls back to the list when dev mode is off', () => {
  const hub = hubSource();
  assert.ok(hub.indexOf('soloPanelId') !== -1);
  assert.ok(hub.indexOf("window.location.replace(window.location.pathname + '?panel=')") !== -1);
});

test('top bar: OBS state, live count (general) and the mode counts (dev only)', () => {
  assert.strictEqual(STR.topBar(false, 'live 1 / shadow 0 / legacy 0', true, 3), 'OBS: つながっています / 送信中: 3 か所');
  assert.strictEqual(STR.topBar(false, 'x', false, 3), 'OBS: つながっていません');
  assert.strictEqual(STR.topBar(true, 'live 1 / shadow 0 / legacy 0', true, 0), 'OBS: つながっています / 送信中: 0 か所 / live 1 / shadow 0 / legacy 0');
  assert.strictEqual(STR.topBar(false, 'x', true, null), 'OBS: つながっています');
});

test('hub.getState carries destinations.liveCount from the engine status', () => {
  const main = read('electron-main.js');
  assert.ok(main.indexOf('destinations.liveCount = Number(engineStatus.liveCount)') !== -1);
  assert.ok(read('host/core/engine/obs-local.js').indexOf("row.state === 'live'") !== -1);
});

test('the whole-site hint no longer speaks about a single site', () => {
  // モードの画面は dev-shadow のプラグインへ移った（K3）。言葉は plugins/dev-shadow/plugins/ui-standard/shell/strings.js の写し
  const panel = read('plugins/dev-shadow/ui/modes.js');
  const fn = panel.slice(panel.indexOf('function modeHintText'), panel.indexOf('function modesSourceLabel'));
  assert.ok(fn.indexOf('S.sendNoneAll') !== -1);
  assert.strictEqual(fn.indexOf('S.sendNone;'), -1);
});

pending.then(() => console.log('m1-fixes ok'));
