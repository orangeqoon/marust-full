'use strict';

const display = document.getElementById('display');
const statusEl = document.getElementById('status');
const legacy = document.getElementById('legacy');
const errorEl = document.getElementById('error');
const hoursInput = document.getElementById('hours');
const minutesInput = document.getElementById('minutes');
const secondsInput = document.getElementById('seconds');
const titleInput = document.getElementById('title');
const categoryInput = document.getElementById('category');
const countdownButton = document.getElementById('mode-countdown');
const countupButton = document.getElementById('mode-countup');
const durationButton = document.getElementById('apply-duration');
const presetBox = document.getElementById('presets');
const progressBar = document.getElementById('progress-bar');
const pauseDuration = document.getElementById('pause-duration');

// フォント・表示設定
const fontBtn = document.getElementById('font-btn');
const fontDialog = document.getElementById('font-dialog');
const fontSelect = document.getElementById('font-select');
const fontCustomInput = document.getElementById('font-custom-input');
const timerSizeInput = document.getElementById('timer-size-input');
const titleSizeInput = document.getElementById('title-size-input');
const zoomInput = document.getElementById('zoom-input');
const spacingInput = document.getElementById('spacing-input');
const fontCancel = document.getElementById('font-cancel');
const fontApply = document.getElementById('font-apply');

const PRESET_STEPS = [300, 900, 1800, 3600, 3600, 3600];
const MAX_SEC = 24 * 3600;
let presetValues = [];
let running = false;
let currentDurationSec = 300;

let seq = 0;

function call(method, params) {
  seq += 1;
  parent.postMessage({
    type: 'marust:call',
    id: String(seq),
    method: method,
    params: params || {}
  }, location.origin);
}

function errorText(code) {
  if (code === 'session-active') return '別のセッションが動いています';
  if (code === 'bad-duration') return '時間は 1 秒から 24 時間までです';
  if (code === 'bad-title') return '題名は 200 文字までです';
  if (code === 'bad-category') return 'カテゴリは 100 文字までです';
  if (code === 'running') return '動作中は時間を変更できません';
  if (code === 'bad-preset') return 'その時間にはできません';
  if (code === 'bad-mode') return 'モードを選べません';
  return '操作できません';
}

function focused(el) {
  return document.activeElement === el;
}

function fillDuration(total) {
  const sec = Number(total);
  if (!Number.isFinite(sec)) return;
  if (focused(hoursInput) || focused(minutesInput) || focused(secondsInput)) return;
  const whole = Math.max(0, Math.floor(sec));
  hoursInput.value = String(Math.floor(whole / 3600));
  minutesInput.value = String(Math.floor((whole % 3600) / 60));
  secondsInput.value = String(whole % 60);
}

function apply(result) {
  if (!result || result.ok === false) {
    errorEl.textContent = errorText(result && result.error);
    return;
  }
  errorEl.textContent = '';
  if (typeof result.display === 'string') display.textContent = result.display;
  statusEl.textContent = result.running ? '動作中' : (result.pausedSec > 0 ? '一時停止中（止めてから ' + clockText(result.pausedSec) + '）' : '停止');
  running = !!result.running;
  legacy.hidden = result.pluginMode !== 'legacy';
  countdownButton.setAttribute('aria-pressed', result.mode === 'countdown' ? 'true' : 'false');
  countupButton.setAttribute('aria-pressed', result.mode === 'countup' ? 'true' : 'false');
  const locked = !!result.running;
  hoursInput.disabled = locked;
  minutesInput.disabled = locked;
  secondsInput.disabled = locked;
  durationButton.disabled = locked;

  if (typeof result.durationSec === 'number') {
    currentDurationSec = result.durationSec;
    fillDuration(result.durationSec);
  }

  // ポーズ中（一時停止）の休憩時間計測表示
  if (!result.running && typeof result.pausedSec === 'number' && result.pausedSec > 0) {
    pauseDuration.textContent = 'Paused: ' + clockText(result.pausedSec);
    pauseDuration.classList.remove('hidden');
    display.classList.add('paused');
  } else {
    pauseDuration.classList.add('hidden');
    display.classList.remove('paused');
  }

  // プログレスバー & タイムアップ（超過）ネオン演出
  if (progressBar) {
    const total = currentDurationSec > 0 ? currentDurationSec : 1;
    if (result.mode === 'countdown') {
      const remaining = typeof result.remainingSec === 'number' ? result.remainingSec : 0;
      const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
      progressBar.style.width = pct + '%';
      if (remaining <= 0 && result.running) {
        progressBar.classList.add('time-up-bar');
        display.classList.add('time-up');
      } else {
        progressBar.classList.remove('time-up-bar');
        display.classList.remove('time-up');
      }
    } else {
      // カウントアップモード（超過中または直接カウントアップ）
      progressBar.style.width = '100%';
      progressBar.classList.add('time-up-bar');
      display.classList.add('time-up');
    }
  }

  if (!focused(titleInput) && typeof result.title === 'string') titleInput.value = result.title;
  if (!focused(categoryInput) && typeof result.category === 'string') categoryInput.value = result.category;
  if (Array.isArray(result.presets)) paintPresets(result.presets);
}

