'use strict';

// 自動枠取り（slot の役目）のパネル。ID は slot- で始まる。
(function () {
  const ID = 'slot-niconico';
  const CODE_RE = /^[a-z0-9-]{1,40}$/;

  const OP_LABEL = {
    created: '枠を作って開始しました',
    reused: '動いている枠を引き継ぎました',
    started: '枠を開始しました',
    ended: '枠が終わりました',
    'ended-natural': '枠が自然に終わりました。次の枠へ進みます',
    'ended-disconnect': 'OBS が止まったので枠を終了しました',
    'end-failed': '枠を終了できませんでした（もう一度試します）',
    'shadow-would-create': '（影）枠を作るはずでした',
    'login-expired': 'ログインが切れています',
    'test-slot': 'テスト枠を作りました'
  };

  const els = {};
  ['mode', 'obs', 'program', 'op', 'login', 'refresh', 'test', 'testnote', 'title', 'category', 'tags', 'desc', 'autoclose-obs', 'autoclose-delay', 'autoclose', 'next', 'extend', 'monetize', 'cruise', 'saved', 'config']
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
    return '失敗: ' + code;
  }

  const MODE_LABEL = { legacy: '使っていません', shadow: '見るだけ（試験。枠は作りません）', live: '使っています' };
  const STATUS_LABEL = { ON_AIR: '放送中', TEST: '準備中', ENDED: '終了', UNKNOWN: '不明' };

  function show(r) {
    els.mode.textContent = MODE_LABEL[r.mode] || '-';
    const obs = r.obs || {};
    els.obs.textContent = obs.reachable === false ? 'つながっていません' : (obs.streaming ? '配信中' : '停止中');
    els.program.textContent = r.liveId ? r.liveId + '（' + (STATUS_LABEL[r.status] || '不明') + '）' : 'なし';
    const op = opText(r.lastOp);
    els.op.textContent = op;
    els.op.className = op.indexOf('失敗') === 0 || r.needsLogin || r.error ? 'is-bad' : '';
    els.login.textContent = r.needsLogin ? '切れています（ブラウザ拡張でニコニコにログインし直してください）' : (r.credentials === true ? 'あり' : (r.credentials === false ? 'なし' : '未確認'));
    const c = r.config || {};
    const set = (el, value) => { if (el && document.activeElement !== el) el.value = value; };
    set(els.title, c.title || '');
    set(els.category, c.category || '');
    set(els.tags, c.tags || '');
    set(els.desc, c.description || '');
    if (els['autoclose-obs']) els['autoclose-obs'].checked = c.autoCloseOnObsStop !== false;
    set(els['autoclose-delay'], c.autoCloseDelaySec != null ? c.autoCloseDelaySec : 60);
    set(els.autoclose, c.autoCloseMin || 5);
    els.next.checked = c.createNextOnNaturalEnd !== false;
    els.extend.checked = c.extendToMax !== false;
    els.monetize.checked = c.monetize === true;
    els.cruise.checked = c.cruiseWait === true;
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
        ? 'テスト枠を作りました: ' + result.liveId
        : '作れませんでした: ' + (result && CODE_RE.test(String(result.error)) ? result.error : 'ng');
      refresh(false);
    });
  });

  els.config.addEventListener('submit', (event) => {
    event.preventDefault();
    call('setConfig', {
      title: els.title.value,
      category: els.category.value,
      tags: els.tags.value,
      description: els.desc.value,
      autoCloseOnObsStop: els['autoclose-obs'] ? els['autoclose-obs'].checked : true,
      autoCloseDelaySec: els['autoclose-delay'] ? Number(els['autoclose-delay'].value) : 0,
      autoCloseMin: Number(els.autoclose.value),
      createNextOnNaturalEnd: els.next.checked,
      extendToMax: els.extend.checked,
      monetize: els.monetize.checked,
      cruiseWait: els.cruise.checked
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
