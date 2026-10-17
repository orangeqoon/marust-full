'use strict';
// Rebuild the public edition using only this source tree and its declared npm dependencies.
const fs = require('node:fs');
const path = require('node:path');
const APP = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const edition = pkg.marustEdition;
const allowed = {
  minimum: { devMode: false, uiLevel: 'standard' },
  full: { devMode: true, uiLevel: 'advanced' }
};
if (!Object.prototype.hasOwnProperty.call(allowed, edition)) throw new Error('package.json must set marustEdition to minimum or full');
const expectedCount = Number(pkg.marustPluginCount);
if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error('package.json marustPluginCount is missing');
const { packAll, writeSetDir } = require('./pack-plugins');
const packager = require('electron-packager');
const outBase = path.join(APP, 'dist');
const pluginOut = path.join(APP, 'dist-plugins');
const index = packAll(pluginOut, APP);
const ids = index.map((row) => row.id);
if (ids.length !== expectedCount || new Set(ids).size !== ids.length) throw new Error(`plugin index mismatch: expected ${expectedCount}, got ${ids.length}`);
const indexText = fs.readFileSync(path.join(pluginOut, 'plugins-index.json'), 'utf8');
async function main() {
const result = await packager({
  dir: APP, name: 'marust', platform: 'win32', arch: 'x64', out: outBase,
  overwrite: true, executableName: 'marust', appVersion: pkg.version,
  icon: path.join(APP, 'assets', 'icon.ico'),
  ignore: [
    /^\/test(\/|$)/, /^\/docs(\/|$)/, /^\/types(\/|$)/,
    /^\/tsconfig\.json$/, /^\/dev-state(\/|$)/, /^\/\.git(\/|$)/,
    /^\/plugins(\/|$)/, /^\/plugins-author(\/|$)/,
    /^\/dist(\/|$)/, /^\/dist-author(\/|$)/, /^\/dist-core(\/|$)/,
    /^\/dist-plugins(\/|$)/, /^\/dist-author-next(\/|$)/,
    /^\/vendor-obs-plugin(\/|$)/
  ],
  afterCopy: [(buildPath, _version, _platform, _arch, done) => {
    try {
      fs.writeFileSync(path.join(buildPath, 'build-info.json'), JSON.stringify({
        distribution: 'edition', edition, editionDefaults: allowed[edition], pluginCount: expectedCount
      }, null, 2) + '\n');
      fs.writeFileSync(path.join(buildPath, 'plugins-index.json'), indexText);
      done();
    } catch (err) { done(err); }
  }]
});
const appOut = result[0];
const pluginsOut = path.join(appOut, 'plugins');
const written = writeSetDir(pluginsOut, APP);
if (written !== expectedCount) throw new Error(`plugin set mismatch: expected ${expectedCount}, got ${written}`);
fs.writeFileSync(path.join(appOut, `start-${edition}.cmd`), `@echo off\r\n"%~dp0marust.exe" %*\r\n`);
if (edition === 'full') fs.copyFileSync(path.join(APP, 'NOTICE-community-MIT.txt'), path.join(appOut, 'NOTICE-community-MIT.txt'));
console.log(`[build] ${edition}: ${expectedCount} plugins -> ${path.relative(APP, appOut)}`);


}
main().catch((err) => { console.error('[build] failed: ' + (err && err.message ? err.message : err)); process.exit(1); });


