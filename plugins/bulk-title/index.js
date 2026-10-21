'use strict';

/**
 * 題名とカテゴリの一括変更（V2）。
 *  - fanout(intent): 本体の hub.fanout（orchestrator.fanout）から呼ばれる。各サイトへは ctx.peers 経由でだけ届く。
 *  - API category.suggest・favorites.get/add/remove/merge（名前・引数・権限は移す前と同じ）。
 * 本物の送信の確認の門・モードの扱いは本体。ここは外へ直接書かない・秘密にも触れない。
 */

const { createFanout } = require('./lib/fanout');
const { createFavorites } = require('./lib/favorites');
const { createTitleState } = require('./lib/title-state');

let fan = null;
let titleState = null;

function token(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? value : 'failed';
}

module.exports = {
  load(ctx) {
    fan = createFanout({
      peers: ctx.peers,
      bus: ctx.bus,
      logger: ctx.logger,
      audit: ctx.audit
    });
    titleState = createTitleState({
      dir: ctx.dataDir,
      bus: ctx.bus
    });
    const favorites = () => createFavorites({ dir: ctx.dataDir });
    const kindRule = { type: 'string', required: true, max: 10, enum: ['title', 'category'], error: 'bad-kind' };

    ctx.api.register('category.suggest', async (params) => {
      const ran = await ctx.peers.run('site-' + params.site, 'suggestCategories', [params.query]);
      if (!ran || ran.result !== 'ok') return { ok: false, error: ran && ran.message === 'peer-denied' ? 'unavailable' : 'failed' };
      const value = ran.value;
      if (!value || value.ok !== true || !Array.isArray(value.items)) {
        return { ok: false, error: token(value && value.error) };
      }
      return {
        ok: true,
        items: value.items.slice(0, 10).map((item) => ({
          id: item && item.id != null ? String(item.id) : '',
          name: item && typeof item.name === 'string' ? item.name : ''
        })).filter((item) => item.id && item.name)
      };
    }, {
      access: 'read',
      description: 'Twitch・Kickのカテゴリ候補を返す。秘密は返さない',
      params: {
        site: { type: 'string', required: true, max: 10, enum: ['twitch', 'kick'], error: 'unknown-site' },
        query: { type: 'string', required: true, max: 100 }
      }
    });
    ctx.api.register('favorites.get', (params) => {
      if (titleState && params && (typeof params.title === 'string' || typeof params.category === 'string')) {
        titleState.setDraft(params);
      }
      const res = favorites().get();
      if (titleState) res.state = titleState.getState();
      return res;
    }, {
      access: 'read',
      description: '題名・カテゴリのお気に入りと現在のタイトル変更プラグイン状態を返す',
      params: {
        title: { type: 'string', required: false, max: 200 },
        category: { type: 'string', required: false, max: 100 },
        source: { type: 'string', required: false, max: 32 }
      }
    });
    ctx.api.register('favorites.add', (params) => favorites().add(params.kind, params.value), {
      access: 'write',
      windowOnly: true,
      description: '題名・カテゴリをお気に入りに入れる（最大 50 件・新しいものが先頭）',
      params: { kind: kindRule, value: { type: 'string', required: true, max: 200 } }
    });
    ctx.api.register('favorites.remove', (params) => favorites().remove(params.kind, params.value), {
      access: 'write',
      windowOnly: true,
      description: '題名・カテゴリをお気に入りから外す',
      params: { kind: kindRule, value: { type: 'string', required: true, max: 200 } }
    });
    // 一覧をまとめて足す。外のプラグインが読んだ一覧（引き継ぎなど）を、画面が渡す。プラグインどうしは呼び合わない
    ctx.api.register('favorites.merge', (params) => favorites().merge(params.titles, params.categories), {
      access: 'write',
      windowOnly: true,
      description: '題名・カテゴリの一覧を、お気に入りに足す（今ある分は残す・最大 50 件。件数と保存済みの一覧を返す）',
      params: {
        titles: { type: 'array', required: true, max: 50, error: 'bad-titles', typeError: 'bad-titles', item: { type: 'string', max: 200 } },
        categories: { type: 'array', required: true, max: 50, error: 'bad-categories', typeError: 'bad-categories', item: { type: 'string', max: 100 } }
      }
    });
  },
  start() {},
  stop() { fan = null; titleState = null; },
  destroy() { fan = null; titleState = null; },
  health() { return { ok: true }; },
  // 本体の orchestrator.fanout が呼ぶ（役目 title.fanout@1）
  async fanout(intent) {
    if (!fan) return [{ id: '*', result: 'skip', elapsedMs: 0, message: 'no-plugin' }];
    if (titleState) titleState.markSending(intent);
    const rows = await fan.fanout(intent);
    if (titleState) titleState.recordFanout(intent, rows);
    return rows;
  }
};
