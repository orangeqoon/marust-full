'use strict';

/**
 * api の名前空間 layout（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * specs は params・権限の定義、runs(S) は実装。S は host/core/api/index.js の createApi の中の道具（同じ名前で受ける）。
 */


const specs = {
  'layout.list': {
    permission: 'read',
    description: 'レイアウト名の一覧を返す',
    params: {}
  },
  'layout.get': {
    permission: 'read',
    description: 'レイアウトを読む',
    params: { name: { type: 'string', required: true, max: 40, layoutName: true, error: 'layout-name' } }
  },
  'layout.save': {
    permission: 'write',
    description: 'レイアウトを保存する',
    params: {
      name: { type: 'string', required: true, max: 40, layoutName: true, error: 'layout-name' },
      data: { type: 'object', required: true, error: 'layout-type' }
    }
  },
  'layout.getLevel': {
    permission: 'read',
    description: '表示の細かさ（中級・上級）ごとに自動で保存した配置を読む',
    params: { level: { type: 'string', required: true, max: 10, enum: ['standard', 'advanced'], error: 'bad-level' } }
  },
  'layout.saveLevel': {
    permission: 'write',
    description: '表示の細かさ（中級・上級）の配置を保存する（離れるとき）',
    params: {
      level: { type: 'string', required: true, max: 10, enum: ['standard', 'advanced'], error: 'bad-level' },
      data: { type: 'object', required: true, error: 'layout-type' }
    }
  },
  'layout.remove': {
    permission: 'write',
    description: 'レイアウトを削除する',
    params: { name: { type: 'string', required: true, max: 40, layoutName: true, error: 'layout-name' } }
  }
};

function runs(S) {
  const { src } = S;
  return {
    'layout.list': function () { return src.layouts ? src.layouts.list() : { ok: false, error: 'unavailable' }; },
    'layout.get': function (params) { return src.layouts ? src.layouts.get(params.name) : { ok: false, error: 'unavailable' }; },
    'layout.save': function (params) { return src.layouts ? src.layouts.save(params.name, params.data) : { ok: false, error: 'unavailable' }; },
    'layout.getLevel': function (params) { return src.layouts ? src.layouts.getLevel(params.level) : { ok: false, error: 'unavailable' }; },
    'layout.saveLevel': function (params) { return src.layouts ? src.layouts.saveLevel(params.level, params.data) : { ok: false, error: 'unavailable' }; },
    'layout.remove': function (params) { return src.layouts ? src.layouts.remove(params.name) : { ok: false, error: 'unavailable' }; }
  };
}

module.exports = { specs, runs };
