'use strict';

/**
 * 移行用の「引っ越しファイル」。別の PC でも同じ設定で使うための、暗号化した 1 ファイル。
 *
 * - 中身: 設定（settings-export と同じ）、金庫の秘密（名前→値）、OBS 接続設定（obs-config.json）。
 * - 暗号: 合言葉 → scrypt → AES-256-GCM。合言葉は画面でユーザーが入れる。ファイルにも記録にも残さない。
 * - 戻り値と記録に出すのは「件数と名前」だけ。値・合言葉・復号した中身は、どこにも返さない・書かない。
 * - 取り込みは「モード」を適用しない（live への切り替えはユーザーが画面で行う）。
 *   配信中（anyOutputLive）は取り込まない。外へは何も送らない。
 * - 合言葉を忘れると開けない。復旧の手段は無い。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT = 'marust-migration';
const VERSION = 1;
const KDF = Object.freeze({ N: 32768, r: 8, p: 1, keyLen: 32, saltLen: 16 });
const MIN_PASSPHRASE = 10;
const MAX_PASSPHRASE = 200;
const MAX_BUNDLE = 8 * 1024 * 1024;
const ACTOR = 'migration';
// 取り込みで適用する設定の項目。modes は入れない。
const IMPORT_SECTIONS = Object.freeze(['layout', 'hotkeys', 'destinations', 'pluginConfigs', 'autostart']);
const FILES = Object.freeze(['obs-config.json']);

function fail(code) {
  return { ok: false, error: code };
}

function scrypt(passphrase, salt, params) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(passphrase, salt, params.keyLen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 128 * 1024 * 1024
    }, function (err, key) {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function passphraseProblem(passphrase) {
  if (typeof passphrase !== 'string') return 'bad-passphrase';
  if (passphrase.length < MIN_PASSPHRASE) return 'passphrase-short';
  if (passphrase.length > MAX_PASSPHRASE) return 'bad-passphrase';
  return '';
}

function stamp(date) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

async function seal(payload, passphrase) {
  const salt = crypto.randomBytes(KDF.saltLen);
  const iv = crypto.randomBytes(12);
  const key = await scrypt(passphrase, salt, KDF);
  const header = {
    format: FORMAT,
    version: VERSION,
    kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64')
  };
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return Object.assign({}, header, {
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  });
}

async function open(envelope, passphrase) {
  if (!envelope || typeof envelope !== 'object' || envelope.format !== FORMAT) return fail('not-a-bundle');
  if (envelope.version !== VERSION) return fail('bad-version');
  const kdf = envelope.kdf;
  if (!kdf || kdf.name !== 'scrypt' || typeof kdf.salt !== 'string') return fail('not-a-bundle');
  // ファイルの値を信用しすぎない（極端な設定でメモリを食わせない）
  if (kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p) return fail('not-a-bundle');
  if (envelope.cipher !== 'aes-256-gcm' || typeof envelope.iv !== 'string' ||
      typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') return fail('not-a-bundle');
  const header = {
    format: envelope.format,
    version: envelope.version,
    kdf: { name: kdf.name, N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
    cipher: envelope.cipher,
    iv: envelope.iv
  };
  let plain;
  try {
    const key = await scrypt(passphrase, Buffer.from(kdf.salt, 'base64'), KDF);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  } catch (_) {
    // 合言葉の間違いか、ファイルの破損か（区別できない）
    return fail('wrong-passphrase');
  }
  try {
    const payload = JSON.parse(plain.toString('utf8'));
    if (!payload || typeof payload !== 'object' || payload.app !== 'marust') return fail('not-a-bundle');
    return { ok: true, payload: payload };
  } catch (_) {
    return fail('not-a-bundle');
  }
}

function createMigrationBundle(options) {
  const opts = options || {};
  const core = opts.core || null;
  const secrets = opts.secrets || null;
  const reader = opts.reader || null;
  const settingsTool = typeof opts.settingsTool === 'function' ? opts.settingsTool : null;
  const isLive = typeof opts.isLive === 'function' ? opts.isLive : function () { return false; };
  const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };

  function servicesDir() {
    return core && core.SERVICES_DIR ? core.SERVICES_DIR : '';
  }

  function exportsDir() {
    return path.join(core.STATE_DIR, 'exports');
  }

  async function collectSecrets() {
    const out = {};
    if (!reader || typeof reader.list !== 'function' || typeof reader.get !== 'function') return out;
    const listed = await reader.list();
    if (!listed || listed.ok !== true || !Array.isArray(listed.secrets)) return out;
    const names = listed.secrets
      .map(function (row) { return row && typeof row.name === 'string' ? row.name : ''; })
      .filter(Boolean);
    for (let i = 0; i < names.length; i += 1) {
      const got = await reader.get(names[i]);
      if (got && got.ok === true && typeof got.value === 'string') out[names[i]] = got.value;
    }
    return out;
  }

  function collectFiles() {
    const out = {};
    const dir = servicesDir();
    if (!dir) return out;
    for (let i = 0; i < FILES.length; i += 1) {
      try {
        const text = fs.readFileSync(path.join(dir, FILES[i]), 'utf8');
        JSON.parse(text);
        out[FILES[i]] = text;
      } catch (_) { /* 無ければ入れない */ }
    }
    return out;
  }

  async function exportBundle(params) {
    if (!core || !core.STATE_DIR || !settingsTool) return fail('unavailable');
    const problem = passphraseProblem(params && params.passphrase);
    if (problem) return fail(problem);
    try {
      const settings = settingsTool().exportAll();
      if (!settings) return fail('unavailable');
      const secretValues = await collectSecrets();
      const files = collectFiles();
      const date = now();
      const envelope = await seal({
        app: 'marust',
        createdAt: date.toISOString(),
        settings: settings,
        secrets: secretValues,
        files: files
      }, params.passphrase);
      const dir = exportsDir();
      fs.mkdirSync(dir, { recursive: true });
      const filename = 'marust-migration-' + stamp(date) + '.marustbundle';
      fs.writeFileSync(path.join(dir, filename), JSON.stringify(envelope) + '\n', 'utf8');
      return {
        ok: true,
        filename: filename,
        dir: dir,
        counts: { secrets: Object.keys(secretValues).length, files: Object.keys(files).length }
      };
    } catch (_) {
      return fail('failed');
    }
  }

  async function importBundle(params) {
    if (!core || !core.STATE_DIR || !settingsTool) return fail('unavailable');
    const problem = passphraseProblem(params && params.passphrase);
    if (problem) return fail(problem);
    const text = params && typeof params.bundle === 'string' ? params.bundle : '';
    if (!text || text.length > MAX_BUNDLE) return fail('bad-bundle');
    let live = false;
    try { live = isLive() === true; } catch (_) { live = false; }
    if (live) return fail('live-now');
    let envelope;
    try { envelope = JSON.parse(text); } catch (_) { return fail('not-a-bundle'); }
    const opened = await open(envelope, params.passphrase);
    if (!opened.ok) return opened;
    const payload = opened.payload;

    const done = { secrets: 0, secretsFailed: 0, files: 0, sections: [], backup: '' };

    // 1) 設定（モード以外）。反映の前に今の設定の控えを取る（settings-export の仕組み）。
    if (payload.settings && typeof payload.settings === 'object') {
      const applied = settingsTool().importSelected(payload.settings, IMPORT_SECTIONS.slice());
      if (!applied || applied.ok !== true) return fail(applied && applied.error ? String(applied.error) : 'failed');
      done.sections = Array.isArray(applied.applied) ? applied.applied : [];
      done.backup = applied.backup || '';
    }

    // 2) 金庫の秘密
    const values = payload.secrets && typeof payload.secrets === 'object' ? payload.secrets : {};
    const failed = [];
    if (secrets && typeof secrets.set === 'function') {
      const names = Object.keys(values);
      for (let i = 0; i < names.length; i += 1) {
        const value = values[names[i]];
        let result = null;
        if (typeof value === 'string' && value) {
          try { result = await secrets.set(names[i], value, ACTOR); } catch (_) { result = null; }
        }
        if (result && result.ok === true) done.secrets += 1;
        else { done.secretsFailed += 1; failed.push(names[i]); }
      }
    }

    // 3) 設定ファイル（上書き前に控えを残す）
    const files = payload.files && typeof payload.files === 'object' ? payload.files : {};
    const dir = servicesDir();
    if (dir) {
      for (let i = 0; i < FILES.length; i += 1) {
        const body = files[FILES[i]];
        if (typeof body !== 'string') continue;
        try {
          JSON.parse(body);
          fs.mkdirSync(dir, { recursive: true });
          const target = path.join(dir, FILES[i]);
          if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak-' + stamp(now()));
          fs.writeFileSync(target, body, 'utf8');
          done.files += 1;
        } catch (_) { /* 1 つ失敗しても残りは続ける */ }
      }
    }

    return {
      ok: true,
      sections: done.sections,
      backup: done.backup,
      counts: { secrets: done.secrets, secretsFailed: done.secretsFailed, files: done.files },
      failedNames: failed
    };
  }

  return { exportBundle: exportBundle, importBundle: importBundle };
}

module.exports = {
  createMigrationBundle,
  IMPORT_SECTIONS,
  MIN_PASSPHRASE,
  MAX_BUNDLE,
  FORMAT,
  VERSION
};
