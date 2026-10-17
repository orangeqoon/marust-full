'use strict';

/**
 * 回線の余裕の設定（V3-8）。プラグインの ctx.dataDir/settings.json に持つ。
 * 無いときは初回だけ、旧い画面の設定（data/marust/ui-settings.json）の 3 欄を、今の範囲に入るものだけ写す（旧ファイルは書き換えない）。
 */

const fs = require('fs');
const path = require('path');

const FILE = 'settings.json';
const LEGACY_FILE = 'ui-settings.json';
const DEFAULTS = Object.freeze({ uplinkMbps: 0, tightPercent: 70, shortPercent: 90 });
const RANGES = Object.freeze({ uplinkMbps: [0, 100000], tightPercent: [10, 100], shortPercent: [10, 100] });
const LEGACY_KEYS = Object.freeze({ uplinkMbps: 'uplinkMbps', tightPercent: 'uplinkTightPercent', shortPercent: 'uplinkShortPercent' });
const MAX_BYTES = 256 * 1024;

function inRange(key, value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= RANGES[key][0] && value <= RANGES[key][1];
}

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (_) {
    return null;
  }
}

function legacyPath(ctx) {
  if (!ctx || typeof ctx.dataDir !== 'string' || !ctx.dataDir) return '';
  return path.resolve(ctx.dataDir, '..', '..', LEGACY_FILE);
}

// 範囲外・型違いの欄は既定のまま
function pick(data, keyOf) {
  const out = Object.assign({}, DEFAULTS);
  Object.keys(DEFAULTS).forEach(function (key) {
    const value = data[keyOf(key)];
    if (inRange(key, value)) out[key] = value;
  });
  return out;
}

function save(ctx, settings) {
  if (!ctx || typeof ctx.dataDir !== 'string' || !ctx.dataDir) return false;
  const file = path.join(ctx.dataDir, FILE);
  const data = Object.assign({ version: 1 }, settings);
  try {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

// settings.json があればそれ。無ければ旧ファイルから 1 回だけ写して settings.json を書く（書けなければメモリだけで続ける）
function loadSettings(ctx) {
  if (ctx && typeof ctx.dataDir === 'string' && ctx.dataDir) {
    const own = readJson(path.join(ctx.dataDir, FILE));
    if (own) return pick(own, function (key) { return key; });
  }
  const oldFile = legacyPath(ctx);
  const old = oldFile ? readJson(oldFile) : null;
  const settings = old ? pick(old, function (key) { return LEGACY_KEYS[key]; }) : Object.assign({}, DEFAULTS);
  if (old) save(ctx, settings);
  return settings;
}

module.exports = { loadSettings, save, DEFAULTS, RANGES };
