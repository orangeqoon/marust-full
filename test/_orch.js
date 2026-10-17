'use strict';

/**
 * V2: 題名の一斉変更の中身は plugins/bulk-title/lib/fanout.js に移った。
 * 偽の registry で orchestrator.fanout を確かめる古い試験のために、本物の createFanout を
 * 「本体の peerList / peerRun」につないだ orchestrator を作る（opts.fanoutImpl の差し込み口を使う）。
 * 新しい試験は本物の bulk-title を読み込むこと（test/v2-bulk-title.test.js）。
 */

const real = require('../host/layer1/orchestrator');
const { createFanout } = require('../plugins/bulk-title/lib/fanout');

function createOrchestrator(options) {
  const opts = options || {};
  let orch = null;
  const peers = {
    list: () => orch.peerList('bulk-title'),
    run: (id, method, args, o) => orch.peerRun('bulk-title', id, method, args, o)
  };
  const core = opts.core;
  const fan = createFanout({
    peers: peers,
    bus: opts.bus && typeof opts.bus.publish === 'function' ? { publish: (name, payload) => opts.bus.publish(name, payload) } : null,
    logger: typeof opts.logger === 'function' ? opts.logger : function () {},
    audit: core && core.STATE_DIR ? {
      fields: require('../host/layer1/audit-fields'),
      append: (record) => require('../host/core/log-writer').appendJsonl(require('path').join(core.STATE_DIR, 'logs', 'marust'), 'shadow', record)
    } : null
  });
  orch = real.createOrchestrator(Object.assign({}, opts, { fanoutImpl: (intent) => fan.fanout(intent) }));
  return orch;
}

module.exports = Object.assign({}, real, { createOrchestrator });