function clockText(total) {
  const sec = Math.max(0, Math.floor(total));
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor((sec % 3600) / 60)) + ':' + pad(sec % 60);
}

function fillDatalist(id, values) {
  const list = document.getElementById(id);
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  values.slice(0, 50).forEach((text) => {
    const option = document.createElement('option');
    option.value = text;
    list.appendChild(option);
  });
}

function labels() {
  return { title: titleInput.value, category: categoryInput.value };
}

function totalSeconds() {
  const hours = Number(hoursInput.value);
  const minutes = Number(minutesInput.value);
  const seconds = Number(secondsInput.value);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

const fanoutHintEl = document.getElementById('fanout-hint');
const SITE_LABELS = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
  twitcasting: 'ツイキャス',
  niconico: 'ニコ生',
  fc2: 'FC2',
  soop: 'SOOP',
  kukulu: 'Kukulu',
  picarto: 'Picarto',
  rumble: 'Rumble'
};
let draftTimer = null;

function applyTitlePluginState(st) {
  if (!st || typeof st !== 'object') return;
  if (!focused(titleInput) && typeof st.title === 'string' && (st.title || !titleInput.value)) {
    if (titleInput.value !== st.title) {
      titleInput.value = st.title;
      call('plugin.timer.setTitle', labels());
    }
  }
  if (!focused(categoryInput) && typeof st.category === 'string' && (st.category || !categoryInput.value)) {
    if (categoryInput.value !== st.category) {
      categoryInput.value = st.category;
      call('plugin.timer.setTitle', labels());
    }
  }
  if (!fanoutHintEl) return;
  const rows = Array.isArray(st.siteResults) ? st.siteResults.filter((r) => r && r.mode !== 'legacy') : [];
  if (st.phase === 'sending') {
    fanoutHintEl.textContent = '【タイトル変更プラグイン】現在、各配信サイトへ題名・カテゴリを送信中です…';
    return;
  }
  if (rows.length > 0) {
    const parts = rows.map((r) => {
      const name = SITE_LABELS[r.site] || r.site;
      if (r.result === 'ok') return name + ':✓反映済';
      if (r.message === 'not-configured' || r.message === 'not-configured-timeout') return name + ':⚠未設定';
      if (r.result === 'error') return name + ':×失敗';
      return name + ':待機中';
    });
    fanoutHintEl.textContent = '【タイトル変更プラグイン同期中】 ' + parts.join(' ／ ');
  } else {
    fanoutHintEl.textContent = '【タイトル変更プラグイン同期中】ホーム・題名パネルと題名・カテゴリを共有しています。開始すると全サイトへ反映します。';
  }
}

function pushDraftToTitlePlugin() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const f = labels();
    call('plugin.timer.setTitle', f);
    call('favorites.get', { title: f.title, category: f.category, source: 'timer' });
  }, 250);
}

window.addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'marust:result') {
    const result = msg.result;
    if (result && Array.isArray(result.titles) && Array.isArray(result.categories)) {
      fillDatalist('fav-titles', result.titles);
      fillDatalist('fav-categories', result.categories);
      if (result.state) applyTitlePluginState(result.state);
      return;
    }
    apply(result);
  }
});

// タイマー数字のクリックで開始 / 一時停止トグル
display.addEventListener('click', () => {
  if (running) {
    call('plugin.timer.stop', {});
  } else {
    const f = labels();
    call('favorites.get', { title: f.title, category: f.category, source: 'timer' });
    call('plugin.timer.start', labels());
  }
});

countdownButton.addEventListener('click', () => {
  call('plugin.timer.setMode', { mode: 'countdown' });
});

countupButton.addEventListener('click', () => {
  call('plugin.timer.setMode', { mode: 'countup' });
});

document.getElementById('duration').addEventListener('submit', (event) => {
  event.preventDefault();
  const seconds = totalSeconds();
  call('plugin.timer.setDuration', { seconds: seconds });
});

document.getElementById('start').addEventListener('click', () => {
  const f = labels();
  call('favorites.get', { title: f.title, category: f.category, source: 'timer' });
  call('plugin.timer.start', labels());
});

document.getElementById('stop').addEventListener('click', () => {
  call('plugin.timer.stop', {});
});

document.getElementById('reset').addEventListener('click', () => {
  call('plugin.timer.reset', {});
});

titleInput.addEventListener('input', pushDraftToTitlePlugin);
titleInput.addEventListener('change', pushDraftToTitlePlugin);

categoryInput.addEventListener('input', pushDraftToTitlePlugin);
categoryInput.addEventListener('change', pushDraftToTitlePlugin);

