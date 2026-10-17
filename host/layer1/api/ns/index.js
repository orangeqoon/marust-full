'use strict';

// api の名前空間の一覧（host/core/api/index.js が specs と runs を集める）。名前空間を足す・消すときはここと ns/<名前>.js。
module.exports = [
  require('./hub'),
  require('./devmode'),
  require('./obs'),
  require('./engine'),
  require('./layout'),
  require('./clients'),
  require('./destination'),
  require('./approval'),
  require('./api'),
  require('./broadcast'),
  require('./secrets'),
  require('./vault'),
  require('./chat'),
  require('./modes'),
  require('./sites'),
  require('./features'),
  require('./plugins'),
  require('./plugin'),
  require('./ui'),
  require('./app'),
  require('./home'),
  require('./settings'),
  require('./migration'),
  require('./diagnostics')
];
