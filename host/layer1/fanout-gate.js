'use strict';

/**
 * 「核が一度確認した予約だけ送る」（K3。host/timer-fanout.js の代わり）。
 * タイマーを始めたとき（プラグイン timer-link が session.started の source が timer を見て）題名とカテゴリを全サイトへ送る。
 * 確認の門は核が持つ。プラグインは confirmed も allowedLiveIds も付けられない（title と category だけ渡す）。
 *  - 予約 = 画面の親が最初の確認で「はい」を押したとき、核が ui-settings に残した fanoutAck と fanoutAckLiveIds（そのとき live だった題名の送り先の id）。
 *  - 本番（live）の送り先があるときは、予約があり、今の live がすべて予約に含まれるときだけ送る（確認済みの印 confirmed は、その判定の結果として核が付ける）。
 *    予約に無い live が増えていたら送らず needs-ack（画面でもう一度確認すると予約が書き直される）。
 *  - 旧い fanoutAck だけ（fanoutAckLiveIds が無い）の人は、最初の 1 回だけ今の live を予約として採用する（確認済みのときの live と同じ前提）。
 * 題名もカテゴリも空なら何もしない（empty）。送り先が全部 legacy なら送らない（legacy）。
 */

function listOf(value) {
  return Array.isArray(value) ? value.filter(function (id) { return typeof id === 'string' && id; }) : [];
}

function createFanoutReserved(deps) {
  const d = deps || {};
  let last = { sent: false, reason: 'none', at: '', missing: [] };

  function note(sent, reason, missing) {
    last = { sent: sent, reason: reason, at: new Date().toISOString(), missing: Array.isArray(missing) ? missing.slice() : [] };
    return sent ? { ok: true } : { ok: false, error: reason };
  }

  async function send(params) {
    const title = params && typeof params.title === 'string' ? params.title.trim() : '';
    const category = params && typeof params.category === 'string' ? params.category.trim() : '';
    if (!title && !category) return note(false, 'empty');
    let summary;
    try { summary = d.summarize(); } catch (_) { return note(false, 'unavailable'); }
    const live = summary && summary.live ? summary.live : 0;
    const shadow = summary && summary.shadow ? summary.shadow : 0;
    if (live + shadow === 0) return note(false, 'legacy');
    const liveIds = listOf(summary.liveIds);
    let reserved = true;
    let missing = [];
    if (live > 0) {
      const view = d.getReservation();
      if (!view || view.ack !== true) {
        reserved = false;
        missing = liveIds;
      } else if (view.liveIds == null) {
        // 旧い確認（送り先の控えが無い）。今の live を、確認したときの live として 1 回だけ採用する
        try { d.setReservation(liveIds); } catch (_) { /* 書けなくても今回の判定は通す */ }
      } else {
        missing = liveIds.filter(function (id) { return view.liveIds.indexOf(id) === -1; });
        reserved = missing.length === 0;
      }
    }
    // 予約外の live が増えている。ホームの知らせ（hub.getState の timerFanout）から、画面でもう一度確認すると予約が書き直される
    if (!reserved) return note(false, 'needs-ack', missing);
    let done;
    try {
      done = await d.fanout({ title: title, category: category, confirmed: reserved, allowedLiveIds: liveIds });
    } catch (_) {
      return note(false, 'failed');
    }
    if (done && done.ok === false && done.error === 'no-plugin') return note(false, 'no-plugin');
    return note(true, 'sent');
  }

  return { send: send, last: function () { return Object.assign({}, last); } };
}

// ハブ画面から受け取る題名とカテゴリ。文字列化し、長さを切る（旧 host/fanout-input.js。門の入口なのでここにまとめた）
function coerceFanoutInput(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const title = body.title == null ? '' : String(body.title);
  const category = body.category == null ? '' : String(body.category);
  return {
    title: title.slice(0, 200),
    category: category.slice(0, 100)
  };
}

module.exports = { createFanoutReserved, coerceFanoutInput };
