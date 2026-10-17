'use strict';

/**
 * 全部止めるボタンの色と文字。配信先の状態と接続だけを見る。
 * live / connecting / reconnecting が 1 つでもあれば青（送信中 n 件）。0 件でも青（全部止める）。未接続は灰。
 */

const ACTIVE = new Set(['live', 'connecting', 'reconnecting']);

function emergencyButtonState(targets, connected) {
  if (!connected) {
    return { color: 'gray', label: 'OBS 未接続', hold: false, count: 0 };
  }
  const list = Array.isArray(targets) ? targets : [];
  let count = 0;
  for (const row of list) {
    const state = row && row.state != null ? String(row.state) : '';
    if (ACTIVE.has(state)) count += 1;
  }
  if (count > 0) {
    return {
      color: 'blue',
      label: '全部止める（送信中 ' + count + ' 件）',
      hold: false,
      count: count
    };
  }
  return { color: 'blue', label: '全部止める', hold: false, count: 0 };
}

module.exports = { emergencyButtonState, ACTIVE };
