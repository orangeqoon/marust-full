'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const view = require('../plugins/ui-standard/shell/view-dock');

const root = path.join(__dirname, '..');
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// ---- 偽の DOM。plan() はそもそも DOM を使わず、mount() は組み立てだけを見る。 ----

function matches(node, selector) {
  const sel = String(selector).trim();
  let m = sel.match(/^\[([a-z-]+)="([^"]*)"\]$/);
  if (m) return node.getAttribute(m[1]) === m[2];
  m = sel.match(/^#([A-Za-z0-9_-]+)$/);
  if (m) return node.id === m[1];
  m = sel.match(/^\.([A-Za-z0-9_-]+)$/);
  if (m) return node.classList.contains(m[1]);
  m = sel.match(/^([a-z]+)\.([A-Za-z0-9_-]+)$/);
  if (m) return node.tagName === m[1].toUpperCase() && node.classList.contains(m[2]);
  if (/^[a-z]+$/.test(sel)) return node.tagName === sel.toUpperCase();
  return false;
}

function walk(node, out) {
  node.children.forEach((child) => {
    out.push(child);
    walk(child, out);
  });
  return out;
}

function makeElement(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    type: '',
    value: '',
    hidden: false,
    disabled: false,
    attrs: {},
    children: [],
    parentNode: null,
    listeners: {},
    _text: '',
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    appendChild(child) {
      if (child.parentNode && child.parentNode !== this) {
        const from = child.parentNode.children.indexOf(child);
        if (from !== -1) child.parentNode.children.splice(from, 1);
      }
      const at = this.children.indexOf(child);
      if (at !== -1) this.children.splice(at, 1);
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    querySelector(selector) {
      return walk(this, []).find((n) => matches(n, selector)) || null;
    },
    click() {
      (this.listeners.click || []).slice().forEach((fn) => fn({ type: 'click' }));
    }
  };
  Object.defineProperty(node, 'textContent', {
    get() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    },
    set(value) {
      this._text = String(value);
      if (this._text === '') this.children = [];
    }
  });
  const classList = {
    add(...names) {
      const set = new Set(node.className.split(/\s+/).filter(Boolean));
      names.forEach((n) => set.add(n));
      node.className = Array.from(set).join(' ');
    },
    contains(name) {
      return node.className.split(/\s+/).indexOf(name) !== -1;
    }
  };
  Object.defineProperty(node, 'classList', { value: classList });
  return node;
}

function hubFixture() {
  const doc = {
    body: null,
    createElement(tag) { return makeElement(tag); },
    querySelector(selector) {
      return walk(doc.body, []).find((n) => matches(n, selector)) || null;
    },
    getElementById(id) { return doc.querySelector('#' + id); }
  };
  doc.body = makeElement('body');

  const header = makeElement('header');
  doc.body.appendChild(header);
  const bar = makeElement('div');
  bar.id = 'shell-bar';
  doc.body.appendChild(bar);
  const dock = makeElement('div');
  dock.id = 'dock';
  doc.body.appendChild(dock);
  const source = makeElement('main');
  source.id = 'panel-source';
  doc.body.appendChild(source);

  function section(id) {
    const sec = makeElement('section');
    sec.setAttribute('data-panel', id);
    const h2 = makeElement('h2');
    h2.textContent = id;
    sec.appendChild(h2);
    source.appendChild(sec);
    return sec;
  }

  const emergency = section('emergency');
  const colorNote = makeElement('p');
  colorNote.id = 'emergency-color-note';
  emergency.appendChild(colorNote);
  const stop = makeElement('button');
  stop.id = 'emergency-stop';
  stop.className = 'emergency gray';
  stop.textContent = 'OBS 未接続';
  stop.setAttribute('data-need', 'emergency');
  emergency.appendChild(stop);

  const dest = section('destinations');
  const destNote = makeElement('p');
  destNote.id = 'dest-color-note';
  dest.appendChild(destNote);
  const destSummary = makeElement('p');
  destSummary.id = 'dest-summary';
  dest.appendChild(destSummary);
  const table = makeElement('div');
  table.id = 'target-table';
  dest.appendChild(table);
  const createHead = makeElement('h2');
  createHead.textContent = '新規作成';
  dest.appendChild(createHead);
  const createForm = makeElement('div');
  createForm.className = 'timer-setup';
  dest.appendChild(createForm);

  const meta = section('metadata');
  const title = makeElement('input');
  title.id = 'fanout-title';
  title.value = '朝の配信';
  meta.appendChild(title);
  const category = makeElement('input');
  category.id = 'fanout-category';
  category.value = '雑談';
  meta.appendChild(category);
  const send = makeElement('button');
  send.id = 'fanout-send';
  send.setAttribute('data-need', 'write');
  send.textContent = '送信（現在のモードで）';
  meta.appendChild(send);

  const session = section('session');
  const summary = makeElement('p');
  summary.id = 'session-summary';
  summary.textContent = 'なし';
  session.appendChild(summary);

  section('secrets');
  section('modes');
  return doc;
}

