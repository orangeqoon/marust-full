'use strict';

/**
 * 「更新を確かめる」（ヘルプ）。押したときにだけ、配布ページ（GitHub Releases）の最新の版を 1 回読む。
 * 自動ではつながない（PLAN-public-v1 §4「外の測定サーバーに勝手につながない」と同じ考え）。
 *   - 読むのは https://api.github.com/repos/<owner>/<repo>/releases/latest だけ。リポジトリ名は package.json の marustReleasesRepo。
 *     空なら not-configured（配布ページが決まるまで）。
 *   - 送るのは User-Agent と Accept だけ。丸ストの設定・秘密・端末の情報は送らない。
 *   - 答えは版・ページの URL・新しいか、だけ。URL は github.com の同じリポジトリのものだけ通す（それ以外は空にする）。
 *   - 失敗は 'network' / 'timeout' / 'bad-response' / 'not-configured' の符号だけ。
 */

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,40})?$/;
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 8000;

function parseVersion(text) {
  const m = VERSION_RE.exec(String(text == null ? '' : text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function createUpdateCheck(options) {
  const opts = options || {};
  const repo = typeof opts.repo === 'string' ? opts.repo.trim() : '';
  const current = String(opts.version || '');
  const fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;

  async function check() {
    if (!repo || !REPO_RE.test(repo)) return { ok: false, error: 'not-configured', current: current };
    if (!fetchImpl) return { ok: false, error: 'network', current: current };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl('https://api.github.com/repos/' + repo + '/releases/latest', {
        method: 'GET',
        headers: { 'User-Agent': 'marust-update-check', Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: controller ? controller.signal : undefined
      });
      if (!res || res.status === 404) return { ok: true, current: current, latest: '', newer: false, url: '', none: true };
      if (!res.ok) return { ok: false, error: 'network', current: current };
      const text = await res.text();
      if (typeof text !== 'string' || text.length > MAX_BODY) return { ok: false, error: 'bad-response', current: current };
      let data;
      try { data = JSON.parse(text); } catch (_) { return { ok: false, error: 'bad-response', current: current }; }
      const tag = data && typeof data.tag_name === 'string' ? data.tag_name : '';
      if (!parseVersion(tag)) return { ok: false, error: 'bad-response', current: current };
      const prefix = 'https://github.com/' + repo + '/';
      const url = data && typeof data.html_url === 'string' && data.html_url.indexOf(prefix) === 0 ? data.html_url : '';
      return { ok: true, current: current, latest: tag.replace(/^v/, ''), newer: isNewer(tag, current), url: url };
    } catch (err) {
      return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : 'network', current: current };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { check, configured: () => !!repo && REPO_RE.test(repo) };
}

module.exports = { createUpdateCheck, isNewer, parseVersion };
