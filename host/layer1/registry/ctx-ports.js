'use strict';

/**
 * makeCtx が渡す口の名前（計画 C・D9・C5）。口ごとに 1 つ。表は docs/PLUGIN-API.md。
 * 自分のことを読むだけの口（id・pluginDir・manifest・logger・redact・events.names・app・mode）と log は宣言なしで常に渡す。
 * obs.read と obs.streamControl はメソッドごとに別の名前。keys・external.open は今までの能力の名前のまま。
 */

const CTX_PORTS = Object.freeze([
  Object.freeze({ name: 'id', prop: 'id', always: true, what: '自分の id。常に渡す' }),
  Object.freeze({ name: 'core', prop: 'core', what: '互換のために残す核のオブジェクト' }),
  Object.freeze({ name: 'pluginDir', prop: 'pluginDir', always: true, what: '自分のプラグインフォルダ。常に渡す' }),
  Object.freeze({ name: 'manifest', prop: 'manifest', always: true, what: 'manifest の読み取り専用の写し。常に渡す' }),
  Object.freeze({ name: 'storage', prop: 'dataDir', what: '自分のデータの置き場。ファイルを読む・書く' }),
  Object.freeze({ name: 'logger', prop: 'logger', always: true, what: 'ログを 1 行出す。常に渡す' }),
  Object.freeze({ name: 'redact', prop: 'redact', always: true, what: '秘密らしい文字列を伏せる。常に渡す' }),
  Object.freeze({ name: 'log', prop: 'log', always: true, what: '日付ごとの JSONL 追記。宣言なしで常に渡す' }),
  Object.freeze({ name: 'audit', prop: 'audit', what: '監査の行の形と、核の記録への追記' }),
  Object.freeze({ name: 'events.names', prop: 'events', always: true, what: 'イベント名の一覧。常に渡す' }),
  Object.freeze({ name: 'app', prop: 'app', always: true, what: '丸ストの版と配布ページ（読むだけ）。常に渡す' }),
  Object.freeze({ name: 'emit', prop: 'emit', what: '登録簿の中の配列に積む。バスには流さない' }),
  Object.freeze({ name: 'mode', prop: 'mode', always: true, what: '今のモード（legacy / shadow / live）。常に渡す' }),
  Object.freeze({ name: 'events.emit', prop: 'bus', method: 'publish', what: '合図をバスへ出す' }),
  Object.freeze({ name: 'events.subscribe', prop: 'bus', method: 'subscribe', what: '合図をバスから受ける' }),
  Object.freeze({ name: 'sessions', prop: 'sessions', what: '配信セッションの閲覧と操作' }),
  Object.freeze({ name: 'secrets', prop: 'secrets', what: '秘密の取得・有無・保存' }),
  Object.freeze({ name: 'overlay', prop: 'overlay', what: 'オーバーレイへ値を出す' }),
  Object.freeze({ name: 'chat', prop: 'chat', what: 'コメントの取り込みと入り口の宣言' }),
  Object.freeze({ name: 'destinations', prop: 'destinations', what: '配信先の一覧と集計' }),
  Object.freeze({ name: 'obs.read', prop: 'obs', methods: ['getStreamStatus', 'isStreaming'], what: 'OBS の配信状態を読む' }),
  Object.freeze({ name: 'obs.streamControl', prop: 'obs', method: 'streamControl', what: '配信全体の開始・停止' }),
  Object.freeze({ name: 'api.register', prop: 'api', method: 'register', what: '窓口にメソッドを足す' }),
  Object.freeze({ name: 'api.call', prop: 'api', method: 'call', what: '窓口のメソッドを呼ぶ' }),
  Object.freeze({ name: 'peers', prop: 'peers', what: 'ほかのプラグインの決まったメソッド' }),
  Object.freeze({ name: 'external.open', prop: 'external', what: 'ブラウザで https の URL を開く' }),
  Object.freeze({ name: 'pluginStates', prop: 'pluginStates', what: 'ほかのプラグインが動いているかとモード' }),
  Object.freeze({ name: 'keys', prop: 'keys', what: 'キー割り当ての読み書き' }),
  Object.freeze({ name: 'ui.panel', prop: 'ui', method: 'panel', what: '画面のパネルを 1 枚足す' })
]);

const CTX_PORT_NAMES = Object.freeze(CTX_PORTS.map((port) => port.name));

function portsForProp(prop) {
  const out = [];
  for (let i = 0; i < CTX_PORTS.length; i += 1) {
    if (CTX_PORTS[i].prop === prop) out.push(CTX_PORTS[i]);
  }
  return out;
}

function methodPort(prop, method) {
  const ports = portsForProp(prop);
  for (let i = 0; i < ports.length; i += 1) {
    const port = ports[i];
    if (port.method === method) return port.name;
    if (port.methods && port.methods.indexOf(method) !== -1) return port.name;
  }
  return '';
}

function needsError(name) {
  const err = new Error('needs に "' + name + '" がありません');
  err.code = 'needs-missing';
  return err;
}

// coreApi が 2 以上のときだけ、宣言した口以外を断る。書いていない・1 は全部渡して警告。
function strictNeeds(manifest) {
  if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, 'coreApi') || manifest.coreApi == null) return false;
  const want = manifest.coreApi;
  return typeof want === 'number' && Number.isInteger(want) && want >= 2;
}

function gateCtx(ctx, options) {
  const opts = options || {};
  const manifest = opts.manifest || {};
  const declared = new Set(Array.isArray(manifest.needs) ? manifest.needs.filter((name) => typeof name === 'string') : []);
  const strict = opts.strict === true;
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const id = typeof opts.id === 'string' ? opts.id : '';
  const warned = new Set();

  function guard(name) {
    if (!name || declared.has(name)) return;
    const port = CTX_PORTS.find((row) => row.name === name);
    if (port && port.always) return;
    if (!strict) {
      if (warned.has(name)) return;
      warned.add(name);
      log('warn', 'needs-undeclared ' + id + ' ' + name);
      return;
    }
    throw needsError(name);
  }

  function childProxy(obj, prop) {
    const base = obj && typeof obj === 'object' ? obj : {};
    return new Proxy(base, {
      get(target, key) {
        if (typeof key === 'string') {
          const name = methodPort(prop, key);
          if (name) guard(name);
        }
        if (obj == null) return undefined;
        return Reflect.get(obj, key, obj);
      }
    });
  }

  return new Proxy(ctx, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, target);
      const ports = portsForProp(prop);
      if (ports.length === 1 && !ports[0].method && !ports[0].methods) guard(ports[0].name);
      if (prop === 'ui') guard('ui.panel');
      const value = Reflect.get(target, prop, target);
      if (ports.some((port) => port.method || port.methods)) {
        if (value == null) return undefined;
        return childProxy(value, prop);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

module.exports = {
  CTX_PORTS,
  CTX_PORT_NAMES,
  portsForProp,
  methodPort,
  needsError,
  strictNeeds,
  gateCtx
};
