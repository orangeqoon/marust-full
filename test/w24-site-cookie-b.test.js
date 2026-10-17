'use strict';
const { requirePlugin } = require('./_plugins');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const qs = require('querystring');

global.fetch = async function blockedFetch() {
  throw new Error('real fetch blocked');
};

const { createRegistry } = require('../host/layer1/plugin-registry');
const { createSiteKukulu } = requirePlugin('site-kukulu');
const { createSitePicarto } = requirePlugin('site-picarto');
const { createSiteRumble } = requirePlugin('site-rumble');
const { createSiteSoop } = requirePlugin('site-soop');

const ROOT = path.join(__dirname, '..');
const T0 = '2026-10-04T03:00:00.000Z';
const KEY = 'SENTINEL-KEY';
const TOKEN = 'SENTINEL-TOKEN';
const COOKIE = 'SENTINEL-COOKIE';
const HEADER = 'SENTINEL-HEADER';
const API = 'deadbeefcafebabe';

let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function response(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async text() { return text; }
  };
}

function boot(create, id, options) {
  const opts = options || {};
  const logs = [];
  const gets = [];
  let wrote = false;
  const secrets = opts.secrets || {};
  const ctx = {
    id: id,
    mode() { return opts.mode || 'live'; },
    logger(level, message) { logs.push(String(message)); },
    secrets: {
      async get(name) {
        gets.push(name);
        if (opts.blowOnGet) throw new Error('secret get');
        if (!Object.prototype.hasOwnProperty.call(secrets, name)) return { ok: false, error: 'unavailable' };
        const value = secrets[name];
        if (value == null) return { ok: false, error: 'unavailable' };
        return { ok: true, value: typeof value === 'string' ? value : JSON.stringify(value) };
      },
      async set() {
        wrote = true;
        throw new Error('wrote vault');
      }
    }
  };
  const calls = [];
  const fetchImpl = opts.fetch || async function failClosed() {
    throw new Error('unexpected fetch');
  };
  const api = create({
    fetch: async function fetch(url, init) {
      calls.push({ url: String(url), init: init || {} });
      return fetchImpl(url, init, calls);
    },
    now: function now() { return new Date(T0); }
  });
  api.load(ctx);
  return {
    api: api,
    ctx: ctx,
    logs: logs,
    gets: gets,
    calls: calls,
    wrote: function wroteVault() { return wrote; }
  };
}

function hosts(calls) {
  return calls.map((call) => new URL(call.url).hostname.toLowerCase());
}

function assertManual(calls) {
  for (let i = 0; i < calls.length; i += 1) {
    assert.strictEqual(calls[i].init.redirect, 'manual');
    assert.ok(calls[i].url.indexOf('evil.example') === -1);
  }
}

function header(call, name) {
  const headers = call && call.init && call.init.headers;
  return headers ? headers[name] : undefined;
}

function rumbleHtml(apiKey) {
  return '<script>Account("AccountContent", "' + apiKey + '")</script>'
    + '<div class="info-video" id="8_450050654_7drsdk_item"></div>';
}

function spanHtml() {
  return '<div class="info-video" id="8_450050654_7drsdk_item"></div><span id="ak_8_450050654">cafebabe99</span>';
}

const FORM = '<form><textarea name="description">keep &amp; desc</textarea><input name="tags" value="ink, test"></form>';

function rumbleFetch(html) {
  return async function fetch(url, init) {
    const host = new URL(url).hostname.toLowerCase();
    if (host !== 'rumble.com' && !host.endsWith('.rumble.com')) throw new Error('foreign');
    if (url.indexOf('/account/live-streaming') !== -1) return response(200, html || rumbleHtml(API));
    if (url.indexOf('a=edit') !== -1 && !(init && init.body)) return response(200, FORM);
    if (url.indexOf('a=edit') !== -1) return response(200, '{"success":true}');
    return response(404, '<html>nope</html>');
  };
}

