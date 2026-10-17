'use strict';

/**
 * L7e: ユーザーの要望 4 つ（2026-10-13）
 * - A. メイン出力の行き先
 * - B. 開発者モードを切っても取り消さない
 * - C. 段階を下げてもプラグインを後戻りさせない
 * - D. 題名の結果を一文で
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STR = require('../plugins/ui-standard/shell/strings');
global.STR = STR;
global.siteLabel = function (id) {
  const map = { youtube: 'YouTube', twitch: 'Twitch', niconico: 'ニコニコ生放送' };
  return map[id] || String(id);
};

const home = require('../plugins/ui-standard/shell/panels/home');
const autopair = require('../host/layer1/dev-autopair');
const { createUiSettings, resolveUiLevel, maxTier } = require('../host/layer1/ui-settings');
const { createClients, WINDOW_ID } = require('../host/layer1/clients');
const { createCore } = require('../host/core/core-bridge');
const { createApi } = require('../host/layer1/api');

const win = { clientId: WINDOW_ID, kind: 'window', permissions: ['read', 'write'] };

let failed = 0;
function test(name, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.then(() => { console.log('ok ' + name); }).catch((err) => {
        failed += 1;
        console.error('FAIL ' + name);
        console.error(err && err.stack ? err.stack : err);
      });
    }
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
  return Promise.resolve();
}

async function runAll() {
  // === A. メイン出力の行き先 ===
  await test('A: homeMainOutputLabel - 未選択・other・サイト名', () => {
    const sites = [{ site: 'youtube', name: 'YouTube' }, { site: 'twitch', name: 'Twitch' }];
    assert.strictEqual(home.homeMainOutputLabel('', sites), 'メイン出力（行き先は未選択）');
    assert.strictEqual(home.homeMainOutputLabel(null, sites), 'メイン出力（行き先は未選択）');
    assert.strictEqual(home.homeMainOutputLabel('other', sites), 'メイン出力 → そのほか');
    assert.strictEqual(home.homeMainOutputLabel('youtube', sites), 'メイン出力 → YouTube');
    assert.strictEqual(home.homeMainOutputLabel('twitch', sites), 'メイン出力 → Twitch');
  });

  await test('A: homeMainOutputView - label に行き先が含まれる', () => {
    const viewNone = home.homeMainOutputView(null, null);
    assert.strictEqual(viewNone.label, 'メイン出力（行き先は未選択）');

    const viewYt = home.homeMainOutputView({ id: 'obs-main', site: 'youtube', enabled: true }, { id: 'main', state: 'live' });
    assert.strictEqual(viewYt.label, 'メイン出力 → YouTube');
    assert.strictEqual(viewYt.stateText, STR.stateLive);

    const viewOther = home.homeMainOutputView({ id: 'obs-main', site: 'other', enabled: true }, { id: 'main', state: 'stopped' });
    assert.strictEqual(viewOther.label, 'メイン出力 → そのほか');
  });

  await test('A: emergencyMainOutput - サイト指定時と引数なし時の挙動', () => {
    assert.strictEqual(STR.emergencyMainOutput(), 'メイン出力');
    assert.strictEqual(STR.emergencyMainOutput('youtube', { youtube: 'YouTube' }), 'メイン出力 → YouTube');
    assert.strictEqual(STR.emergencyMainOutput('', {}), 'メイン出力（行き先は未選択）');
    assert.strictEqual(STR.emergencyMainOutput('other', {}), 'メイン出力 → そのほか');
  });

  // === B. 開発者モードを切っても取り消さない ===
  await test('B: 開発者モードを切っても自動端末を取り消さない（sync で revoke されない）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l7e-b-'));
    try {
      const core = Object.assign(createCore(), {
        STATE_DIR: tmp,
        SERVICES_DIR: path.join(tmp, 'services'),
        COOKIES_DIR: path.join(tmp, 'cookies'),
        DATA_DIR: path.join(tmp, 'data')
      });
      const clients = createClients({ core: core });
      clients.ensureWindowClient();

      // オンで作成
      const onRes = autopair.sync({ clients: clients, servicesDir: core.SERVICES_DIR, devModeOn: () => true, env: {} });
      assert.strictEqual(onRes.on, true);
      assert.strictEqual(onRes.made.length, 2);

      const beforeClients = clients.list().length;
      assert.ok(beforeClients >= 3); // window + 2 auto

      // オフで sync
      const offRes = autopair.sync({ clients: clients, servicesDir: core.SERVICES_DIR, devModeOn: () => false, env: {} });
      assert.strictEqual(offRes.on, false);
      assert.strictEqual(offRes.revoked, 0);

      // 自動端末がそのまま残っている
      assert.strictEqual(clients.list().length, beforeClients);
      const names = clients.list().map((r) => r.name);
      assert.ok(names.some((n) => n.endsWith(autopair.AUTO_SUFFIX)));

      // 合言葉ファイルも残っている
      assert.ok(fs.existsSync(path.join(core.SERVICES_DIR, 'marust-cli.json')));
      assert.ok(fs.existsSync(path.join(core.SERVICES_DIR, 'marust-mcp.json')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // === C. 段階を下げてもプラグインを後戻りさせない ===
  await test('C: uiLevelMax - uiLevel を上げた時だけ上がり、下げても下がらない', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l7e-c-'));
    try {
      const settings = createUiSettings({ stateDir: tmp });
      // 初期状態
      assert.strictEqual(settings.getView().uiLevelMax, '');

      // standard に設定
      settings.set({ uiLevel: 'standard', uiLevelMax: 'standard' });
      assert.strictEqual(settings.getView().uiLevel, 'standard');
      assert.strictEqual(settings.getView().uiLevelMax, 'standard');

      // advanced に上げる
      settings.set({ uiLevel: 'advanced', uiLevelMax: 'advanced' });
      assert.strictEqual(settings.getView().uiLevel, 'advanced');
      assert.strictEqual(settings.getView().uiLevelMax, 'advanced');

      // basic に下げる（uiLevelMax は advanced のまま）
      settings.set({ uiLevel: 'basic' });
      assert.strictEqual(settings.getView().uiLevel, 'basic');
      assert.strictEqual(settings.getView().uiLevelMax, 'advanced');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('C: maxTier とプラグイン門の解決', () => {
    // maxTier
    assert.strictEqual(maxTier('basic', 'advanced'), 'advanced');
    assert.strictEqual(maxTier('advanced', 'basic'), 'advanced');
    assert.strictEqual(maxTier('standard', 'basic'), 'standard');
    assert.strictEqual(maxTier('basic', 'basic'), 'basic');

    // uiLevelMax が無い時は今の段階と同じ（勝手に上げない）
    const levelCur = resolveUiLevel('basic', {});
    assert.strictEqual(levelCur, 'basic');

    // basic だけを使ってきた人（uiLevelMax が basic）は basic のまま
    assert.strictEqual(maxTier(levelCur, 'basic'), 'basic');

    // advanced にしたことがあれば、今の段階が basic でも門は advanced
    assert.strictEqual(maxTier('basic', 'advanced'), 'advanced');
  });

  await test('C: ui.setSettings - 下げた時は applyTier が呼ばれず、上げた時は呼ばれる', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l7e-c-api-'));
    try {
      const settings = createUiSettings({ stateDir: tmp });
      settings.set({ uiLevel: 'basic' });

      let applyTierCalls = 0;
      let appliedTierValue = 'basic';
      const fakeRegistry = {
        appliedTier: () => appliedTierValue,
        applyTier: async () => {
          applyTierCalls += 1;
          appliedTierValue = settings.getView().uiLevel;
          return { ok: true, deferred: [] };
        }
      };

      const api = createApi({
        uiSettings: settings,
        pluginRegistry: fakeRegistry,
        devMode: { get: () => ({ devMode: false }) },
        skipNetwork: true,
        skipDisk: true
      });

      // basic -> standard に上げる（applyTier が呼ばれる）
      const upRes = await api.call('ui.setSettings', { uiLevel: 'standard' }, win);
      assert.strictEqual(upRes.ok, true);
      assert.strictEqual(applyTierCalls, 1);
      assert.strictEqual(settings.getView().uiLevel, 'standard');
      assert.strictEqual(settings.getView().uiLevelMax, 'standard');

      // standard -> basic に下げる（applyTier は呼ばれない！L7e）
      const downRes = await api.call('ui.setSettings', { uiLevel: 'basic' }, win);
      assert.strictEqual(downRes.ok, true);
      assert.strictEqual(applyTierCalls, 1); // 増えていない！
      assert.strictEqual(settings.getView().uiLevel, 'basic');
      assert.strictEqual(settings.getView().uiLevelMax, 'standard'); // max は維持
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // === D. 題名の結果を一文で ===
  await test('D: homeApplyResultSentence - 全部通った / 一部だめ / 全部skip / 送る先なし', () => {
    const sites = [{ site: 'youtube', name: 'YouTube' }, { site: 'twitch', name: 'Twitch' }, { site: 'niconico', name: 'ニコニコ生放送' }];

    // 全部通った
    const allOk = home.homeApplyResultSentence({
      ok: true,
      results: [
        { id: 'site-youtube', result: 'ok' },
        { id: 'site-twitch', result: 'ok' },
        { id: 'site-niconico', result: 'ok' }
      ]
    }, sites);
    assert.strictEqual(allOk.text, '題名を 3 サイトに反映しました');
    assert.strictEqual(allOk.kind, 'ok');

    // 一部だめ
    const partial = home.homeApplyResultSentence({
      ok: true,
      results: [
        { id: 'site-youtube', result: 'ok' },
        { id: 'site-niconico', result: 'ok' },
        { id: 'site-twitch', result: 'failed' }
      ]
    }, sites);
    assert.strictEqual(partial.text, '題名を 2 サイトに反映しました。Twitch は反映できませんでした');
    assert.strictEqual(partial.kind, 'partial');

    // 全部 skip
    const allSkip = home.homeApplyResultSentence({
      ok: true,
      results: [
        { id: 'site-youtube', result: 'skip' },
        { id: 'site-twitch', result: 'skip' }
      ]
    }, sites);
    assert.strictEqual(allSkip.text, '題名はどのサイトにも反映されませんでした（「題名を送る」と「OBS の操作」を確認してください）。');
    assert.strictEqual(allSkip.kind, 'warn');

    // 送る先が無い
    const none = home.homeApplyResultSentence({ ok: true, results: [] }, sites);
    assert.strictEqual(none.text, STR.homeApplyNone);
    assert.strictEqual(none.kind, 'warn');
  });

  if (failed) {
    console.error(`[l7e-user-requests] ${failed} failed`);
    process.exit(1);
  }
  console.log('[marust] l7e user requests tests passed');
}

runAll();
