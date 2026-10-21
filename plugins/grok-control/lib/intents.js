'use strict';

/**
 * Grok（使う人の AI）から来た言葉を、丸ストの API の名前と引数に直す（決まりだけで解く。外へは通信しない）。
 * ここは表と文字の処理だけ。API は呼ばない（呼ぶのは index.js）。
 *
 * kind:
 *   read    … 読むだけ。プラグインが live のとき ctx.api.call で実行してよい（manifest の api.calls にある名前だけ）
 *   resolve … 読むだけだが、プラグインからは呼べない名前（plugin.* など）。名前と引数を返し、Grok が CLI か MCP で呼ぶ
 *   write   … 書き込み。プラグインは実行しない。名前と引数を返し、Grok が CLI か MCP で呼ぶ（丸ストの窓の承認を通る）
 *   danger  … 配信の開始・停止など。confirm: true が無いと名前と引数も「確かめて」と返すだけ。あっても実行はしない
 *   refused … 緊急停止など AI に任せないもの。画面かキーで使う人が行う
 */

const SITE_ALIASES = Object.freeze({
  youtube: ['youtube', 'ユーチューブ', 'ようつべ', 'ゆーちゅーぶ'],
  niconico: ['niconico', 'ニコニコ', 'ニコ生', 'にこにこ', 'nico'],
  twitch: ['twitch', 'ツイッチ'],
  twitcasting: ['twitcasting', 'ツイキャス', 'ついきゃす'],
  kick: ['kick', 'キック'],
  fc2: ['fc2'],
  rumble: ['rumble', 'ランブル'],
  soop: ['soop', 'スープ'],
  picarto: ['picarto', 'ピカート'],
  kukulu: ['kukulu', 'くくる', 'ククル']
});

const TEXT_MAX = 500;
const VALUE_MAX = 200;

function normalize(text) {
  const raw = typeof text === 'string' ? text : '';
  let s = raw;
  try { s = s.normalize('NFKC'); } catch (_) { /* 古い環境はそのまま */ }
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s;
}

function sitesIn(text) {
  const low = text.toLowerCase();
  const out = [];
  Object.keys(SITE_ALIASES).forEach(function (site) {
    if (SITE_ALIASES[site].some(function (a) { return low.indexOf(a.toLowerCase()) !== -1; })) out.push(site);
  });
  return out;
}

