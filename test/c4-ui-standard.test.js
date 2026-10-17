'use strict';

/**
 * 段 C4: 画面は ui-standard の shell。核の画面は strings.js に頼らない。
 * ガイドは窓口の /plugins/<id>/shell/ と /plugin/<id>/shell/ の両方で配る。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createGateway } = require('../host/layer1/gateway');
const { siteIdsFromRows } = require('../host/layer1/ext-receiver');

const ROOT = path.join(__dirname, '..');
const STR = require(path.join(ROOT, 'plugins', 'ui-standard', 'shell', 'strings'));

const KEEP = [
  'a11y.js',
  'api-client.js',
  'core-strings.js',
  'fallback.css',
  'fallback.js',
  'hub.html',
  'offline.css',
  'offline.html',
  'pair.css',
  'pair.html',
  'pair.js',
  'plugin-host.css',
  'plugin-host.js',
  'popout.html',
  'preload.js',
  'core/theme.js',
  'THIRD_PARTY.md'
];
const CORE_SCREENS = [
  'ui/hub.html',
  'ui/fallback.js',
  'ui/pair.html',
  'ui/pair.js',
  'ui/pair.css',
  'ui/offline.html',
  'ui/offline.css',
  'ui/popout.html'
];

let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(function () { console.log('ok ' + name); }, function (err) {
        failed += 1;
        console.error('FAIL ' + name);
        console.error(err && err.stack ? err.stack : err);
      });
    }
    console.log('ok ' + name);
    return Promise.resolve();
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
    return Promise.resolve();
  }
}

function listUi(dir, prefix, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) listUi(path.join(dir, entry.name), rel, out);
    else out.push(rel.replace(/\\/g, '/'));
  });
  return out;
}

function walkJs(dir, out) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (/\.(js|html|css)$/.test(entry.name)) out.push(full);
  });
  return out;
}

function guidePaths() {
  return Object.keys(STR).filter(function (key) { return /GuidePath$/.test(key); }).map(function (key) { return STR[key]; });
}

function linkedAssets(html, pagePath) {
  const out = [];
  const re = /<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"/gi;
  let match;
  while ((match = re.exec(html))) {
    const ref = match[1];
    if (/^(https?:|data:|#)/.test(ref)) continue;
    if (ref.charAt(0) === '/') out.push(ref);
    else out.push(pagePath.slice(0, pagePath.lastIndexOf('/') + 1) + ref);
  }
  return out;
}

(async function main() {
  await test('ui/ は核の画面だけ（THIRD_PARTY.md は同梱ライセンス）', function () {
    const found = listUi(path.join(ROOT, 'ui'), '', []).sort();
    assert.deepStrictEqual(found, KEEP.slice().sort());
  });

  await test('ui-standard は basic / public', function () {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'ui-standard', 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.tier, 'basic');
    assert.strictEqual(manifest.audience, 'public');
    assert.strictEqual(manifest.kind, 'shell');
  });

  await test('ひな形は核にあり、CLI は核から読む', function () {
    const scaffold = require(path.join(ROOT, 'host', 'layer1', 'plugin-scaffold'));
    const files = scaffold.templateFiles('sample-plug');
    assert.ok(files['manifest.json'] && files['index.js'] && files['ui/panel.html'] && files['ui/panel.js']);
    const src = fs.readFileSync(path.join(ROOT, 'host', 'layer1', 'api', 'ns', 'plugin.js'), 'utf8');
    assert.ok(src.includes("require('../../plugin-scaffold')"));
    assert.ok(!/require\s*\(\s*['"`][^'"`]*cli[\\/]/.test(src));
    const cli = fs.readFileSync(path.join(ROOT, 'cli', 'new-plugin.js'), 'utf8');
    assert.ok(cli.includes("require('../host/layer1/plugin-scaffold')"));
    const tpl = require(path.join(ROOT, 'cli', 'new-plugin'));
    assert.strictEqual(tpl.templateFiles, scaffold.templateFiles);
  });

  await test('host の js は cli を require しない', function () {
    const hits = [];
    walkJs(path.join(ROOT, 'host'), []).forEach(function (file) {
      if (!file.endsWith('.js')) return;
      const text = fs.readFileSync(file, 'utf8');
      if (/require\s*\(\s*['"`][^'"`]*cli[\\/]/.test(text)) hits.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    });
    assert.deepStrictEqual(hits, []);
  });

  await test('核は ui-standard のファイルを直に読まない', function () {
    const files = walkJs(path.join(ROOT, 'host'), []).concat(walkJs(path.join(ROOT, 'ui'), []), path.join(ROOT, 'electron-main.js'));
    const hits = [];
    files.forEach(function (file) {
      const text = fs.readFileSync(file, 'utf8');
      // A3: この 2 行の案内コメントだけを除外する。未知の参照や実行コードは従来どおり検出する。
      const documentedComments = {
        'host/core/owners.js': " * - parentActions: ['ai.pair']（親の窓だけが実行する操作。plugins/ui-standard/shell/core/parent-actions.js）",
        'host/layer1/plugin-surface.js': '// 実行（確認の窓・権限の判断）は親の画面（plugins/ui-standard/shell/core/parent-actions.js）。iframe は名前と値を渡すだけ。'
      };
      const note = documentedComments[path.relative(ROOT, file).replace(/\\/g, '/')];
      const withoutNote = (source) => source.split(/\r?\n/).filter((line) => line !== note).join('\n');
      if (note) {
        assert.ok(text.split(/\r?\n/).includes(note), '案内コメントの変更は再確認する');
        assert.ok(withoutNote(text + '\nrequire("plugins/ui-standard/shell/hub.js");').includes('ui-standard'), '実依存を隠さない');
      }
      if (withoutNote(text).includes('ui-standard')) hits.push(path.relative(ROOT, file));
    });
    assert.deepStrictEqual(hits, []);
  });

  await test('核の画面は strings.js を読まず STR に頼らない', function () {
    CORE_SCREENS.forEach(function (rel) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!/(?<!core-)strings\.js/.test(text), rel);
      assert.ok(!/(^|[^\w$])STR\b/.test(text), rel + ' STR');
    });
  });

  await test('拡張のサイト名は manifest.site.id から作る', function () {
    const ext = fs.readFileSync(path.join(ROOT, 'host', 'layer1', 'ext-receiver.js'), 'utf8');
    assert.ok(ext.includes('function siteIdsFromRows'));
    assert.ok(!ext.includes('SITE_LIST'));
    ['youtube', 'twitch', 'niconico', 'twitcasting', 'fc2', 'kick'].forEach(function (name) {
      assert.ok(!new RegExp('([\'"`/:])' + name + '([\'"`/:])').test(ext), name);
    });
    const rows = [
      { manifest: { site: { id: 'youtube' } } },
      { manifest: { site: { id: 'youtube' } } },
      { manifest: { site: { id: 'not a site' } } },
      { manifest: {} }
    ];
    assert.deepStrictEqual(siteIdsFromRows(rows), ['youtube']);
  });

  await test('ガイドのパスと、ページが読む css・js が 200 で返る', async function () {
    const dir = path.join(ROOT, 'plugins', 'ui-standard');
    const gateway = createGateway({
      receiver: { handle: function () { return false; } },
      clients: { authenticate: function () { return null; }, list: function () { return []; } },
      plugins: { snapshot: function () { return [{ id: 'ui-standard', dir: dir, status: 'data', manifest: { kind: 'shell' } }]; } }
    });
    const server = await gateway.listen(0);
    const port = server.address().port;
    function request(urlPath) {
      return new Promise(function (resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: urlPath, headers: { Host: '127.0.0.1:18770' } }, function (res) {
          const chunks = [];
          res.on('data', function (chunk) { chunks.push(chunk); });
          res.on('end', function () { resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
        }).on('error', reject);
      });
    }
    try {
      const pages = guidePaths();
      assert.ok(pages.length >= 8, String(pages.length));
      for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i];
        assert.ok(page.indexOf('/plugins/ui-standard/shell/guide/') === 0, page);
        const viaPlugin = '/plugin/' + page.slice('/plugins/'.length);
        const got = await request(page);
        assert.strictEqual(got.status, 200, page);
        assert.strictEqual((await request(viaPlugin)).status, 200, viaPlugin);
        const assets = linkedAssets(got.text, page);
        for (let j = 0; j < assets.length; j += 1) {
          const asset = await request(assets[j]);
          assert.strictEqual(asset.status, 200, page + ' -> ' + assets[j]);
        }
      }
    } finally {
      await new Promise(function (resolve) { server.close(resolve); });
    }
  });

  await test('AI ガイドの書き出し先は shell の guide', function () {
    const sync = require(path.join(ROOT, 'cli', 'sync-ai-guide'));
    assert.strictEqual(sync.HTML, path.join(ROOT, 'plugins', 'ui-standard', 'shell', 'guide', 'ai-guide.html'));
  });

  if (failed) {
    console.error('[c4] ' + failed + ' failed');
    process.exit(1);
  }
  console.log('[c4] ui-standard tests passed');
})();