function presetLabel(sec) {
  if (sec === 0) return 'SET';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  let out = '';
  if (h) out += h + 'H';
  if (m) out += m + '分';
  if (s || !out) out += s + '秒';
  return out;
}

function paintPresets(values) {
  if (values.length === presetValues.length && values.every((v, i) => v === presetValues[i])) return;
  presetValues = values.slice();
  while (presetBox.firstChild) presetBox.removeChild(presetBox.firstChild);
  values.forEach((sec, i) => {
    const cell = document.createElement('div');
    cell.className = 'preset-cell p' + ((i % 6) + 1);

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'preset';
    go.textContent = presetLabel(sec);
    go.title = presetLabel(sec) + ' で、いますぐ始めます';
    go.addEventListener('click', () => {
      const fields = labels();
      call('favorites.get', { title: fields.title, category: fields.category, source: 'timer' });
      call('plugin.timer.startPreset', { seconds: sec, title: fields.title, category: fields.category });
    });

    const arrows = document.createElement('div');
    arrows.className = 'arrows';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'arrow';
    up.textContent = '▲';
    up.title = presetLabel(PRESET_STEPS[i]) + ' 増やす';
    up.addEventListener('click', () => {
      call('plugin.timer.setPreset', { index: i, seconds: Math.min(MAX_SEC, sec + PRESET_STEPS[i]) });
    });

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'arrow';
    down.textContent = '▼';
    down.title = presetLabel(PRESET_STEPS[i]) + ' 減らす';
    down.addEventListener('click', () => {
      call('plugin.timer.setPreset', { index: i, seconds: Math.max(60, sec - PRESET_STEPS[i]) });
    });

    arrows.appendChild(up);
    arrows.appendChild(down);
    cell.appendChild(go);
    cell.appendChild(arrows);
    presetBox.appendChild(cell);
  });
}

// フォント & 表示設定の保存・復元
function applyFontStyles(settings) {
  const root = document.documentElement;
  if (settings.font) {
    root.style.setProperty('--timer-font-family', `"${settings.font}", "Cascadia Mono", Consolas, monospace`);
  }
  if (settings.timerSize) {
    root.style.setProperty('--timer-font-size', settings.timerSize + 'px');
  }
  if (settings.titleSize && titleInput) {
    titleInput.style.fontSize = settings.titleSize + 'px';
  }
  if (settings.zoom) {
    root.style.setProperty('--app-zoom', settings.zoom);
  }
  if (settings.spacing) {
    root.style.setProperty('--timer-letter-spacing', settings.spacing + 'px');
  }
}

function loadSavedSettings() {
  try {
    const saved = localStorage.getItem('marust_timer_ui_settings');
    if (!saved) return;
    const data = JSON.parse(saved);
    applyFontStyles(data);
    if (fontSelect && data.font) {
      if (Array.from(fontSelect.options).some(o => o.value === data.font)) {
        fontSelect.value = data.font;
      } else {
        fontSelect.value = 'custom';
        if (fontCustomInput) {
          fontCustomInput.classList.remove('hidden');
          fontCustomInput.value = data.font;
        }
      }
    }
    if (timerSizeInput && data.timerSize) timerSizeInput.value = data.timerSize;
    if (titleSizeInput && data.titleSize) titleSizeInput.value = data.titleSize;
    if (zoomInput && data.zoom) zoomInput.value = data.zoom;
    if (spacingInput && data.spacing) spacingInput.value = data.spacing;
  } catch (_) {}
}

if (fontBtn && fontDialog) {
  fontBtn.addEventListener('click', () => {
    fontDialog.showModal();
  });
  if (fontSelect && fontCustomInput) {
    fontSelect.addEventListener('change', () => {
      if (fontSelect.value === 'custom') {
        fontCustomInput.classList.remove('hidden');
        fontCustomInput.focus();
      } else {
        fontCustomInput.classList.add('hidden');
      }
    });
  }
  if (fontCancel) {
    fontCancel.addEventListener('click', () => fontDialog.close());
  }
  if (fontApply) {
    fontApply.addEventListener('click', () => {
      const selectedFont = fontSelect.value === 'custom' ? (fontCustomInput.value.trim() || '') : fontSelect.value;
      const settings = {
        font: selectedFont,
        timerSize: timerSizeInput ? timerSizeInput.value : '64',
        titleSize: titleSizeInput ? titleSizeInput.value : '18',
        zoom: zoomInput ? zoomInput.value : '1.0',
        spacing: spacingInput ? spacingInput.value : '-1'
      };
      applyFontStyles(settings);
      try {
        localStorage.setItem('marust_timer_ui_settings', JSON.stringify(settings));
      } catch (_) {}
      fontDialog.close();
    });
  }
}

loadSavedSettings();
call('favorites.get', {});
call('plugin.timer.getState', {});
let tickCount = 0;
setInterval(() => {
  call('plugin.timer.getState', {});
  tickCount += 1;
  if (tickCount % 3 === 0) call('favorites.get', {});
}, 1000);
