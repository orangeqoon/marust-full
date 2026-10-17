'use strict';

/**
 * 金庫の「行」の形と検査。核（vault.js）と置き場（vault-store-file.js・差し替えの置き場）が同じ物差しを使う。
 * 行 = { name, ciphertext(base64), backend, updatedAt, size }。値（平文）の欄は持たない。
 */

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SECRET_BYTES = 64 * 1024;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BACKEND_RE = /^[a-z0-9-]{1,40}$/;

function hasValueField(row) {
  return !!row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, 'value');
}

function normalizeEntry(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (typeof row.name !== 'string' || !NAME_RE.test(row.name)) return null;
  if (typeof row.ciphertext !== 'string' || !B64_RE.test(row.ciphertext)) return null;
  if (row.ciphertext.length % 4 !== 0) return null;
  if (!Number.isFinite(row.size) || row.size < 0 || row.size > MAX_SECRET_BYTES) return null;
  const backendName = typeof row.backend === 'string' && BACKEND_RE.test(row.backend) ? row.backend : '';
  return {
    name: row.name,
    ciphertext: row.ciphertext,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    size: row.size,
    backend: backendName
  };
}

function sortedRows(map) {
  const rows = [];
  for (const row of map.values()) {
    rows.push({
      name: row.name,
      ciphertext: row.ciphertext,
      updatedAt: row.updatedAt,
      size: row.size,
      backend: row.backend || ''
    });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

module.exports = { NAME_RE, MAX_SECRET_BYTES, B64_RE, BACKEND_RE, hasValueField, normalizeEntry, sortedRows };
