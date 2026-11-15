// The paper library and PDF files in OneDrive, via Microsoft Graph.
//
// This module offers the same functions as drive.js (used by the viewer) and
// library-drive.js (used by the library), so the rest of the extension doesn't
// care which cloud it talks to. See js/provider.js.
//
// Design (and how it differs from Google Drive):
//   * Same folder layout: one "Paper Library" folder in your OneDrive, every
//     collection is a real folder under it.
//   * OneDrive has no hidden per-file "properties" that apps can write (Drive
//     does). So paper details (title, authors, year…), favourites, extra
//     collections and the trash record live in ONE small JSON file in the
//     library folder: ".paper-library.json", keyed by each file's OneDrive ID.
//     IDs stay the same when a file is moved or renamed.
//   * Two open tabs could both change that file. Every write sends the version
//     we last read ("If-Match: <eTag>"); if someone else wrote in between,
//     OneDrive answers 412, and we re-read the file and apply our change again.
//   * Trash: a paper moved to Trash goes into a hidden ".trash" folder inside
//     the library, so it can be listed and restored (Graph can't list
//     OneDrive's own recycle bin for personal accounts).
//   * A paper in a second collection: OneDrive has no shortcuts, so the extra
//     collection is remembered in the JSON file.
//   * Supplementary files sit in Paper Library/Supplementary/<paper name>/.
//     The index remembers that folder's ID (suppRoot, never shown as a
//     collection) and, per paper, its folder and file count: supp: { folder, n }.

import { getToken, invalidateToken, AuthError } from './ms-auth.js';
import { suppFolderName } from './supplementary.js';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
const ROOT_NAME = 'Paper Library';
const INDEX_NAME = '.paper-library.json';
const TRASH_NAME = '.trash';
const SELECT = 'id,name,size,file,folder,parentReference,createdDateTime,lastModifiedDateTime,lastModifiedBy,webUrl,eTag,cTag';
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024; // larger files go through an upload session
const CHUNK = 320 * 1024 * 32; // 10 MiB; Graph wants chunks in multiples of 320 KiB

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GraphError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** fetch() with the bearer token; renews once on 401, waits and retries on 429/503 (throttling). */
export async function authedFetch(url, init = {}, attempt = 0) {
  const token = await getToken({ interactive: false });
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && attempt === 0) {
    await invalidateToken();
    return authedFetch(url, init, 1);
  }
  if ((res.status === 429 || res.status === 503) && attempt < 3) {
    await sleep((Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000);
    return authedFetch(url, init, attempt + 1);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let code = '';
    try {
      const body = await res.json();
      msg = body.error?.message || msg;
      code = body.error?.code || '';
    } catch {}
    if (res.status === 401) throw new AuthError(msg, 'needs-sign-in');
    if (code === 'quotaLimitReached' || res.status === 507) throw new GraphError(await quotaMessage(), res.status);
    throw new GraphError(msg, res.status);
  }
  return res;
}

/** OneDrive is full: say how full, and what to do (Graph's own message is just "Quota limit reached"). */
async function quotaMessage() {
  const gb = (b) => (b / 1024 ** 3).toFixed(1) + ' GB';
  try {
    const { quota } = await (await authedFetch('/me/drive?$select=quota')).json();
    return (
      `Your OneDrive is full (${gb(quota.used)} of ${gb(quota.total)} used), so OneDrive refuses to create or save files. ` +
      'Free up space at onedrive.live.com (Outlook.com attachments count too), then click reload.'
    );
  } catch {
    return 'Your OneDrive is full, so OneDrive refuses to create or save files. Free up space, then click reload.';
  }
}