function soopCapture(extra) {
  return Object.assign({
    url: 'https://api-broadcast.sooplive.com/broad/setting',
    method: 'POST',
    body: { notice: 'keep me', title: 'old', category_no: '5' },
    headers: { 'X-Leak': HEADER }
  }, extra || {});
}

async function main() {
  await test('レジストリが4つの v2 を accepted にする', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w24-reg-'));
    try {
      const registry = createRegistry({
        appRoot: ROOT,
        core: { STATE_DIR: dir },
        logger() {}
      });
      const rows = registry.discover();
      const expect = {
        'site-kukulu': ['kukulu.config'],
        'site-picarto': ['picarto.config'],
        'site-rumble': ['cookies.rumble-main', 'capture.rumble-main.rumble-save'],
        'site-soop': ['cookies.soop-main', 'capture.soop-main.soop-save']
      };
      const ids = Object.keys(expect);
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        const row = rows.find((item) => item.id === id);
        assert.ok(row, id);
        assert.strictEqual(row.status, 'accepted');
        assert.strictEqual(row.manifest.manifestVersion, 2);
        assert.strictEqual(row.manifest.runtime, 'inproc');
        assert.strictEqual(row.manifest.kind, 'integration');
        assert.strictEqual(row.manifest.defaultMode, 'legacy');
        assert.deepStrictEqual(row.manifest.provides, ['stream.site@1', 'ui.panel@1']);
        assert.deepStrictEqual(row.manifest.secrets, expect[id]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('ソースは NeonTimer と枠操作を参照しない', async () => {
    const files = [
      'plugins/sites/kukulu/site.js',
      'plugins/sites/picarto/site.js',
      'plugins/sites/rumble/site.js',
      'plugins/sites/soop/site.js'
    ];
    for (let i = 0; i < files.length; i += 1) {
      const text = fs.readFileSync(path.join(ROOT, files[i]), 'utf8');
      assert.ok(text.indexOf('NeonTimer') === -1, files[i]);
      assert.ok(text.indexOf('state/cookies') === -1, files[i]);
      assert.ok(text.indexOf('state/services') === -1, files[i]);
      assert.ok(text.indexOf('writeFile') === -1, files[i]);
      assert.ok(text.indexOf('child_process') === -1, files[i]);
    }
    const kukulu = fs.readFileSync(path.join(ROOT, 'plugins/sites/kukulu/site.js'), 'utf8');
    assert.ok(kukulu.indexOf('port_modify') !== -1);
    assert.ok(kukulu.indexOf('port_status') === -1);
    assert.ok(kukulu.indexOf('port_get') === -1);
    const rumble = fs.readFileSync(path.join(ROOT, 'plugins/sites/rumble/site.js'), 'utf8');
    assert.ok(rumble.indexOf('livestream-api') === -1);
    assert.ok(rumble.indexOf('rumble_auto_caster') === -1);
  });

  await test('ククルの更新要求は port_modify で、カテゴリは載せない', async () => {
    const title = 'Hello 世界';
    const env = boot(createSiteKukulu, 'site-kukulu', {
      secrets: { 'kukulu.config': { apikey: 'abc123' } },
      fetch: async function fetch(url) {
        assert.strictEqual(new URL(url).hostname, 'live.erinn.biz');
        return response(200, { success: 1 });
      }
    });
    const result = await env.api.updateMetadata({ title: title, category: 'UNIQUE-CAT' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(env.calls.length, 1);
    assertManual(env.calls);
    const expected = 'https://live.erinn.biz/api/?category=mylive&type=port_modify&apikey='
      + encodeURIComponent('abc123') + '&title=' + encodeURIComponent(title) + '&description=';
    assert.strictEqual(env.calls[0].url, expected);
    assert.strictEqual(env.calls[0].init.method, 'GET');
    assert.ok(env.calls[0].url.indexOf('UNIQUE-CAT') === -1);
    assert.deepStrictEqual(env.logs, ['updated']);
    assert.deepStrictEqual(env.api.getStatus(), { title: title });
    assert.deepStrictEqual(await env.api.actions.getStatus({}, env.ctx), {
      ok: true,
      configured: true,
      lastResult: 'ok',
      lastAt: T0,
      mode: 'live'
    });
    assert.strictEqual(env.wrote(), false);
  });

  await test('ククルの睡眠タイトルも題名更新のまま送る', async () => {
    const title = '寝る';
    const env = boot(createSiteKukulu, 'site-kukulu', {
      secrets: { 'kukulu.config': { apikey: 'abc123' } },
      fetch: async function fetch() { return response(200, { success: 1 }); }
    });
    const result = await env.api.updateMetadata({ title: title }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.ok(env.calls[0].url.indexOf('type=port_modify') !== -1);
    assert.ok(env.calls[0].url.indexOf('type=port_status') === -1);
    assert.ok(env.calls[0].url.indexOf(encodeURIComponent(title)) !== -1);
  });

  await test('ククルは秘密が無いと外に出ない', async () => {
    const env = boot(createSiteKukulu, 'site-kukulu', {
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await env.api.isConfigured(), false);
    const result = await env.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'not-configured' });
    assert.strictEqual(env.calls.length, 0);
    assert.deepStrictEqual(env.logs, ['failed not-configured']);
    const placeholder = boot(createSiteKukulu, 'site-kukulu', {
      secrets: { 'kukulu.config': { apikey: 'YOUR_KUKULU_APIKEY_HERE' } },
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await placeholder.api.isConfigured(), false);
    assert.deepStrictEqual(await placeholder.api.updateMetadata({ title: 'Hello' }, {}), {
      ok: false,
      error: 'not-configured'
    });
    assert.strictEqual(placeholder.calls.length, 0);
  });

  await test('ククルの dryRun と legacy と shadow は秘密も取らず外に出ない', async () => {
    const live = boot(createSiteKukulu, 'site-kukulu', {
      mode: 'live',
      blowOnGet: true,
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.deepStrictEqual(await live.api.updateMetadata({ title: 'Hello' }, { dryRun: true }), {
      ok: true,
      dryRun: true
    });
    assert.strictEqual(live.calls.length, 0);
    assert.strictEqual(live.gets.length, 0);
    const legacy = boot(createSiteKukulu, 'site-kukulu', {
      mode: 'legacy',
      blowOnGet: true,
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.deepStrictEqual(await legacy.api.updateMetadata({ title: 'Hello' }, {}), { ok: true });
    assert.strictEqual(legacy.calls.length, 0);
    const shadow = boot(createSiteKukulu, 'site-kukulu', {
      mode: 'shadow',
      blowOnGet: true,
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.deepStrictEqual(await shadow.api.updateMetadata({ title: 'Hello' }, {}), {
      ok: true,
      dryRun: true
    });
    assert.strictEqual(shadow.calls.length, 0);
  });

  await test('ククルはリダイレクトを追わず、応答の秘密をログとパネルに出さない', async () => {
    const redirect = boot(createSiteKukulu, 'site-kukulu', {
      secrets: { 'kukulu.config': { apikey: KEY } },
      fetch: async function fetch() { return response(302, ''); }
    });
    const redirected = await redirect.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(redirected, { ok: false, error: 'redirect' });
    assert.strictEqual(redirect.calls.length, 1);
    assertManual(redirect.calls);
    assert.ok(redirect.logs.join('\n').indexOf(KEY) === -1);
    const leak = boot(createSiteKukulu, 'site-kukulu', {
      secrets: { 'kukulu.config': { apikey: KEY } },
      fetch: async function fetch() {
        return response(200, { success: 0, error_display: 'bad ' + KEY });
      }
    });
    const result = await leak.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'bad-response' });
    assert.ok(JSON.stringify(result).indexOf(KEY) === -1);
    assert.ok(leak.logs.join('\n').indexOf(KEY) === -1);
    const panel = await leak.api.actions.getStatus({}, leak.ctx);
    assert.ok(JSON.stringify(panel).indexOf(KEY) === -1);
    assert.strictEqual(panel.configured, true);
    assert.strictEqual(panel.lastResult, 'ng');
  });

  await test('Picarto の更新要求は Bearer と form の title だけ', async () => {
    const title = 'Hello 世界';
    const body = new URLSearchParams({ title: title }).toString();
    const env = boot(createSitePicarto, 'site-picarto', {
      secrets: { 'picarto.config': { token: TOKEN } },
      fetch: async function fetch(url) {
        assert.strictEqual(new URL(url).hostname, 'api.picarto.tv');
        return response(200, 'ok');
      }
    });
    const result = await env.api.updateMetadata({ title: title, category: 'UNIQUE-CAT' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(env.calls.length, 1);
    assertManual(env.calls);
    assert.strictEqual(env.calls[0].url, 'https://api.picarto.tv/api/v1/user/title');
    assert.strictEqual(env.calls[0].init.method, 'POST');
    assert.strictEqual(env.calls[0].init.body, body);
    assert.ok(env.calls[0].init.body.indexOf('UNIQUE-CAT') === -1);
    assert.strictEqual(header(env.calls[0], 'Authorization'), 'Bearer ' + TOKEN);
    assert.strictEqual(header(env.calls[0], 'Content-Type'), 'application/x-www-form-urlencoded');
    assert.strictEqual(header(env.calls[0], 'Content-Length'), String(Buffer.byteLength(body)));
    assert.strictEqual(header(env.calls[0], 'User-Agent'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    assert.deepStrictEqual(env.logs, ['updated']);
    assert.ok(env.logs.join('\n').indexOf(TOKEN) === -1);
    const panel = await env.api.actions.getStatus({}, env.ctx);
    assert.deepStrictEqual(panel, {
      ok: true,
      configured: true,
      lastResult: 'ok',
      lastAt: T0,
      mode: 'live'
    });
    assert.ok(JSON.stringify(panel).indexOf(TOKEN) === -1);
    assert.deepStrictEqual(env.api.getStatus(), { title: title });
  });

  await test('Picarto は秘密が無いと外に出ず、プレースホルダも未設定', async () => {
    const missing = boot(createSitePicarto, 'site-picarto', {
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await missing.api.isConfigured(), false);
    assert.deepStrictEqual(await missing.api.updateMetadata({ title: 'Hello' }, {}), {
      ok: false,
      error: 'not-configured'
    });
    assert.strictEqual(missing.calls.length, 0);
    const placeholder = boot(createSitePicarto, 'site-picarto', {
      secrets: { 'picarto.config': { token: 'ここにトークン' } },
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await placeholder.api.isConfigured(), false);
    assert.strictEqual(placeholder.calls.length, 0);
  });

  await test('Picarto の dryRun は外に出ず、リダイレクトとエラー本文も返さない', async () => {
    const dry = boot(createSitePicarto, 'site-picarto', {
      blowOnGet: true,
      secrets: { 'picarto.config': { token: TOKEN } },
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.deepStrictEqual(await dry.api.updateMetadata({ title: 'Hello' }, { dryRun: true }), {
      ok: true,
      dryRun: true
    });
    assert.strictEqual(dry.calls.length, 0);
    assert.strictEqual(dry.gets.length, 0);
    const redirect = boot(createSitePicarto, 'site-picarto', {
      secrets: { 'picarto.config': { token: TOKEN } },
      fetch: async function fetch() { return response(302, 'go https://evil.example/' + TOKEN); }
    });
    const redirected = await redirect.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(redirected, { ok: false, error: 'redirect' });
    assert.strictEqual(redirect.calls.length, 1);
    assert.ok(JSON.stringify(redirected).indexOf(TOKEN) === -1);
    assert.ok(redirect.logs.join('\n').indexOf(TOKEN) === -1);
    const http = boot(createSitePicarto, 'site-picarto', {
      secrets: { 'picarto.config': { token: TOKEN } },
      fetch: async function fetch() { return response(500, TOKEN); }
    });
    const failedHttp = await http.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(failedHttp, { ok: false, error: 'http' });
    assert.ok(JSON.stringify(failedHttp).indexOf(TOKEN) === -1);
    assert.ok(http.logs.join('\n').indexOf(TOKEN) === -1);
  });

  await test('Rumble の更新要求は編集フォームの題名差し替え', async () => {
    const title = 'Hello 世界';
    const env = boot(createSiteRumble, 'site-rumble', {
      secrets: {
        'cookies.rumble-main': { u_s: COOKIE },
        'capture.rumble-main.rumble-save': {
          url: 'https://evil.example/account/content?a=edit&sid=1&id=2&apiKey=abc',
          headers: { 'X-Leak': HEADER }
        }
      },
      fetch: rumbleFetch(rumbleHtml(API))
    });
    const result = await env.api.updateMetadata({ title: title, category: 'UNIQUE-CAT' }, {});
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(hosts(env.calls), ['rumble.com', 'rumble.com', 'rumble.com']);
    assertManual(env.calls);
    const edit = 'https://rumble.com/account/content?a=edit&sid=8&id=450050654&apiKey=' + API;
    assert.strictEqual(env.calls[0].url, 'https://rumble.com/account/live-streaming');
    assert.strictEqual(env.calls[0].init.method, 'GET');
    assert.strictEqual(header(env.calls[0], 'Cookie'), 'u_s=' + COOKIE);
    assert.strictEqual(env.calls[1].url, edit);
    assert.strictEqual(env.calls[1].init.method, 'POST');
    assert.strictEqual(env.calls[1].init.body, '');
    assert.strictEqual(env.calls[2].url, edit);
    const params = new URLSearchParams(env.calls[2].init.body);
    assert.strictEqual(params.get('title'), title);
    assert.strictEqual(params.get('description'), 'keep &amp; desc');
    assert.strictEqual(params.get('tags'), 'ink, test');
    assert.strictEqual(params.get('visibility'), 'public');
    assert.strictEqual(params.get('siteChannelId'), '13');
    assert.strictEqual(params.get('mediaChannelId'), '0');
    assert.strictEqual(params.get('channelId'), '');
    assert.strictEqual(params.get('closed_captions'), '{"uploads": [], "removals": []}');
    assert.strictEqual(params.get('priceCents'), '');
    assert.strictEqual(params.get('license'), '');
    assert.ok(env.calls[2].init.body.indexOf('UNIQUE-CAT') === -1);
    assert.strictEqual(header(env.calls[2], 'Origin'), 'https://rumble.com');
    assert.strictEqual(header(env.calls[2], 'Content-Type'), 'application/x-www-form-urlencoded; charset=UTF-8');
    assert.strictEqual(header(env.calls[2], 'X-Leak'), undefined);
    assert.deepStrictEqual(env.logs, ['updated']);
    assert.ok(env.logs.join('\n').indexOf(COOKIE) === -1);
    assert.ok(env.logs.join('\n').indexOf(API) === -1);
    assert.ok(env.logs.join('\n').indexOf(HEADER) === -1);
    const panel = await env.api.actions.getStatus({}, env.ctx);
    assert.deepStrictEqual(panel, {
      ok: true,
      configured: true,
      lastResult: 'ok',
      lastAt: T0,
      mode: 'live'
    });
    assert.deepStrictEqual(env.api.getStatus(), { title: title });
    assert.ok(JSON.stringify(env.api.getStatus()).indexOf(API) === -1);
    assert.strictEqual(env.wrote(), false);
  });

  await test('Rumble は span の apiKey と、次の呼び出しのメモリを使う', async () => {
    let round = 0;
    const env = boot(createSiteRumble, 'site-rumble', {
      secrets: { 'cookies.rumble-main': { cookieString: 'a=' + COOKIE } },
      fetch: async function fetch(url, init) {
        round += 1;
        if (url.indexOf('/account/live-streaming') !== -1 || url.indexOf('type=all') !== -1) {
          return response(200, round <= 2 ? spanHtml() : '<html></html>');
        }
        if (!(init && init.body)) return response(200, '<form></form>');
        return response(200, 'saved');
      }
    });
    const first = await env.api.updateMetadata({ title: 'one' }, {});
    assert.deepStrictEqual(first, { ok: true });
    assert.ok(env.calls.some((call) => call.url.indexOf('apiKey=cafebabe99') !== -1));
    const before = env.calls.length;
    const second = await env.api.updateMetadata({ title: 'two' }, {});
    assert.deepStrictEqual(second, { ok: true });
    const later = env.calls.slice(before);
    assert.ok(later.some((call) => call.url.indexOf('apiKey=cafebabe99') !== -1));
    assert.ok(later.every((call) => new URL(call.url).hostname === 'rumble.com'));
    assert.strictEqual(env.wrote(), false);
    assert.ok(env.logs.join('\n').indexOf('cafebabe99') === -1);
    assert.ok(env.logs.join('\n').indexOf(COOKIE) === -1);
  });

  await test('Rumble は Cookie が無いと外に出ない', async () => {
    const env = boot(createSiteRumble, 'site-rumble', {
      secrets: {
        'capture.rumble-main.rumble-save': {
          url: 'https://rumble.com/account/content?a=edit&sid=8&id=1&apiKey=abc'
        }
      },
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await env.api.isConfigured(), false);
    assert.deepStrictEqual(await env.api.updateMetadata({ title: 'Hello' }, {}), {
      ok: false,
      error: 'not-configured'
    });
    assert.strictEqual(env.calls.length, 0);
  });

  await test('Rumble の dryRun は外に出ず、リダイレクト先も開かない', async () => {
    const dry = boot(createSiteRumble, 'site-rumble', {
      blowOnGet: true,
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.deepStrictEqual(await dry.api.updateMetadata({ title: 'Hello' }, { dryRun: true }), {
      ok: true,
      dryRun: true
    });
    assert.strictEqual(dry.calls.length, 0);
    assert.strictEqual(dry.gets.length, 0);
    const redirect = boot(createSiteRumble, 'site-rumble', {
      secrets: { 'cookies.rumble-main': { u_s: COOKIE } },
      fetch: async function fetch(url) {
        if (url.indexOf('evil.example') !== -1) throw new Error('followed');
        return response(302, '');
      }
    });
    const redirected = await redirect.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(redirected, { ok: false, error: 'redirect' });
    assert.ok(redirect.calls.length >= 1);
    assertManual(redirect.calls);
    assert.ok(hosts(redirect.calls).every((host) => host === 'rumble.com'));
    const form = boot(createSiteRumble, 'site-rumble', {
      secrets: { 'cookies.rumble-main': { u_s: COOKIE } },
      fetch: async function fetch(url, init) {
        if (url.indexOf('/account/live-streaming') !== -1) return response(200, rumbleHtml(API));
        if (!(init && init.body)) return response(302, '');
        throw new Error('saved after redirect');
      }
    });
    assert.deepStrictEqual(await form.api.updateMetadata({ title: 'Hello' }, {}), {
      ok: false,
      error: 'redirect'
    });
    assert.ok(form.logs.join('\n').indexOf(COOKIE) === -1);
    assert.ok(form.logs.join('\n').indexOf(API) === -1);
  });

  await test('Rumble は検出も capture も無いと no-target', async () => {
    const env = boot(createSiteRumble, 'site-rumble', {
      secrets: { 'cookies.rumble-main': { cookies: { u_s: COOKIE } } },
      fetch: async function fetch(url) {
        assert.strictEqual(new URL(url).hostname, 'rumble.com');
        return response(200, '<html></html>');
      }
    });
    const result = await env.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(result, { ok: false, error: 'no-target' });
    assert.deepStrictEqual(hosts(env.calls), ['rumble.com', 'rumble.com']);
    assert.ok(env.logs.join('\n').indexOf(COOKIE) === -1);
  });

  await test('SOOP は capture の本文に題名だけ載せ、数字のカテゴリだけ category_no にする', async () => {
    const title = 'Hello 世界';
    const env = boot(createSiteSoop, 'site-soop', {
      secrets: {
        'cookies.soop-main': { u_s: COOKIE },
        'capture.soop-main.soop-save': soopCapture()
      },
      fetch: async function fetch(url) {
        assert.strictEqual(url, 'https://api-broadcast.sooplive.com/broad/setting');
        return response(200, { result: 1 });
      }
    });
    const named = await env.api.updateMetadata({ title: title, category: 'Just Chatting' }, {});
    assert.deepStrictEqual(named, { ok: true });
    assert.strictEqual(env.calls.length, 1);
    assertManual(env.calls);
    assert.strictEqual(env.calls[0].init.method, 'POST');
    let parsed = qs.parse(env.calls[0].init.body);
    assert.strictEqual(parsed.title, title);
    assert.strictEqual(parsed.notice, 'keep me');
    assert.strictEqual(parsed.category_no, '5');
    assert.strictEqual(header(env.calls[0], 'Cookie'), 'u_s=' + COOKIE);
    assert.strictEqual(header(env.calls[0], 'Content-Type'), 'application/x-www-form-urlencoded; charset=UTF-8');
    assert.strictEqual(header(env.calls[0], 'Origin'), 'https://dashboard.sooplive.com');
    assert.strictEqual(header(env.calls[0], 'X-Leak'), undefined);
    assert.deepStrictEqual(env.logs, ['updated']);
    assert.ok(env.logs.join('\n').indexOf(COOKIE) === -1);
    assert.ok(env.logs.join('\n').indexOf(HEADER) === -1);
    assert.deepStrictEqual(env.api.getStatus(), { title: title });
    const numbered = boot(createSiteSoop, 'site-soop', {
      secrets: {
        'cookies.soop-main': { cookieString: 'a=' + COOKIE },
        'capture.soop-main.soop-save': soopCapture({ url: 'https://api-broadcast.sooplive.co.kr/broad/setting' })
      },
      fetch: async function fetch(url) {
        assert.strictEqual(new URL(url).hostname, 'api-broadcast.sooplive.co.kr');
        return response(200, 'plain');
      }
    });
    const result = await numbered.api.updateMetadata({ title: title, category: '42' }, {});
    assert.deepStrictEqual(result, { ok: true });
    parsed = qs.parse(numbered.calls[0].init.body);
    assert.strictEqual(parsed.category_no, '42');
    assert.strictEqual(parsed.notice, 'keep me');
    assert.deepStrictEqual(numbered.api.getStatus(), { title: title, category: '42' });
    const panel = await numbered.api.actions.getStatus({}, numbered.ctx);
    assert.ok(JSON.stringify(panel).indexOf(COOKIE) === -1);
    assert.strictEqual(panel.lastResult, 'ok');
    assert.strictEqual(numbered.wrote(), false);
  });

  await test('SOOP は Cookie か capture が無いと外に出ない', async () => {
    const cookiesOnly = boot(createSiteSoop, 'site-soop', {
      secrets: { 'cookies.soop-main': { u_s: COOKIE } },
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await cookiesOnly.api.isConfigured(), false);
    assert.deepStrictEqual(await cookiesOnly.api.updateMetadata({ title: 'Hello' }, {}), {
      ok: false,
      error: 'not-configured'
    });
    assert.strictEqual(cookiesOnly.calls.length, 0);
    const captureOnly = boot(createSiteSoop, 'site-soop', {
      secrets: { 'capture.soop-main.soop-save': soopCapture() },
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await captureOnly.api.isConfigured(), false);
    assert.strictEqual(captureOnly.calls.length, 0);
    const disabled = boot(createSiteSoop, 'site-soop', {
      secrets: {
        'cookies.soop-main': { u_s: COOKIE },
        'capture.soop-main.soop-save': soopCapture({ enabled: false })
      },
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.strictEqual(await disabled.api.isConfigured(), false);
    assert.strictEqual(disabled.calls.length, 0);
  });

  await test('SOOP の dryRun は外に出ず、他ドメインとリダイレクトも開かない', async () => {
    const dry = boot(createSiteSoop, 'site-soop', {
      blowOnGet: true,
      fetch: async function fetch() { throw new Error('fetched'); }
    });
    assert.deepStrictEqual(await dry.api.updateMetadata({ title: 'Hello' }, { dryRun: true }), {
      ok: true,
      dryRun: true
    });
    assert.strictEqual(dry.calls.length, 0);
    assert.strictEqual(dry.gets.length, 0);
    const badUrls = [
      'https://evil.example/broad/setting',
      'https://api-broadcast.sooplive.com.evil.example/broad/setting',
      'https://user:pass@api-broadcast.sooplive.com/broad/setting',
      'http://api-broadcast.sooplive.com/broad/setting',
      'https://soop.io/broad/setting'
    ];
    for (let i = 0; i < badUrls.length; i += 1) {
      const env = boot(createSiteSoop, 'site-soop', {
        secrets: {
          'cookies.soop-main': { u_s: COOKIE },
          'capture.soop-main.soop-save': soopCapture({ url: badUrls[i] })
        },
        fetch: async function fetch() { throw new Error('fetched ' + badUrls[i]); }
      });
      const result = await env.api.updateMetadata({ title: 'Hello' }, {});
      assert.deepStrictEqual(result, { ok: false, error: 'network' });
      assert.strictEqual(env.calls.length, 0, badUrls[i]);
    }
    const redirect = boot(createSiteSoop, 'site-soop', {
      secrets: {
        'cookies.soop-main': { u_s: COOKIE },
        'capture.soop-main.soop-save': soopCapture()
      },
      fetch: async function fetch() { return response(302, 'https://evil.example/' + COOKIE); }
    });
    const redirected = await redirect.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(redirected, { ok: false, error: 'redirect' });
    assert.strictEqual(redirect.calls.length, 1);
    assertManual(redirect.calls);
    assert.ok(JSON.stringify(redirected).indexOf(COOKIE) === -1);
    assert.ok(redirect.logs.join('\n').indexOf(COOKIE) === -1);
    const rejected = boot(createSiteSoop, 'site-soop', {
      secrets: {
        'cookies.soop-main': { u_s: COOKIE },
        'capture.soop-main.soop-save': soopCapture()
      },
      fetch: async function fetch() { return response(200, { result: 0, msg: COOKIE }); }
    });
    const bad = await rejected.api.updateMetadata({ title: 'Hello' }, {});
    assert.deepStrictEqual(bad, { ok: false, error: 'bad-response' });
    assert.ok(JSON.stringify(bad).indexOf(COOKIE) === -1);
    const panel = await rejected.api.actions.getStatus({}, rejected.ctx);
    assert.ok(JSON.stringify(panel).indexOf(COOKIE) === -1);
    assert.ok(JSON.stringify(panel).indexOf(HEADER) === -1);
  });

  await test('空の題名はどのサイトも送らない', async () => {
    const sites = [
      [createSiteKukulu, 'site-kukulu', { 'kukulu.config': { apikey: 'abc123' } }],
      [createSitePicarto, 'site-picarto', { 'picarto.config': { token: 'abc123' } }],
      [createSiteRumble, 'site-rumble', { 'cookies.rumble-main': { u_s: 'abc' } }],
      [createSiteSoop, 'site-soop', {
        'cookies.soop-main': { u_s: 'abc' },
        'capture.soop-main.soop-save': soopCapture()
      }]
    ];
    for (let i = 0; i < sites.length; i += 1) {
      const env = boot(sites[i][0], sites[i][1], {
        secrets: sites[i][2],
        fetch: async function fetch() { throw new Error('fetched'); }
      });
      assert.deepStrictEqual(await env.api.updateMetadata({ title: '', category: '42' }, {}), {
        ok: false,
        error: 'needs-title'
      });
      assert.strictEqual(env.calls.length, 0);
    }
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
