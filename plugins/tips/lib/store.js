'use strict';

/**
 * 紹介の状態の置き場（K3）。以前は ui-settings.json の completedStreams・tipsDone・tipPending・features だった。
 * 今はプラグイン自身の dataDir の tips.json。getView()/set(patch) は ui-settings と同じ形（tipsDone・features はカンマ区切りの文字列でも渡せる。返すのは配列）。
 * 初めて読むとき、旧い置き場の値（本体の ui.getSettings が返す写し）があれば 1 回だけ写す。元は消さない。
 */

const fs = require('fs');
const path = require('path');

const TIP_IDS = Object.freeze(['slot-niconico', 'slot-youtube', 'bulk-title', 'comment-send', 'bulk-send']);
const MAX_BYTES = 64 * 1024;

function ids(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' && value ? value.split(',') : []);
  const out = [];
  raw.forEach(function (item) { if (TIP_IDS.indexOf(item) !== -1 && out.indexOf(item) === -1) out.push(item); });
  return out;
}

function clean(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const count = Number(src.completedStreams);
  return {
    completedStreams: Number.isInteger(count) && count >= 0 && count <= 1000000 ? count : 0,
    tipsDone: ids(src.tipsDone),
    tipPending: TIP_IDS.indexOf(src.tipPending) !== -1 ? src.tipPending : '',
    features: ids(src.features)
  };
}

function createTipsStore(options) {
  const dir = options && typeof options.dir === 'string' ? options.dir : '';
  const file = dir ? path.join(dir, 'tips.json') : '';
  let state = clean(null);

  function persist() {
    if (!file) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state) + '\n', 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (_) { return false; }
  }

  function load(legacy) {
    let found = false;
    if (file) {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size <= MAX_BYTES) {
          state = clean(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
          found = true;
        }
      } catch (_) { /* 無ければ旧い置き場から写す */ }
    }
    if (!found && legacy && typeof legacy === 'object') {
      state = clean(legacy);
      persist();
    }
    return getView();
  }

  function getView() {
    return { completedStreams: state.completedStreams, tipsDone: state.tipsDone.slice(), tipPending: state.tipPending, features: state.features.slice() };
  }

  function set(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = Object.assign({}, state);
    if (Object.prototype.hasOwnProperty.call(p, 'completedStreams')) next.completedStreams = clean({ completedStreams: p.completedStreams }).completedStreams;
    if (Object.prototype.hasOwnProperty.call(p, 'tipsDone')) next.tipsDone = ids(p.tipsDone);
    if (Object.prototype.hasOwnProperty.call(p, 'tipPending')) next.tipPending = clean({ tipPending: p.tipPending }).tipPending;
    if (Object.prototype.hasOwnProperty.call(p, 'features')) next.features = ids(p.features);
    const before = state;
    state = next;
    if (!persist()) { state = before; return { ok: false, error: 'write-failed' }; }
    return { ok: true };
  }

  return { load, getView, set, file: function () { return file; } };
}

module.exports = { createTipsStore, TIP_IDS };
