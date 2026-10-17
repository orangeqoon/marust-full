'use strict';
// W60: 引っ越しファイル（暗号化した設定＋秘密）。値・合言葉が出力や記録に出ないこと、配信中は取り込まないこと。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../host/core/core-bridge');
const { createSecretProvider } = require('../host/core/vault');
const { createFakeBackend } = require('../host/core/vault-backends/fake');
const { createMigrationBundle } = require('../host/layer1/migration-bundle');
const { createApi } = require('../host/layer1/api');
const { WINDOW_ID } = require('../host/layer1/clients');

const SECRET_A = 'SECRET-VALUE-A-w60-' + 'x'.repeat(24);
const SECRET_B = 'SECRET-VALUE-B-w60-' + 'y'.repeat(24);
const OBS_PW = 'OBSPASSWORD-SENTINEL-w60';
const PASS = 'correct horse battery w60';

function boxCore(dir) {
  const c = createCore();
  return {
    STATE_DIR: dir,
    COOKIES_DIR: path.join(dir, 'cookies'),
    SERVICES_DIR: path.join(dir, 'services'),
    DATA_DIR: path.join(dir, 'data'),
    atomicWriteJsonSync: c.atomicWriteJsonSync
  };
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w60-'));
  const core = boxCore(dir);
  fs.mkdirSync(core.SERVICES_DIR, { recursive: true });
  fs.writeFileSync(path.join(core.SERVICES_DIR, 'obs-config.json'), JSON.stringify({ host: 'localhost', port: 4455, password: OBS_PW }));
  const vault = createSecretProvider({ core: core, backend: createFakeBackend(), allowFake: true, logger() {} });
  await vault.ready;
  assert.strictEqual((await vault.set('youtube.oauth', SECRET_A, 'test')).ok, true);
  assert.strictEqual((await vault.set('twitch.oauth', SECRET_B, 'test')).ok, true);

  let live = false;
  const applied = [];
  const settingsTool = () => ({
    exportAll: () => ({ schemaVersion: 1, layout: { last: '', items: [] }, modes: { plugins: {} }, hotkeys: [], destinations: [], pluginConfigs: {}, autostart: {} }),
    importSelected: (doc, sections) => { applied.push(sections.slice()); return { ok: true, backup: 'b.json', applied: sections.slice() }; }
  });
  const tool = createMigrationBundle({ core: core, secrets: vault, reader: vault.coreReader('migration', () => true), settingsTool: settingsTool, isLive: () => live });

  // 合言葉が短い／無い
  assert.strictEqual((await tool.exportBundle({ passphrase: 'short' })).error, 'passphrase-short');
  assert.strictEqual((await tool.exportBundle({})).error, 'bad-passphrase');

  // 書き出し: 戻り値に値・合言葉が無い
  const out = await tool.exportBundle({ passphrase: PASS });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.counts.secrets, 2);
  assert.strictEqual(out.counts.files, 1);
  const returned = JSON.stringify(out);
  for (const bad of [SECRET_A, SECRET_B, OBS_PW, PASS]) assert.ok(!returned.includes(bad));

  // ファイルは暗号化されていて、値も合言葉も平文で入っていない
  const file = path.join(out.dir, out.filename);
  const text = fs.readFileSync(file, 'utf8');
  for (const bad of [SECRET_A, SECRET_B, OBS_PW, PASS, 'youtube.oauth']) assert.ok(!text.includes(bad), 'plain in bundle: ' + bad);
  assert.strictEqual(JSON.parse(text).format, 'marust-migration');

  // 別の PC を模す: 空の金庫・空の state
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w60b-'));
  const core2 = boxCore(dir2);
  const vault2 = createSecretProvider({ core: core2, backend: createFakeBackend(), allowFake: true, logger() {} });
  await vault2.ready;
  const tool2 = createMigrationBundle({ core: core2, secrets: vault2, reader: vault2.coreReader('migration', () => true), settingsTool: settingsTool, isLive: () => live });

  // 間違った合言葉・壊れたファイル
  assert.strictEqual((await tool2.importBundle({ passphrase: 'wrong passphrase 123', bundle: text })).error, 'wrong-passphrase');
  assert.strictEqual((await tool2.importBundle({ passphrase: PASS, bundle: 'not json' })).error, 'not-a-bundle');
  const tampered = JSON.parse(text); tampered.data = Buffer.from('tampered').toString('base64');
  assert.strictEqual((await tool2.importBundle({ passphrase: PASS, bundle: JSON.stringify(tampered) })).error, 'wrong-passphrase');
  assert.strictEqual((await vault2.list()).secrets.length, 0);

  // 配信中は取り込まない（何も変えない）
  live = true;
  assert.strictEqual((await tool2.importBundle({ passphrase: PASS, bundle: text })).error, 'live-now');
  assert.strictEqual((await vault2.list()).secrets.length, 0);
  assert.strictEqual(applied.length, 0);
  live = false;

  // 取り込み
  const done = await tool2.importBundle({ passphrase: PASS, bundle: text });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.counts.secrets, 2);
  assert.strictEqual(done.counts.files, 1);
  const doneText = JSON.stringify(done);
  for (const bad of [SECRET_A, SECRET_B, OBS_PW, PASS]) assert.ok(!doneText.includes(bad));
  // モードは適用しない
  assert.strictEqual(applied.length, 1);
  assert.ok(!applied[0].includes('modes'));
  // 値が復元されている
  assert.strictEqual((await vault2.coreReader('t', () => true).get('youtube.oauth')).value, SECRET_A);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(core2.SERVICES_DIR, 'obs-config.json'), 'utf8')).password, OBS_PW);

  // 2 回目: 既存の obs-config は控えが残る
  const again = await tool2.importBundle({ passphrase: PASS, bundle: text });
  assert.strictEqual(again.ok, true);
  assert.ok(fs.readdirSync(core2.SERVICES_DIR).some((n) => n.startsWith('obs-config.json.bak-')));

  // API: ウィンドウだけ。ログには引数の名前だけ
  const logs = [];
  const api = createApi({
    getState() { return { product: 'marust' }; },
    core: core, secrets: vault,
    audit: { write(row) { logs.push(JSON.stringify(row)); } }
  });
  const browser = { clientId: 'x', kind: 'browser', permissions: ['read', 'write'] };
  assert.strictEqual((await api.call('migration.export', { passphrase: PASS }, browser)).error, 'forbidden');
  assert.strictEqual((await api.call('migration.import', { passphrase: PASS, bundle: text }, browser)).error, 'forbidden');
  const viaApi = await api.call('migration.export', { passphrase: PASS }, { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] });
  assert.strictEqual(viaApi.ok, true);
  assert.ok(!JSON.stringify(viaApi).includes(SECRET_A));
  for (const row of logs) for (const bad of [SECRET_A, SECRET_B, OBS_PW, PASS]) assert.ok(!row.includes(bad));

  // state 配下のどのファイルにも、合言葉は残らない
  for (const f of walk(dir, []).concat(walk(dir2, []))) {
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!body.includes(PASS), 'passphrase leaked in ' + f);
    if (!/obs-config\.json/.test(f)) assert.ok(!body.includes(SECRET_A), 'secret plain in ' + f);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  console.log('ok w60-migration-bundle');
}

main().catch((err) => { console.error(err); process.exit(1); });
