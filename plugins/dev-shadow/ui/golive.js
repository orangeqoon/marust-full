'use strict';

// 本番切り替えの案内（開発者用）。golive.check（読むだけ。プラグイン dev-shadow が出す）を親の画面経由で呼ぶ。
var SITES = ['rumble', 'youtube', 'twitch', 'kick', 'twitcasting', 'niconico', 'fc2', 'kukulu', 'picarto', 'soop'];
var siteEl = document.getElementById('site');
var statusEl = document.getElementById('status');
var stepsEl = document.getElementById('steps');
var pending = '';
var seq = 0;

SITES.forEach(function (site) {
  var option = document.createElement('option');
  option.value = site;
  option.textContent = site;
  siteEl.appendChild(option);
});

function mark(level) {
  if (level === 'ok') return '✓';
  if (level === 'warn') return '!';
  return '□';
}

function paint(result) {
  while (stepsEl.firstChild) stepsEl.removeChild(stepsEl.firstChild);
  var steps = result && Array.isArray(result.steps) ? result.steps : [];
  if (!steps.length) {
    var empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '案内を取得できません';
    stepsEl.appendChild(empty);
    return;
  }
  var ul = document.createElement('ul');
  steps.forEach(function (row) {
    var level = row && (row.level === 'ok' || row.level === 'warn' || row.level === 'todo') ? row.level : 'warn';
    var li = document.createElement('li');
    li.className = 'golive-' + level;
    var detail = row && typeof row.detail === 'string' ? row.detail.slice(0, 240) : '';
    li.textContent = mark(level) + ' ' + detail;
    ul.appendChild(li);
  });
  stepsEl.appendChild(ul);
}

function load() {
  statusEl.textContent = '';
  seq += 1;
  pending = 'g' + seq;
  parent.postMessage({ type: 'marust:call', id: pending, method: 'golive.check', params: { site: siteEl.value } }, '*');
}

window.addEventListener('message', function (event) {
  var msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.type !== 'marust:result' || String(msg.id) !== pending) return;
  if (!msg.result || msg.result.ok === false) {
    statusEl.textContent = '案内を取得できません';
    paint(null);
    return;
  }
  paint(msg.result);
});

siteEl.addEventListener('change', load);
document.getElementById('refresh').addEventListener('click', load);
load();
