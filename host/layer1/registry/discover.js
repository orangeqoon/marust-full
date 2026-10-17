'use strict';

/**
 * 登録簿の部品: プラグインの置き場の探索・manifest の検査・記録の登録（計画 X・S8b。host/core/plugin-registry.js から機械的に移した。動きは変えていない）。
 * S は host/core/plugin-registry.js の createRegistry が作る道具箱（共有の状態 st・opts・records など）。他の部品の関数は S.fn から呼ぶ。
 */

const fs = require('fs');
const path = require('path');
const { setModeKeys } = require('../modes');
const { DATA_KINDS, validateDataManifest } = require('../data-plugins');
const { ID_RE } = require('../plugin-surface');
const { coreApiProblem, FANOUT_METHODS, FANOUT_REQUIRES, KNOWN_CAPS, claimOwns, expandSiteManifest, externalGuard, externalIdProblem, mapV1Provides, normalizeApiField, normalizePeersField, normalizeTimeouts, normalizeV2, realInside } = require('./manifest');

function createDiscover(S) {
  const { setRoots, setFrom, setEnvMissing, externalRoot, rootOf, records, byId, log, st } = S;
  const tierOf = (...args) => S.fn.tierOf(...args);

  function resolveMain(dir, mainRel) {
    const rel = mainRel == null || mainRel === '' ? 'index.js' : String(mainRel);
    if (path.isAbsolute(rel)) return null;
    const parts = rel.split(/[\\/]/);
    if (parts.includes('..')) return null;
    const abs = path.resolve(dir, rel);
    const back = path.relative(dir, abs);
    if (back.startsWith('..') || path.isAbsolute(back)) return null;
    return abs;
  }

  function readManifestFile(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { missing: true };
    let text;
    try {
      text = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      return { error: 'invalid-json', detail: 'read-failed' };
    }
    try {
      const manifest = JSON.parse(text);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { error: 'invalid-json' };
      }
      return { manifest };
    } catch (err) {
      return { error: 'invalid-json' };
    }
  }

  function shellFilesProblem(dir, shell) {
    const root = path.join(dir, 'shell');
    const names = shell.scripts.concat(shell.styles, shell.layout ? [shell.layout] : [], shell.template ? [shell.template] : []);
    for (const rel of names) {
      const abs = path.join(root, rel);
      let ok = false;
      try { ok = fs.statSync(abs).isFile() && realInside(root, abs); } catch (_) { ok = false; }
      if (!ok) return 'shell-file-missing';
    }
    return '';
  }

  function validate(dirName, parsed, source, vopts) {
    const given = vopts || {};
    const dir = given.dir || path.join(rootOf[source] || externalRoot, dirName);
    const base = {
      id: dirName,
      source,
      dir,
      manifest: parsed.manifest || null,
      status: 'skip',
      reason: null,
      mainPath: null,
      instance: null
    };
    if (given.extra) Object.assign(base, given.extra);
    // サイトの形（展開）で作った記録だけが siblings・siteId・role を持てる。旧い形の manifest に書かれていても使わない（M6 Must 1）。
    // データだけのプラグイン（kind: theme|layout）は消さずに通し、下の検査で `data-only-forbidden-field` として断る（V8 Later 1）。
    if (!given.extra && parsed.manifest && typeof parsed.manifest === 'object' && DATA_KINDS.indexOf(parsed.manifest.kind) === -1) {
      delete parsed.manifest.siblings;
      delete parsed.manifest.siteId;
      delete parsed.manifest.role;
    }
    if (parsed.missing) return null;
    if (parsed.error) {
      base.reason = parsed.error;
      log('warn', `skip ${source}/${dirName} ${parsed.error}`);
      return base;
    }
    const manifest = parsed.manifest;
    const id = manifest.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      base.reason = 'bad-id';
      log('warn', `skip ${source}/${dirName} bad-id`);
      return base;
    }
    if (id !== dirName) {
      base.id = id;
      base.reason = 'id-mismatch';
      log('warn', `skip ${source}/${dirName} id-mismatch`);
      return base;
    }
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      base.reason = 'missing-field';
      log('warn', `skip ${id} missing-field name`);
      return base;
    }
    if (typeof manifest.version !== 'string') {
      base.reason = 'missing-field';
      log('warn', `skip ${id} missing-field version`);
      return base;
    }

    // つなぎ口の版（計画 C・D2）。核より新しい口を要るものは読み込まない（画面の一覧には reason で出る）。
    const apiProblem = coreApiProblem(manifest);
    if (apiProblem) {
      base.reason = apiProblem;
      log('warn', `skip ${source}/${id} ${apiProblem} coreApi=${typeof manifest.coreApi === 'number' ? manifest.coreApi : 'invalid'}`);
      return base;
    }

    // データだけのプラグイン（テーマ・並べ方）。main も ctx も持たない。ほかの欄が 1 つでもあれば読み込まない（host/core/data-plugins.js）。
    if (DATA_KINDS.indexOf(manifest.kind) !== -1) {
      const idBad = source === 'user' && externalIdProblem(id);
      const got = idBad ? { error: 'reserved-id' } : validateDataManifest(manifest);
      if (got.error) {
        base.reason = got.error;
        log('warn', `skip ${source}/${id} ${got.error}`);
        return base;
      }
      if (got.theme) manifest.theme = got.theme;
      if (got.layout) manifest.layout = got.layout;
      if (got.set) manifest.set = got.set;
      if (got.shell) {
        manifest.shell = got.shell;
        // 画面の本体役: 書いたファイルが <フォルダ>/shell/ の中に全部あること（無ければ読み込まない＝選べない。セットの shell に戻れる。計画 C・C3-1）
        const missing = shellFilesProblem(dir, got.shell);
        if (missing) {
          base.reason = missing;
          log('warn', `skip ${source}/${id} ${missing}`);
          return base;
        }
      }
      base.manifest = manifest;
      base.status = 'data';
      base.reason = null;
      return base;
    }

    if (source === 'user') {
      // id の規則は installer と同じ（★2 M4）。外部は v2 だけ（v1 の道には main の realpath 検査が無い。★2 M8）
      const idProblem = externalIdProblem(id) ? 'reserved-id' : (manifest.manifestVersion !== 2 ? 'v1-not-allowed' : '');
      if (idProblem) {
        base.reason = idProblem;
        log('warn', 'skip external/' + id + ' ' + idProblem);
        return base;
      }
      const guard = externalGuard(manifest, id);
      if (guard) {
        base.reason = guard;
        log('warn', 'skip external/' + id + ' ' + guard);
        return base;
      }
    }

    if (manifest.manifestVersion === 2) {
      const surfaceError = normalizeV2(manifest, id, log);
      normalizeApiField(manifest, id, source, log);
      normalizePeersField(manifest, id, source, log);
      claimOwns(manifest, id, source, log);
      if (surfaceError) {
        base.reason = surfaceError;
        log('warn', 'skip ' + id + ' ' + surfaceError);
        return base;
      }
      const v2Main = resolveMain(dir, manifest.main);
      if (!v2Main || (source === 'user' && !realInside(dir, v2Main))) {
        base.reason = 'main-escape';
        log('warn', 'skip ' + id + ' main-escape');
        return base;
      }
      base.manifest = manifest;
      base.mainPath = v2Main;
      if (manifest.kind === 'site') {
        const fanout = manifest.fanout;
        const siteRole = Array.isArray(manifest.provides) && manifest.provides.indexOf('stream.site@1') !== -1;
        const fanoutOk = !!(fanout && FANOUT_REQUIRES.has(fanout.requires) && FANOUT_METHODS.has(fanout.method));
        if (!fanoutOk && !(siteRole && (fanout == null))) {
          base.reason = 'missing-field';
          log('warn', 'skip ' + id + ' missing-field fanout');
          return base;
        }
      }
      if (manifest.runtime !== 'inproc') {
        base.status = 'listed-not-started';
        base.reason = 'runtime-not-supported-yet';
        return base;
      }
      base.status = 'accepted';
      base.reason = null;
      return base;
    }
    if (manifest.kind !== 'site' && manifest.kind !== 'ui' && manifest.kind !== 'integration') {
      base.reason = 'missing-field';
      log('warn', `skip ${id} missing-field kind`);
      return base;
    }
    if (!Array.isArray(manifest.capabilities)) {
      base.reason = 'missing-field';
      log('warn', `skip ${id} missing-field capabilities`);
      return base;
    }
    const caps = [];
    for (const cap of manifest.capabilities) {
      if (KNOWN_CAPS.has(cap)) caps.push(cap);
      else log('warn', `unknown capability ${String(cap)} on ${id}`);
    }
    manifest.capabilities = caps;
    if (Object.prototype.hasOwnProperty.call(manifest, 'timeouts')) {
      manifest.timeouts = normalizeTimeouts(manifest.timeouts, id, log);
    }
    const mainPath = resolveMain(dir, manifest.main);
    if (!mainPath) {
      base.reason = 'main-escape';
      log('warn', `skip ${id} main-escape`);
      return base;
    }
    if (manifest.kind === 'site') {
      const fanout = manifest.fanout;
      if (!fanout || !FANOUT_REQUIRES.has(fanout.requires) || !FANOUT_METHODS.has(fanout.method)) {
        base.reason = 'missing-field';
        log('warn', `skip ${id} missing-field fanout`);
        return base;
      }
    }
    base.manifest = manifest;
    base.mainPath = mainPath;
    if (manifest.kind !== 'site') {
      base.status = 'listed-not-started';
      base.reason = 'listed-not-started';
      return base;
    }
    base.status = 'accepted';
    base.reason = null;
    return base;
  }

  // community=true は「みんなのプラグイン」の置き場。信頼は内蔵と同じ（作者の build に入れたもの）で、出どころの印だけ付ける。
  function scanRoot(root, source, community, author) {
    if (!root || !fs.existsSync(root)) return;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      log('warn', `discover unreadable ${source}`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.charAt(0) === '.') continue; // .tmp-* など（入れている途中のフォルダ）は読まない
      const dir = path.join(root, entry.name);
      const parsed = readManifestFile(dir);
      if (parsed.missing) continue;
      const rec = validate(entry.name, parsed, source, { dir });
      if (!rec) continue;
      if (community) rec.community = true;
      if (author) rec.author = true;
      register(rec);
    }
    // サイトの形（plugins/sites/）は内蔵・作者用だけ。外から入れるものでは受けない（PLAN §7.3）。
    if (source !== 'user' && !community) scanSites(path.join(root, 'sites'), source, author);
  }

  function register(rec) {
    const registerable = rec.status === 'accepted' || rec.status === 'listed-not-started' || rec.status === 'data';
    // 同じ id はセットが勝つ。セットの同じ id が版（coreApi）などで読み込まれなくても、自分で足したものに席を譲らない（計画 C・C2-2）。
    const setHasId = rec.source === 'user' && records.some((other) => other.source === 'set' && other.id === rec.id);
    if (registerable && (byId.has(rec.id) || setHasId)) {
      rec.status = 'skip';
      rec.reason = 'id-collision-skipped';
      log('warn', 'id-collision-skipped ' + rec.id);
      records.push(rec);
      return;
    }
    records.push(rec);
    if (registerable) byId.set(rec.id, rec);
  }

  // plugins/sites/<site>/ の 1 つを、役目ごとの記録（rec）へ。失敗したら skip の記録 1 つ。
  function siteRecords(dirName, dir, source) {
    const parsed = readManifestFile(dir);
    if (parsed.missing) return [];
    const fail = (reason) => {
      log('warn', 'skip ' + source + '/sites/' + dirName + ' ' + reason);
      return [{ id: dirName, source, dir, manifest: parsed.manifest || null, status: 'skip', reason: reason, mainPath: null, instance: null }];
    };
    if (parsed.error) return fail(parsed.error);
    const top = parsed.manifest;
    if (typeof top.id !== 'string' || !ID_RE.test(top.id)) return fail('bad-id');
    if (top.id !== dirName) return fail('id-mismatch');
    if (typeof top.name !== 'string' || top.name === '' || typeof top.version !== 'string') return fail('missing-field');
    const apiProblem = coreApiProblem(top);
    if (apiProblem) return fail(apiProblem);
    const expanded = expandSiteManifest(top, dirName, log);
    if (expanded.error) return fail(expanded.error);
    return expanded.roles.map((row) => {
      const rec = validate(row.id, { manifest: row.manifest }, source, {
        dir,
        extra: { siteId: dirName, role: row.role, modeKey: dirName + ':' + row.role }
      });
      return rec;
    });
  }

  function scanSites(sitesRoot, source, author) {
    if (!sitesRoot || !fs.existsSync(sitesRoot)) return;
    let entries;
    try {
      entries = fs.readdirSync(sitesRoot, { withFileTypes: true });
    } catch (err) {
      log('warn', 'discover unreadable ' + source + '/sites');
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      siteRecords(entry.name, path.join(sitesRoot, entry.name), source).forEach((rec) => { if (rec) { if (author) rec.author = true; register(rec); } });
    }
  }

  function snapshot() {
    return records.map((rec) => {
      if (rec.manifest && rec.manifest.manifestVersion !== 2) mapV1Provides(rec.manifest);
      return {
        id: rec.id,
        source: rec.source,
        community: !!rec.community,
        author: !!rec.author,
        dir: rec.dir,
        manifest: rec.manifest,
        status: rec.status,
        reason: rec.reason,
        siteId: rec.siteId || '',
        role: rec.role || '',
        modeKey: rec.modeKey || '',
        tier: tierOf(rec),
        lastError: rec.lastError ? { message: rec.lastError.message, where: rec.lastError.where } : null
      };
    });
  }

  // 兄弟の一覧は「登録されている・同じサイトの・同じフォルダの記録」だけに絞る。
  // 外の置き場に同じ名前のサイトを置かれても、本物の別サイトの役目が兄弟に入らない（M6 Must 1。パネルの許可はこの一覧で広がる）。
  function pruneSiblings() {
    records.forEach((rec) => {
      const manifest = rec.manifest;
      if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.siblings)) return;
      manifest.siblings = rec.siteId
        ? manifest.siblings.filter((id) => {
          const other = byId.get(id);
          return !!other && other.siteId === rec.siteId && other.dir === rec.dir;
        })
        : [];
    });
  }

  function discover() {
    if (st.loaded) return snapshot();
    records.length = 0;
    byId.clear();
    // 置き場をログに一行（パスは出さない。none＝置き場が無い／count 0＝置き場はあるが空）。配る版で plugins/ が無いと一覧が空になるだけなので、原因が分かるように。
    if (setEnvMissing) log('warn', 'set-dirs env-missing');
    log('info', 'set-dirs from=' + setFrom + ' count=' + setRoots.length);
    setRoots.forEach((row) => scanRoot(row.dir, row.source, row.community, row.author));
    scanRoot(externalRoot, 'user');
    // サイトのプラグインの「内部の id → モードのキー」。モードを読む・書く所は modeKeyOf を通す（host/core/modes.js）。
    setModeKeys(records.filter((rec) => rec.modeKey && byId.get(rec.id) === rec).map((rec) => [rec.id, rec.modeKey]));
    pruneSiblings();
    return snapshot();
  }

  return {
    readManifestFile,
    validate,
    scanRoot,
    register,
    siteRecords,
    snapshot,
    pruneSiblings,
    discover
  };
}

module.exports = { createDiscover };