function cleanValue(value) {
  let v = String(value || '').trim();
  v = v.replace(/(?:に|へ)?(?:して|変えて|かえて|変更して|変更|する|設定して|セットして)?\s*(?:ください|下さい|くれ|ちょうだい|お願い(?:します)?)?\s*[。．.!！?？]*$/u, '').trim();
  v = v.replace(/(?:に|へ)$/u, '').trim();
  v = v.replace(/^[「『"'“]+/u, '').replace(/[」』"'”]+$/u, '').trim();
  return v.length > VALUE_MAX ? v.slice(0, VALUE_MAX) : v;
}

function extractAfter(text, reJa, reEn) {
  let m = reJa.exec(text);
  if (m && m[1]) return cleanValue(m[1]);
  m = reEn.exec(text);
  if (m && m[1]) return cleanValue(m[1]);
  return '';
}

/**
 * 表。上から順に見る（危ないものを先に。題名に「配信開始」と入っていても、確かめる側へ倒す）。
 * build(text) は { params, needs? } を返す。needs: 'destinationIds' は index.js が配信先の一覧から埋める。
 */
const INTENTS = Object.freeze([
  {
    id: 'emergencyStop', kind: 'refused', method: 'engine.emergencyStop',
    label: '緊急停止', examples: ['緊急停止して', 'emergency stop'],
    test: /緊急停止|非常停止|emergency/i,
    note: '緊急停止は AI からは呼べません（丸ストが AI の道具から外しています）。画面の「全部止める」か、キーで止めてください'
  },
  {
    id: 'stopAll', kind: 'danger', method: 'broadcast.stopAll',
    label: '全部止める', examples: ['全部止めて', 'すべての配信を停止', 'stop all'],
    test: /(?:全部|すべて|全て|ぜんぶ|まとめて)\s*(?:の配信)?\s*(?:を)?\s*(?:止め|とめ|停止|ストップ|終了)|stop\s*all/i,
    build: function () { return { params: {} }; }
  },
  {
    id: 'broadcastStop', kind: 'danger', method: 'broadcast.stop',
    label: '配信を止める', examples: ['配信止めて', 'YouTube の配信を停止して', 'stop the stream'],
    test: /配信\s*(?:を)?\s*(?:止め|とめ|停止|終了|やめ|ストップ|終わ)|(?:stop|end)\s+(?:the\s+)?(?:stream|broadcast)/i,
    build: function () { return { params: { destinationIds: [] }, needs: 'destinationIds', want: 'running' }; }
  },
  {
    id: 'preflight', kind: 'read', method: 'broadcast.preflight',
    label: '配信前チェック', examples: ['配信前チェックして', 'preflight'],
    test: /配信前\s*(?:の)?\s*(?:チェック|確認|点検)|プリフライト|preflight/i,
    build: function () { return { params: {} }; }
  },
  {
    id: 'broadcastStart', kind: 'danger', method: 'broadcast.start',
    label: '配信を始める', examples: ['配信開始', 'ニコニコで配信を始めて', 'go live'],
    test: /配信\s*(?:を)?\s*(?:開始|始め|はじめ|スタート|始ま)|(?:start|begin)\s+(?:the\s+)?(?:stream|broadcast)|go\s*live/i,
    // confirmed は付けない（丸スト本体の「本物へ出す前の確認」をそのまま通す）
    build: function () { return { params: { destinationIds: [] }, needs: 'destinationIds', want: 'enabled' }; }
  },
  {
    id: 'pluginStatus', kind: 'resolve', method: 'plugin.status',
    label: 'プラグインの状態', examples: ['プラグイン bulk-title の状態'],
    test: /プラグイン\s*[「『"]?([a-z][a-z0-9-]{1,30})/i,
    build: function (text) {
      const m = /([a-z][a-z0-9-]{1,30})/i.exec(text.replace(/^.*?プラグイン/u, ''));
      return m ? { params: { id: m[1].toLowerCase() } } : { error: 'no-plugin-id' };
    },
    cli: function (p) { return ['plugin', 'status', p.id]; }
  },
  {
    id: 'setTitle', kind: 'write', method: 'hub.fanout',
    label: '題名を送る', examples: ['タイトルを「雑談」にして', '題名を朝活に変えて', 'set title to Morning chat'],
    test: /タイトル|題名|\btitle\b/i,
    build: function (text) {
      const v = extractAfter(text, /(?:タイトル|題名)\s*(?:を|は|:|：)?\s*(.+)$/u, /(?:set|change)?\s*(?:the\s+)?title\s*(?:to|:)\s*(.+)$/i);
      return v ? { params: { title: v } } : { error: 'no-title' };
    }
  },
  {
    id: 'setCategory', kind: 'write', method: 'hub.fanout',
    label: 'カテゴリを送る', examples: ['カテゴリをゲームにして', 'set category to Just Chatting'],
    test: /カテゴリ|カテゴリー|\bcategory\b/i,
    build: function (text) {
      const v = extractAfter(text, /カテゴリー?\s*(?:を|は|:|：)?\s*(.+)$/u, /(?:set|change)?\s*(?:the\s+)?category\s*(?:to|:)\s*(.+)$/i);
      return v ? { params: { category: v } } : { error: 'no-category' };
    }
  },
  {
    id: 'destinations', kind: 'read', method: 'destination.list',
    label: '配信先の一覧', examples: ['配信先を教えて', 'list destinations'],
    test: /配信先|destinations?/i,
    build: function () { return { params: {} }; }
  },
  {
    id: 'status', kind: 'read', method: 'broadcast.status',
    label: '今の状態', examples: ['ステータス教えて', '今どうなってる？', 'status'],
    test: /ステータス|状態|状況|どうなって|status/i,
    build: function () { return { params: {} }; },
    also: ['engine.status']
  },
  {
    id: 'help', kind: 'help', method: '',
    label: 'できること', examples: ['何ができる？', 'help'],
    test: /ヘルプ|何ができ|なにができ|使い方|できること|help/i,
    build: function () { return { params: {} }; }
  }
]);

/** 戻り: { ok, intent, kind, method, params, sites, needs?, want?, also?, note?, error? } */
function parse(text) {
  const s = normalize(text);
  if (!s) return { ok: false, error: 'empty-text' };
  const sites = sitesIn(s);
  for (let i = 0; i < INTENTS.length; i += 1) {
    const it = INTENTS[i];
    if (!it.test.test(s)) continue;
    const built = typeof it.build === 'function' ? it.build(s) : { params: {} };
    if (built.error) return { ok: false, intent: it.id, kind: it.kind, error: built.error, sites: sites };
    const out = { ok: true, intent: it.id, kind: it.kind, method: it.method, params: built.params || {}, sites: sites };
    if (built.needs) out.needs = built.needs;
    if (built.want) out.want = built.want;
    if (it.also) out.also = it.also.slice();
    if (it.note) out.note = it.note;
    return out;
  }
  return { ok: false, intent: 'unknown', kind: 'unknown', error: 'no-intent', sites: sites };
}

function cliArgsFor(intentId, params) {
  const it = INTENTS.find(function (x) { return x.id === intentId; });
  if (!it || !it.method) return [];
  if (typeof it.cli === 'function') return it.cli(params || {});
  return ['call', it.method, JSON.stringify(params || {})];
}

function list() {
  return INTENTS.map(function (it) {
    return { id: it.id, kind: it.kind, method: it.method, label: it.label, examples: it.examples.slice() };
  });
}

module.exports = { parse, list, cliArgsFor, normalize, sitesIn, cleanValue, INTENTS, SITE_ALIASES };
