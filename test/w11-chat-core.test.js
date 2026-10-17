'use strict';
require('./_ui-inline');
const { hubSource } = require('./_ui-source');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createChat, TEXT_MAX, NAME_MAX, RECENT_MAX, DEDUPE_MAX, RATE_MAX } = require('./_k3-parts');
const { createApi, IPC_PERMISSIONS, CHAT_WRITE, PERMISSIONS } = require('../host/layer1/api');
const { createClients, WINDOW_ID } = require('../host/layer1/clients');
const { createEventBus } = require('../host/core/event-bus');
const { createRegistry } = require('../host/layer1/plugin-registry');

const BODY = 'w11-body-9f3c-<b>not-html</b>';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function fakeCore(dir) {
  const core = createCore();
  return {
    STATE_DIR: dir,
    COOKIES_DIR: path.join(dir, 'cookies'),
    SERVICES_DIR: path.join(dir, 'services'),
    DATA_DIR: path.join(dir, 'data'),
    atomicWriteJsonSync: core.atomicWriteJsonSync
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w11-'));
}

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name);
    throw err;
  }
}

function message(id, extra) {
  return Object.assign({
    id: String(id),
    site: 'fc2',
    account: 'main',
    userId: 'u1',
    name: 'なまえ',
    text: 'hello',
    badges: ['mod'],
    isOwner: false,
    hasGift: false
  }, extra || {});
}

function readAudit(dir) {
  const folder = path.join(dir, 'logs', 'marust');
  if (!fs.existsSync(folder)) return '';
  return fs.readdirSync(folder)
    .filter(function (name) { return name.indexOf('api-') === 0 && name.endsWith('.jsonl'); })
    .map(function (name) { return fs.readFileSync(path.join(folder, name), 'utf8'); })
    .join('\n');
}

function fakeDocument() {
  function TextNode(value) {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.childNodes = [];
  }
  function Element(name) {
    this.nodeType = 1;
    this.nodeName = String(name).toUpperCase();
    this.childNodes = [];
    this.className = '';
  }
  Element.prototype.setAttribute = function () {};
  Element.prototype.appendChild = function (child) {
    this.childNodes.push(child);
    return child;
  };
  Element.prototype.removeChild = function (child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    return child;
  };
  Object.defineProperty(Element.prototype, 'firstChild', {
    get: function () { return this.childNodes[0] || null; }
  });
  Object.defineProperty(Element.prototype, 'textContent', {
    get: function () {
      return this.childNodes.map(function (node) {
        return node.nodeType === 3 ? node.nodeValue : node.textContent;
      }).join('');
    },
    set: function (value) {
      this.childNodes = [new TextNode(value == null ? '' : String(value))];
    }
  });
  Object.defineProperty(Element.prototype, 'innerHTML', {
    get: function () {
      return this.childNodes.map(serialize).join('');
    },
    set: function () { throw new Error('innerHTML'); }
  });
  function serialize(node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return '<' + node.nodeName.toLowerCase() + '>' + node.childNodes.map(serialize).join('') + '</' + node.nodeName.toLowerCase() + '>';
  }
  return {
    createElement: function (name) { return new Element(name); },
    createTextNode: function (value) { return new TextNode(value); }
  };
}

function findAll(node, className, out) {
  const found = out || [];
  if (node && node.nodeType === 1 && node.className === className) found.push(node);
  const kids = node && node.childNodes ? node.childNodes : [];
  for (let i = 0; i < kids.length; i += 1) findAll(kids[i], className, found);
  return found;
}

function install(root, id, manifest) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), [
    "'use strict';",
    'module.exports = {',
    '  load(ctx) { this.ctx = ctx; },',
    '  start(ctx) { this.started = ctx; },',
    '  stop() {},',
    '  destroy() {}',
    '};',
    ''
  ].join('\n'));
}

function manifest(id, provides) {
  return {
    id: id,
    name: id,
    version: '1.0.0',
    manifestVersion: 2,
    runtime: 'inproc',
    main: 'index.js',
    provides: provides,
    subscribes: []
  };
}