// ---- 表示の切り替え（DOM を使わない） ----

test('view=dock は 全停止だけを出す', function () {
  const plan = view.plan('?view=dock');
  assert.strictEqual(plan.mode, 'dock');
  assert.strictEqual(plan.panel, null);
  assert.deepStrictEqual(plan.widgets, ['emergency']);
  assert.strictEqual(plan.widgets.length, 1);
  assert.ok(plan.widgets.indexOf('secrets') === -1, '金庫は出さない');
  assert.ok(plan.widgets.indexOf('modes') === -1, 'モードは出さない');
});

test('panel は view=dock より優先する', function () {
  const both = view.plan('?view=dock&panel=emergency');
  assert.strictEqual(both.mode, 'panel');
  assert.strictEqual(both.panel, 'emergency');
  assert.deepStrictEqual(both.widgets, []);
  const reversed = view.plan('?panel=metadata&view=dock');
  assert.strictEqual(reversed.mode, 'panel');
  assert.strictEqual(reversed.panel, 'metadata');
});

test('view が無ければ今の動き（panel / 通常表示）のまま', function () {
  assert.strictEqual(view.plan('').mode, 'default');
  assert.strictEqual(view.plan('/').mode, 'default');
  assert.strictEqual(view.plan('?view=tall').mode, 'default');
  assert.strictEqual(view.plan('?panel=destinations').mode, 'panel');
  assert.strictEqual(view.plan('?panel=destinations').panel, 'destinations');
  assert.strictEqual(view.plan('?panel=').mode, 'panel');
  assert.strictEqual(view.plan('?panel=').panel, '');
  assert.strictEqual(view.plan('?panel=ghost').panel, 'ghost');
});

// ---- 組み立て（偽の DOM） ----

test('mount は 4 部品だけを 1 列に組み立てる', function () {
  const doc = hubFixture();
  const plan = { mode: 'dock', panel: null, widgets: ['emergency', 'destinations', 'metadata', 'session'] }; // 部品を組み立てる処理そのものは、4 部品でも試す
  const container = view.mount(doc, plan);
  assert.ok(container);
  assert.ok(doc.body.classList.contains('dock-view'));
  assert.strictEqual(doc.body.children[doc.body.children.length - 1], container);
  assert.deepStrictEqual(
    container.children.map((c) => c.getAttribute('data-panel')),
    ['emergency', 'destinations', 'metadata', 'session']
  );
  const source = doc.querySelector('#panel-source');
  assert.deepStrictEqual(source.children.map((c) => c.getAttribute('data-panel')), ['secrets', 'modes']);
  assert.strictEqual(container.children.length, 4, '4 部品以外は container に入れない');
});

