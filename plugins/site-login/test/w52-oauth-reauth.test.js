'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const { createOauthReauth, redirectInfo, TIMEOUT_MS } = require('../lib/oauth-reauth');
const { createApi } = require('../../../host/layer1/api');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok ' + name); }
  catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err.stack || err); }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
let lastBody = '';
function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { lastBody = text; resolve(res.statusCode); });
    });
    req.on('error', reject);
  });
}
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
function connect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host, port: port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}
async function waitForPort(host, port, tries) {
  for (let i = 0; i < (tries || 100); i += 1) {
    if (await connect(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
function fakeRes() {
  return {
    status: 0,
    body: '',
    ended: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body || ''; this.ended = true; }
  };
}
// 待ち受けだけを偽物にする。fail が host を見て Error を返すと、その host は開けなかったことになる。
function fakeHttp(fail) {
  const created = [];
  const impl = {
    createServer(handler) {
      const events = {};
      const server = {
        handler: handler,
        host: '',
        port: 0,
        listening: false,
        closed: false,
        once(event, fn) { (events[event] = events[event] || []).push(fn); return server; },
        listen(port, host) {
          server.port = port;
          server.host = host;
          setImmediate(() => {
            const err = fail ? fail(host, port) : null;
            if (err) {
              (events.error || []).slice().forEach((fn) => fn(err));
              return;
            }
            server.listening = true;
            (events.listening || []).slice().forEach((fn) => fn());
          });
        },
        close() { server.listening = false; server.closed = true; }
      };
      created.push(server);
      return server;
    }
  };
  return { impl: impl, servers: created, hosts: () => created.map((s) => s.host) };
}
// 3 分のタイマーは他のテストで確かめる。ここでは回さない（失敗時にプロセスを待たせないため）。
const noHoldTimer = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} };
// 拒否されるはずのものが止まったときは、待ったままで終わらせない。
async function rejectsCode(start, code, label) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' did not reject with ' + code + ' within 10s')), 10000);
  });
  try {
    await Promise.race([assert.rejects(() => start(), (err) => err.code === code, label), guard]);
  } finally { clearTimeout(timer); }
}
function tokenFetch(record) {
  return async (url, opts) => {
    if (record) record.push({ url: url, body: opts.body });
    return { status: 200, json: async () => ({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 }) };
  };
}

