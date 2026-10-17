#!/usr/bin/env node
'use strict';

/**
 * 「本体だけ」の配り物を作る（v3 §5.1・V5）。npm run build:core。
 *   - plugins/・plugins-author/ を入れない（本体＋画面だけ。画面のプラグインは V8・V9 で builtin に入る）。
 *   - exe の中に build-info.json（{ distribution: 'core' }）と plugins-index.json（内蔵プラグインの id・版・SHA-256）を同梱する。
 *     「本体だけ」かどうかは plugins/ が空かどうかで推し量らない（Opus 2026-10-10 Q-2026-10-10-v5-distribution.md）。
 *   - 出力: dist-core/（git の管理外）と dist-plugins/（pack:plugins の出力）。
 * 配るのは「入れる道」ができてから（今は作るだけ。内蔵つきの npm run build が配り物）。
 */

const fs = require('fs');
const path = require('path');
const { packAll, packLists, writePacks, PACK_ORDER } = require('./pack-plugins');

const APP_ROOT = path.join(__dirname, '..');

// electron-packager の ignore（build と同じ除外に、plugins と dist-core を足す）
const CORE_IGNORE = Object.freeze([
  '/test', '/docs', '/types', '/tsconfig.json', '/dev-state', '/.git', '/plugins-author', '/dist-author', '/dist-core', '/dist-plugins', '/vendor-obs-plugin',
  '^/plugins$', '^/plugins/', '^/dist$'
]);

function buildInfo() {
  return { distribution: 'core', builtAt: new Date().toISOString().slice(0, 10) };
}

async function main() {
  const packager = require('electron-packager');
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  const pluginsOut = path.join(APP_ROOT, 'dist-plugins');
  const index = packAll(pluginsOut);
  // 束（K5）。リポジトリの正本 packs/*.json が plugins/ の manifest.tier と食い違うなら止める（exe に古い束を同梱しない）
  const lists = packLists(index);
  PACK_ORDER.forEach((name) => {
    let have = null;
    try { have = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'packs', name + '.json'), 'utf8')); } catch (_) { /* 下で止める */ }
    if (!have || JSON.stringify(have) !== JSON.stringify(lists[name])) throw new Error('packs/' + name + '.json が古い。npm run pack:plugins をやり直す');
  });
  writePacks(index, pluginsOut, path.join(APP_ROOT, 'packs'), APP_ROOT);
  const indexText = fs.readFileSync(path.join(pluginsOut, 'plugins-index.json'), 'utf8');
  const out = await packager({
    dir: APP_ROOT,
    name: 'marust',
    platform: 'win32',
    arch: 'x64',
    out: path.join(APP_ROOT, 'dist-core'),
    overwrite: true,
    executableName: 'marust',
    appVersion: pkg.version,
    icon: path.join(APP_ROOT, 'assets', 'icon.ico'),
    // OBS プラグイン（L5b）。cli/bundle-obs-plugin.js が作った写しがあれば resourcesendor-obs-plugin に入れる
    extraResource: fs.existsSync(path.join(APP_ROOT, 'vendor-obs-plugin')) ? [path.join(APP_ROOT, 'vendor-obs-plugin')] : [],
    ignore: CORE_IGNORE.map((p) => new RegExp(p.charAt(0) === '^' ? p : '^' + p.replace(/[.]/g, '\.') + '(/|$)')),
    afterCopy: [(buildPath, _electronVersion, _platform, _arch, done) => {
      try {
        fs.writeFileSync(path.join(buildPath, 'build-info.json'), JSON.stringify(buildInfo(), null, 2) + '\n');
        fs.writeFileSync(path.join(buildPath, 'plugins-index.json'), indexText);
        done();
      } catch (err) { done(err); }
    }]
  });
  console.log('[build:core] ' + out.join(', ') + ' / 内蔵プラグイン zip ' + index.length + ' 個 -> dist-plugins');
}

if (require.main === module) {
  main().catch((err) => { console.error('[build:core] failed: ' + (err && err.message ? err.message : err)); process.exit(1); });
}

module.exports = { CORE_IGNORE, buildInfo };