test('全部止めると題名の送信は今の部品のまま移す', function () {
  const doc = hubFixture();
  const container = view.mount(doc, { mode: 'dock', panel: null, widgets: ['emergency', 'destinations', 'metadata', 'session'] });
  const stop = container.querySelector('#emergency-stop');
  assert.ok(stop, '全部止めるのボタンは同じ部品');
  assert.strictEqual(stop.className, 'emergency gray');
  assert.strictEqual(stop.getAttribute('data-need'), 'emergency');
  assert.ok(!container.querySelector('#emergency-hold'), '長押しのバーは無い');
  const send = container.querySelector('#fanout-send');
  assert.ok(send, '題名とカテゴリの送信ボタンは同じ部品');
  assert.strictEqual(send.getAttribute('data-need'), 'write');
  assert.strictEqual(send.textContent, '送信（現在のモードで）');
});

test('配信先の状態とタイマーの部品を足す', function () {
  const doc = hubFixture();
  const container = view.mount(doc, { mode: 'dock', panel: null, widgets: ['emergency', 'destinations', 'metadata', 'session'] });
  assert.ok(container.querySelector('#dock-dest-status'), '配信先の状態');
  const start = container.querySelector('#dock-session-start');
  const clock = container.querySelector('#dock-session-clock');
  assert.ok(start, 'タイマーの開始');
  assert.ok(clock, '経過時間');
  assert.strictEqual(start.textContent, '開始');
  assert.strictEqual(start.getAttribute('data-need'), 'write');
  const stop = container.querySelector('#dock-session-stop');
  assert.strictEqual(stop.textContent, '停止');
  assert.strictEqual(stop.getAttribute('data-need'), 'write');
  assert.strictEqual(container.querySelector('#dock-session-status').getAttribute('aria-live'), 'polite');
});

// ---- 配信先の 1 行 ----

test('配信先はサイト名・状態・再接続回数だけを拾う', function () {
  const info = view.destinationInfo({
    id: 't1',
    name: 'main',
    site: 'youtube',
    state: 'live',
    reconnects: 2,
    key: 'SUPER-SECRET-KEY',
    server: 'rtmp://example.test/live'
  });
  assert.strictEqual(info.label, 'youtube / main');
  assert.strictEqual(info.state, 'live');
  assert.strictEqual(info.reconnects, 2);
  const json = JSON.stringify(info);
  assert.ok(json.indexOf('SUPER-SECRET-KEY') === -1, 'キーは出さない');
  assert.ok(json.indexOf('rtmp://example.test') === -1, '配信先の値は出さない');
});

test('サイトが無い行と再接続回数が無い行', function () {
  assert.strictEqual(view.destinationInfo({ name: 'obs-1', site: '', state: 'stopped', reconnects: null }).label, 'obs-1');
  const unknown = view.destinationInfo({ name: 'obs-1', site: '', state: 'stopped', reconnects: null });
  assert.strictEqual(unknown.reconnects, null);
  assert.strictEqual(view.destinationInfo({ name: 'x', site: '', state: 'reconnecting', reconnects: '3' }).reconnects, 3);
  assert.strictEqual(view.destinationInfo({ name: 'x', site: '', state: 'connecting', reconnects: 0 }).reconnects, 0);
  assert.strictEqual(view.destinationInfo({ name: 'x', site: '', state: '' }).state, '');
  assert.strictEqual(view.destinationInfo(null).label, '(名前なし)');
});

test('状態の色は今と同じ対応', function () {
  assert.strictEqual(view.stateClass('live'), 'state-live');
  assert.strictEqual(view.stateClass('connecting'), 'state-connecting');
  assert.strictEqual(view.stateClass('reconnecting'), 'state-connecting');
  assert.strictEqual(view.stateClass('stopped'), 'state-stopped');
  assert.strictEqual(view.stateClass('broken'), 'state-error');
});

