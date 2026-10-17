#!/usr/bin/env node
'use strict';
/**
 * 開発者用: 起動中の marust ウィンドウの中から API を 1 つ呼ぶ（ウィンドウ限定の API を試すため）。
 * 使い方: node cli/window-call.js <method> [<params-json>]
 * 前提: marust を `--remote-debugging-port=9333` 付きで起動している（127.0.0.1 のみ）。
 * 値（秘密）は扱わない。結果の JSON をそのまま出す。
 */
const http = require('http');
const path = require('path');
const { WebSocket } = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const PORT = Number(process.env.MARUST_DEBUG_PORT) || 9333;
const method = process.argv[2];
let params = {};
if (!method || !/^[a-zA-Z][\w.]*$/.test(method)) {
  console.error('usage: node cli/window-call.js <method> [<params-json>]');
  process.exit(2);
}
try { params = process.argv[3] ? JSON.parse(process.argv[3]) : {}; } catch (_) {
  console.error('params must be JSON');
  process.exit(2);
}

http.get({ host: '127.0.0.1', port: PORT, path: '/json' }, (res) => {
  let body = '';
  res.on('data', (d) => { body += d; });
  res.on('end', () => {
    const page = JSON.parse(body).find((t) => t.type === 'page');
    if (!page) { console.error('no marust page'); process.exit(1); }
    const cdp = new WebSocket(page.webSocketDebuggerUrl);
    const expression = '(async()=>new Promise(res=>{const ws=new WebSocket("ws://127.0.0.1:18770/ws");' +
      'ws.onopen=()=>ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:' + JSON.stringify(method) + ',params:' + JSON.stringify(params) + '}));' +
      'ws.onmessage=e=>{const j=JSON.parse(e.data);if(j.id!==1)return;res(j.result||j.error);ws.close()};setTimeout(()=>res({error:"timeout"}),30000)}))()';
    cdp.on('open', () => cdp.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expression, awaitPromise: true, returnByValue: true } })));
    cdp.on('message', (m) => {
      const j = JSON.parse(m);
      if (j.id !== 1) return;
      console.log(JSON.stringify(j.result && j.result.result ? j.result.result.value : j.error));
      process.exit(0);
    });
  });
}).on('error', () => { console.error('debug port not open (start marust with --remote-debugging-port=9333)'); process.exit(1); });
