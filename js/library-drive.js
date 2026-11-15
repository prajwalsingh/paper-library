// The paper library, stored entirely in Google Drive.
//
// Design (why it looks like this):
//   * One root folder, "Paper Library", in My Drive. Every collection is a real
//     Drive folder under it, so the library is still neatly organised when you
//     browse Drive without this extension.
//   * Paper details (title, authors, year, source, DOI…) are saved ON the PDF
//     file as Drive "properties": small hidden key/value pairs attached to a
//     file. They travel with the file when it is moved or renamed, and there is
//     no separate database that could get out of sync.
//   * Drive limits each property to 124 bytes (key + value) and a file to 30
//     properties per app, so long values (titles, author lists) are split into
//     numbered chunks: dphT0, dphT1, …
//   * A file can live in only one Drive folder. Putting a paper into a second
//     collection creates a Drive *shortcut* there (one file, two places).

import { API, UPLOAD, authedFetch, patchMetadata } from './drive.js';
import { getToken } from './auth.js';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const PDF = 'application/pdf';
const ROOT_NAME = 'Paper Library';
const FILE_FIELDS =
  'id,name,mimeType,parents,size,md5Checksum,createdTime,modifiedTime,starred,trashed,properties,' +
  'shortcutDetails(targetId,targetMimeType),webViewLink';

// ---------------------------------------------------------------------------
// Metadata <-> Drive properties
// ---------------------------------------------------------------------------
const MAX_CHUNKS = { T: 4, A: 13, S: 3, D: 2 }; // title, authors, source, DOI
const CHUNK_BYTES = 110; // 124 minus the key ("dphA12") with some headroom
const enc = new TextEncoder();

