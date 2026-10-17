'use strict';

/**
 * 試験用の部品: 起動時の移しかえ（plugins-author/dev-legacy-migrate/boot.js）を、前の host/p2-migrate.js・host/modes-migrate.js と同じ呼び方で使う。
 * 本物の起動では registry が起動前フック（manifest の boot）として呼ぶ。
 */

const path = require('path');
const { createBootContext } = require('../host/layer1/boot-context');
const boot = require('../plugins-author/dev-legacy-migrate/boot');

function contextOf(o, rows) {
  return createBootContext({ core: o.core, bus: o.bus, audit: o.audit, uiSettings: o.uiSettings, logger: o.logger, fs: o.fs })('dev-legacy-migrate', rows);
}

module.exports = {
  migrateFeaturePlugins: (o) => boot.migrateFeaturePlugins(contextOf(o)),
  migrateModeKeys: (o) => boot.migrateModeKeys(contextOf(o, () => o.registry.snapshot())),
  markerPath: (core) => path.join(core.STATE_DIR, 'data', 'marust', boot.MARKER + '.json'),
  boot
};
