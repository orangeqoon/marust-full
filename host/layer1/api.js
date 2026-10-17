'use strict';

// 本体は host/core/api/index.js（計画 X・S8a。名前空間ごとの定義と実装は host/core/api/ns/）。この 1 行は S11 まで、host/core/api を require する場所を変えないための入口。
module.exports = require('./api/index');
