'use strict';
/** 画面全体で共有する状態（パネルの一覧・権限・表示の細かさ・ドック）。ここは値だけで、動きは持たない。 */
var PANELS = [
  ['home', STR.uiMenubar30],
  ['emergency', STR.uiState1],
  ['destinations', STR.uiMenubar32],
  ['features', STR.featuresPanelTitle],
  ['plugin-manager', STR.pluginManagerTitle],
  ['approvals', STR.uiMenubar9, { dev: true }],
  ['obs-connect', STR.uiMenubar4],
  ['site-add', STR.uiMenubar5],
  ['secrets', STR.uiState6],
  ['clients', STR.uiMenubar8],
  ['sites', STR.uiState8],
  ['migration', STR.migrationTitle],
  ['about', STR.uiMenubar63]
];
var can = { read: true, write: true, emergency: true };
// 表示の細かさ（R8）。ui.getSettings の uiLevel で受ける。取得前・失敗時は初級（basic）からスタート。
var uiLevel = 'basic';
// 配り物の種類（ui.getSettings の distribution）。'core'＝「本体だけ」。
var buildDistribution = 'full';
var UI_LEVEL_ORDER = { basic: 0, standard: 1, advanced: 2 };
// 開発者モード（R1）。hub.getState の devMode で受ける。取得前は false 扱い（devModeKnown が false の間は、保存済みの配置から dev パネルを外さない）。
var devMode = false;
var devModeKnown = false;
var soloListEl = null;
var soloPanelId = '';
var obsLiveCount = null; // hub.getState.destinations.liveCount
var obsConnected = null; // hub.getState.engineStatus.connected（分からないときは null）
var confirmLiveWanted = true; // hub.getState の confirmLive。false なら live 切り替えで id を入力させない
var dockApi = null;
var suppressRestore = false;
var pluginHost = null;
var useDefaultLayout = false;
var catalogTries = 0;
