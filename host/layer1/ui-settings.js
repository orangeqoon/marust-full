'use strict';

/**
 * 画面の設定（ui-settings.json）の読み書き。devMode と同じファイルを共有し、他のキーは壊さない。
 * 場所: <STATE_DIR>/data/marust/ui-settings.json。許すキーだけ（ここでは showExperimental）。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;
const KEYS = Object.freeze({
  showExperimental: 'boolean',
  uiLevel: 'string',             // 表示の細かさ（R8）: basic / standard / advanced。無ければ画面側で既定（開発者モードなら advanced、そうでなければ basic）
  uiLevelMax: 'string',          // 今までに選んだいちばん高い段階（L7e）: basic / standard / advanced。プラグイン読み込み門に使う
  fanoutAck: 'boolean',          // 題名の本番送信の確認を、最初の 1 回だけにする（押したら二度と出さない）
  fanoutAckLiveIds: 'string',     // 確認したときに live だった題名の送り先の id（カンマ区切り。核が付ける。タイマーの自動送信の予約。K3）
  setupDone: 'boolean',          // 初回の案内（R6）を終えた／とばした。無いときだけ案内を出す
  setupStep: 'number',           // 案内の途中の手順（続きから）
  setupSkipped: 'string',        // とばした手順の id（カンマ区切り）
  setupSites: 'string',          // 案内で選んだサイトの id（カンマ区切り）
  completedStreams: 'number',    // 配信が終わった回数（R24。紹介は 3 回目の終了から）
  tipsDone: 'string',            // 紹介を済ませた／断った中級機能の id（カンマ区切り）
  tipPending: 'string',          // いま出している紹介の id（返事待ち）。無ければ ''
  features: 'string',            // オンにした中級機能の id（カンマ区切り）
  hiddenPlugins: 'string',       // 上級の「プラグインの管理」で隠した内蔵プラグインの id（カンマ区切り。P3）
  shell: 'string',
  theme: 'string'                // 選んだテーマ（データだけのプラグイン kind:'theme'）の id。'' ＝ 既定（V8）
});
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RANGES = Object.freeze({ setupStep: [0, 20], completedStreams: [0, 1000000] });
const ENUMS = Object.freeze({
  uiLevel: ['basic', 'standard', 'advanced'],
  uiLevelMax: ['basic', 'standard', 'advanced'],
  tipPending: null
});
const UI_LEVEL_RANK = Object.freeze({ basic: 0, standard: 1, advanced: 2 });
function maxTier(a, b) {
  const ra = UI_LEVEL_RANK[a] !== undefined ? UI_LEVEL_RANK[a] : -1;
  const rb = UI_LEVEL_RANK[b] !== undefined ? UI_LEVEL_RANK[b] : -1;
  if (ra === -1 && rb === -1) return 'basic';
  if (ra === -1) return b;
  if (rb === -1) return a;
  return rb > ra ? b : a;
}
const LIST_RE = /^[a-z0-9-]+(,[a-z0-9-]+)*$/;
const LIST_KEYS = Object.freeze(['setupSkipped', 'setupSites', 'tipsDone', 'features', 'hiddenPlugins', 'fanoutAckLiveIds']);

function list(value, max) {
  if (typeof value !== 'string' || !value) return [];
  return value.split(',').filter(function (item) { return /^[a-z0-9-]{1,32}$/.test(item); }).slice(0, max || 30);
}
const HIDDEN_MAX = 100; // 隠した内蔵プラグインの上限（P3）。内蔵は約 50 なので足りる

/**
 * 今の段階（basic / standard / advanced）。保存した uiLevel があればそれ。無いときは、開発者モードなら advanced、そうでなければ basic（版ごとの初回の段階は、初回に保存する ui-settings の既定が決める）。
 * 画面（ui.getSettings）と、プラグインを読み込む門（registry の tierFor）が同じ答えになるよう、ここだけで決める。
 */
function resolveUiLevel(stored, options) {
  const o = options || {};
  if (ENUMS.uiLevel.indexOf(stored) !== -1) return stored;
  return o.devMode === true ? 'advanced' : 'basic';
}

