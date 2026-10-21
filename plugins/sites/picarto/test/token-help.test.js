'use strict';

// Picarto のパネルに、トークンの取り方（アプリの登録→許可→トークンを読む→貼る）が入っていること
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'panel.html'), 'utf8');
const help = html.slice(html.indexOf('id="token-help"'), html.indexOf('</details>'));

assert.ok(help.length > 0, '手順の欄がある');
assert.ok(help.includes('https://oauth.picarto.tv/client'), 'アプリの登録先');
assert.ok(help.includes('https://api.picarto.tv/api/oauth2-callback'), '戻り先（Picarto の API 説明書の oauth2RedirectUrl）');
assert.ok(help.includes('readpriv') && help.includes('write'), '使う権限');
assert.ok(/sudo には印をつけない/.test(help), 'sudo を許さない注意');
assert.ok(help.includes('Authorization: Bearer'), 'トークンの読み方');
assert.ok(!/value="[0-9a-f]{8}-[0-9a-f]{4}-/.test(html), 'Client ID などの実の値を書かない');
console.log('picarto token-help: ok');
