'use strict';

/**
 * サイトのプラグイン（plugins/sites/<site>/。R16）をテストから扱う道具。
 * 内部の id は役目ごと（site-twitch・sink-twitch・slot-youtube …）で、置き場所は plugins/sites/<site>/。
 * サイトのプラグインは全部この形に移したので、旧い形（plugins/<役目>-<site>/）の読み分けはもう無い。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');
const SITES = path.join(PLUGINS, 'sites');
const ROLE_RE = /^(site|sink|slot)-([a-z0-9][a-z0-9-]*)$/;

function siteDirOf(id) {
  const m = ROLE_RE.exec(id);
  if (!m) return '';
  const dir = path.join(SITES, m[2]);
  return fs.existsSync(path.join(dir, 'manifest.json')) ? dir : '';
}

/** 役目の manifest を置いてあるフォルダ（サイトのフォルダ）。 */
function dirOf(id) {
  const dir = siteDirOf(id);
  if (!dir) throw new Error('plugin not found: ' + id);
  return dir;
}

/** その役目の実装ファイル（require する本体）: site.js・sink.js・slot.js。 */
function mainFileOf(id) {
  return path.join(dirOf(id), ROLE_RE.exec(id)[1] + '.js');
}

function requirePlugin(id) {
  return require(mainFileOf(id));
}

/** パネルのフォルダ（ui/）。役目は兄弟のパネルをまとめて持つので、サイトの ui/ を返す。 */
function uiDirOf(id) {
  return path.join(dirOf(id), 'ui');
}

/** id のプラグインを、destRoot（レジストリの builtinRoot になる一時フォルダ）へ写す。サイトごと 1 回だけ。 */
function copyPlugin(id, destRoot) {
  const dir = dirOf(id);
  const target = path.join(destRoot, 'sites', path.basename(dir));
  if (!fs.existsSync(target)) fs.cpSync(dir, target, { recursive: true });
}

/** 公開サイトの「サイトの説明を持つ manifest」の一覧: [{ name: 'site-twitch', manifest }]（一番上の manifest）。 */
function siteManifests() {
  const out = [];
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  fs.readdirSync(SITES).forEach((n) => {
    const file = path.join(SITES, n, 'manifest.json');
    if (fs.existsSync(file)) out.push({ name: 'site-' + n, manifest: read(file) });
  });
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

let discovered = null;
/** その役目の manifest（レジストリが展開したあとの形。kind は integration・main・provides・secrets などは役目ごと）。 */
function roleManifest(id) {
  if (!discovered) {
    const os = require('os');
    const { createRegistry } = require('../host/layer1/plugin-registry');
    discovered = createRegistry({ appRoot: ROOT, core: { STATE_DIR: os.tmpdir() }, logger() {} }).discover();
  }
  const row = discovered.find((r) => r.id === id);
  if (!row) throw new Error('plugin not found: ' + id);
  return row.manifest;
}

/** その役目のパネルのスクリプト: site=panel.js・sink=panel-sink.js・slot=panel-slot.js。 */
function panelFileOf(id) {
  const m = ROLE_RE.exec(id);
  if (!m) throw new Error('plugin not found: ' + id);
  return path.join(dirOf(id), 'ui', m[1] === 'site' ? 'panel.js' : 'panel-' + m[1] + '.js');
}

module.exports = { panelFileOf, roleManifest, ROOT, PLUGINS, SITES, dirOf, mainFileOf, requirePlugin, uiDirOf, copyPlugin, siteManifests };
