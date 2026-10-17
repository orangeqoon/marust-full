'use strict';

// L4a: OBS の設定を読んでつなぐ・YouTube の自動停止の案内・ログインの欄は二層目があるときだけ。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STR = require('../plugins/ui-standard/shell/strings');
global.STR = STR;
global.registerPanel = function () {};
const sites = require('../plugins/ui-standard/shell/panels/sites');
const { createObsSetup } = require('../host/layer1/obs-setup');
const { specs } = require('../host/layer1/api/ns/obs');
const { summarizeSite } = require('../host/layer1/site-info');
const { createSiteConfig } = require('../host/layer1/site-config');

let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const SECRET = 'pw-' + 'Zq9xK2mV7';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-l4a-'));

function writeCfg(name, doc, raw) {
  const file = path.join(tmp, name + '.json');
  fs.writeFileSync(file, raw != null ? raw : JSON.stringify(doc));
  return file;
}
function makeSetup(file) {
  const sets = [];
  const secrets = { set: async (n, v, who) => { sets.push({ n, v, who }); return { ok: true }; } };
  const setup = createObsSetup({ core: {}, secrets, reader: null, obsWebsocketConfigPath: file, engine: { reconnect: async () => {}, connection: { getStatus: () => ({ connected: true }) } } });
  return { setup, sets };
}

test('importFromObs: ファイルなし → not-found（金庫に書かない）', async () => {
  const { setup, sets } = makeSetup(path.join(tmp, 'nothing.json'));
  assert.deepStrictEqual(await setup.importFromObs(), { ok: false, error: 'not-found' });
  assert.strictEqual(sets.length, 0);
});

test('importFromObs: 壊れた JSON → unreadable', async () => {
  const { setup, sets } = makeSetup(writeCfg('broken', null, '{not json'));
  assert.deepStrictEqual(await setup.importFromObs(), { ok: false, error: 'unreadable' });
  assert.strictEqual(sets.length, 0);
});

test('importFromObs: server_enabled false → server-disabled。金庫の set を呼ばず、ファイルも変えない', async () => {
  const file = writeCfg('disabled', { server_enabled: false, server_port: 4455, auth_required: true, server_password: SECRET });
  const before = fs.readFileSync(file, 'utf8');
  const { setup, sets } = makeSetup(file);
  assert.deepStrictEqual(await setup.importFromObs(), { ok: false, error: 'server-disabled' });
  assert.strictEqual(sets.length, 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('importFromObs: ポートが変 → bad-port', async () => {
  const { setup, sets } = makeSetup(writeCfg('badport', { server_enabled: true, server_port: 70000 }));
  assert.deepStrictEqual(await setup.importFromObs(), { ok: false, error: 'bad-port' });
  assert.strictEqual(sets.length, 0);
});

test('importFromObs: auth_required false → パスワード空で保存', async () => {
  const { setup, sets } = makeSetup(writeCfg('noauth', { server_enabled: true, server_port: 4466, auth_required: false, server_password: SECRET }));
  const res = await setup.importFromObs();
  assert.deepStrictEqual(res, { ok: true, port: 4466, hasPassword: false, connected: true });
  assert.strictEqual(sets.length, 1);
  assert.deepStrictEqual(JSON.parse(sets[0].v), { host: '127.0.0.1', port: 4466, password: '' });
});

test('importFromObs: よい場合は金庫に入り、答えにパスワードの値が入らない', async () => {
  const file = writeCfg('good', { server_enabled: true, server_port: 4455, auth_required: true, server_password: SECRET });
  const before = fs.readFileSync(file, 'utf8');
  const { setup, sets } = makeSetup(file);
  const res = await setup.importFromObs();
  assert.deepStrictEqual(res, { ok: true, port: 4455, hasPassword: true, connected: true });
  assert.ok(!JSON.stringify(res).includes(SECRET));
  assert.strictEqual(sets[0].n, 'obs.websocket');
  assert.deepStrictEqual(JSON.parse(sets[0].v), { host: '127.0.0.1', port: 4455, password: SECRET });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('窓口 obs.importConfig は write・windowOnly・params なし', () => {
  const s = specs['obs.importConfig'];
  assert.ok(s);
  assert.strictEqual(s.permission, 'write');
  assert.strictEqual(s.windowOnly, true);
  assert.deepStrictEqual(s.params, {});
});

test('site-info: addHint を通し、200 字で切る。無ければ空', () => {
  const a = summarizeSite({ id: 'x', addHint: 'あ'.repeat(500) }, 'site-x', 'live', []);
  assert.strictEqual(a.addHint.length, 200);
  assert.strictEqual(summarizeSite({ id: 'x' }, 'site-x', 'live', []).addHint, '');
  const dir = path.join(ROOT, 'plugins', 'sites');
  const hints = fs.readdirSync(dir).map((d) => JSON.parse(fs.readFileSync(path.join(dir, d, 'manifest.json'), 'utf8')).site)
    .filter((s) => s && s.addHint);
  assert.ok(hints.some((s) => /自動停止/.test(s.addHint)));
  assert.ok(hints.every((s) => s.addHint.length <= 200));
});

test('ログインの列: 二層目なし → 出さない／一部だけ → 出す・無いサイトは空のセル', () => {
  assert.strictEqual(sites.sitesLoginVisible(null), false);
  assert.strictEqual(sites.sitesLoginVisible([{ id: 'a', hasLayer2: false }, { id: 'b' }]), false);
  const rows = [{ id: 'a', hasLayer2: true }, { id: 'b', hasLayer2: false }];
  assert.strictEqual(sites.sitesLoginVisible(rows), true);
  assert.strictEqual(sites.sitesLoginRowActive(rows[0]), true);
  assert.strictEqual(sites.sitesLoginRowActive(rows[1]), false);
  assert.strictEqual(sites.sitesLoginRowActive(null), false);
});

test('loginFacts: オンのプラグインが <サイト>. か cookies.<サイト>- を宣言していれば hasLayer2', async () => {
  const mk = (declared) => createSiteConfig({
    secrets: { list: async () => ({ ok: true, secrets: [] }) },
    getDeclaredNames: () => declared,
    getSites: async () => [
      { id: 'sa', login: { type: 'oauth' }, secretNames: ['sa.oauth'] },
      { id: 'sb', login: { type: 'cookie' }, secretNames: ['cookies.sb-main'] },
      { id: 'sc', login: { type: 'config' }, secretNames: ['sc.config'] }
    ]
  });
  const none = (await mk([]).loginFacts()).sites;
  assert.ok(none.every((r) => r.hasLayer2 === false));
  const some = (await mk(['sa.oauth', 'cookies.sb-main']).loginFacts()).sites;
  assert.deepStrictEqual(some.map((r) => r.hasLayer2), [true, true, false]);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(failed + ' 件失敗'); process.exit(1); }
  console.log('l4a: すべて ok');
})();
