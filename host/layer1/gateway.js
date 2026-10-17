'use strict';

// 本体は host/core/gateway/index.js（計画 X・S8b。HTTP の道具は http-util.js・端末の追跡は sockets.js・プラグインの画面の配信は plugin-serve.js）。この 1 行は S11 まで、host/core/gateway を require する場所を変えないための入口。
module.exports = require('./gateway/index');
