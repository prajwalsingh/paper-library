// Thin wrapper around the Google Drive v3 REST API.
//
// Key idea for "updating directly on Drive": we never create a new file when
// saving. We PATCH the *content* of the same file ID, which Drive stores as a
// new revision. Links, sharing, folder location and comments stay the same,
// and older versions remain available under "Manage versions" in Drive.

import { getToken, invalidateToken, AuthError } from './auth.js';

export const API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const META_FIELDS =
  'id,name,mimeType,headRevisionId,modifiedTime,size,parents,webViewLink,' +
  'capabilities(canEdit,canDownload),shortcutDetails(targetId,targetMimeType),' +
  'lastModifyingUser(displayName,emailAddress),properties';

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// fetch() with the bearer token; on 401 renews the token once and retries.
export async function authedFetch(url, init = {}, retried = false) {
  const token = await getToken({ interactive: false });
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && !retried) {
    await invalidateToken();
    return authedFetch(url, init, true);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body.error?.message || msg;
    } catch {}
    if (res.status === 401) throw new AuthError(msg, 'needs-sign-in');
    throw new DriveError(msg, res.status);
  }
  return res;
}

export async function getAbout() {
  const res = await authedFetch(`${API}/about?fields=user(displayName,emailAddress,photoLink)`);
  return (await res.json()).user;
}

export async function getMetadata(fileId) {
  const res = await authedFetch(
    `${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${META_FIELDS}`
  );
  const meta = await res.json();
  // Drive shortcuts point at another file; follow them transparently.
  if (meta.mimeType === 'application/vnd.google-apps.shortcut' && meta.shortcutDetails?.targetId) {
    return getMetadata(meta.shortcutDetails.targetId);
  }
  return meta;
}

/** Downloads file bytes, reporting progress as (loadedBytes, totalBytes). */
export async function download(fileId, onProgress) {
  const res = await authedFetch(
    `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`
  );
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Replaces the file's content in place (creates a new Drive revision). */
export async function updateContent(fileId, bytes) {
  const res = await authedFetch(
    `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true` +
      `&fields=${META_FIELDS}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: bytes }
  );
  return res.json();
}

/** Creates a new PDF file (used for "Save a copy"). */
export async function createFile(name, bytes, parents) {
  const boundary = 'dph' + Math.random().toString(36).slice(2);
  const metadata = { name, mimeType: 'application/pdf', ...(parents?.length ? { parents } : {}) };
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Blob([head, bytes, tail]);
  const res = await authedFetch(
    `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${META_FIELDS}`,
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
  );
  return res.json();
}

/** Lists PDFs, most recently viewed first; optional name filter. */
export async function listPdfs(nameFilter = '') {
  let q = "mimeType='application/pdf' and trashed=false";
  if (nameFilter) q += ` and name contains '${nameFilter.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const params = new URLSearchParams({
    q,
    orderBy: 'viewedByMeTime desc',
    pageSize: '50',
    fields: 'files(id,name,modifiedTime,viewedByMeTime,size,owners(displayName))',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await authedFetch(`${API}/files?${params}`);
  return (await res.json()).files || [];
}

/** Extracts a Drive file ID from a link (or returns the input if it already is an ID). */
export function parseDriveId(text) {
  text = (text || '').trim();
  const m =
    text.match(/\/file\/d\/([\w-]{20,})/) ||
    text.match(/[?&]id=([\w-]{20,})/) ||
    text.match(/^([\w-]{20,})$/);
  return m ? m[1] : null;
}

/** Updates file metadata (name, starred, properties, …) without touching its content. */
export async function patchMetadata(fileId, body, query = '') {
  const res = await authedFetch(
    `${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id${query}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return res.json();
}
