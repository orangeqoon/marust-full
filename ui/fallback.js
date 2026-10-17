'use strict';
(function () {
  var api = window.marustApi;
  var active = '';
  var watched = [];
  var booting = true;
  var failed = (new URLSearchParams(location.search).get('shell-failed') || '').split(',').filter(function (id) { return /^[a-z][a-z0-9-]{0,31}$/.test(id); }).slice(0, 10);
  var fallback = document.getElementById('core-fallback');
  var root = document.getElementById('shell-root');
  function table(name) {
    if (typeof window !== 'undefined' && window[name]) return window[name];
    if (typeof globalThis !== 'undefined' && globalThis[name]) return globalThis[name];
    return {};
  }
  function coreText(key, backup) {
    var value = table('CORE_STR')[key];
    return typeof value === 'string' && value ? value : backup;
  }
  function reasonText(reason) {
    var value = table('CORE_REASONS')[reason];
    return typeof value === 'string' && value ? value : coreText('unknownReason', '画面を読み込めません');
  }
  function paintLabels() {
    var title = document.getElementById('core-title');
    if (title) title.textContent = coreText('title', '丸スト');
    document.getElementById('core-stop').textContent = coreText('stopAll', '全部止める');
    document.getElementById('core-restart').textContent = coreText('restart', '立ち上げ直す');
  }
  function fail() {
    if (active && failed.indexOf(active) === -1 && failed.length < 10) {
      failed.push(active);
      var next = new URL(location.href); next.searchParams.set('shell-failed', failed.join(',')); location.replace(next.href);
      return;
    }
    fallback.hidden = false;
    root.hidden = true;
    document.getElementById('core-reason').textContent = coreText('noShell', '画面を読み込めません。セットを入れ直して立ち上げ直してください。');
  }
  function live(state) {
    return !!(state && ((state.destinations && state.destinations.liveCount > 0) || (state.engineStatus && (state.engineStatus.streaming === true || state.engineStatus.anyOutputLive === true || state.engineStatus.mainStreaming === true || state.engineStatus.profileWarning === true))));
  }
  function refresh() {
    api.call('hub.getState', {}).then(function (state) {
      document.getElementById('core-state').textContent = live(state) ? coreText('stateLive', '配信中です') : coreText('stateIdle', '本体は動いています');
    }).catch(function () { document.getElementById('core-state').textContent = coreText('stateOffline', '本体につながっていません'); });
  }
  function shouldReload(message) {
    if (!message) return false;
    if (message.name === 'ui.shellChanged') return true;
    var payload = message.payload || {};
    if (message.name === 'plugin.reloaded') {
      var id = payload.id;
      return !active || id === active || id === '*' || failed.indexOf(id) !== -1 || watched.indexOf(id) !== -1;
    }
    if (message.name === 'ui.reloadRequested') {
      var target = payload.target;
      if (target === 'theme') return false;
      if (target === 'all') return true;
      if (typeof target !== 'string' || target.indexOf('plugin:') !== 0) return false;
      var pluginId = target.slice(7);
      return !active || pluginId === active || watched.indexOf(pluginId) !== -1 || failed.indexOf(pluginId) !== -1;
    }
    return false;
  }
  document.getElementById('core-stop').onclick = function () {
    api.call('broadcast.stopAll', {}).then(function (answer) { document.getElementById('core-result').textContent = answer && answer.ok === false ? coreText('stopCheck', '停止結果を確認してください') : coreText('stopSent', '全部止める操作を送りました'); }).catch(function () { document.getElementById('core-result').textContent = coreText('stopFailed', '停止の操作を送れませんでした'); });
  };
  document.getElementById('core-restart').onclick = function () { api.call('ui.restart', {}).then(function (answer) { if (!answer || answer.ok === false) document.getElementById('core-result').textContent = coreText('restartFailed', '丸ストを終了して、もう一度開いてください'); }).catch(function () { document.getElementById('core-result').textContent = coreText('restartFailed', '丸ストを終了して、もう一度開いてください'); }); };
  api.subscribe(function (message) {
    if (!shouldReload(message)) return;
    var next = new URL(location.href); next.searchParams.delete('shell-failed'); location.replace(next.href);
  });
  window.addEventListener('error', function () { if (booting && active) fail(); });
  window.addEventListener('unhandledrejection', function () { if (booting && active) fail(); });
  var readyResolve;
  var ready = new Promise(function (resolve) { readyResolve = resolve; });
  window.marustShell = Object.freeze({ ready: function () { readyResolve(); }, fail: fail });
  function asset(tag, field, url) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement(tag);
      el[field] = url;
      if (tag === 'link') el.rel = 'stylesheet';
      var timer = setTimeout(function () { reject(new Error('asset-timeout')); }, 15000);
      el.onload = function () { clearTimeout(timer); resolve(); };
      el.onerror = function () { clearTimeout(timer); reject(new Error('asset-failed')); };
      document.head.appendChild(el);
    });
  }
  paintLabels();
  refresh();
  setInterval(function () { if (!document.hidden && !fallback.hidden) refresh(); }, 15000);
  api.call('ui.getShell', { excluded: failed.join(',') }).then(async function (answer) {
    watched = (answer.shells || []).map(function (row) { return row.id; }).concat((answer.problems || []).map(function (row) { return row.id; }), answer.wanted || []);
    failed.forEach(function (id) { var li = document.createElement('li'); li.textContent = id + ': ' + reasonText('shell-load-failed'); document.getElementById('core-problems').appendChild(li); });
    (answer.problems || []).forEach(function (problem) {
      var li = document.createElement('li');
      li.textContent = problem.id + ': ' + reasonText(problem.reason);
      document.getElementById('core-problems').appendChild(li);
    });
    if (!answer.active) { fail(); return; }
    var shell = answer.active;
    active = shell.id;
    if (shell.template) {
      var response = await fetch(shell.base + shell.template);
      if (!response.ok) throw new Error('template');
      var markup = await response.text();
      root.innerHTML = markup;
    }
    for (var style of shell.styles) await asset('link', 'href', shell.base + style);
    root.hidden = false;
    for (var script of shell.scripts) await asset('script', 'src', shell.base + script);
    await Promise.race([ready, new Promise(function (_resolve, reject) { setTimeout(function () { reject(new Error('shell-not-ready')); }, 15000); })]);
    booting = false;
    fallback.hidden = true;
    if (failed.length || answer.fellBack || (answer.problems || []).length) {
      var notice = document.getElementById('core-notice');
      notice.hidden = false;
      notice.textContent = (answer.wanted || failed[0] || '画面') + ': ' + reasonText(answer.reason || (failed.length ? 'shell-load-failed' : (answer.problems[0] || {}).reason)) + '。' + coreText('fellBack', 'セットの画面で開きました。');
    }
  }).catch(fail);
})();