async function main() {
  await test('redirect URI must be loopback with explicit port', async () => {
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret', redirect_uri: 'https://evil.example/cb' }) }) };
    await assert.rejects(() => createOauthReauth({ secrets: vault }).reauth('twitch'), (err) => err.code === 'redirect-uri-unsupported');
  });

  await test('wrong state is rejected and success writes same vault name without exposing token', async () => {
    const port = await freePort();
    const original = { client_id: 'client-id', client_secret: 'client-secret', redirect_uri: 'http://127.0.0.1:' + port + '/oauth/callback', keep: 'same' };
    let savedName = '';
    let savedValue = '';
    let opened = '';
    const vault = {
      get: async () => ({ ok: true, value: JSON.stringify(original) }),
      set: async (name, value) => { savedName = name; savedValue = value; return { ok: true }; }
    };
    const auth = createOauthReauth({
      secrets: vault,
      openExternal: async (url) => {
        opened = url;
        const parsed = new URL(url);
        await request('http://127.0.0.1:' + port + '/oauth/callback?state=wrong&code=bad');
        await request(parsed.searchParams.get('redirect_uri') + '?state=' + encodeURIComponent(parsed.searchParams.get('state')) + '&code=good');
      },
      fetch: async () => ({ status: 200, json: async () => ({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 }) })
    });
    const result = await auth.reauth('twitch');
    assert.deepStrictEqual(result, { ok: true, site: 'twitch' });
    assert.ok(opened.includes('code_challenge='));
    assert.strictEqual(savedName, 'twitch.oauth');
    const saved = JSON.parse(savedValue);
    assert.strictEqual(saved.keep, 'same');
    assert.strictEqual(saved.access_token, 'new-access-token');
    assert.ok(!JSON.stringify(result).includes('new-access-token'));
  });

  for (const pair of [['invalid_client', 'invalid-client'], ['invalid_grant', 'invalid-grant'], ['redirect_uri_mismatch', 'redirect-mismatch'], ['whatever', 'unauthorized']]) {
    await test('token exchange refused with ' + pair[0] + ' -> ' + pair[1], async () => {
      const port = await freePort();
      const vault = {
        get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'client-id', client_secret: 'client-secret', redirect_uri: 'http://127.0.0.1:' + port + '/oauth/callback' }) }),
        set: async () => ({ ok: true })
      };
      const auth = createOauthReauth({
        secrets: vault,
        openExternal: async (url) => {
          const parsed = new URL(url);
          await request(parsed.searchParams.get('redirect_uri') + '?state=' + encodeURIComponent(parsed.searchParams.get('state')) + '&code=good');
        },
        fetch: async () => ({ status: 400, json: async () => ({ error: pair[0], error_description: 'x' }) })
      });
      await assert.rejects(() => auth.reauth('twitch'), (err) => err.code === pair[1]);
    });
  }

  await test('three minute timer always closes the listener', async () => {
    let timerFn;
    const timers = [];
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret', redirect_uri: 'http://127.0.0.1:1/cb' }) }) };
    const auth = createOauthReauth({ secrets: vault, setTimeout: (fn, ms) => { timerFn = fn; timers.push(ms); return { fn }; }, clearTimeout: () => {} });
    const pending = auth.reauth('kick');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(timers[0], TIMEOUT_MS);
    timerFn();
    await assert.rejects(() => pending, (err) => err.code === 'timeout');
  });

  await test('redirectInfo accepts only 127.0.0.1 and localhost with an explicit port', async () => {
    assert.deepStrictEqual(redirectInfo('http://localhost:3000').hosts, ['127.0.0.1', '::1']);
    assert.deepStrictEqual(redirectInfo('http://127.0.0.1:3000/cb').hosts, ['127.0.0.1']);
    assert.deepStrictEqual(redirectInfo('http://127.0.0.1:3000/cb').path, '/cb');
    assert.strictEqual(redirectInfo('http://localhost:3000').port, 3000);
    for (const bad of ['http://0.0.0.0:3000', 'http://192.168.0.2:3000', 'https://localhost:3000', 'http://example.com:3000', 'http://localhost', 'http://[::1]:3000', 'http://user:pw@localhost:3000']) {
      assert.strictEqual(redirectInfo(bad), null, bad);
    }
  });

  await test('localhost redirect URI listens on 127.0.0.1 and ::1', async () => {
    const port = await freePort();
    const saved = [];
    const vault = {
      get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'client-id', client_secret: 'client-secret', redirect_uri: 'http://localhost:' + port + '/oauth/callback' }) }),
      set: async (name, value) => { saved.push({ name: name, value: value }); return { ok: true }; }
    };
    let opened = '';
    const auth = createOauthReauth(Object.assign({ secrets: vault, openExternal: async (url) => { opened = url; }, fetch: tokenFetch() }, noHoldTimer));
    const pending = auth.reauth('twitch');
    pending.catch(() => {});
    for (let i = 0; i < 100 && !opened; i += 1) await tick();
    assert.ok(opened, 'browser should be opened');
    assert.strictEqual(new URL(opened).searchParams.get('redirect_uri'), 'http://localhost:' + port + '/oauth/callback');
    assert.ok(await waitForPort('127.0.0.1', port), '127.0.0.1 must be listening');
    assert.ok(await waitForPort('::1', port), '::1 must be listening');
    const state = new URL(opened).searchParams.get('state');
    const status = await request('http://127.0.0.1:' + port + '/oauth/callback?state=' + state + '&code=good');
    assert.strictEqual(status, 200);
    // N5: 交換の前に返す文言なので「完了」とは言わない。結果は丸ストの画面で確かめてもらう
    assert.ok(/丸ストに戻って結果を確かめて/.test(lastBody) && !/完了しました/.test(lastBody), lastBody);
    assert.deepStrictEqual(await pending, { ok: true, site: 'twitch' });
    assert.strictEqual(saved[0].name, 'twitch.oauth');
    assert.strictEqual(await connect('127.0.0.1', port), false, '127.0.0.1 must be closed');
    assert.strictEqual(await connect('::1', port), false, '::1 must be closed');
  });

  await test('callback arriving on ::1 also succeeds and closes both listeners', async () => {
    const port = await freePort();
    const vault = {
      get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'client-id', client_secret: 'client-secret', redirect_uri: 'http://localhost:' + port + '/oauth/callback' }) }),
      set: async () => ({ ok: true })
    };
    let opened = '';
    const auth = createOauthReauth(Object.assign({ secrets: vault, openExternal: async (url) => { opened = url; }, fetch: tokenFetch() }, noHoldTimer));
    const pending = auth.reauth('twitch');
    pending.catch(() => {});
    for (let i = 0; i < 100 && !opened; i += 1) await tick();
    assert.ok(await waitForPort('::1', port), '::1 must be listening');
    const state = new URL(opened).searchParams.get('state');
    const status = await request('http://[::1]:' + port + '/oauth/callback?state=' + state + '&code=good');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(await pending, { ok: true, site: 'twitch' });
    assert.strictEqual(await connect('127.0.0.1', port), false, '127.0.0.1 must be closed');
    assert.strictEqual(await connect('::1', port), false, '::1 must be closed');
  });

  await test('a listen failure on one host still finishes on the other alone', async () => {
    for (const broken of ['::1', '127.0.0.1']) {
      const fake = fakeHttp((host) => host === broken ? Object.assign(new Error('cannot bind'), { code: 'EADDRNOTAVAIL' }) : null);
      const saved = [];
      const vault = {
        get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'client-id', client_secret: 'client-secret', redirect_uri: 'http://localhost:3000/oauth/callback' }) }),
        set: async (name, value) => { saved.push({ name: name, value: value }); return { ok: true }; }
      };
      let opened = '';
      const auth = createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async (url) => { opened = url; }, fetch: tokenFetch() });
      const pending = auth.reauth('twitch');
      pending.catch(() => {});
      for (let i = 0; i < 100 && !opened; i += 1) await tick();
      assert.deepStrictEqual(fake.hosts(), ['127.0.0.1', '::1'], broken);
      const live = fake.servers.filter((server) => server.listening);
      assert.deepStrictEqual(live.map((server) => server.host), [broken === '::1' ? '127.0.0.1' : '::1'], broken);
      const state = new URL(opened).searchParams.get('state');
      live[0].handler({ url: '/oauth/callback?state=' + state + '&code=good' }, fakeRes());
      assert.deepStrictEqual(await pending, { ok: true, site: 'twitch' }, broken);
      assert.strictEqual(saved[0].name, 'twitch.oauth', broken);
      assert.ok(fake.servers.every((server) => server.closed), 'every listener closes: ' + broken);
    }
  });

  await test('the three minute timer closes both localhost listeners', async () => {
    const fake = fakeHttp();
    let timerFn;
    const timers = [];
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret', redirect_uri: 'http://localhost:3000' }) }) };
    const auth = createOauthReauth({
      secrets: vault,
      http: fake.impl,
      setTimeout: (fn, ms) => { timerFn = fn; timers.push(ms); return { fn: fn }; },
      clearTimeout: () => {}
    });
    const pending = auth.reauth('twitch');
    pending.catch(() => {});
    for (let i = 0; i < 100 && !timerFn; i += 1) await tick();
    assert.strictEqual(typeof timerFn, 'function', 'a three minute timer must be armed');
    assert.strictEqual(timers[0], TIMEOUT_MS);
    assert.deepStrictEqual(fake.hosts(), ['127.0.0.1', '::1']);
    timerFn();
    await rejectsCode(() => pending, 'timeout', 'three minute timeout');
    assert.ok(fake.servers.every((server) => server.closed), 'every listener closes');
  });

  await test('both listen failures report port-in-use', async () => {
    const fake = fakeHttp(() => Object.assign(new Error('in use'), { code: 'EADDRINUSE' }));
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret', redirect_uri: 'http://localhost:3000' }) }) };
    await rejectsCode(() => createOauthReauth({ secrets: vault, http: fake.impl }).reauth('twitch'), 'port-in-use', 'both hosts in use');
    assert.ok(fake.servers.every((server) => server.closed), 'every listener closes');
  });

  await test('twitch without redirect_uri uses http://localhost:3000', async () => {
    const fake = fakeHttp();
    const calls = [];
    const saved = [];
    const vault = {
      get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'client-id', client_secret: 'client-secret' }) }),
      set: async (name, value) => { saved.push({ name: name, value: value }); return { ok: true }; }
    };
    let opened = '';
    const auth = createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async (url) => { opened = url; }, fetch: tokenFetch(calls) });
    const pending = auth.reauth('twitch');
    pending.catch(() => {});
    for (let i = 0; i < 100 && !opened; i += 1) await tick();
    assert.ok(opened, 'browser should be opened');
    assert.strictEqual(new URL(opened).searchParams.get('redirect_uri'), 'http://localhost:3000');
    assert.deepStrictEqual(fake.hosts(), ['127.0.0.1', '::1']);
    assert.deepStrictEqual(fake.servers.map((server) => server.port), [3000, 3000]);
    const state = new URL(opened).searchParams.get('state');
    fake.servers[0].handler({ url: '/?state=' + state + '&code=good' }, fakeRes());
    assert.deepStrictEqual(await pending, { ok: true, site: 'twitch' });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].body.includes('redirect_uri=' + encodeURIComponent('http://localhost:3000')), calls[0].body);
    assert.strictEqual(JSON.parse(saved[0].value).redirect_uri, 'http://localhost:3000');
  });

  await test('youtube without redirect_uri uses the registered http://localhost:3000/oauth2callback', async () => {
    const fake = fakeHttp();
    const calls = [];
    const saved = [];
    const vault = {
      get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'client-id', client_secret: 'client-secret' }) }),
      set: async (name, value) => { saved.push({ name: name, value: value }); return { ok: true }; }
    };
    let opened = '';
    const auth = createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async (url) => { opened = url; }, fetch: tokenFetch(calls) });
    const pending = auth.reauth('youtube');
    pending.catch(() => {});
    for (let i = 0; i < 100 && !opened; i += 1) await tick();
    assert.ok(opened, 'browser should be opened');
    assert.strictEqual(new URL(opened).searchParams.get('redirect_uri'), 'http://localhost:3000/oauth2callback');
    assert.deepStrictEqual(fake.servers.map((server) => server.port), [3000, 3000]);
    const state = new URL(opened).searchParams.get('state');
    fake.servers[0].handler({ url: '/oauth2callback?state=' + state + '&code=good' }, fakeRes());
    assert.deepStrictEqual(await pending, { ok: true, site: 'youtube' });
    assert.strictEqual(saved[0].name, 'youtube.oauth');
    assert.strictEqual(JSON.parse(saved[0].value).redirect_uri, 'http://localhost:3000/oauth2callback');
  });

  await test('google calendar re-link asks only for calendar.events, offline, and saves to google.oauth', async () => {
    const fake = fakeHttp();
    const saved = [];
    const vault = {
      get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'client-id', client_secret: 'client-secret' }) }),
      set: async (name, value) => { saved.push({ name: name, value: value }); return { ok: true }; }
    };
    let opened = '';
    const auth = createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async (url) => { opened = url; }, fetch: tokenFetch([]) });
    const pending = auth.reauth('google');
    pending.catch(() => {});
    for (let i = 0; i < 100 && !opened; i += 1) await tick();
    const url = new URL(opened);
    assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.strictEqual(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events');
    assert.strictEqual(url.searchParams.get('access_type'), 'offline');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://localhost:3000/oauth2callback');
    fake.servers[0].handler({ url: '/oauth2callback?state=' + url.searchParams.get('state') + '&code=good' }, fakeRes());
    assert.deepStrictEqual(await pending, { ok: true, site: 'google' });
    assert.strictEqual(saved[0].name, 'google.oauth');
    assert.strictEqual(JSON.parse(saved[0].value).refresh_token, 'new-refresh-token');
  });

  await test('kick without redirect_uri uses the registered http://localhost:3000/oauth2callback', async () => {
    const fake = fakeHttp();
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret' }) }) };
    let opened = '';
    const auth = createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async (url) => { opened = url; }, ...noHoldTimer });
    auth.reauth('kick').catch(() => {});
    for (let i = 0; i < 100 && !opened; i += 1) await tick();
    assert.strictEqual(new URL(opened).searchParams.get('redirect_uri'), 'http://localhost:3000/oauth2callback');
  });

  await test('a port in use on one host fails instead of continuing on the other', async () => {
    const fake = fakeHttp((host) => host === '::1' ? Object.assign(new Error('in use'), { code: 'EADDRINUSE' }) : null);
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret' }) }) };
    await rejectsCode(() => createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async () => {}, ...noHoldTimer }).reauth('youtube'), 'port-in-use', 'one-host in use');
  });

  await test('a new reauth cancels the previous pending one and frees its port', async () => {
    const fake = fakeHttp();
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret' }) }) };
    let opened = 0;
    const auth = createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async () => { opened += 1; }, ...noHoldTimer });
    const first = auth.reauth('youtube');
    const firstOutcome = first.then(() => 'ok', (err) => err.code);
    for (let i = 0; i < 100 && !opened; i += 1) await tick();
    const second = auth.reauth('twitch');
    second.catch(() => {});
    assert.strictEqual(await firstOutcome, 'cancelled');
    assert.ok(fake.servers.slice(0, 2).every((server) => server.closed), 'first servers must be closed');
  });

  await test('a browser tab of a cancelled reauth gets a clear message, not a bare Not found', async () => {
    const fake = fakeHttp();
    const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret' }) }) };
    const urls = [];
    const auth = createOauthReauth({ secrets: vault, http: fake.impl, openExternal: async (url) => { urls.push(url); }, ...noHoldTimer });
    auth.reauth('twitch').catch(() => {});
    for (let i = 0; i < 100 && urls.length < 1; i += 1) await tick();
    const oldState = new URL(urls[0]).searchParams.get('state');
    auth.reauth('kick').catch(() => {});
    for (let i = 0; i < 100 && urls.length < 2; i += 1) await tick();
    const live = fake.servers.filter((server) => server.listening);
    assert.ok(live.length > 0, 'kick must be listening');
    // Twitch の同意画面で押したあと、ブラウザは http://localhost:3000/?code=… に戻り、Kick の待ち受けに当たる。
    const res = fakeRes();
    live[0].handler({ url: '/?state=' + oldState + '&code=late' }, res);
    assert.strictEqual(res.status, 409);
    assert.ok(/Twitch/.test(res.body) && /Kick/.test(res.body) && /もう一度/.test(res.body), res.body);
    const stray = fakeRes();
    live[0].handler({ url: '/other?state=unknown' }, stray);
    assert.strictEqual(stray.status, 404);
    assert.ok(/もう一度/.test(stray.body), stray.body);
  });

  await test('0.0.0.0, LAN address, https and other hostnames stay rejected', async () => {
    const bad = ['http://0.0.0.0:3000', 'http://192.168.0.2:3000', 'https://localhost:3000', 'http://example.com:3000'];
    for (const value of bad) {
      const vault = { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'id', client_secret: 'secret', redirect_uri: value }) }) };
      await rejectsCode(() => createOauthReauth({ secrets: vault, http: fakeHttp().impl }).reauth('twitch'), 'redirect-uri-unsupported', value);
    }
  });

  await test('auth.reauth is forbidden outside the Electron window', async () => {
    const api = createApi({ core: {}, secrets: {} });
    // auth.reauth はプラグイン site-login が出す（K3）。windowOnly の行
    api.registerPluginMethod('auth', 'auth.reauth', { access: 'write', windowOnly: true, params: { site: { type: 'string', required: true, max: 16 } } }, async () => ({ ok: true }), { audience: 'public' });
    const result = await api.call('auth.reauth', { site: 'youtube' }, { clientId: 'browser', permissions: ['write'], kind: 'browser' });
    assert.deepStrictEqual(result, { ok: false, error: 'forbidden' });
  });
}

main().then(() => {
  if (failed) {
    console.error(failed + ' failed');
    process.exit(1); // 失敗時は待ち受けが残っていても待たずに終わる。
  }
  process.exitCode = 0;
});
