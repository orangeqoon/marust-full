'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyEditionDefaults } = require('../lib/edition-defaults');

const ROOT = path.resolve(__dirname, '..');
const TEMP_ROOT = path.join(ROOT, 'dist', 'audit-20261017', 'tmp');
fs.mkdirSync(TEMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TEMP_ROOT, 'edition-defaults-'));

function settingsPath(stateDir) { return path.join(stateDir, 'data', 'marust', 'ui-settings.json'); }
function writeSettings(stateDir, value) {
  const file = settingsPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

try {
  for (const [edition, expected] of Object.entries({ minimum: { devMode: false, uiLevel: 'standard' }, full: { devMode: true, uiLevel: 'advanced' } })) {
    const stateDir = path.join(work, edition);
    const writes = [];
    const result = applyEditionDefaults({
      stateDir,
      buildInfo: { distribution: 'edition', edition },
      atomicWriteJsonSync(file, data) {
        writes.push(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(stateDir), 'utf8')), expected);
    assert.equal(writes.length, 1);
    assert.equal(applyEditionDefaults({ stateDir, buildInfo: { distribution: 'edition', edition } }).applied, false);
  }

  const existingState = path.join(work, 'existing');
  writeSettings(existingState, { devMode: false, uiLevel: 'basic', setupDone: true, features: 'comment-send' });
  const existingResult = applyEditionDefaults({ stateDir: existingState, buildInfo: { distribution: 'edition', edition: 'full' } });
  assert.equal(existingResult.applied, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(existingState), 'utf8')), { devMode: false, uiLevel: 'basic', setupDone: true, features: 'comment-send' });

  const partialState = path.join(work, 'partial');
  writeSettings(partialState, { devMode: false, setupDone: true });
  assert.equal(applyEditionDefaults({ stateDir: partialState, buildInfo: { distribution: 'edition', edition: 'full' } }).applied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(partialState), 'utf8')), { devMode: false, setupDone: true, uiLevel: 'advanced' });

  for (const info of [null, {}, { distribution: 'author', edition: 'full' }, { distribution: 'edition', edition: 'author' }, { distribution: 'edition', edition: 'unknown' }]) {
    const stateDir = path.join(work, 'invalid-info-' + Math.random().toString(16).slice(2));
    assert.equal(applyEditionDefaults({ stateDir, buildInfo: info }).applied, false);
    assert.equal(fs.existsSync(settingsPath(stateDir)), false);
  }

  const invalidSettings = path.join(work, 'invalid-settings');
  const invalidFile = settingsPath(invalidSettings);
  fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
  fs.writeFileSync(invalidFile, '{broken');
  assert.equal(applyEditionDefaults({ stateDir: invalidSettings, buildInfo: { distribution: 'edition', edition: 'full' } }).reason, 'settings-unreadable');
  assert.equal(fs.readFileSync(invalidFile, 'utf8'), '{broken');
  console.log('[edition-defaults] passed: first-run minimum/full, existing and partial settings, author/invalid metadata, malformed state');
} finally {
  const absolute = path.resolve(work); const base = path.resolve(TEMP_ROOT);
  if (!absolute.startsWith(base + path.sep)) throw new Error('refuse cleanup outside audit tmp');
  fs.rmSync(absolute, { recursive: true, force: true });
}
