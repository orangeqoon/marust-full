'use strict';

/**
 * manifest v2 の見本。配信 API は呼ばない。
 * パネル、オーバーレイ、action、購読、dataDir を一度ずつ使う。
 */

const fs = require('fs');
const path = require('path');

function clip(value) {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

function remember(params, ctx) {
  const note = clip(params && params.note);
  fs.writeFileSync(path.join(ctx.dataDir, 'note.json'), JSON.stringify({ note: note }));
  ctx.overlay.publish('clock', { title: '見本', note: note });
  return { ok: true, note: note };
}

module.exports = {
  load(ctx) {
    ctx.logger('info', 'load');
    const file = path.join(ctx.dataDir, 'started.json');
    fs.writeFileSync(file, JSON.stringify({
      id: ctx.id,
      mode: ctx.mode(),
      name: ctx.manifest.name
    }));
    ctx.bus.subscribe('session.*', (name, payload) => {
      ctx.overlay.publish('clock', {
        title: clip(payload && payload.title),
        note: clip(name)
      });
    });
  },
  start() {},
  stop() {},
  destroy() {},
  onEvent() {},
  health() {
    return { ok: true, detail: 'sample-v2' };
  },
  actions: { remember }
};
