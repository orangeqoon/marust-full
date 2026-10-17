'use strict';

// コメントを流す・送る画面（V7 C3。前は本体の ui/panels/chat.js）。
// 読む API（chat.recent・modes.list・sites.loginStatus）は marust.call、
// 送信はこのプラグイン自身の操作 plugin.comment-send.send、
// 書き込みのオン（sites.setCommentSend）は親の窓の中継（marust.relay）だけを通る。

var SITE_LABELS = {
  twitch: 'Twitch', youtube: 'YouTube', twitcasting: 'ツイキャス', niconico: 'ニコニコ', kick: 'Kick',
  fc2: 'FC2', kukulu: 'kukulu', picarto: 'Picarto', rumble: 'Rumble', soop: 'SOOP'
};
var ENABLE_ERRORS = {
  'send-off': '先に、ホームでこのサイトの「題名を送る」をオンにしてください。',
  'not-logged-in': 'ログインが済んでいません。',
  'bad-id': 'このサイトでは使えません。'
};

var list = document.getElementById('chat-list');
var input = document.getElementById('chat-text');
var sitesBox = document.getElementById('chat-sites');
var button = document.getElementById('chat-send');
var results = document.getElementById('chat-send-results');
var sending = false;
var checked = {};

function siteLabel(site) {
  return Object.prototype.hasOwnProperty.call(SITE_LABELS, site) ? SITE_LABELS[site] : site;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function writable() {
  return window.marust.can().write === true;
}

function chatTime(at) {
  var m = /T(\d{2}:\d{2}:\d{2})/.exec(String(at || ''));
  return m ? m[1] : '';
}

function paintChat(rows) {
  var stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  clear(list);
  var items = Array.isArray(rows) ? rows : [];
  if (!items.length) {
    list.appendChild(el('p', 'empty', 'コメントはまだありません。'));
    return;
  }
  items.forEach(function (row) {
    var item = row && typeof row === 'object' ? row : {};
    var siteId = item.site == null ? '' : String(item.site);
    var bubble = el('div', 'chat-bubble');
    bubble.setAttribute('data-site', siteId);
    var head = el('div', 'bubble-header');
    head.appendChild(el('span', 'bubble-author', item.name == null ? '' : String(item.name)));
    head.appendChild(el('span', 'bubble-meta', siteLabel(siteId) + (chatTime(item.at) ? ' · ' + chatTime(item.at) : '')));
    bubble.appendChild(head);
    bubble.appendChild(el('div', 'chat-text', item.text == null ? '' : String(item.text)));
    list.appendChild(bubble);
  });
  if (stick) list.scrollTop = list.scrollHeight;
}

function refresh() {
  refreshNotice();
  window.marust.call('chat.recent', { limit: 200 }).then(function (res) {
    paintChat(res && res.ok !== false ? res.messages : []);
  });
}

// わんコメとの橋がつながっているか: 入り口（chat.inlets）に、わんコメから来たコメントの記録があるか。
// 調べられない（unavailable など）ときは案内を出さない。つながったら消える。
var notice = document.getElementById('chat-onecomme');
var noticeSteps = document.getElementById('chat-onecomme-steps');
var noticeOpen = document.getElementById('chat-onecomme-open');

function oneCommeConnected(inlets) {
  var rows = inlets && typeof inlets === 'object' ? inlets : {};
  return Object.keys(rows).some(function (site) { return rows[site] && rows[site].lastSource === 'onecomme'; });
}

function paintNotice(res) {
  if (!notice) return;
  var known = !!(res && res.ok === true && res.inlets && typeof res.inlets === 'object');
  notice.hidden = !known || oneCommeConnected(res.inlets);
}

function refreshNotice() {
  window.marust.call('chat.inlets', {}).then(paintNotice);
}

if (noticeOpen && noticeSteps) {
  noticeOpen.addEventListener('click', function () {
    noticeSteps.hidden = !noticeSteps.hidden;
    noticeOpen.setAttribute('aria-expanded', noticeSteps.hidden ? 'false' : 'true');
  });
}

function paintSites(plugins, login) {
  var rows = Array.isArray(plugins) ? plugins : [];
  var sites = [];
  var usable = {};
  var reasons = {};
  var canEnable = {};
  var logins = {};
  (Array.isArray(login) ? login : []).forEach(function (r) { if (r && typeof r.id === 'string') logins[r.id] = r.state; });
  var sendOn = {};
  rows.forEach(function (r) {
    var m = r && typeof r.id === 'string' ? /^site-(.+)$/.exec(r.id) : null;
    if (m) sendOn[m[1]] = r.mode === 'live';
  });
  rows.forEach(function (row) {
    var id = row && row.id;
    if (typeof id !== 'string' || id.indexOf('sink-') !== 0) return;
    var site = id.slice(5);
    if (!site || sites.indexOf(site) !== -1) return;
    sites.push(site);
    usable[site] = row.mode === 'live'; // 書き込めないサイトは選べなくして、理由を出す
    if (!usable[site]) {
      var label = siteLabel(site);
      if (!sendOn[site]) reasons[site] = label + ': 先に、ホームでこのサイトの「題名を送る」をオンにしてください。';
      else if (logins[site] !== 'logged-in') reasons[site] = label + ': ログインが済んでいないので書き込めません（ホームの「ログインする」）。';
      else { reasons[site] = label + ': コメントの書き込みがオフです。'; canEnable[site] = true; }
    }
  });
  clear(sitesBox);
  if (!sites.length) {
    sitesBox.appendChild(el('p', 'hint', '送れるサイトはまだありません。'));
    return;
  }
  sites.forEach(function (siteName) {
    var pill = el('label', 'platform-pill ' + siteName);
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-chat-site', siteName);
    box.checked = usable[siteName] && checked[siteName] !== false;
    if (!usable[siteName]) {
      box.disabled = true;
      pill.title = reasons[siteName] || 'このサイトには、今はコメントを書き込めません。';
    }
    pill.classList.toggle('active', box.checked);
    box.addEventListener('change', function () {
      checked[siteName] = box.checked;
      pill.classList.toggle('active', box.checked);
    });
    pill.appendChild(box);
    pill.appendChild(el('span', 'pill-dot'));
    pill.appendChild(document.createTextNode(' ' + siteLabel(siteName)));
    sitesBox.appendChild(pill);
    if (!usable[siteName]) {
      var why = el('span', 'hint chat-site-reason', (reasons[siteName] || siteLabel(siteName) + ': このサイトには、今はコメントを書き込めません。') + ' ');
      if (canEnable[siteName]) {
        var on = el('button', '', 'オンにする');
        on.type = 'button';
        on.setAttribute('data-chat-enable', siteName);
        on.disabled = !writable();
        on.addEventListener('click', function () {
          window.marust.relay('sites.setCommentSend', { site: siteName, on: true }).then(function (r) {
            if (!r || r.ok !== true) {
              var code = r && r.error;
              window.marust.toast(Object.prototype.hasOwnProperty.call(ENABLE_ERRORS, code) ? ENABLE_ERRORS[code] : '切り替えられませんでした。');
            }
            loadSites();
          });
        });
        why.appendChild(on);
      }
      sitesBox.appendChild(why);
    }
  });
}

function setAllSites(on) {
  var nodes = document.querySelectorAll('[data-chat-site]');
  for (var n = 0; n < nodes.length; n += 1) {
    if (nodes[n].disabled) continue;
    nodes[n].checked = on;
    checked[nodes[n].getAttribute('data-chat-site')] = on;
    nodes[n].parentNode.classList.toggle('active', on);
  }
}

function loadSites() {
  Promise.all([
    window.marust.call('modes.list', {}),
    window.marust.call('sites.loginStatus', {})
  ]).then(function (rs) {
    var res = rs[0];
    var login = rs[1];
    paintSites(res && res.ok !== false ? res.plugins : [], login && login.ok === true ? login.sites : []);
  });
}

function selectedSites() {
  var nodes = document.querySelectorAll('[data-chat-site]');
  var sites = [];
  for (var i = 0; i < nodes.length; i += 1) {
    if (nodes[i].checked) sites.push(nodes[i].getAttribute('data-chat-site'));
  }
  return sites;
}

function paintSend(res) {
  clear(results);
  if (res && res.pending === true) {
    results.appendChild(el('p', 'hint', '承認待ちです。'));
    return;
  }
  var rows = res && Array.isArray(res.results) ? res.results : [];
  if (!rows.length) {
    if (res && res.ok === false) results.appendChild(el('p', 'broadcast-ng', typeof res.error === 'string' ? res.error : '失敗しました'));
    return;
  }
  rows.forEach(function (row) {
    var item = row || {};
    var ok = item.ok === true;
    results.appendChild(el('p', ok ? 'broadcast-ok' : 'broadcast-ng', (ok ? '✓ ' : '✗ ') + (item.site || '') + (ok ? '' : (' ' + (item.error || '')))));
  });
}

function armButton() {
  button.disabled = sending || !writable();
}

function sendNow() {
  if (sending || !writable()) return;
  var text = input.value;
  var sites = selectedSites();
  if (!text || !sites.length) {
    paintSend({ ok: false, error: !text ? '本文を入れてください' : 'サイトを選んでください' });
    return;
  }
  sending = true;
  armButton();
  window.marust.call('plugin.comment-send.send', { text: text, sites: sites }).then(function (res) {
    paintSend(res);
    if (res && res.ok === true) input.value = '';
  }).then(function () {
    sending = false;
    armButton();
  });
}

button.addEventListener('click', sendNow);
document.getElementById('chat-all').addEventListener('click', function () { setAllSites(true); });
document.getElementById('chat-none').addEventListener('click', function () { setAllSites(false); });
input.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  sendNow();
});
window.marust.onPerm(function () { armButton(); loadSites(); });
// コメントが届いたとき・モードが変わったときに 1 回だけ読み直す（定期の読み出しは 15 秒以上）
window.marust.onEvent(function (name) {
  if (name === 'chat.message') refresh();
  if (name === 'modes.changed') loadSites();
});
armButton();
refresh();
loadSites();
setInterval(refresh, 15000);
