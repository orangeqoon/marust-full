'use strict';

// 金庫の置き場に使うプラグイン id の形（file は既定の置き場の予約語）。
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

module.exports = { ID_RE };
