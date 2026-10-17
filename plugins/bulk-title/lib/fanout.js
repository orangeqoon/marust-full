'use strict';

/**
 * 題名とカテゴリを各サイトへ送る（V2 で host/layer1/orchestrator.js の fanout から移した）。
 * 行・message の言葉は移す前と同じ: live-not-confirmed / superseded-by-v2 / needs-title / needs-title-or-category /
 * not-configured / not-configured-timeout / no-fanout / legacy-mode / plugin-stuck / superseded。
 * サイトの中身は ctx.peers 経由でしか呼べない。モードの扱い（legacy は呼ばない・shadow は dryRun）と順番待ちは本体が守る。
 * 本物の送信の確認の門（hubFanoutDecision）は本体の hub.fanout にある。ここは渡された allowedLiveIds を見るだけ。
 */

const CODE_RE = /^[a-z0-9-]{1,40}$/;

function skip(id, message) {
  return { id: id, result: 'skip', elapsedMs: 0, message: message };
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function createFanout(options) {
  const opts = options || {};
  const peers = opts.peers;
  const bus = opts.bus || null;
  const logger = typeof opts.logger === 'function' ? opts.logger : function () {};
  // ctx.audit（形は核が決める: fields。記録への追記: append）。無ければ記録しない
  const audit = opts.audit && typeof opts.audit.append === 'function' && opts.audit.fields ? opts.audit : null;

  // L9b: ログイン切れ（unauthorized / login-expired）を site.trouble で知らせる。同じサイトは直る（送れる）まで 1 回だけ。
  // 切れたサイトだけ飛ばす（ほかのサイトへは送る）。shadow・dryRun は実際に送っていないので出さない
  const troubled = new Set();
  function reportTrouble(id, row, mode, dryRun) {
    if (!bus || typeof bus.publish !== 'function' || mode !== 'live' || dryRun) return;
    const site = String(id).replace(/^site-/, '');
    if (row.result === 'ok') { troubled.delete(site); return; }
    if (row.result !== 'error' || (row.message !== 'unauthorized' && row.message !== 'login-expired')) return;
    if (troubled.has(site)) return;
    troubled.add(site);
    try {
      bus.publish('site.trouble', { site: site, job: 'title', kind: 'login-expired', code: 'login-expired', at: new Date().toISOString() });
    } catch (_) { /* 通知が落ちても行は返す */ }
  }

  function withMode(row, mode) {
    return Object.assign({}, row, { mode: mode });
  }

  // ran（peers.run の答え）を行にする。value は出さない
  function rowOf(id, ran) {
    return {
      id: id,
      result: ran && ran.result != null ? ran.result : 'error',
      elapsedMs: ran && ran.elapsedMs != null ? ran.elapsedMs : 0,
      message: ran && ran.message != null ? ran.message : ''
    };
  }

  // updateMetadata は { ok:false, error } を返してきたら失敗として扱う
  function metadataRow(id, ran) {
    const row = rowOf(id, ran);
    const value = ran && ran.value;
    if (row.result === 'ok' && value && typeof value === 'object' && !Array.isArray(value) && value.ok === false) {
      const code = value.error;
      if (typeof code === 'string' && CODE_RE.test(code)) {
        row.result = 'error';
        row.message = code;
      }
    }
    return row;
  }

  // isConfigured。送れる状態なら null、だめなら skip の行
  async function considerConfigured(id, gate) {
    if (!gate.ok) return skip(id, gate.message);
    const checked = await peers.run(id, 'isConfigured', []);
    if (checked && checked.result === 'timeout') return skip(id, 'not-configured-timeout');
    if (!checked || checked.result !== 'ok' || !checked.value) return skip(id, 'not-configured');
    return null;
  }

  function writeAudit(record) {
    if (!audit) return;
    const ok = audit.append(record);
    if (!ok) logger('warn', 'shadow log was not written');
  }

  async function fanout(intent) {
    const list = peers.list();
    const byId = {};
    list.forEach(function (row) { byId[row.id] = row; });
    const title = intent && intent.title != null ? String(intent.title) : '';
    const category = intent && intent.category != null ? String(intent.category) : '';
    const source = (intent && intent.source) || 'timer-ui';

    function supersededByV2(id) {
      if (!id || id.indexOf('site-') === 0) return false;
      const v2 = byId['site-' + id];
      return !!v2 && v2.mode !== 'legacy';
    }

    const jobs = [];
    for (const rec of list) {
      const id = rec.id;
      const mode = rec.mode;
      const fan = rec.fanout;
      if (supersededByV2(id)) {
        jobs.push(Promise.resolve(withMode(skip(id, 'superseded-by-v2'), mode)));
        continue;
      }
      if (mode === 'legacy') {
        jobs.push(Promise.resolve(withMode(skip(id, 'legacy-mode'), mode)));
        continue;
      }
      if (mode === 'live' && intent && Array.isArray(intent.allowedLiveIds) && intent.allowedLiveIds.indexOf(id) === -1) {
        jobs.push(Promise.resolve(withMode(skip(id, 'live-not-confirmed'), mode)));
        continue;
      }
      const dryRun = mode === 'shadow' ? true : !!(intent && intent.dryRun);
      const meta = { source: source, dryRun: dryRun, mode: mode };
      const isV2Site = rec.manifestVersion === 2 && rec.provides.indexOf('stream.site@1') !== -1;
      if (isV2Site) {
        jobs.push((async function () {
          const denied = await considerConfigured(id, { ok: true });
          if (denied) return withMode(denied, mode);
          const ran = await peers.run(id, 'updateMetadata', [{ title: title, category: category }, meta], { queue: 'fanout' });
          const done = metadataRow(id, ran);
          reportTrouble(id, done, mode, dryRun);
          return withMode(done, mode);
        })());
        continue;
      }
      if (!fan) {
        jobs.push(Promise.resolve(withMode(skip(id, 'no-fanout'), mode)));
        continue;
      }
      let gate = { ok: true };
      if (fan.requires === 'title' && !hasText(title)) gate = { ok: false, message: 'needs-title' };
      if (fan.requires === 'title-or-category' && !hasText(title) && !hasText(category)) {
        gate = { ok: false, message: 'needs-title-or-category' };
      }
      jobs.push((async function () {
        const denied = await considerConfigured(id, gate);
        if (denied) return withMode(denied, mode);
        const method = fan.method;
        let args;
        if (method === 'updateStream') args = [title || '', category || '', meta];
        else if (method === 'updateTitle') args = [title, meta];
        else args = [category, meta];
        const ran = await peers.run(id, method, args, { queue: 'fanout' });
        return withMode(rowOf(id, ran), mode);
      })());
    }
    const rows = await Promise.all(jobs);
    if (audit) writeAudit({
      ts: audit.fields.localIso(),
      kind: 'fanout',
      source: source,
      title: audit.fields.clipField(title),
      category: audit.fields.clipField(category),
      sites: audit.fields.summarizeSites(rows)
    });
    if (bus && typeof bus.publish === 'function') {
      try { bus.publish('stream.metadata.changed', { title: title, category: category }); } catch (_) { /* 通知が落ちても行は返す */ }
    }
    return rows;
  }

  return { fanout: fanout };
}

module.exports = { createFanout };
