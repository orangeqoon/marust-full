'use strict';

/**
 * 役割ごとの「約束の試験」（計画 X・P6）。役割（manifest の provides。例: stream.site@1）を名乗るプラグインが、本体が呼ぶ口を持っているか。
 * 同じ役割の別のプラグインに入れ替えても本体を直さなくてよい、を確かめる物差し。内蔵のプラグインも、自分で作ったプラグインも、同じ試験で確かめる。
 * 使い方: require('./contracts').check(role, { module, manifest, dir }) → 足りないものの文字列の配列（空なら約束を満たす）。
 * 役割を足したら、ここに 1 つ足す（x5-contracts.test.js が「役割の数 ＝ 約束の数」を見張る）。
 */

const fs = require('fs');
const path = require('path');

function missingFns(mod, names) {
  const out = [];
  names.forEach((n) => { if (!mod || typeof mod[n] !== 'function') out.push('関数 ' + n); });
  return out;
}

function panelsOk(ctx) {
  const panels = ctx.manifest && Array.isArray(ctx.manifest.panels) ? ctx.manifest.panels : [];
  const out = [];
  if (!panels.length && !(ctx.manifest.roles)) out.push('パネルが 1 つも無い');
  panels.forEach((p) => { if (!p.file || !fs.existsSync(path.join(ctx.dir, p.file))) out.push('パネルの画面 ' + p.file + ' が無い'); });
  return out;
}

function apiNamespace(ctx, name) {
  const api = ctx.manifest && ctx.manifest.api;
  return api && Array.isArray(api.namespaces) && api.namespaces.indexOf(name) !== -1 ? [] : ['manifest の api.namespaces に ' + name + ' が無い'];
}

const LIFE = ['load', 'start', 'stop', 'destroy'];

const CONTRACTS = {
  'stream.site@1': { about: '配信するサイト（題名とカテゴリの送信・状態）', check: (c) => missingFns(c.module, LIFE.concat(['isConfigured', 'health', 'updateMetadata', 'getStatus'])) },
  'stream.slot@1': { about: '自動枠取り（枠を作る・確かめる・終わらせる）', check: (c) => missingFns(c.module, LIFE.concat(['prepareBroadcast', 'verifyLive', 'endBroadcast', 'health'])) },
  'chat.sink@1': { about: 'コメントの送信先', check: (c) => missingFns(c.module, LIFE.concat(['sendComment', 'health'])) },
  'chat.source@1': { about: 'コメントの受け手（試験中。開発者用）', check: (c) => missingFns(c.module, LIFE.concat(['onEvent', 'health'])) },
  'chat.inlet@1': { about: 'コメントの入口（受け口の本体）', check: (c) => (c.module && 'inlet' in c.module ? [] : ['inlet']).concat(missingFns(c.module, LIFE)) },
  'notify.sink@1': { about: '通知の送り先', check: (c) => missingFns(c.module, LIFE.concat(['onEvent', 'health'])) },
  'session.controller@1': { about: '配信の経過時間を数えるもの', check: (c) => missingFns(c.module, LIFE.concat(['health'])).concat(c.module && c.module.actions && typeof c.module.actions === 'object' ? [] : ['actions']) },
  'session.store@1': { about: 'セッションの置き場（view・start・pause・resume・end・retitle の口）', check: (c) => (c.module && 'controller' in c.module ? [] : ['controller']).concat(missingFns(c.module, LIFE)) },
  'session.recorder@1': { about: 'セッションの記録', check: (c) => missingFns(c.module, LIFE.concat(['onEvent', 'health'])) },
  'stream.lifecycle@1': { about: '配信の始まり・終わりに反応するもの', check: (c) => missingFns(c.module, LIFE.concat(['onEvent', 'health'])) },
  'title.fanout@1': { about: '題名の一斉変更', check: (c) => missingFns(c.module, LIFE.concat(['fanout'])) },
  'site.login@1': { about: 'サイトのログインの状態を読ませるもの（sites.* を出す）', check: (c) => missingFns(c.module, LIFE).concat(apiNamespace(c, 'sites')) },
  'tips.source@1': { about: '機能の紹介の状態を読ませるもの（tips.* を出す）', check: (c) => missingFns(c.module, LIFE).concat(apiNamespace(c, 'tips')) },
  'storage.locator@1': { about: '保存場所の差し込み（作者用。locator.js）', check: (c) => {
    const file = path.join(c.dir, 'locator.js');
    if (!fs.existsSync(file)) return ['locator.js'];
    return missingFns(require(file), ['createCore', 'resolveCoreDir', 'pathsJs']);
  } },
  'ui.panel@1': { about: '画面のパネルを持つ', check: panelsOk },
  'stream.engine@1': {
    about: '配信エンジン（OBS の部品とつなぐもの。単位 2）。実装は host/core/engine/',
    core: 'host/core/engine/index.js',
    check: (c) => {
      const target = c && (c.module || c.engine || c);
      if (!target || typeof target !== 'object') return ['エンジンまたはモジュールが存在しない'];
      const engine = typeof target.createEngine === 'function' ? target.createEngine() : target;
      const required = ['capabilities', 'listTargets', 'status', 'start', 'stop', 'stopAll'];
      const missing = [];
      required.forEach((fn) => {
        if (typeof engine[fn] !== 'function') missing.push('関数 ' + fn);
      });
      return missing;
    }
  },
  'vault-store@1': { about: '金庫の保存先の差し替え（K6）。実装は host/core/vault-store-file.js', core: 'host/core/vault-store-file.js', check: () => [] },
  'auth.provider@1': { about: 'ログインの提供元（予約）。実装はまだ無い', core: '', check: () => [] }
};

function roles() { return Object.keys(CONTRACTS); }

function check(role, ctx) {
  const c = CONTRACTS[role];
  if (!c) return ['約束の試験が無い役割: ' + role];
  return c.check(ctx);
}

module.exports = { CONTRACTS, roles, check };