test('経過時間は hh:mm:ss', function () {
  assert.strictEqual(view.formatClock(0), '00:00:00');
  assert.strictEqual(view.formatClock(3661000), '01:01:01');
  assert.strictEqual(view.formatClock(59000), '00:00:59');
  assert.strictEqual(view.formatClock(NaN), '00:00:00');
  assert.strictEqual(view.formatClock(-5), '00:00:00');
});

test('失敗の文言はコードから', function () {
  assert.strictEqual(view.errorText('session-active'), '配信の経過時間はすでに動いています');
  assert.strictEqual(view.errorText('forbidden'), 'この端末では操作できません');
  assert.strictEqual(view.errorText('no-api'), 'つながっていません');
  assert.strictEqual(view.errorText(''), '失敗しました');
  assert.strictEqual(view.errorText(null), '失敗しました');
});

// ---- つなぎ方 ----

test('hub.html は hub.js の前に view-dock.js を読む', function () {
  const html = require('./_ui-source').shellDocument();
  const at = html.indexOf('<script src="/plugins/ui-standard/shell/view-dock.js"></script>');
  const hubAt = html.indexOf('<script src="/plugins/ui-standard/shell/hub.js"></script>');
  const a11yAt = html.indexOf('<script src="/ui/a11y.js"></script>');
  assert.ok(at !== -1, '読み込みが足りない');
  assert.ok(a11yAt !== -1 && a11yAt < at, 'a11y の後');
  assert.ok(hubAt !== -1 && at < hubAt, 'hub.js の前');
});

test('既存の画面スクリプトと同じ場所で読んでも名前がぶつからない', function () {
  const sandbox = {
    console: console,
    URLSearchParams: URLSearchParams,
    Promise: Promise,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  // ブラウザと同じく、同じ大域に順に評価する（const の二重宣言はここで落ちる）。
  ['ui/a11y.js', 'plugins/ui-standard/shell/view-dock.js'].forEach(function (rel) {
    vm.runInContext(read(rel), ctx, { filename: rel });
  });
  assert.strictEqual(typeof sandbox.window.marustDockView.plan, 'function');
  assert.strictEqual(typeof sandbox.window.marustA11y.focusDialog, 'function');
});

test('hub.js は panel を先に、次に view=dock を見る', function () {
  const src = hubSource();
  const panelAt = src.indexOf("if (plan.mode === 'panel')");
  const dockAt = src.indexOf("if (plan.mode === 'dock')");
  assert.ok(panelAt !== -1 && dockAt !== -1, '分岐が足りない');
  assert.ok(panelAt < dockAt, 'panel が先');
  assert.ok(src.indexOf('viewDock.mount(document, plan)') !== -1);
  assert.ok(src.indexOf('viewDock.watch(document)') !== -1);
});

test('hub.css は dock-view の 1 列と 4 部品の縮め方を持つ', function () {
  const css = read('plugins/ui-standard/shell/hub.css');
  assert.ok(css.indexOf('body.dock-view') !== -1);
  assert.ok(css.indexOf('#dock-view') !== -1);
  assert.ok(css.indexOf('flex-direction: column') !== -1);
  assert.ok(css.indexOf('[data-panel="destinations"] #target-table') !== -1, '配信先の表は出さない');
  assert.ok(css.indexOf('button.emergency { min-width: 0') !== -1, '非常停止を幅いっぱいに');
  assert.ok(css.indexOf('.dock-dest-row') !== -1);
  assert.ok(css.indexOf('.dock-elapsed') !== -1);
});

test('GUIDE に OBS のカスタムブラウザドックの手順がある', function () {
  const guide = read('docs/GUIDE.md');
  assert.ok(guide.indexOf('http://127.0.0.1:18770/?view=dock') !== -1);
  assert.ok(guide.indexOf('カスタムブラウザドック') !== -1);
  assert.ok(guide.indexOf('`?view=dock` はコードにありません') === -1, '未実装の文は消す');
});

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('w48-view-dock ok');
