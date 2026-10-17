'use strict';

/**
 * サイトの設定欄とログインの「有無」（K3。host/site-login.js から、金庫の持ち主の振り分けに当たる部分を核に残した）。
 *  - setConfig: manifest.site.configSchema にある項目だけを、金庫の <site>.config へ。値は返さない。
 *  - loginFacts: サイトごとの { id, type, oauthName, present }（名前と有無だけ）。OAuth の中身の状態（logged-in / expired…）はプラグイン site-login が読む。
 * 保存先は金庫。名前は manifest の secrets にあるものだけを使う。値は画面にも答えにもログにも出さない。
 */

const ACTOR = 'site-config'; // 金庫の記録に残る読み書きの名前（核の持ち物。サイトのログインの画面はプラグイン site-login が持つ）
const MAX_FIELD = 2000;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nameFor(site, kind) {
  const names = Array.isArray(site.secretNames) ? site.secretNames : [];
  if (kind === 'oauth') return names.find((n) => /\.oauth$/.test(n)) || '';
  if (kind === 'config') return names.find((n) => /\.config$/.test(n)) || '';
  return names.find((n) => /^cookies\./.test(n)) || '';
}

function createSiteConfig(options) {
  const opts = options || {};
  const secrets = opts.secrets || null;
  const reader = opts.reader || null;
  const getSites = typeof opts.getSites === 'function' ? opts.getSites : async () => [];
  // 二層目（plugin-layers.json の layer2）の動いているプラグインが宣言している金庫の名前（名前だけ。L11b）
  const getDeclared = typeof opts.getDeclaredNames === 'function' ? opts.getDeclaredNames : () => [];

  async function readJson(name) {
    if (!reader || typeof reader.get !== 'function') return { ok: false, error: 'unavailable' };
    const got = await reader.get(name);
    if (!got || got.ok !== true || typeof got.value !== 'string') return { ok: false, error: got && got.error ? got.error : 'not-found' };
    try { return { ok: true, doc: JSON.parse(got.value) }; } catch (_) { return { ok: true, doc: null }; }
  }

  async function listedNames() {
    if (!secrets || typeof secrets.list !== 'function') return new Set();
    const listed = await secrets.list();
    const rows = listed && listed.ok === true && Array.isArray(listed.secrets) ? listed.secrets : [];
    return new Set(rows.map((row) => row && row.name).filter((n) => typeof n === 'string'));
  }

  async function loginFacts() {
    const sites = await getSites();
    const have = await listedNames();
    const declared = [].concat(await getDeclared()).filter((n) => typeof n === 'string');
    const out = [];
    for (const site of sites) {
      const login = asObject(site && site.login);
      if (!login || login.type === 'none') continue;
      const name = nameFor(site, login.type);
      // 二層目あり ＝ 二層目のプラグインのどれかが <サイト>. か cookies.<サイト>- で始まる名前を宣言している（一層目のサイトの名簿の宣言は数えない）
      const hasLayer2 = declared.some((n) => n.startsWith(site.id + '.') || n.startsWith('cookies.' + site.id + '-'));
      out.push({ id: site.id, type: login.type, oauthName: login.type === 'oauth' ? name : '', present: !!name && have.has(name), hasLayer2: hasLayer2 });
    }
    return { ok: true, sites: out };
  }

  async function findSite(id) {
    const sites = await getSites();
    return sites.find((s) => s && s.id === id) || null;
  }

  /** manifest.site.configSchema（[{ name, secret? }]）にある項目だけを、金庫の <site>.config へ。 */
  async function setConfig(input) {
    const given = asObject(input) || {};
    const site = await findSite(String(given.site || ''));
    const schema = site && Array.isArray(site.configSchema) ? site.configSchema : [];
    const name = site ? nameFor(site, 'config') : '';
    if (!site || !name || !schema.length) return { ok: false, error: 'unknown-site' };
    const fields = asObject(given.fields) || {};
    const read = await readJson(name);
    const doc = read.ok && asObject(read.doc) ? Object.assign({}, read.doc) : {};
    for (const key of Object.keys(fields)) {
      if (!schema.some((f) => f.name === key)) return { ok: false, error: 'bad-field' };
      const value = fields[key];
      if (typeof value !== 'string' || value.length > MAX_FIELD) return { ok: false, error: 'bad-field' };
      if (value !== '') doc[key] = value.trim(); // 空欄は今のまま
    }
    for (const f of schema) {
      if (f.required === true && !nonEmpty(doc[f.name])) return { ok: false, error: 'missing-field' };
    }
    const saved = await secrets.set(name, JSON.stringify(doc), ACTOR);
    return saved && saved.ok === true ? { ok: true } : { ok: false, error: saved && saved.error ? saved.error : 'unavailable' };
  }

  return { setConfig, loginFacts };
}

/**
 * 二層目のプラグイン（layers.layer2 にある id で status === 'running'）が宣言している secrets の一覧。
 * 一層目（layer1）や三層目（外から入れたプラグインなど）の宣言は除外する。
 * @param {Array<{ id: string, status: string, manifest?: { secrets?: string[] } }>} snapshot
 * @param {{ layer1?: string[], layer2?: string[] }} layers
 * @returns {string[]}
 */
function layer2DeclaredNames(snapshot, layers) {
  const rows = Array.isArray(snapshot) ? snapshot : [];
  const l2 = layers && Array.isArray(layers.layer2) ? layers.layer2 : [];
  const l2Set = new Set(l2);
  const out = [];
  for (const row of rows) {
    if (!row || row.status !== 'running' || !l2Set.has(row.id)) continue;
    const secrets = row.manifest && Array.isArray(row.manifest.secrets) ? row.manifest.secrets : [];
    for (const name of secrets) {
      if (typeof name === 'string' && out.indexOf(name) === -1) {
        out.push(name);
      }
    }
  }
  return out;
}

module.exports = { createSiteConfig, layer2DeclaredNames };
