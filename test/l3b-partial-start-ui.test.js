'use strict';

// L3b: 送信中と配信中の文字・出せなかった配信先の理由と「もう一度出す」・OBS が止まった知らせ・トレイの「全部止める」は確認なし。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STR = require('../plugins/ui-standard/shell/strings');
global.STR = STR;
const buttons = require('../plugins/ui-standard/shell/panels/destinations');
const home = require('../plugins/ui-standard/shell/panels/home');
const tray = require('../host/layer1/tray');
const { emergencyButtonState } = require('../host/core/engine/emergency-button');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  await test('送信中の文字: stateLive・liveCount・色の説明', () => {
    assert.strictEqual(STR.stateLive, '送信中');
    assert.strictEqual(STR.liveCount(2), '送信中: 2 か所');
    assert.ok(/緑は送信中/.test(STR.stateColorNote));
    assert.strictEqual(STR.stateLiveWithSite(), '送信中・配信中');
    assert.strictEqual(STR.state('live'), '送信中');
  });

  await test('配信中はサイトで公開を見られたときだけ足す（siteLive が無ければ送信中だけ）', () => {
    const targets = [{ id: '1', site: 'twitch', state: 'live', destinationId: 'twitch-1' }];
    assert.strictEqual(buttons.streamGroups(targets, { twitch: 'T' }, {})[0].siteLive, false);
    assert.strictEqual(buttons.streamGroups(targets, { twitch: 'T' })[0].siteLive, false);
    assert.strictEqual(buttons.streamGroups(targets, { twitch: 'T' }, { 'twitch-1': true })[0].siteLive, true);
    assert.deepStrictEqual(buttons.streamSiteLiveMap([{ id: 'a', siteLive: true }, { id: 'b', siteLive: false }, { id: 'c' }]), { a: true });
  });

  await test('結果の文: preflight（全体）・全部 ok・一部だけ失敗', () => {
    const nameOf = (id) => 'N-' + id;
    const pre = buttons.streamResultSummary([{
      ok: false, error: 'preflight', items: [],
      preflight: { ok: false, globalOk: false, items: [{ id: 'x', level: 'error', code: 'obs-disconnected', message: 'OBS につながっていません', scope: 'global' }] }
    }], nameOf);
    assert.ok(pre.text.indexOf('何も出していません') !== -1);
    assert.ok(pre.text.indexOf('OBS につながっていません') !== -1);
    assert.strictEqual(pre.error, 'preflight');
    assert.deepStrictEqual(pre.failed, []);

    const ok = buttons.streamResultSummary([{ ok: true, error: '', items: [{ destinationId: 'a', ok: true, step: 'verify' }, { destinationId: 'b', ok: true, step: 'verify' }] }], nameOf);
    assert.strictEqual(ok.text, '全部出しました');
    assert.deepStrictEqual(ok.failed, []);
    assert.deepStrictEqual(ok.okIds, ['a', 'b']);

    const part = buttons.streamResultSummary([{
      ok: true, error: '', items: [
        { destinationId: 'a', ok: true, step: 'verify' },
        { destinationId: 'b', ok: false, step: 'preflight', error: 'target-missing' },
        { destinationId: 'c', ok: false, step: 'start', error: 'start-failed' }
      ]
    }], nameOf);
    assert.ok(part.text.indexOf('出せたもの: N-a') !== -1);
    assert.ok(part.text.indexOf('出せなかったもの: N-b、N-c') !== -1);
    assert.deepStrictEqual(part.failed.map((f) => [f.id, f.reason]), [
      ['b', 'OBS の配信先の行がありません（作り直してください）'],
      ['c', 'OBS が送り始められませんでした（キーかサーバーを確かめてください）']
    ]);
    assert.strictEqual(buttons.streamResultText([{ ok: true, error: '', items: [] }]), '');
  });

  await test('もう一度出した結果を一覧に重ねる（出せたら消える・まだなら理由を書き直す）', () => {
    const prev = [{ id: 'b', name: 'b', code: 'target-missing', step: 'preflight', reason: 'x' }, { id: 'c', name: 'c', code: 'x', step: 'start', reason: 'y' }];
    const okRes = buttons.streamMergeRetry(prev, 'b', { ok: true, error: '', items: [{ destinationId: 'b', ok: true, step: 'verify' }] });
    assert.deepStrictEqual(okRes.failed.map((f) => f.id), ['c']);
    assert.strictEqual(okRes.text, '全部出しました');
    const ng = buttons.streamMergeRetry(prev, 'b', { ok: true, error: '', items: [{ destinationId: 'b', ok: false, step: 'start', error: 'x' }] });
    assert.deepStrictEqual(ng.failed.map((f) => f.id).sort(), ['b', 'c']);
    const glob = buttons.streamMergeRetry(prev, 'b', { ok: false, error: 'preflight', items: [], preflight: { items: [{ level: 'error', scope: 'global', code: 'obs', message: 'OBS につながっていません' }] } });
    assert.deepStrictEqual(glob.failed.map((f) => f.id).sort(), ['b', 'c']);
  });

  await test('理由の表: 日本語にする。知らない code は「出せませんでした（code）」', () => {
    assert.strictEqual(STR.broadcastFailReason('target-missing'), 'OBS の配信先の行がありません（作り直してください）');
    assert.strictEqual(STR.broadcastFailReason('destination-unlinked'), 'OBS の配信先にひも付いていません');
    assert.strictEqual(STR.broadcastFailReason('destination-disabled'), 'この配信先は使わない設定です');
    assert.strictEqual(STR.broadcastFailReason('anything', 'start'), 'OBS が送り始められませんでした（キーかサーバーを確かめてください）');
    assert.strictEqual(STR.broadcastFailReason('anything', 'confirm'), 'OBS が送り始められませんでした（キーかサーバーを確かめてください）');
    assert.strictEqual(STR.broadcastFailReason('weird-code'), '出せませんでした（weird-code）');
  });

  await test('トレイ: 全部止めるは確認の窓なしで emergencyStop が 1 回。押している間の二度押しは 1 回だけ', async () => {
    const dialogs = [];
    const stops = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const menu = { template: null };
    function FakeTray() { this.setToolTip = () => {}; this.setContextMenu = () => {}; this.setImage = () => {}; this.destroy = () => {}; }
    const handle = tray.createTray({
      Tray: FakeTray,
      Menu: { buildFromTemplate: (t) => { menu.template = t; return t; } },
      nativeImage: { createFromPath: (p) => ({ p }) },
      dialog: { showMessageBox: () => { dialogs.push(1); return Promise.resolve({ response: 0 }); } },
      getButtonState: () => emergencyButtonState([], false),
      emergencyStop: () => { stops.push(1); return gate.then(() => ({ ok: true })); },
      assetsDir: path.join(ROOT, 'assets')
    });
    assert.ok(handle.labels.indexOf('全部止める') !== -1);
    assert.strictEqual(handle.labels.indexOf('非常停止'), -1);
    const first = handle.click('全部止める');
    await new Promise((resolve) => setImmediate(resolve));
    const second = await handle.click('全部止める');
    assert.strictEqual(second.error, 'busy');
    release();
    assert.strictEqual((await first).ok, true);
    assert.strictEqual(stops.length, 1);
    assert.strictEqual(dialogs.length, 0);
    assert.strictEqual(tray.EMERGENCY_DIALOG, undefined);
  });

  await test('ソース: もう一度出すは broadcast.start を destinationIds 1 つで呼ぶ。キーの値を say に渡さない', () => {
    const dest = read('plugins/ui-standard/shell/panels/destinations.js');
    const homeSrc = read('plugins/ui-standard/shell/panels/home.js');
    assert.ok(/call\('broadcast\.start', \{ destinationIds: \[entry\.id\],[^}]*confirmed: true \}\)/.test(dest), 'retry');
    assert.ok(/streamBindFailed\(/.test(homeSrc), 'home uses the shared retry box');
    assert.ok(/home-broadcast-failed/.test(homeSrc));
    // 作り直し: 同じ destinationId で link し（今の行のまま）
    assert.ok(/engine\.link', \{ destinationId: destId, targetId: String\(target\.id\), site: site \}/.test(dest));
    assert.ok(!/say\([^)]*\bkey\b/.test(dest) && !/say\([^)]*\bkey\b/.test(homeSrc), 'key value must not reach say');
    assert.ok(/type: 'password', maxlength: '300', autocomplete: 'off'/.test(dest));
    // 自動のやり直しを作らない: broadcast.start を呼ぶのはボタンの処理だけ（OBS が止まった判定の近くには無い）
    const stopped = homeSrc.slice(homeSrc.indexOf('function obsStoppedNotice'), homeSrc.indexOf('function ensureHomePanel'));
    assert.ok(stopped.indexOf('broadcast.start') === -1);
  });

  await test('OBS が止まった判定: 送信中 2 → 0 は出す・止めた記録が 15 秒以内なら出さない・未接続になったら出す', () => {
    const f = home.obsStoppedNotice;
    const now = 1000000;
    assert.strictEqual(f({ liveCount: 2, obs: true }, { liveCount: 0, obs: true }, 0, now), true);
    assert.strictEqual(f({ liveCount: 2, obs: true }, { liveCount: 0, obs: true }, now - 5000, now), false);
    assert.strictEqual(f({ liveCount: 2, obs: true }, { liveCount: 0, obs: true }, now - 20000, now), true);
    assert.strictEqual(f({ liveCount: 2, obs: true }, { liveCount: null, obs: false }, now - 1000, now), true);
    assert.strictEqual(f({ liveCount: 0, obs: true }, { liveCount: 0, obs: true }, 0, now), false);
    assert.strictEqual(f({ liveCount: 0, obs: true }, { liveCount: 0, obs: false }, 0, now), false);
    assert.strictEqual(f({ liveCount: 2, obs: true }, { liveCount: 2, obs: true }, 0, now), false);
    assert.strictEqual(f(null, { liveCount: 0, obs: true }, 0, now), false);
    assert.ok(/OBS が止まりました。もう一度出すなら配信開始を押してください。/.test(STR.obsStoppedNotice));
  });

  if (failed) { console.error(failed + ' failed'); process.exit(1); }
})();
