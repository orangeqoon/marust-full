'use strict';

/**
 * 中級機能の紹介（R24。K3 で host/tips.js から出した）。
 *  - 配信が終わった回数を数え、3 回目の終了から 1 つずつ紹介する。状態は dataDir/tips.json（初回だけ旧い置き場から写す）。
 *  - API tips.get（read）・tips.respond / tips.setFeature / tips.reset（ウィンドウだけの write）。名前・引数・権限は移す前と同じ。
 *  - 核が features.set（guide の機能）のとき出す feature.toggled を受けて、「使う」の印を残す。切（legacy）なら印は残らず、入／切だけ進む。
 * 外へは何も書かない。秘密は扱わない。
 */

const { createTips } = require('./lib/tips');
const { createTipsStore, TIP_IDS } = require('./lib/store');

let tips = null;

function loginStates(got) {
  const out = {};
  if (got && got.ok === true && got.states && typeof got.states === 'object') {
    Object.keys(got.states).forEach(function (site) { if (typeof got.states[site] === 'string') out[site] = got.states[site]; });
  }
  return out;
}

module.exports = {
  async load(ctx) {
    const store = createTipsStore({ dir: ctx.dataDir });
    let legacy = null;
    try {
      const got = await ctx.api.call('ui.getSettings', {});
      if (got && got.ok === true) {
        legacy = { completedStreams: got.completedStreams, tipsDone: got.tipsDone, tipPending: got.tipPending, features: got.features };
      }
    } catch (_) { legacy = null; }
    store.load(legacy);
    tips = createTips({
      uiSettings: store,
      bus: ctx.bus,
      getPlugins: async () => {
        const got = await ctx.api.call('hub.getState', {});
        return got && Array.isArray(got.plugins) ? got.plugins : [];
      },
      getLogin: async () => loginStates(await ctx.api.call('sites.loginStates', {}))
    });
    const idRule = { type: 'string', required: true, enum: TIP_IDS.slice(), error: 'bad-id', typeError: 'bad-id' };
    ctx.api.register('tips.get', () => Object.assign({ ok: true }, tips.get()), {
      access: 'read',
      description: '中級機能の紹介の状態（配信が終わった回数・いま出している紹介・済みの紹介・オンの機能）を返す（R24）。読むだけ',
      params: {}
    });
    ctx.api.register('tips.respond', (params) => tips.respond(params.id, params.action), {
      access: 'write',
      windowOnly: true,
      description: '中級機能の紹介への返事（setup=機能をオン / later=次の終了でまた / never=もう出さない）。ウィンドウだけ',
      params: {
        id: idRule,
        action: { type: 'string', required: true, enum: ['setup', 'later', 'never'], error: 'bad-action', typeError: 'bad-action' }
      }
    });
    ctx.api.register('tips.setFeature', (params) => tips.setFeature(params.id, params.on), {
      access: 'write',
      windowOnly: true,
      description: '中級機能のオン・オフ（ホームの「中級機能」）。ウィンドウだけ',
      params: { id: idRule, on: { type: 'boolean', required: true, typeError: 'bad-value' } }
    });
    ctx.api.register('tips.reset', () => tips.reset(), {
      access: 'write',
      windowOnly: true,
      description: '中級機能の紹介の「済み」を戻し、次の配信終了からまた紹介する（ヘルプ「中級機能の紹介を見る」）。機能のオン・オフは変えない。ウィンドウだけ',
      params: {}
    });
    // 核の features.set（guide の機能）が出す feature.toggled。持ち主は核（events.js の OWNERS）
    ctx.bus.subscribe(ctx.events.NAMES.FEATURE_TOGGLED, (_name, payload, meta) => {
      // 出どころが核のときだけ（持ち主のあるイベント。守りをもう 1 枚。K3 評価 Should 7）
      if (!meta || meta.source !== '#core') return;
      if (payload && typeof payload.id === 'string' && typeof payload.on === 'boolean' && tips) tips.setFeature(payload.id, payload.on);
    });
  },
  onEvent() {},
  start() {},
  stop() { if (tips) tips.stop(); tips = null; },
  destroy() { if (tips) tips.stop(); tips = null; },
  health() { return { ok: true }; }
};
