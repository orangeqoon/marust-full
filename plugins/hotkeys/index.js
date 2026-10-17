'use strict';

/**
 * ホットキー（V3 は印だけ。K3 で ctx.keys につないだ）。
 * キーの検査・登録・押下の実行（窓と同じ権限・全部止めるは 1 回押し）は一層目の口 ctx.keys（host/layer1/keys-port.js）。ここは API の名前と、入／切・読み直しのきっかけだけ。
 *   hotkeys.list（read）・hotkeys.save（ウィンドウだけの write）。名前・引数・権限は移す前と同じ。
 * 切（legacy）のあいだ核は何も登録せず、hotkeys.list・hotkeys.save も無いものとして扱う。入れるまで、全部止めるのキーも効かない。
 */

let keys = null;
let ctxRef = null;

function reload() {
  if (!keys) return Promise.resolve({ ok: false, error: 'unavailable' });
  return keys.reload();
}

module.exports = {
  load(ctx) {
    ctxRef = ctx;
    keys = ctx.keys || null;
    ctx.api.register('hotkeys.list', () => (keys ? keys.list() : { ok: false, error: 'unavailable' }), {
      access: 'read',
      description: 'ホットキーの割り当てを返す',
      params: {}
    });
    ctx.api.register('hotkeys.save', (params) => (keys ? keys.save(params.bindings) : { ok: false, error: 'unavailable' }), {
      access: 'write',
      windowOnly: true,
      description: 'ホットキーを検証して保存し、登録し直す',
      params: { bindings: { type: 'array', required: true, max: 32 } }
    });
    // 機能の入／切・プラグインの読み直しで、登録を作り直す（一覧が古くならない。切っていれば核が何も登録しない）
    const again = () => { reload().catch(() => {}); };
    ctx.bus.subscribe(ctx.events.NAMES.MODES_CHANGED, again);
    ctx.bus.subscribe(ctx.events.NAMES.PLUGIN_RELOADED, again);
  },
  onEvent() {},
  start() { reload().catch(() => {}); },
  stop() { if (keys) keys.release(); },
  destroy() { if (keys) keys.release(); keys = null; ctxRef = null; },
  health() { return { ok: true, detail: ctxRef ? 'hotkeys' : '' }; }
};
