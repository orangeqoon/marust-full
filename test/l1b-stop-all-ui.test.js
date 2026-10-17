'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

test('home.js has home-stop-all and calls broadcast.stopAll', () => {
  const src = read('plugins/ui-standard/shell/panels/home.js');
  assert.ok(src.includes("id: 'home-stop-all'"));
  assert.ok(src.includes("call('broadcast.stopAll', {})"));
});

test('home-stop-all is not inside the same actions container as home-start', () => {
  const src = read('plugins/ui-standard/shell/panels/home.js');
  // home-stop-all appears inside stop-all-row, home-start inside broadcast-main actions
  assert.ok(src.indexOf('stop-all-row') < src.indexOf('home-stop-all'));
  assert.ok(src.indexOf('timer-actions broadcast-main') < src.indexOf('home-start'));
  assert.ok(src.indexOf('home-start') < src.indexOf('home-stop-all') === false);
});

test('key-restart and restartIfActive are removed from home.js', () => {
  const src = read('plugins/ui-standard/shell/panels/home.js');
  assert.ok(!src.includes('key-restart'));
  assert.ok(!src.includes('restartIfActive'));
  assert.ok(src.includes('homeKeyLocked'));
});

test('hub.html does not load emergency-hold.js', () => {
  const html = require('./_ui-source').shellDocument();
  assert.ok(!html.includes('emergency-hold.js'));
});

test('emergency panel uses click and broadcast.stopAll, no MarustEmergencyHold', () => {
  const src = read('plugins/ui-standard/shell/panels/emergency.js');
  assert.ok(src.includes("call('broadcast.stopAll', {})"));
  assert.ok(src.includes("button.addEventListener('click', handleStopAll)"));
  assert.ok(!src.includes('MarustEmergencyHold'));
});

test('destinations panel no longer has stream-all-stop button', () => {
  const src = read('plugins/ui-standard/shell/panels/destinations.js');
  assert.ok(!src.includes('stream-all-stop'));
});

test('emergencyButtonState returns only blue and gray, no red, hold always false', () => {
  const { emergencyButtonState } = require('../host/core/engine/emergency-button');
  const states = [
    emergencyButtonState([], false),
    emergencyButtonState([], true),
    emergencyButtonState([{ state: 'stopped' }], true),
    emergencyButtonState([{ state: 'live' }], true),
    emergencyButtonState([{ state: 'connecting' }], true),
    emergencyButtonState([{ state: 'reconnecting' }], true)
  ];
  states.forEach((s) => {
    assert.ok(s.color === 'blue' || s.color === 'gray');
    assert.strictEqual(s.hold, false);
  });
});

if (failed) {
  console.error('l1b-stop-all-ui: ' + failed + ' failed');
  process.exit(1);
}
console.log('l1b-stop-all-ui ok');