function createUiSettings(deps) {
  const d = deps || {};
  const stateDir = typeof d.stateDir === 'string' && d.stateDir ? d.stateDir : '';
  const file = stateDir ? path.join(stateDir, 'data', 'marust', 'ui-settings.json') : '';

  function read() {
    if (!file) return { ok: false, data: {} };
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return { ok: false, data: {} };
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, data: {} };
      return { ok: true, data: data };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, data: {} };
      return { ok: false, data: {} };
    }
  }

  function get() {
    return { showExperimental: read().data.showExperimental === true };
  }

  /** 画面の設定の全部（表示の細かさ・初回の案内の進み具合を含む）。uiLevel が無ければ ''。 */
  function getView() {
    const got = read();
    const data = got.data;
    return {
      readable: got.ok,
      showExperimental: data.showExperimental === true,
      uiLevel: ENUMS.uiLevel.indexOf(data.uiLevel) === -1 ? '' : data.uiLevel,
      uiLevelMax: ENUMS.uiLevelMax.indexOf(data.uiLevelMax) === -1 ? '' : data.uiLevelMax,
      setupDone: data.setupDone === true,
      fanoutAck: data.fanoutAck === true,
      // 予約の送り先。キーが無い（旧い確認）のときは null
      fanoutAckLiveIds: typeof data.fanoutAckLiveIds === 'string' ? list(data.fanoutAckLiveIds, 64) : null,
      setupStep: Number.isInteger(data.setupStep) && data.setupStep >= 0 && data.setupStep <= 20 ? data.setupStep : 0,
      setupSkipped: list(data.setupSkipped),
      setupSites: list(data.setupSites),
      completedStreams: Number.isInteger(data.completedStreams) && data.completedStreams >= 0 && data.completedStreams <= 1000000 ? data.completedStreams : 0,
      tipsDone: list(data.tipsDone),
      tipPending: typeof data.tipPending === 'string' && /^[a-z0-9-]{1,32}$/.test(data.tipPending) ? data.tipPending : '',
      features: list(data.features),
      hiddenPlugins: list(data.hiddenPlugins, HIDDEN_MAX),
      shell: typeof data.shell === 'string' && THEME_ID_RE.test(data.shell) ? data.shell : '',
      theme: typeof data.theme === 'string' && THEME_ID_RE.test(data.theme) ? data.theme : ''
    };
  }

  function set(patch) {
    const given = patch && typeof patch === 'object' ? patch : {};
    const next = {};
    const clear = [];
    for (const key of Object.keys(given)) {
      if (!Object.prototype.hasOwnProperty.call(KEYS, key)) return { ok: false, error: 'bad-key' };
      if (typeof given[key] !== KEYS[key]) return { ok: false, error: 'bad-value' };
      if (key === 'theme' || key === 'shell') {
        if (given[key] === '') { clear.push(key); continue; } // 既定に戻す
        if (!THEME_ID_RE.test(given[key])) return { ok: false, error: 'bad-value' };
      }
      if ((key === 'uiLevel' || key === 'uiLevelMax') && given[key] === '') { clear.push(key); continue; } // 未保存に戻す（段階の反映に失敗したとき。画面からは来ない）
      if (KEYS[key] === 'number') {
        const range = RANGES[key];
        if (!Number.isFinite(given[key]) || given[key] < range[0] || given[key] > range[1]) return { ok: false, error: 'bad-value' };
      }
      if (ENUMS[key] && ENUMS[key].indexOf(given[key]) === -1) return { ok: false, error: 'bad-value' };
      if (key === 'tipPending' && given[key] !== '' && !/^[a-z0-9-]{1,32}$/.test(given[key])) return { ok: false, error: 'bad-value' }; // 紹介の id は機能が決める（本体は形だけ見る）
      if (LIST_KEYS.indexOf(key) !== -1 && given[key] !== '' && (given[key].length > (key === 'hiddenPlugins' || key === 'fanoutAckLiveIds' ? 3400 : 400) || !LIST_RE.test(given[key]))) return { ok: false, error: 'bad-value' };
      if ((key === 'setupStep' || key === 'completedStreams') && !Number.isInteger(given[key])) return { ok: false, error: 'bad-value' };
      next[key] = given[key];
    }
    if (!file) return { ok: false, error: 'unavailable' };
    const current = read();
    if (!current.ok) return { ok: false, error: 'unreadable' };
    try {
      const merged = Object.assign({}, current.data, next);
      clear.forEach((key) => { delete merged[key]; });
      if (typeof d.atomicWriteJsonSync === 'function') d.atomicWriteJsonSync(file, merged);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      }
    } catch (_) {
      return { ok: false, error: 'write-failed' };
    }
    return Object.assign({ ok: true }, get());
  }

  return { get: get, getView: getView, set: set };
}

module.exports = { createUiSettings, resolveUiLevel, maxTier, UI_LEVEL_RANK, KEYS };
