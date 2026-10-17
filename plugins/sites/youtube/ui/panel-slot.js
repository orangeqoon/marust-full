'use strict';

// 自動枠取り（slot の役目）のパネル。ID は slot- で始まる。
(function () {
  const ID = 'slot-youtube';
  const CODE_RE = /^[a-z0-9-]{1,40}$/;

  const OP_LABEL = {
    created: '枠を作って開始しました',
    'created-waiting': '枠を作りました（配信の受信待ち）',
    reused: '動いている枠があります',
    switched: '次の枠へ切り替えました',
    'shadow-would-create': '（影）枠を作るはずでした',
    'shadow-would-switch': '（影）切り替えるはずでした',
    'login-expired': 'ログインが切れています',
    quota: 'API の上限のため、きょうは止めています',
    'obs-restart-failed': 'OBS の配信を再開できませんでした。すぐ確認してください',
    'obs-control-off': '「OBS の操作」がオフのため止めました',
    'test-slot': 'テスト枠を作りました'
  };

  const els = {};
  ['mode', 'obs', 'broadcast', 'op', 'login', 'usage', 'refresh', 'test', 'testnote', 'threshold', 'streamid', 'prefix', 'desc', 'saved', 'config']
    .forEach((name) => { els[name] = document.getElementById('slot-' + name); });

  let seq = 0;
  const waiting = {};
  let armed = false;

  function call(method, params, done) {
    seq += 1;
    const id = 'slot-' + seq;
    waiting[id] = done;
    parent.postMessage({ type: 'marust:call', id: id, method: 'plugin.' + ID + '.' + method, params: params || {} }, location.origin);
  }

  function opText(code) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return 'まだありません';
    if (OP_LABEL[code]) return OP_LABEL[code];
    if (code.indexOf('blocked-') === 0) return '安全のため止めました（' + code.slice(8) + '）';
    return '失敗: ' + code;
  }

  function mmss(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h + '時間' + m + '分';
  }

  function show(r) {
    els.mode.textContent = r.mode === 'legacy' || r.mode === 'shadow' || r.mode === 'live' ? r.mode : '-';
    const obs = r.obs || {};
    els.obs.textContent = obs.reachable === false ? 'つながっていません' : (obs.streaming ? '配信中 ' + mmss(obs.elapsedSec || 0) : '停止中');
    els.broadcast.textContent = r.broadcastId ? r.broadcastId + (r.waitingLive ? '（開始待ち）' : '') : 'なし';
    const op = opText(r.lastOp);
    els.op.textContent = op;
    els.op.className = op.indexOf('失敗') === 0 || r.needsLogin || r.error ? 'is-bad' : '';
    els.login.textContent = r.needsLogin ? '切れています（サイトのログインからやり直してください）' : (r.credentials === true ? 'あり' : (r.credentials === false ? 'なし' : '未確認'));
    const u = r.usage || {};
    els.usage.textContent = (u.units || 0) + ' 単位 / 枠 ' + (u.creates || 0) + ' 回 / 切り替え ' + (u.switches || 0) + ' 回' + (r.quotaStopped ? '（上限のため停止中）' : '');
    const c = r.config || {};
    if (document.activeElement !== els.threshold) els.threshold.value = c.thresholdSec || 42600;
    if (document.activeElement !== els.streamid) els.streamid.value = c.streamId || '';
    if (document.activeElement !== els.prefix) els.prefix.value = c.titlePrefix || '';
    if (document.activeElement !== els.desc) els.desc.value = c.defaultDescription || '';
  }

  function refresh(check) {
    call('getStatus', check ? { check: true } : {}, (result) => {
      if (result && result.ok === true) show(result);
      else { els.op.textContent = result && CODE_RE.test(String(result.error)) ? result.error : 'ng'; els.op.className = 'is-bad'; }
    });
  }

  els.refresh.addEventListener('click', () => refresh(true));

  els.test.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      els.test.textContent = 'もう一度押すと本当に作ります';
      return;
    }
    armed = false;
    els.test.textContent = 'テスト枠を作る';
    call('createTestSlot', { confirmed: true }, (result) => {
      els.testnote.textContent = result && result.ok === true
        ? 'テスト枠を作りました: ' + result.broadcastId
        : '作れませんでした: ' + (result && CODE_RE.test(String(result.error)) ? result.error : 'ng');
      refresh(false);
    });
  });

  els.config.addEventListener('submit', (event) => {
    event.preventDefault();
    call('setConfig', {
      thresholdSec: Number(els.threshold.value),
      streamId: els.streamid.value,
      titlePrefix: els.prefix.value,
      defaultDescription: els.desc.value
    }, (result) => {
      els.saved.textContent = result && result.ok === true ? '保存しました' : '保存できませんでした';
      refresh(false);
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.type !== 'marust:result') return;
    const done = waiting[String(msg.id)];
    if (!done) return;
    delete waiting[String(msg.id)];
    done(msg.result);
  });

  refresh(false);
  setInterval(() => { if (!document.hidden) refresh(false); }, 15000);
})();