const json = async (url, init) => (await authedFetch(url, init)).json();
const jsonBody = (method, body, headers = {}) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Files (the viewer's side; same shapes as drive.js returns)
// ---------------------------------------------------------------------------

/** OneDrive item → the Drive-like file description the viewer expects. */
function toMeta(it) {
  const isPdf = /\.pdf$/i.test(it.name || '') || it.file?.mimeType === 'application/pdf';
  return {
    id: it.id,
    name: it.name,
    mimeType: it.folder ? 'folder' : isPdf ? 'application/pdf' : it.file?.mimeType || '',
    // cTag changes only when the *content* changes, which is what the
    // "file changed elsewhere?" check needs.
    headRevisionId: it.cTag || it.eTag,
    modifiedTime: it.lastModifiedDateTime,
    size: it.size,
    parents: it.parentReference?.id ? [it.parentReference.id] : [],
    webViewLink: it.webUrl,
    capabilities: { canEdit: true, canDownload: true },
    lastModifyingUser: { displayName: it.lastModifiedBy?.user?.displayName || '' },
  };
}

export async function getAbout() {
  const u = await json('/me?$select=displayName,mail,userPrincipalName');
  return { displayName: u.displayName, emailAddress: u.mail || u.userPrincipalName };
}

const getItem = (id) => json(`/me/drive/items/${enc(id)}`);

export async function getMetadata(id) {
  return toMeta(await getItem(id));
}

/** Reads a response body, reporting progress as (loadedBytes, totalBytes). */
async function readWithProgress(res, total, onProgress) {
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

/**
 * Downloads a file. Graph gives every file a short-lived, pre-signed download
 * link on Microsoft's storage servers (*.1drv.com / *.sharepoint.com); it
 * needs no token, so none is sent there.
 */
export async function download(id, onProgress) {
  const it = await getItem(id);
  const url = it['@microsoft.graph.downloadUrl'];
  if (!url) throw new GraphError('OneDrive did not return a download link for this file.', 0);
  const res = await fetch(url);
  if (!res.ok) throw new GraphError(`Download failed: ${res.status}`, res.status);
  return readWithProgress(res, it.size || Number(res.headers.get('Content-Length')) || 0, onProgress);
}

/** Uploads bytes through an upload session, in chunks (any size, with progress). */
async function uploadSession(sessionPath, body, data, onProgress) {
  const { uploadUrl } = await json(sessionPath, jsonBody('POST', body));
  const total = data.size;
  let item = null;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total);
    item = await new Promise((resolve, reject) => {
      // XMLHttpRequest because, unlike fetch, it reports upload progress.
      // The upload URL is pre-signed: no Authorization header (Graph rejects one).
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(start + e.loaded, total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.status === 202 ? null : JSON.parse(xhr.responseText));
        else reject(new GraphError(`Upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`, xhr.status));
      };
      xhr.onerror = () => reject(new GraphError('Network error during upload', 0));
      xhr.send(data.slice(start, end));
    });
  }
  return item;
}

/** Replaces the file's content in place (OneDrive keeps the old one in its version history). */
export async function updateContent(id, bytes) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/pdf' });
  if (blob.size <= SIMPLE_UPLOAD_MAX) {
    return toMeta(await json(`/me/drive/items/${enc(id)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: blob,
    }));
  }
  const item = await uploadSession(`/me/drive/items/${enc(id)}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'replace' } }, blob);
  return toMeta(item || (await getItem(id)));
}

/** Creates a new PDF ("Save a copy"); a name clash gets a number added. */
export async function createFile(name, bytes, parents) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/pdf' });
  const where = parents?.[0] ? `/me/drive/items/${enc(parents[0])}:/${enc(name)}:` : `/me/drive/root:/${enc(name)}:`;
  if (blob.size <= SIMPLE_UPLOAD_MAX) {
    return toMeta(await json(`${where}/content?@microsoft.graph.conflictBehavior=rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: blob,
    }));
  }
  return toMeta(await uploadSession(`${where}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'rename' } }, blob));
}

// ---------------------------------------------------------------------------
// The library index (.paper-library.json)
// ---------------------------------------------------------------------------
let root = null; // { id, name }
let trashFolder = null; // { id }
let index = null; // { etag, data: { app, version, papers: { [id]: entry } } }
let writes = Promise.resolve(); // index writes from this page, one after another
const kinds = new Map(); // id → 'folder' | 'paper' (from the last load)

const emptyIndex = () => ({ app: 'paper-library', version: 1, papers: {} });

