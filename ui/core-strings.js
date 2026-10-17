'use strict';
window.CORE_STR = Object.freeze({
  agentOk: '丸スト: 動いています',
  agentLost: '丸スト: つながっていません',
  title: '丸スト',
  stateChecking: '状態を確認しています',
  stateLive: '配信中です',
  stateIdle: '本体は動いています',
  stateOffline: '本体につながっていません',
  loading: '画面を読み込んでいます',
  noShell: '画面を読み込めません。セットを入れ直して立ち上げ直してください。',
  stopAll: '全部止める',
  restart: '立ち上げ直す',
  stopSent: '全部止める操作を送りました',
  stopFailed: '停止の操作を送れませんでした',
  stopCheck: '停止結果を確認してください',
  restartFailed: '丸ストを終了して、もう一度開いてください',
  fellBack: 'セットの画面で開きました。',
  unknownReason: '画面を読み込めません'
});

window.CORE_REASONS = Object.freeze({
  'core-api-too-new': '本体より新しいつなぎ口が必要です',
  'bad-core-api': 'つなぎ口の版が正しくありません',
  'core-api-too-old': 'つなぎ口の版が古すぎます',
  'shell-file-missing': '画面のファイルが見つかりません',
  'bad-shell': '画面の設定が正しくありません',
  'bad-shell-path': '画面のファイル名が正しくありません',
  'shell-load-failed': '画面を読み込めませんでした',
  'unknown-shell': '選んだ画面が見つかりません',
  'empty-set': 'セットに画面がありません'
});
