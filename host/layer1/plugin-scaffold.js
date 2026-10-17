'use strict';

/**
 * P5「作る」: 外から入れる形のプラグインのひな形（plugin.create が書くファイル）。
 * 文章はここが持つ。cli/new-plugin.js はここから読む（CLI が核を使う）。
 * ここは相対パスから文章の表を作るだけで、ファイルは書かない
 * （書くのは host/core/plugin-install.js の scaffold。空いている id のときだけ、上書きしない）。
 * 試験用のファイル（test/）は作らない。外から入れたものは丸ストの test には入らない。
 */
function siteOf(id) {
  return String(id).replace(/^site-/, '');
}

function title(id) {
  return id.replace(/^site-/, '').split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function manifestFor(id, site) {
  if (site) {
    const s = siteOf(id);
    return JSON.stringify({
      id: s,
      name: title(id),
      category: 'destination', // 種類（決まった語は docs/PLUGIN-API.md）。画面の「種類ごと」の分け方に使う
      version: '0.1.0',
      manifestVersion: 2,
      coreApi: 2,
      runtime: 'inproc',
      roles: {
        site: {
          main: 'site.js',
          provides: ['stream.site@1', 'ui.panel@1'],
          defaultMode: 'legacy',
          timeouts: { updateMetadata: 30000, getStatus: 20000 },
          actions: { getStatus: 'read' },
          panels: [{ name: 'status', title: title(id), file: 'ui/panel.html' }]
        }
      },
      audience: 'public',
      stability: 'experimental',
      site: {
        id: s,
        name: title(id),
        tier: 'extra',
        ingest: [{ label: '自分で URL を入れる', url: null, helpUrl: null }],
        keyHelpUrl: null,
        tosUrl: null,
        login: { type: 'none', needed: 'optional', for: [] }
      }
    }, null, 2) + '\n';
  }
  return JSON.stringify({
    id: id,
    name: title(id),
    category: 'tool', // 種類（決まった語は docs/PLUGIN-API.md）。効くサイトがあるなら for: ["<サイトの id>"]（全部なら ["*"]）も名乗る
    version: '0.1.0',
    manifestVersion: 2,
    coreApi: 2,
    runtime: 'inproc',
    main: 'index.js',
    kind: 'integration',
    provides: ['ui.panel@1'],
    defaultMode: 'legacy',
    timeouts: { getStatus: 10000 },
    actions: { getStatus: 'read' },
    panels: [{ name: 'status', title: title(id), file: 'ui/panel.html' }],
    audience: 'public',
    stability: 'experimental'
  }, null, 2) + '\n';
}

function indexFor(id, site) {
  const siteMethods = site ? `
  /**
   * 題名とカテゴリを送る（stream.site@1）。コメントの受信は作らない（受信はわんコメ）。
   * legacy は何もしない。shadow は外へ出さない。live だけが送る。
   * TODO: ここにそのサイトの API を呼ぶ処理を書く。本物のサイトにはテストでつながない（偽の fetch を使う）。
   */
  async function updateMetadata(input, meta) {
    void input;
    const mode = meta && meta.mode ? meta.mode : modeOf(ctx);
    if (mode === 'legacy') return { ok: true };
    if (mode === 'shadow') return { ok: true, dryRun: true };
    // const secret = await ctx.secrets.get('key'); // 秘密: 値をログに出さない
    lastOk = false;
    lastError = 'not-implemented';
    return { ok: false, error: 'not-implemented' };
  }
` : '';
  return `'use strict';

/**
 * ${title(id)}（ひな形）。
 * 秘密（キー・トークン）は manifest の secrets に名前を書き、ctx.secrets.get(名前) で読む。
 * 値はそのまま使えるが、ログ・画面・戻り値・エラーに出さない（写した文字列は出口で伏せられない）。
 * 詳しい約束は docs/PLUGIN-API.md、AI への手引きは AGENTS.md。
 */

function modeOf(ctx) {
  try { return ctx && typeof ctx.mode === 'function' ? ctx.mode() : 'legacy'; } catch (_) { return 'legacy'; }
}

function create() {
  let ctx = null;
  let lastOk = null;
  let lastError = '';
${siteMethods}
  function load(passed) { ctx = passed || null; }
  function start() {}
  function stop() {}
  function destroy() { ctx = null; lastOk = null; lastError = ''; }
  function health() { return { ok: true, detail: '${id}' }; }

  // パネルが読む「今の状態」。読むだけ。
  function getStatus() {
    return { ok: true, mode: modeOf(ctx), lastOk: lastOk, lastError: lastError };
  }

  return {
    load: load,
    start: start,
    stop: stop,
    destroy: destroy,
    health: health,${site ? '\n    updateMetadata: updateMetadata,' : ''}
    getStatus: getStatus,
    actions: { getStatus: getStatus }
  };
}

const singleton = create();
singleton.create = create;
module.exports = singleton;
`;
}

// 画面の「作る」が書くファイル（試験ファイルは作らない。書くのは host/core/plugin-install.js の scaffold）。
function templateFiles(id) {
  return {
    'manifest.json': manifestFor(id, false),
    'index.js': indexFor(id, false),
    'ui/panel.html': panelHtml(id),
    'ui/panel.js': panelJs(id)
  };
}

function panelHtml(id) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>${title(id)}</title>
  <style>
    body { font-family: "Segoe UI", "Yu Gothic UI", "Meiryo", sans-serif; background: #161b26; color: #e6eaf2; margin: 12px; }
    dt { color: #a0aabd; } dd { margin: 0 0 8px; }
  </style>
</head>
<body>
  <h1>${title(id)}</h1>
  <dl>
    <dt>状態</dt>
    <dd id="mode">-</dd>
    <dt>最後の結果</dt>
    <dd id="last">-</dd>
  </dl>
  <p><button id="refresh" type="button">更新</button></p>
  <script src="panel.js"></script>
</body>
</html>
`;
}

function panelJs(id) {
  return `'use strict';

// パネルは本体へ postMessage で頼む（直接つながない）。値（秘密）は扱わない。
const METHOD = 'plugin.${id}.getStatus';
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const modeEl = document.getElementById('mode');
const lastEl = document.getElementById('last');
let seq = 0;
let pending = '';

function call(method) {
  seq += 1;
  pending = String(seq);
  parent.postMessage({ type: 'marust:call', id: pending, method: method, params: {} }, location.origin);
}

window.addEventListener('message', function (ev) {
  if (ev.origin !== location.origin) return;
  const msg = ev.data;
  if (!msg || msg.type !== 'marust:result' || msg.id !== pending) return;
  const r = msg.result || {};
  modeEl.textContent = r.mode === 'live' ? '使っています' : (r.mode === 'shadow' ? '試しに動かしています' : '使っていません');
  lastEl.textContent = r.lastOk === true ? '成功' : (r.lastOk === false ? '失敗 ' + (CODE_RE.test(r.lastError) ? r.lastError : '') : 'まだありません');
});

document.getElementById('refresh').addEventListener('click', function () { call(METHOD); });
call(METHOD);
`;
}

module.exports = { templateFiles, manifestFor, indexFor, panelHtml, panelJs, title, siteOf };