function splitByBytes(text, maxChunks) {
  const chunks = [];
  let cur = '';
  for (const ch of text) {
    if (enc.encode(cur + ch).length > CHUNK_BYTES) {
      chunks.push(cur);
      cur = '';
      if (chunks.length === maxChunks) return { chunks, truncated: true };
    }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  return { chunks, truncated: false };
}

function chunked(prefix, text, out) {
  const { chunks } = splitByBytes(text || '', MAX_CHUNKS[prefix]);
  for (let i = 0; i < MAX_CHUNKS[prefix]; i++) out[`dph${prefix}${i}`] = chunks[i] ?? null; // null deletes
}

function unchunk(props, prefix) {
  let s = '';
  for (let i = 0; i < MAX_CHUNKS[prefix]; i++) s += props[`dph${prefix}${i}`] || '';
  return s;
}

/** meta -> properties object for files.update (null values delete stale chunks). */
export function encodeMeta(meta, status = 'auto') {
  const props = { dphLib: '1', dphMv: status };
  chunked('T', meta.title || '', props);
  // Authors are joined with ";" because each name already contains a comma ("Last, First").
  let authors = (meta.authors || []).join('; ');
  const { truncated } = splitByBytes(authors, MAX_CHUNKS.A);
  if (truncated) {
    // Keep as many whole names as fit, then mark the rest.
    const names = [...(meta.authors || [])];
    while (names.length > 1 && splitByBytes(names.join('; ') + '; et al.', MAX_CHUNKS.A).truncated) names.pop();
    authors = names.join('; ') + '; et al.';
  }
  chunked('A', authors, props);
  chunked('S', meta.source || '', props);
  chunked('D', meta.doi || '', props);
  props.dphY = meta.year ? String(meta.year) : null;
  props.dphX = meta.arxivId || null;
  return props;
}

export function decodeMeta(props = {}) {
  const authors = unchunk(props, 'A');
  return {
    title: unchunk(props, 'T'),
    authors: authors ? authors.split('; ').filter(Boolean) : [],
    year: props.dphY ? Number(props.dphY) : null,
    source: unchunk(props, 'S'),
    doi: unchunk(props, 'D') || null,
    arxivId: props.dphX || null,
    status: props.dphMv || null, // 'auto' | 'manual' | 'failed' | null (= not read yet)
    lastRead: props.dphLr || null,
  };
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------
async function listAll(q, fields = FILE_FIELDS) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q,
      fields: `nextPageToken,files(${fields})`,
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await authedFetch(`${API}/files?${params}`);
    const body = await res.json();
    files.push(...(body.files || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return files;
}

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function parentsClause(ids) {
  return '(' + ids.map((id) => `${quote(id)} in parents`).join(' or ') + ')';
}

async function inBatches(ids, size, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

async function createResource(body) {
  const res = await authedFetch(`${API}/files?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Root folder
// ---------------------------------------------------------------------------
/**
 * Finds the library root folder, creating it on first use. The folder carries
 * the property dphRoot=1 so it is found again on another computer, even if
 * you rename it.
 */
export async function ensureRoot() {
  const { libraryRootId } = await chrome.storage.local.get('libraryRootId');
  if (libraryRootId) {
    try {
      const res = await authedFetch(`${API}/files/${libraryRootId}?fields=id,name,trashed&supportsAllDrives=true`);
      const f = await res.json();
      if (!f.trashed) return f;
    } catch {}
  }
  const found = await listAll(
    `mimeType='${FOLDER}' and trashed=false and properties has { key='dphRoot' and value='1' }`,
    'id,name,createdTime'
  );
  let root = found.sort((a, b) => a.createdTime.localeCompare(b.createdTime))[0];
  if (!root) root = await createResource({ name: ROOT_NAME, mimeType: FOLDER, properties: { dphRoot: '1' } });
  await chrome.storage.local.set({ libraryRootId: root.id });
  return root;
}

// ---------------------------------------------------------------------------
// Loading the whole library
// ---------------------------------------------------------------------------
/**
 * Returns { root, folders: [{id,name,parentId}], papers: [paper], trashed: [paper] }
 * paper = { id, name, size, md5, created, modified, starred, parentId,
 *           collections: [folderId...], shortcuts: [{id, parentId}], meta, webViewLink }
 */
export async function loadLibrary() {
  const root = await ensureRoot();

  // 1. Folder tree, one level at a time (Drive can't search a folder recursively).
  const folders = [];
  let level = [root.id];
  while (level.length) {
    const kids = await inBatches(level, 40, (ids) =>
      listAll(`mimeType='${FOLDER}' and trashed=false and ${parentsClause(ids)}`, 'id,name,parents')
    );
    for (const f of kids) folders.push({ id: f.id, name: f.name, parentId: f.parents?.[0] });
    level = kids.map((f) => f.id);
  }

  // 2. PDFs and shortcuts in any of those folders.
  const allFolderIds = [root.id, ...folders.map((f) => f.id)];
  const items = await inBatches(allFolderIds, 40, (ids) =>
    listAll(`trashed=false and (mimeType='${PDF}' or mimeType='${SHORTCUT}') and ${parentsClause(ids)}`)
  );

  const papers = new Map();
  const shortcuts = [];
  for (const f of items) {
    if (f.mimeType === PDF) papers.set(f.id, toPaper(f));
    else if (f.shortcutDetails?.targetMimeType === PDF) shortcuts.push(f);
  }
  // Shortcuts whose target lives outside the library tree: fetch the target too.
  const missing = [...new Set(shortcuts.map((s) => s.shortcutDetails.targetId))].filter((id) => !papers.has(id));
  for (const id of missing) {
    try {
      const res = await authedFetch(`${API}/files/${id}?supportsAllDrives=true&fields=${FILE_FIELDS}`);
      const f = await res.json();
      if (!f.trashed) papers.set(f.id, toPaper(f));
    } catch {}
  }
  for (const s of shortcuts) {
    const p = papers.get(s.shortcutDetails.targetId);
    if (!p) continue;
    p.shortcuts.push({ id: s.id, parentId: s.parents?.[0] });
    if (!p.collections.includes(s.parents?.[0])) p.collections.push(s.parents?.[0]);
  }

  // 3. Trash: library papers (tagged dphLib=1) that are in Drive's trash.
  const trashed = (
    await listAll(`trashed=true and mimeType='${PDF}' and properties has { key='dphLib' and value='1' }`)
  ).map(toPaper);

  return { root, folders, papers: [...papers.values()], trashed };
}

function toPaper(f) {
  return {
    id: f.id,
    name: f.name,
    size: Number(f.size) || 0,
    md5: f.md5Checksum || null,
    created: f.createdTime,
    modified: f.modifiedTime,
    starred: !!f.starred,
    parentId: f.parents?.[0] || null,
    collections: f.parents ? [...f.parents] : [],
    shortcuts: [],
    meta: decodeMeta(f.properties),
    webViewLink: f.webViewLink,
  };
}

// ---------------------------------------------------------------------------
// Collections (folders)
// ---------------------------------------------------------------------------
export async function createFolder(name, parentId) {
  const f = await createResource({ name, mimeType: FOLDER, parents: [parentId] });
  return { id: f.id, name: f.name, parentId };
}

export const renameItem = (id, name) => patchMetadata(id, { name });
export const trashItem = (id) => patchMetadata(id, { trashed: true });
export const restoreItem = (id) => patchMetadata(id, { trashed: false });
export const setStarred = (id, starred) => patchMetadata(id, { starred });

/** Moves a file or folder to another folder. */
export async function moveItem(id, fromParentId, toParentId) {
  if (fromParentId === toParentId) return;
  const q = `&addParents=${encodeURIComponent(toParentId)}` + (fromParentId ? `&removeParents=${encodeURIComponent(fromParentId)}` : '');
  return patchMetadata(id, {}, q);
}

/** Puts a paper into an extra collection as a Drive shortcut. */
export async function addShortcut(targetId, parentId, name) {
  const f = await createResource({ name, mimeType: SHORTCUT, shortcutDetails: { targetId }, parents: [parentId] });
  return { id: f.id, parentId };
}

/** Removes a shortcut for good (it is only a pointer; the paper itself stays). */
export async function deleteShortcut(id) {
  await authedFetch(`${API}/files/${id}?supportsAllDrives=true`, { method: 'DELETE' });
}

/**
 * Deletes a paper for good: skips Drive's trash, so it can't be restored. Its
 * shortcuts in other collections are removed too, so none are left pointing at nothing.
 */
export async function deleteForever(id) {
  try {
    for (const sc of await listAll(`shortcutDetails.targetId=${quote(id)}`, 'id')) {
      await authedFetch(`${API}/files/${sc.id}?supportsAllDrives=true`, { method: 'DELETE' }).catch(() => {});
    }
  } catch {} // shortcuts are tidy-up only
  await authedFetch(`${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'DELETE' });
  return { permanent: true };
}

// ---------------------------------------------------------------------------
// Paper details
// ---------------------------------------------------------------------------
export async function saveMeta(id, meta, status = 'manual') {
  return patchMetadata(id, { properties: encodeMeta(meta, status) });
}

export async function markMetaFailed(id) {
  return patchMetadata(id, { properties: { dphLib: '1', dphMv: 'failed' } });
}

export async function markRead(id, when = new Date()) {
  return patchMetadata(id, { properties: { dphLr: when.toISOString() } });
}

// ---------------------------------------------------------------------------
// Upload (resumable, with progress)
// ---------------------------------------------------------------------------
/**
 * Uploads a PDF into a folder. Uses Drive's "resumable" protocol: first we
 * announce the file (name, folder, size) and get an upload URL back, then we
 * send the bytes. XMLHttpRequest is used because, unlike fetch, it reports
 * upload progress.
 */
export async function uploadPdf(blob, name, parentId, properties, onProgress) {
  const init = await authedFetch(
    `${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': PDF,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({ name, mimeType: PDF, parents: [parentId], properties: { dphLib: '1', ...properties } }),
    }
  );
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new Error('Drive did not return an upload URL');
  const token = await getToken();
  const file = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', PDF);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(blob);
  });
  return toPaper(file);
}

/**
 * Opens a Drive PDF with PDF.js *without downloading all of it*: PDF.js asks
 * for byte ranges, and a paper's first page + info usually sit in the first
 * few hundred KB. Used to read details of papers already in Drive.
 */
export async function pdfSource(id) {
  const token = await getToken();
  return {
    url: `${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    httpHeaders: { Authorization: `Bearer ${token}` },
    disableAutoFetch: true,
    disableStream: true,
  };
}

/** Paper details for the viewer's Markdown export (Drive keeps them on the file itself). */
export async function paperDetails(meta) {
  return decodeMeta(meta.properties);
}