async function readIndex() {
  const r = await ensureRoot();
  try {
    const it = await json(`/me/drive/items/${enc(r.id)}:/${enc(INDEX_NAME)}`);
    const res = await fetch(it['@microsoft.graph.downloadUrl']);
    const data = await res.json();
    index = { etag: it.eTag, data: data?.papers ? data : emptyIndex() };
  } catch (e) {
    if (e.status !== 404) throw e;
    index = { etag: null, data: emptyIndex() };
  }
  return index;
}

/**
 * Applies `change(data)` to the index and saves it. If another tab or computer
 * saved in between (412), re-reads and applies the change again.
 */
function updateIndex(change) {
  const run = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!index) await readIndex();
      change(index.data);
      const headers = { 'Content-Type': 'application/json' };
      if (index.etag) headers['If-Match'] = index.etag;
      const conflict = index.etag ? '' : '?@microsoft.graph.conflictBehavior=fail';
      try {
        const it = await json(`/me/drive/items/${enc(root.id)}:/${enc(INDEX_NAME)}:/content${conflict}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(index.data),
        });
        index.etag = it.eTag;
        return;
      } catch (e) {
        if (e.status !== 412 && e.status !== 409) throw e;
        index = null; // someone else wrote it: start again from their version
        await sleep(200 + Math.random() * 400);
      }
    }
    throw new GraphError('Could not save the library index (too many simultaneous changes). Try again.', 409);
  };
  writes = writes.then(run, run);
  return writes;
}

function entry(data, id) {
  return (data.papers[id] ||= {});
}

function detailsOf(e = {}) {
  return {
    title: e.title || '',
    authors: e.authors || [],
    year: e.year ? Number(e.year) : null,
    source: e.source || '',
    doi: e.doi || null,
    arxivId: e.arxivId || null,
    status: e.status || null, // 'auto' | 'manual' | 'failed' | null (= not read yet)
    lastRead: e.lastRead || null,
  };
}

/** Paper details for the viewer's Markdown export. */
export async function paperDetails(meta) {
  if (!index) await readIndex();
  return detailsOf(index.data.papers[meta.id]);
}

// ---------------------------------------------------------------------------
// Root folder
// ---------------------------------------------------------------------------
export async function ensureRoot() {
  if (root) return root;
  const { msLibraryRootId } = await chrome.storage.local.get('msLibraryRootId');
  if (msLibraryRootId) {
    try {
      const it = await getItem(msLibraryRootId);
      if (it.folder) return (root = { id: it.id, name: it.name, webViewLink: it.webUrl });
    } catch {}
  }
  let it;
  try {
    it = await json(`/me/drive/root:/${enc(ROOT_NAME)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    it = await json('/me/drive/root/children', jsonBody('POST', { name: ROOT_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }));
  }
  await chrome.storage.local.set({ msLibraryRootId: it.id });
  return (root = { id: it.id, name: it.name, webViewLink: it.webUrl });
}

async function ensureTrash() {
  if (trashFolder) return trashFolder;
  const r = await ensureRoot();
  let it;
  try {
    it = await json(`/me/drive/items/${enc(r.id)}:/${enc(TRASH_NAME)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    it = await json(`/me/drive/items/${enc(r.id)}/children`, jsonBody('POST', { name: TRASH_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }));
  }
  return (trashFolder = { id: it.id });
}

// ---------------------------------------------------------------------------
// Loading the whole library
// ---------------------------------------------------------------------------
async function children(id) {
  const out = [];
  let url = `/me/drive/items/${enc(id)}/children?$top=500&$select=${SELECT}`;
  while (url) {
    const body = await json(url);
    out.push(...body.value);
    url = body['@odata.nextLink'] || '';
  }
  return out;
}

const isPdfItem = (it) => it.file && /\.pdf$/i.test(it.name);
const hidden = (it) => it.name.startsWith('.');

// A "shortcut" id names the paper and the extra collection: also|<paperId>|<folderId>
const shortcutId = (paperId, folderId) => `also|${paperId}|${folderId}`;

function toPaper(it, e) {
  const parentId = it.parentReference?.id || null;
  const hashes = it.file?.hashes || {};
  const also = (e?.also || []).filter((f) => f !== parentId);
  return {
    id: it.id,
    name: it.name,
    size: Number(it.size) || 0,
    // Any content hash works for spotting duplicates (OneDrive has no MD5).
    md5: hashes.quickXorHash || hashes.sha1Hash || hashes.sha256Hash || null,
    created: it.createdDateTime,
    modified: it.lastModifiedDateTime,
    starred: !!e?.starred,
    parentId,
    collections: [parentId, ...also].filter(Boolean),
    shortcuts: also.map((f) => ({ id: shortcutId(it.id, f), parentId: f })),
    meta: detailsOf(e),
    suppCount: e?.supp?.n || 0,
    webViewLink: it.webUrl,
  };
}

/** Same result shape as library-drive.js: { root, folders, papers, trashed }. */
export async function loadLibrary() {
  root = null;
  trashFolder = null;
  const r = await ensureRoot();
  await readIndex();
  kinds.clear();

  // Walk the folder tree level by level, a few folders at a time.
  const folders = [];
  const items = [];
  let trashId = null;
  let level = [r.id];
  while (level.length) {
    const next = [];
    for (let i = 0; i < level.length; i += 6) {
      const lists = await Promise.all(level.slice(i, i + 6).map(children));
      for (const it of lists.flat()) {
        if (it.folder) {
          if (it.name === TRASH_NAME && it.parentReference?.id === r.id) {
            trashId = it.id;
            continue;
          }
          if (hidden(it) || it.id === index.data.suppRoot) continue; // supplementary files are not a collection
          folders.push({ id: it.id, name: it.name, parentId: it.parentReference?.id });
          kinds.set(it.id, 'folder');
          next.push(it.id);
        } else if (isPdfItem(it)) {
          items.push(it);
        }
      }
    }
    level = next;
  }
  if (trashId) trashFolder = { id: trashId };

  const papers = items.map((it) => {
    kinds.set(it.id, 'paper');
    return toPaper(it, index.data.papers[it.id]);
  });
  // A second collection that no longer exists is simply ignored.
  const folderIds = new Set([r.id, ...folders.map((f) => f.id)]);
  for (const p of papers) {
    p.shortcuts = p.shortcuts.filter((s) => folderIds.has(s.parentId));
    p.collections = p.collections.filter((c) => folderIds.has(c));
  }
  const trashed = trashId ? (await children(trashId)).filter(isPdfItem).map((it) => {
    kinds.set(it.id, 'paper');
    return toPaper(it, index.data.papers[it.id]);
  }) : [];
  return { root: r, folders, papers, trashed };
}

// ---------------------------------------------------------------------------
// Collections (folders) and moving things around
// ---------------------------------------------------------------------------
export async function createFolder(name, parentId) {
  const it = await json(`/me/drive/items/${enc(parentId)}/children`, jsonBody('POST', { name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }));
  kinds.set(it.id, 'folder');
  return { id: it.id, name: it.name, parentId };
}

export async function renameItem(id, name) {
  return json(`/me/drive/items/${enc(id)}`, jsonBody('PATCH', { name }));
}

/** Moves a file or folder to another folder (a name clash gets a number added). */
export async function moveItem(id, fromParentId, toParentId) {
  if (fromParentId === toParentId) return;
  return json(`/me/drive/items/${enc(id)}?@microsoft.graph.conflictBehavior=rename`, jsonBody('PATCH', { parentReference: { id: toParentId } }));
}

async function isFolder(id) {
  if (kinds.has(id)) return kinds.get(id) === 'folder';
  return !!(await getItem(id)).folder;
}

/**
 * Papers go to the library's hidden .trash folder (restorable from Trash).
 * A deleted collection goes to OneDrive's recycle bin; the library has already
 * moved its papers out by then.
 */
export async function trashItem(id) {
  if (await isFolder(id)) {
    await authedFetch(`/me/drive/items/${enc(id)}`, { method: 'DELETE' });
    return;
  }
  const it = await getItem(id);
  const t = await ensureTrash();
  await moveItem(id, null, t.id);
  await updateIndex((d) => {
    entry(d, id).trash = { from: it.parentReference?.id || null, at: new Date().toISOString() };
  });
}

export async function restoreItem(id) {
  if (!index) await readIndex();
  const from = index.data.papers[id]?.trash?.from;
  let target = (await ensureRoot()).id;
  if (from) {
    try {
      const f = await getItem(from);
      if (f.folder) target = f.id;
    } catch {} // the collection was deleted meanwhile: restore to the top level
  }
  await moveItem(id, null, target);
  await updateIndex((d) => {
    delete entry(d, id).trash;
  });
}

/**
 * Deletes a paper for good. Graph's permanentDelete skips OneDrive's recycle
 * bin, but Microsoft's docs disagree on whether personal accounts support it.
 * If OneDrive refuses, the file goes to OneDrive's recycle bin instead (emptied
 * by OneDrive after 30 days), and we report that honestly.
 */
export async function deleteForever(id) {
  if (!index) await readIndex();
  const suppId = index.data.papers[id]?.supp?.folder;
  let permanent = await removeItem(id);
  if (suppId) permanent = (await removeItem(suppId).catch(() => true)) && permanent; // with its files
  kinds.delete(id);
  await updateIndex((d) => {
    delete d.papers[id];
  });
  return { permanent, recycleBinUrl: permanent ? null : recycleBinUrl() };
}

/** permanentDelete, or the recycle bin if OneDrive refuses. Returns whether it was permanent. */
async function removeItem(id) {
  try {
    await authedFetch(`/me/drive/items/${enc(id)}/permanentDelete`, { method: 'POST' });
    return true;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    try {
      await authedFetch(`/me/drive/items/${enc(id)}`, { method: 'DELETE' });
    } catch (e2) {
      if (e2.status !== 404) throw e2; // 404: already gone
    }
    return false;
  }
}

/** Where the user empties OneDrive's recycle bin (personal vs work/school OneDrive). */
export function recycleBinUrl() {
  const m = (root?.webViewLink || '').match(/^(https:\/\/[^/]+\.sharepoint\.com\/personal\/[^/]+)/);
  return m ? `${m[1]}/_layouts/15/RecycleBin.aspx` : 'https://onedrive.live.com/?v=recyclebin';
}

export const setStarred = (id, starred) =>
  updateIndex((d) => {
    if (starred) entry(d, id).starred = true;
    else delete entry(d, id).starred;
  });

/** A paper in a second collection (OneDrive has no shortcuts, so it's noted in the index). */
export async function addShortcut(targetId, parentId) {
  await updateIndex((d) => {
    const e = entry(d, targetId);
    e.also = [...new Set([...(e.also || []), parentId])];
  });
  return { id: shortcutId(targetId, parentId), parentId };
}

export async function deleteShortcut(id) {
  const [, paperId, folderId] = id.split('|');
  await updateIndex((d) => {
    const e = d.papers[paperId];
    if (e?.also) e.also = e.also.filter((f) => f !== folderId);
  });
}

// ---------------------------------------------------------------------------
// Paper details
// ---------------------------------------------------------------------------
export function saveMeta(id, meta, status = 'manual') {
  return updateIndex((d) => {
    const e = entry(d, id);
    Object.assign(e, {
      title: meta.title || '',
      authors: meta.authors || [],
      year: meta.year || null,
      source: meta.source || '',
      doi: meta.doi || null,
      arxivId: meta.arxivId || null,
      status,
    });
  });
}

export const markMetaFailed = (id) =>
  updateIndex((d) => {
    entry(d, id).status = 'failed';
  });

export const markRead = (id, when = new Date()) =>
  updateIndex((d) => {
    entry(d, id).lastRead = when.toISOString();
  });

// ---------------------------------------------------------------------------
// Upload and partial reading
// ---------------------------------------------------------------------------
export async function uploadPdf(blob, name, parentId, properties, onProgress) {
  const it = await uploadSession(
    `/me/drive/items/${enc(parentId)}:/${enc(name)}:/createUploadSession`,
    { item: { '@microsoft.graph.conflictBehavior': 'rename' } },
    blob,
    onProgress
  );
  kinds.set(it.id, 'paper');
  if (!index) await readIndex();
  return toPaper(it, index.data.papers[it.id]);
}

/**
 * Opens a OneDrive PDF with PDF.js without downloading all of it (PDF.js asks
 * the pre-signed download link for byte ranges).
 */
export async function pdfSource(id) {
  const it = await getItem(id);
  return { url: it['@microsoft.graph.downloadUrl'], disableAutoFetch: true, disableStream: true };
}

/** Pulls a OneDrive item ID out of what the user typed (we only accept IDs). */
export function parseDriveId(text) {
  const t = (text || '').trim();
  return /^[\w!.-]{10,}$/.test(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Supplementary files
// ---------------------------------------------------------------------------

/** Number of supplementary files, for the viewer's "Open with supplementary" item. */
export async function suppCount(meta) {
  if (!index) await readIndex();
  return index.data.papers[meta.id]?.supp?.n || 0;
}

const exists = async (id) => {
  try {
    return !!(await getItem(id)).folder;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
};

/** The paper's own folder ID (null if none); created when `paper` is given. */
async function suppFolder(paperId, paper = null) {
  if (!index) await readIndex();
  const known = index.data.papers[paperId]?.supp?.folder;
  if (known && (await exists(known))) return known;
  if (!paper) return null;
  const r = await ensureRoot();
  let rootId = index.data.suppRoot;
  if (!rootId || !(await exists(rootId))) {
    rootId = (await json(`/me/drive/items/${enc(r.id)}/children`, jsonBody('POST', { name: 'Supplementary', folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }))).id;
    await updateIndex((d) => {
      d.suppRoot = rootId;
    });
  }
  const it = await json(`/me/drive/items/${enc(rootId)}/children`, jsonBody('POST', { name: suppFolderName(paper), folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }));
  await updateIndex((d) => {
    entry(d, paperId).supp = { folder: it.id, n: 0 };
  });
  return it.id;
}

const toSupp = (it) => ({ id: it.id, name: it.name, mimeType: it.file?.mimeType || '', size: Number(it.size) || 0, modified: it.lastModifiedDateTime, webViewLink: it.webUrl });
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The paper's supplementary files, sorted by name ("File S2" before "File S10").
 * If `knownCount` differs (files added or removed in OneDrive itself), the badge count is corrected.
 */
export async function listSupplementary(paperId, knownCount = null) {
  const folder = await suppFolder(paperId);
  const files = folder ? (await children(folder)).filter((it) => it.file).map(toSupp).sort(byName) : [];
  if (knownCount != null && knownCount !== files.length) await setCount(paperId, files.length).catch(() => {});
  return files;
}

const setCount = (paperId, n) =>
  updateIndex((d) => {
    const e = entry(d, paperId);
    if (e.supp) e.supp.n = n;
  });

async function recount(paperId) {
  const n = (await listSupplementary(paperId)).length;
  await setCount(paperId, n);
  return n;
}

/** Uploads one file (any type) to the paper's folder. Returns { file, count }. */
export async function uploadSupplementary(paper, file, onProgress) {
  const folder = await suppFolder(paper.id, paper);
  const it = file.size <= SIMPLE_UPLOAD_MAX // small (or empty) files in one request
    ? await json(`/me/drive/items/${enc(folder)}:/${enc(file.name)}:/content?@microsoft.graph.conflictBehavior=rename`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
    : await uploadSession(
    `/me/drive/items/${enc(folder)}:/${enc(file.name)}:/createUploadSession`,
    { item: { '@microsoft.graph.conflictBehavior': 'rename' } },
    file,
    onProgress
  );
  return { file: toSupp(it), count: await recount(paper.id) };
}

export const renameSupplementary = (fileId, name) => renameItem(fileId, name);

/** Moves the file to OneDrive's recycle bin (restorable there). Returns the new count. */
export async function deleteSupplementary(paperId, fileId) {
  try {
    await authedFetch(`/me/drive/items/${enc(fileId)}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return recount(paperId);
}
