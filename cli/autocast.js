#!/usr/bin/env node
'use strict';

/**
 * 自動枠取りの部品（plugins/sites の lib）を丸ストなしで使う単体コマンド（読むだけ。枠は作らない・終わらせない）。
 *   npm run autocast -- youtube status      （環境変数 YOUTUBE_ACCESS_TOKEN）
 *   npm run autocast -- niconico status     （環境変数 NICO_USER_SESSION）
 * 秘密は環境変数からだけ読み、画面には出さない。枠の作成は丸ストの画面の「テスト枠を作る」から。
 */

const { createYoutube } = require('../plugins/sites/youtube/lib/youtube');
const { createNiconico } = require('../plugins/sites/niconico/lib/niconico');

function usage() {
  console.log('usage: npm run autocast -- youtube|niconico status');
  console.log('  youtube: env YOUTUBE_ACCESS_TOKEN / niconico: env NICO_USER_SESSION');
  return 2;
}

async function main(argv) {
  const target = argv[0];
  const command = argv[1];
  if (command !== 'status' || (target !== 'youtube' && target !== 'niconico')) return usage();
  if (target === 'youtube') {
    const token = process.env.YOUTUBE_ACCESS_TOKEN || '';
    if (!token) { console.error('YOUTUBE_ACCESS_TOKEN is not set'); return 1; }
    const yt = createYoutube({ getAccessToken: async () => token });
    const out = await yt.listActive();
    if (!out.ok) { console.error('error: ' + out.code); return 1; }
    console.log('active broadcasts: ' + out.items.length);
    for (const item of out.items) console.log('- ' + item.id + ' ' + ((item.snippet && item.snippet.title) || ''));
    return 0;
  }
  const session = process.env.NICO_USER_SESSION || '';
  if (!session) { console.error('NICO_USER_SESSION is not set'); return 1; }
  const nico = createNiconico({ getAuth: async () => ({ session: session }) });
  const latest = await nico.getLatestProgram();
  if (!latest.ok) { console.error('error: ' + latest.code); return 1; }
  if (!latest.data) { console.log('no program'); return 0; }
  const status = await nico.checkStatus(latest.data.id);
  console.log('latest: ' + latest.data.id + ' ' + status.status);
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  console.error('error: ' + (err && err.code ? err.code : 'failed'));
  process.exitCode = 1;
});
