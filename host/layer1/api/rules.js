'use strict';

/**
 * api の規則と共通の定数（計画 X・S8a。host/core/api.js から機械的に移した。動きは変えていない）。
 * params の検査（checkRule・validateParams・publicParams）・秘密の項目を伏せる withoutSecrets・権限の名前・名前空間の specs が使う入力の規則。
 */

const { validName } = require('../layouts');

const PROTOCOLS = new Set(['RTMP', 'SRT_RIST', 'WHIP']);

const destinationIdsRule = {
  type: 'array',
  required: true,
  min: 1,
  max: 20,
  error: 'destination-ids',
  typeError: 'destination-ids',
  item: { type: 'string', max: 80 }
};
const preflightIdsRule = {
  type: 'array',
  required: false,
  max: 20,
  error: 'destination-ids',
  typeError: 'destination-ids',
  item: { type: 'string', max: 80 }
};

const IPC_PERMISSIONS = Object.freeze(['read', 'write', 'emergency']);
const EXT_WRITE = 'ext-write';
// 核が callInternal で呼んでよい、プラグインが出した read の API の名前（K3。外から渡された名前は通さない）
// 名前 → 出すプラグインが名乗る役割（manifest の provides）。内蔵のプラグインが名乗った役割の行だけ信じる（別のプラグインが先に同じ名前を出しても、核は信じない。K3 評価 Should 1・計画 X・P1）
const INTERNAL_READS = Object.freeze({ 'tips.get': 'tips.source@1', 'sites.loginStatus': 'site.login@1' });
const CHAT_WRITE = 'chat-write';
const PERMISSIONS = Object.freeze(['read', 'write', 'emergency', EXT_WRITE, CHAT_WRITE]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const SECRET_FIELD = /^(key|token|password|secret|cookie)s?$/i;

function withoutSecrets(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) out.push(withoutSecrets(value[i]));
    return out;
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (SECRET_FIELD.test(key)) continue;
    out[key] = withoutSecrets(value[key]);
  }
  return out;
}

function checkRule(name, rule, source) {
  if (!rule || rule.loose === true) return '';
  const label = rule.label || name;
  let value = source[name];

  if (rule.layoutName === true) {
    return validName(value) ? '' : (rule.error || 'layout-name');
  }
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return rule.error || (label + '-type');
    return '';
  }
  if (rule.type === 'array') {
    if (value == null) return rule.required ? (rule.typeError || rule.error || (label + '-type')) : '';
    if (!Array.isArray(value)) return rule.typeError || rule.error || (label + '-type');
    if (typeof rule.min === 'number' && value.length < rule.min) return rule.error || (label + '-length');
    if (typeof rule.max === 'number' && value.length > rule.max) return rule.error || (label + '-length');
    const item = rule.item;
    if (item && item.type === 'string') {
      for (let i = 0; i < value.length; i += 1) {
        const entry = value[i];
        if (typeof entry !== 'string' || entry.trim() === '') return rule.error || item.error || (label + '-type');
        if (typeof item.max === 'number' && entry.length > item.max) return rule.error || item.error || (label + '-length');
      }
    }
    return '';
  }
  if (rule.type === 'boolean') {
    if (value == null) return rule.required ? (rule.typeError || (label + '-type')) : '';
    if (typeof value !== 'boolean') return rule.typeError || (label + '-type');
    return '';
  }
  if (rule.type === 'number') {
    if (value == null) return rule.required ? (rule.typeError || (label + '-type')) : '';
    if (typeof value !== 'number' || !Number.isFinite(value)) return rule.typeError || (label + '-type');
    if (rule.integer === true && !Number.isInteger(value)) return rule.typeError || (label + '-type');
    if (typeof rule.min === 'number' && value < rule.min) return rule.rangeError || (label + '-range');
    if (typeof rule.max === 'number' && value > rule.max) return rule.rangeError || (label + '-range');
    return '';
  }
  if (Array.isArray(rule.enum)) {
    if (value == null && rule.required !== true) return '';
    if (typeof value !== 'string' || rule.enum.indexOf(value) === -1) return rule.error || (label + '-type');
    return '';
  }
  if (rule.nullAsEmpty === true && value == null) value = '';
  else if (value == null) return rule.required ? (rule.typeError || (label + '-type')) : '';
  if (rule.stringify === true) value = String(value);
  if (typeof value !== 'string') return rule.typeError || (label + '-type');
  if (typeof rule.max === 'number' && value.length > rule.max) return rule.lengthError || (label + '-length');
  if (rule.trimEmpty === true && value.trim().length < 1) return rule.emptyError || (label + '-empty');
  if (rule.falsyEmpty === true && !source[name]) return rule.emptyError || (label + '-empty');
  if (rule.emptyError && rule.falsyEmpty !== true && rule.trimEmpty !== true && value === '') return rule.emptyError;
  return '';
}

function validateParams(spec, params) {
  const source = asObject(params);
  const rules = spec || {};
  const names = Object.keys(rules);
  for (let i = 0; i < names.length; i += 1) {
    const problem = checkRule(names[i], rules[names[i]], source);
    if (problem) return problem;
  }
  return '';
}

function publicParams(spec) {
  const out = {};
  const rules = spec || {};
  const names = Object.keys(rules);
  for (let i = 0; i < names.length; i += 1) {
    const rule = rules[names[i]] || {};
    const item = {
      type: rule.type || 'string',
      required: rule.required === true
    };
    if (typeof rule.min === 'number') item.min = rule.min;
    if (typeof rule.max === 'number') item.max = rule.max;
    out[names[i]] = item;
  }
  return out;
}

const idRule = { type: 'string', required: true, max: 80 };
const destinationIdRule = {
  type: 'string',
  required: true,
  max: 80,
  label: 'destination',
  nullAsEmpty: true,
  emptyError: 'bad-id'
};

module.exports = {
  PROTOCOLS,
  destinationIdsRule,
  preflightIdsRule,
  IPC_PERMISSIONS,
  EXT_WRITE,
  INTERNAL_READS,
  CHAT_WRITE,
  PERMISSIONS,
  asObject,
  SECRET_FIELD,
  withoutSecrets,
  checkRule,
  validateParams,
  publicParams,
  idRule,
  destinationIdRule
};