async function main() {
  await test('validation, length, dedupe, recent buffer, and the per-second drop', async function () {
    let clock = 10000;
    const warnings = [];
    const published = [];
    const bus = {
      publish: function (name, payload, info) {
        published.push({ name: name, payload: payload, info: info });
        return 1;
      }
    };
    const chat = createChat({
      bus: bus,
      now: function () { return clock; },
      logger: function (level, message) { warnings.push(level + ' ' + message); }
    });

    assert.strictEqual(chat.ingest(message('ok', { text: 'x'.repeat(TEXT_MAX), name: 'n'.repeat(NAME_MAX) }), { source: 'demo' }).ok, true);
    assert.strictEqual(chat.ingest(message('long-text', { text: 'x'.repeat(TEXT_MAX + 1) }), { source: 'demo' }).error, 'text-length');
    assert.strictEqual(chat.ingest(message('long-name', { name: 'n'.repeat(NAME_MAX + 1) }), { source: 'demo' }).error, 'name-length');
    assert.strictEqual(chat.ingest({ id: 't', site: 'fc2', name: 'n', text: 1 }, { source: 'demo' }).error, 'bad-text');
    assert.strictEqual(chat.ingest(message('bad-badge', { badges: ['ok', 1] }), { source: 'demo' }).error, 'bad-badges');
    assert.strictEqual(chat.ingest(message('bad-owner', { isOwner: 'yes' }), { source: 'demo' }).error, 'bad-owner');
    assert.strictEqual(chat.ingest(message(''), { source: 'demo' }).error, 'bad-id');
    assert.strictEqual(chat.ingest('nope', { source: 'demo' }).error, 'bad-message');
    assert.strictEqual(chat.ingest(message('no-source')).error, 'bad-source');

    const html = '<img src=x onerror=alert(1)>';
    const badges = ['<b>mod</b>'];
    const kept = chat.ingest(message('html', {
      text: html,
      name: '<b>name</b>',
      badges: badges,
      hasGift: true,
      amount: 12,
      currency: 'JPY',
      html: '<script>nope</script>'
    }), { source: 'onecomme' });
    assert.strictEqual(kept.ok, true);
    badges.push('later');
    const stored = chat.recent(1).messages[0];
    assert.strictEqual(stored.text, html);
    assert.strictEqual(stored.name, '<b>name</b>');
    assert.deepStrictEqual(stored.badges, ['<b>mod</b>']);
    assert.strictEqual(stored.amount, 12);
    assert.strictEqual(stored.currency, 'JPY');
    assert.strictEqual(stored.source, 'onecomme');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'html'), false);
    assert.strictEqual(published[published.length - 1].name, 'chat.message');
    assert.strictEqual(published[published.length - 1].info.source, 'chat-inlet');
    assert.strictEqual(published[published.length - 1].payload.text, html);

    assert.strictEqual(chat.ingest(message('html'), { source: 'onecomme' }).error, 'duplicate');
    assert.strictEqual(warnings.length, 0);

    let rateClock = 30000;
    const rateWarnings = [];
    const rate = createChat({
      now: function () { return rateClock; },
      logger: function (level, message) { rateWarnings.push(level + ' ' + message); }
    });
    for (let i = 0; i < RATE_MAX; i += 1) {
      assert.strictEqual(rate.ingest(message('r' + i), { source: 'demo' }).ok, true);
    }
    assert.strictEqual(rate.ingest(message('overflow', { text: BODY }), { source: 'demo' }).error, 'dropped');
    assert.deepStrictEqual(rateWarnings, ['warn chat drop count=1']);
    assert.ok(rateWarnings.join('\n').indexOf(BODY) === -1);
    assert.ok(!rate.recent(RATE_MAX).messages.some(function (row) { return row.id === 'overflow'; }));
    rateClock += 1000;
    assert.strictEqual(rate.ingest(message('overflow', { text: BODY }), { source: 'demo' }).ok, true);

    const freshWarnings = [];
    let batchClock = 0;
    const batch = createChat({
      now: function () { return batchClock; },
      logger: function (level, message) { freshWarnings.push(level + ' ' + message); }
    });
    for (let i = 0; i < 180; i += 1) assert.strictEqual(batch.ingest(message('p' + i), { source: 'demo' }).ok, true);
    const incoming = [];
    for (let i = 0; i < 50; i += 1) incoming.push(message('b' + i, { text: BODY, source: 'onecomme' }));
    const burst = batch.publish(incoming, { source: 'onecomme' });
    assert.strictEqual(burst.ok, true);
    assert.strictEqual(burst.accepted, 20);
    assert.strictEqual(burst.dropped, 30);
    assert.strictEqual(burst.rejected, 0);
    assert.deepStrictEqual(freshWarnings, ['warn chat drop count=30']);
    assert.ok(freshWarnings.join('\n').indexOf(BODY) === -1);
    const newest = batch.recent(20).messages.map(function (row) { return row.id; });
    const expected = [];
    for (let i = 49; i >= 30; i -= 1) expected.push('b' + i);
    assert.deepStrictEqual(newest, expected);

    let historyClock = 0;
    const history = createChat({ now: function () { return historyClock; }, logger: function () {} });
    for (let i = 0; i < RECENT_MAX + 1; i += 1) {
      if (i > 0 && i % RATE_MAX === 0) historyClock += 1000;
      assert.strictEqual(history.ingest(message('h' + i), { source: 'demo' }).ok, true);
    }
    const all = history.recent(200);
    assert.strictEqual(all.messages.length, 200);
    assert.strictEqual(all.messages[0].id, 'h' + RECENT_MAX);
    assert.strictEqual(history.recent().messages.length, 50);
    const wide = history.recent(RECENT_MAX);
    assert.strictEqual(wide.messages.length, RECENT_MAX);
    assert.strictEqual(wide.messages[wide.messages.length - 1].id, 'h1');

    let dedupeClock = 0;
    const dedupe = createChat({ now: function () { return dedupeClock; }, logger: function () {} });
    for (let i = 0; i < DEDUPE_MAX; i += 1) {
      if (i > 0 && i % RATE_MAX === 0) dedupeClock += 1000;
      assert.strictEqual(dedupe.ingest(message('d' + i), { source: 'demo' }).ok, true);
    }
    assert.strictEqual(dedupe.ingest(message('d0'), { source: 'demo' }).error, 'duplicate');
    dedupeClock += 1000;
    assert.strictEqual(dedupe.ingest(message('d' + DEDUPE_MAX), { source: 'demo' }).ok, true);
    dedupeClock += 1000;
    assert.strictEqual(dedupe.ingest(message('d0'), { source: 'demo' }).ok, true);
    assert.strictEqual(dedupe.ingest(message('d' + DEDUPE_MAX), { source: 'demo' }).error, 'duplicate');
  });

  await test('chat.message shape from a chat.source plugin, source fixed', async function () {
    const dir = tempDir();
    const root = path.join(dir, 'plugins');
    const warnings = [];
    const bus = createEventBus({ logger: function (_level, message) { warnings.push(message); } });
    const chat = createChat({ bus: bus, logger: function () {} });
    const seen = [];
    bus.subscribe('chat.message', function (name, payload, meta) {
      seen.push({ name: name, payload: payload, meta: meta });
    });
    try {
      install(root, 'fc2-chat', manifest('fc2-chat', ['chat.source@1']));
      install(root, 'reader', manifest('reader', ['ui.panel@1']));
      const registry = createRegistry({
        core: fakeCore(dir),
        appRoot: root,
        builtinRoot: root,
        externalRoot: path.join(dir, 'external'),
        bus: bus,
        chat: chat,
        logger: function () {}
      });
      await registry.loadAll();
      const source = registry.getRunning().find(function (row) { return row.id === 'fc2-chat'; });
      const reader = registry.getRunning().find(function (row) { return row.id === 'reader'; });
      assert.ok(source && reader);
      const badges = ['owner'];
      const ingested = source.ctx.chat.ingest({
        id: 'c1',
        site: 'fc2',
        name: '配信者',
        text: '<b>hello</b>',
        badges: badges,
        isOwner: true,
        hasGift: false,
        source: 'onecomme',
        html: '<script>'
      });
      assert.strictEqual(ingested.ok, true);
      badges.push('nope');
      assert.deepStrictEqual(reader.ctx.chat.ingest(message('c2')), { ok: false, error: 'not-chat-source' });
      await bus.flush();
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].name, 'chat.message');
      assert.strictEqual(seen[0].meta.source, 'chat-inlet');
      assert.strictEqual(seen[0].meta.version, 1);
      assert.strictEqual(typeof seen[0].meta.id, 'string');
      assert.strictEqual(seen[0].payload.source, 'fc2-chat');
      assert.strictEqual(seen[0].payload.text, '<b>hello</b>');
      assert.strictEqual(seen[0].payload.site, 'fc2');
      assert.strictEqual(seen[0].payload.name, '配信者');
      assert.strictEqual(seen[0].payload.account, '');
      assert.strictEqual(seen[0].payload.userId, '');
      assert.deepStrictEqual(seen[0].payload.badges, ['owner']);
      assert.strictEqual(seen[0].payload.isOwner, true);
      assert.strictEqual(seen[0].payload.hasGift, false);
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(seen[0].payload.at));
      assert.strictEqual(Object.prototype.hasOwnProperty.call(seen[0].payload, 'html'), false);
      assert.ok(!warnings.some(function (line) { return line.indexOf('unknown event') !== -1; }));
      assert.strictEqual(chat.recent(1).messages[0].source, 'fc2-chat');

      const bare = createRegistry({
        core: fakeCore(dir),
        appRoot: path.join(dir, 'bare-app'),
        builtinRoot: path.join(dir, 'bare'),
        externalRoot: path.join(dir, 'bare-ext'),
        bus: bus,
        logger: function () {}
      });
      install(path.join(dir, 'bare'), 'fc2-chat', manifest('fc2-chat', ['chat.source@1']));
      install(path.join(dir, 'bare'), 'reader', manifest('reader', ['ui.panel@1']));
      await bare.loadAll();
      const unplugged = bare.getRunning().find(function (row) { return row.id === 'fc2-chat'; });
      const quiet = bare.getRunning().find(function (row) { return row.id === 'reader'; });
      assert.deepStrictEqual(unplugged.ctx.chat.ingest(message('z')), { ok: false, error: 'unavailable' });
      assert.deepStrictEqual(quiet.ctx.chat.ingest(message('z2')), { ok: false, error: 'not-chat-source' });
    } finally {
      rimraf(dir);
    }
  });

  await test('chat.publish permissions, approval bypass, and audit without the body', async function () {
    const dir = tempDir();
    const core = fakeCore(dir);
    let clock = 20000;
    const chat = createChat({ now: function () { return clock; }, logger: function () {} });
    let fanouts = 0;
    const clients = createClients({ core: core, now: function () { return clock; } });
    const api = createApi({
      core: core,
      chat: chat,
      clients: clients,
      getState: function () { return { ok: true }; },
      fanout: function () { fanouts += 1; return { ok: true }; },
      forceLegacy: function () { return { ok: true }; },
      setTimer: function () { return 0; },
      clearTimer: function () {}
    });
    const chatCtx = {
      permissions: ['read', CHAT_WRITE],
      kind: 'native',
      clientId: 'onecomme-1',
      requiresApproval: true
    };
    const readCtx = { permissions: ['read'], kind: 'native', clientId: 'reader', requiresApproval: true };
    const writeCtx = { permissions: ['read', 'write'], kind: 'native', clientId: 'cli-1', requiresApproval: true };
    const bothCtx = {
      permissions: ['read', 'write', 'emergency', CHAT_WRITE],
      kind: 'browser',
      clientId: 'both',
      requiresApproval: true
    };
    const windowCtx = {
      permissions: ['read', 'write', 'emergency'],
      kind: 'window',
      clientId: WINDOW_ID
    };
    try {
      assert.ok(PERMISSIONS.indexOf(CHAT_WRITE) !== -1);
      assert.ok(IPC_PERMISSIONS.indexOf(CHAT_WRITE) === -1);
      const described = await api.call('api.describe', {});
      const recent = described.methods.find(function (row) { return row.method === 'chat.recent'; });
      const publish = described.methods.find(function (row) { return row.method === 'chat.publish'; });
      assert.strictEqual(recent.permission, 'read');
      assert.strictEqual(recent.params.limit.min, 1);
      assert.strictEqual(recent.params.limit.max, 200);
      assert.strictEqual(recent.params.limit.required, false);
      assert.ok(recent.description.length > 0);
      assert.strictEqual(publish.permission, CHAT_WRITE);
      assert.strictEqual(publish.windowOnly, false);
      assert.strictEqual(publish.params.messages.min, 1);
      assert.strictEqual(publish.params.messages.max, 50);
      assert.strictEqual(publish.params.messages.required, true);
      assert.strictEqual(publish.params.source.required, false);
      assert.strictEqual(publish.params.source.max, 40);
      assert.ok(publish.description.length > 0);

      assert.strictEqual((await api.call('chat.publish', { messages: [message('a', { text: BODY })] })).error, 'forbidden');
      assert.strictEqual((await api.call('chat.publish', { messages: [message('a', { text: BODY })] }, readCtx)).error, 'forbidden');
      assert.strictEqual((await api.call('chat.publish', { messages: [message('a', { text: BODY })] }, writeCtx)).error, 'forbidden');
      assert.strictEqual((await api.call('chat.publish', { messages: [message('a')] }, windowCtx)).error, 'forbidden');
      assert.strictEqual((await api.call('hub.fanout', { title: 't' }, chatCtx)).error, 'forbidden');
      assert.strictEqual((await api.call('destination.start', { id: 'yt' }, chatCtx)).error, 'forbidden');
      assert.strictEqual((await api.call('engine.start', { id: 'yt' }, bothCtx)).error, 'forbidden');
      assert.strictEqual((await api.call('clients.beginPairing', { name: '増やす' }, bothCtx)).error, 'forbidden');
      assert.strictEqual(fanouts, 0);

      const held = await api.call('destination.start', { id: 'yt' }, writeCtx);
      assert.strictEqual(held.pending, true);
      const posted = await api.call('chat.publish', {
        source: 'onecomme',
        messages: [message('live', { text: BODY, source: 'fc2-chat' })]
      }, chatCtx);
      assert.strictEqual(posted.ok, true);
      assert.strictEqual(posted.accepted, 1);
      assert.notStrictEqual(posted.pending, true);
      const waiting = await api.call('approval.list', {}, readCtx);
      assert.strictEqual(waiting.approvals.length, 1);
      assert.strictEqual(waiting.approvals[0].method, 'destination.start');

      const view = await api.call('chat.recent', { limit: 1 }, chatCtx);
      assert.strictEqual(view.ok, true);
      assert.strictEqual(view.messages[0].text, BODY);
      assert.strictEqual(view.messages[0].source, 'onecomme');
      view.messages[0].text = 'changed';
      assert.strictEqual((await api.call('chat.recent', { limit: 1 }, readCtx)).messages[0].text, BODY);
      assert.strictEqual((await api.call('chat.recent', {}, readCtx)).ok, true);
      assert.strictEqual((await api.call('chat.recent', { limit: 0 }, readCtx)).error, 'limit-range');
      assert.strictEqual((await api.call('chat.recent', { limit: 1.5 }, readCtx)).error, 'limit-type');
      assert.strictEqual((await api.call('chat.recent', { limit: 201 }, readCtx)).error, 'limit-range');
      assert.strictEqual((await api.call('chat.publish', { messages: [] }, chatCtx)).error, 'messages-length');
      assert.strictEqual((await api.call('chat.publish', { messages: new Array(51).fill(message('z')) }, chatCtx)).error, 'messages-length');
      assert.strictEqual((await api.call('chat.publish', { source: 'Bad', messages: [message('z2')] }, chatCtx)).error, 'bad-source');
      const rejected = await api.call('chat.publish', { messages: [message('nosource')] }, chatCtx);
      assert.strictEqual(rejected.ok, true);
      assert.strictEqual(rejected.accepted, 0);
      assert.strictEqual(rejected.rejected, 1);

      const windowOpen = await api.call('clients.beginPairing', {
        name: 'わんコメ',
        kind: 'native',
        permissions: ['read', 'write', 'chat-write']
      }, windowCtx);
      assert.strictEqual(windowOpen.ok, true);
      const browserOpen = await api.call('clients.beginPairing', {
        name: 'ブラウザ',
        kind: 'native',
        permissions: ['read', 'chat-write']
      }, { permissions: ['read', 'write'], clientId: 'browser-1', kind: 'browser' });
      assert.strictEqual(browserOpen.error, 'forbidden');
      const redeemed = clients.redeem(windowOpen.code, { kind: 'native' });
      assert.strictEqual(redeemed.ok, true);
      assert.strictEqual(redeemed.client.kind, 'native');
      assert.deepStrictEqual(redeemed.client.permissions, ['read', 'chat-write']);

      const session = await api.call('session.start', { title: 'window' }, windowCtx);
      assert.notStrictEqual(session.error, 'forbidden');

      const log = readAudit(dir);
      assert.ok(log.indexOf('chat.publish') !== -1);
      assert.ok(log.indexOf(BODY) === -1);
      assert.ok(log.indexOf('kept-secret') === -1);
    } finally {
      rimraf(dir);
    }
  });

  await test('pairing keeps extension permissions fixed and chat-write narrow', async function () {
    const dir = tempDir();
    const clients = createClients({ core: fakeCore(dir) });
    try {
      const defaults = clients.beginPairing({ name: '既定' });
      assert.deepStrictEqual(clients.redeem(defaults.code).client.permissions, ['read', 'emergency']);
      const emergency = clients.beginPairing({ name: '緊急', permissions: ['emergency'] });
      assert.deepStrictEqual(clients.redeem(emergency.code).client.permissions, ['read', 'emergency']);
      const unknown = clients.beginPairing({ name: '不明', permissions: ['nope'] });
      assert.strictEqual(unknown.error, 'permissions');
      const only = clients.beginPairing({ name: 'コメント', kind: 'native', permissions: ['chat-write'] });
      assert.deepStrictEqual(clients.redeem(only.code, { kind: 'native' }).client.permissions, ['read', 'chat-write']);
      const mixed = clients.beginPairing({
        name: '混在',
        kind: 'native',
        permissions: ['write', 'emergency', 'chat-write']
      });
      assert.deepStrictEqual(clients.redeem(mixed.code, { kind: 'native' }).client.permissions, ['read', 'chat-write']);
      const extension = clients.beginPairing({
        name: '拡張',
        kind: 'extension',
        permissions: ['read', 'write', 'chat-write'],
        requiresApproval: true
      });
      const ext = clients.redeem(extension.code, { kind: 'extension', extensionId: EXT_ID });
      assert.strictEqual(ext.ok, true);
      assert.deepStrictEqual(ext.client.permissions, ['read', 'ext-write']);
      assert.strictEqual(ext.client.requiresApproval, false);
    } finally {
      rimraf(dir);
    }
  });

  await test('comment panel paints the body as text', async function () {
    const src = hubSource();
    // コメントの画面は comment-send のパネル（V7）。その iframe の JS から paintChat と部品だけ取り出して動かす
    const block = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'comment-send', 'ui', 'panel.js'), 'utf8'); // コメントのパネルのファイル全体
    const labelsStart = block.indexOf('var SITE_LABELS');
    const labelsEnd = block.indexOf('var list = ');
    const paintStart = block.indexOf('function siteLabel(');
    const paintEnd = block.indexOf('function refresh(');
    assert.ok(labelsStart >= 0 && labelsEnd > labelsStart && paintStart > labelsEnd && paintEnd > paintStart);
    const paintSrc = block.slice(labelsStart, labelsEnd) + block.slice(paintStart, paintEnd);
    assert.ok(paintSrc.indexOf('innerHTML') === -1);
    assert.ok(block.indexOf('innerHTML') === -1);
    assert.ok(block.indexOf('insertAdjacentHTML') === -1);
    assert.ok(block.indexOf('document.write') === -1);
    assert.ok(src.indexOf("oneButton.textContent = 'わんコメをつなぐ'") !== -1);
    assert.ok(src.indexOf("kind: 'native'") !== -1);
    assert.ok(src.indexOf("permissions: ['read', 'chat-write']") !== -1);

    const doc = fakeDocument();
    const root = doc.createElement('div');
    const make = new Function('document', 'list', paintSrc + '\nreturn paintChat;');
    const paintRows = make(doc, root);
    assert.strictEqual(typeof paintRows, 'function');
    const paint = (node, rows) => paintRows(rows);
    const html = '<img src=x onerror=alert(1)>';
    paint(root, [
      { site: 'fc2', name: '<b>A</b>', text: html },
      { site: 'rumble', name: 'B', text: 'plain' }
    ]);
    const texts = findAll(root, 'chat-text');
    assert.strictEqual(texts.length, 2);
    assert.strictEqual(texts[0].textContent, html);
    assert.strictEqual(texts[0].childNodes[0].nodeType, 3);
    assert.strictEqual(texts[1].textContent, 'plain');
    assert.ok(root.childNodes[0].textContent.indexOf('FC2') !== -1);
    assert.ok(root.innerHTML.indexOf('&lt;img') !== -1);
    assert.ok(root.innerHTML.indexOf('<img') === -1);
    assert.ok(root.innerHTML.indexOf('<b>') === -1);
    paint(root, []);
    assert.strictEqual(root.childNodes.length, 1);
    assert.strictEqual(root.textContent, 'コメントはまだありません。');
    paint(root, null);
    assert.strictEqual(root.textContent, 'コメントはまだありません。');
  });

  console.log('[marust] w11 tests passed');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
