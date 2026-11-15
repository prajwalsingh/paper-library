// Tests the Google Drive side of supplementary files (js/library-drive.js) against
// a small in-memory fake of the Drive API (no account needed).
//   node dev/tests/drive.test.mjs
import assert from 'node:assert/strict';

// ---------- fake chrome storage (a valid token, so no sign-in) ----------
const mem = { local: {}, session: { authToken: { token: 'T', expires: Date.now() + 3600e3 } } };
const area = (o) => ({
  async get(k) { const keys = typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(o); return Object.fromEntries(keys.filter((x) => x in o).map((x) => [x, o[x]])); },
  async set(v) { Object.assign(o, v); },
  async remove(k) { for (const x of [].concat(k)) delete o[x]; },
});
globalThis.chrome = { storage: { local: area(mem.local), session: area(mem.session) }, identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' } };

// ---------- fake Drive ----------
const FOLDER = 'application/vnd.google-apps.folder';
let n = 0;
const files = new Map();
function mk(f) {
  const id = 'F' + ++n;
  const file = { id, trashed: false, starred: false, properties: {}, parents: [], createdTime: new Date(Date.now() + n).toISOString(), modifiedTime: new Date().toISOString(), webViewLink: `https://drive.google.com/file/d/${id}/view`, ...f };
  file.properties = Object.fromEntries(Object.entries(file.properties || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  files.set(id, file);
  return file;
}
const out = (f) => ({ ...f, size: f.size == null ? undefined : String(f.size) });
const J = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Turns the Drive query subset the extension uses into a JS predicate. */
function predicate(q) {
  const js = q
    .replace(/properties has \{ key='([^']*)' and value='([^']*)' \}/g, "P('$1','$2')")
    .replace(/shortcutDetails\.targetId='([^']*)'/g, "f.shortcutDetails?.targetId==='$1'")
    .replace(/'([^']*)' in parents/g, "f.parents.includes('$1')")
    .replace(/mimeType!='([^']*)'/g, "f.mimeType!=='$1'")
    .replace(/mimeType='([^']*)'/g, "f.mimeType==='$1'")
    .replace(/trashed=false/g, '!f.trashed')
    .replace(/trashed=true/g, 'f.trashed')
    .replace(/ and /g, ' && ')
    .replace(/ or /g, ' || ');
  return new Function('f', `const P=(k,v)=>f.properties[k]===v; return ${js};`);
}
const log = [];
const uploads = new Map();

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method || 'GET';
  assert.equal(init.headers?.Authorization, 'Bearer T');
  log.push(`${method} ${u.pathname}`);
  if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
    const sid = 'u' + ++n;
    uploads.set(sid, JSON.parse(init.body));
    return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/session/${sid}` } });
  }
  const m = u.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
  if (!m) throw new Error('unrouted ' + u.pathname);
  const id = m[1] && decodeURIComponent(m[1]);
  if (!id && method === 'GET') return J(200, { files: [...files.values()].filter(predicate(u.searchParams.get('q'))).map(out) });
  if (!id && method === 'POST') return J(200, out(mk(JSON.parse(init.body))));
  const f = files.get(id);
  if (!f) return J(404, { error: { message: 'File not found' } });
  if (method === 'GET') return J(200, out(f));
  if (method === 'PATCH') {
    const b = JSON.parse(init.body);
    if (b.name) f.name = b.name;
    if ('trashed' in b) f.trashed = b.trashed;
    for (const [k, v] of Object.entries(b.properties || {})) v == null ? delete f.properties[k] : (f.properties[k] = String(v));
    const add = u.searchParams.get('addParents');
    const rem = u.searchParams.get('removeParents');
    if (add) f.parents = [...f.parents.filter((p) => p !== rem), add];
    return J(200, { id: f.id });
  }
  if (method === 'DELETE') {
    const del = (x) => { for (const c of [...files.values()].filter((y) => y.parents.includes(x))) del(c.id); files.delete(x); };
    del(id);
    return new Response(null, { status: 204 });
  }
  throw new Error('unhandled ' + method + ' ' + u.pathname);
};

globalThis.XMLHttpRequest = class {
  constructor() { this.upload = {}; this.h = {}; }
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.h[k.toLowerCase()] = v; }
  async send(blob) {
    const meta = uploads.get(this.url.split('/').pop());
    assert.equal(this.h['content-type'], meta.mimeType, 'upload sends the file type');
    this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size, total: blob.size });
    const f = mk({ ...meta, size: blob.size });
    this.status = 200;
    this.responseText = JSON.stringify(out(f));
    this.onload();
  }
};

// ---------- the tests ----------
const lib = await import(new URL('../../js/library-drive.js', import.meta.url));

let l = await lib.loadLibrary();
const rootId = l.root.id;
const mine = await lib.createFolder('Supplementary', rootId); // the user's own collection with that name stays theirs
const paper = await lib.uploadPdf(new Blob([new Uint8Array(900)], { type: 'application/pdf' }), 'atlas.pdf', rootId, {});
const p = { ...paper, meta: { title: 'Muscle degeneration: a single-cell atlas', authors: ['Ng, Ann'], year: 2025 } };
assert.equal(paper.suppCount, 0);
assert.deepEqual(await lib.listSupplementary(paper.id), [], 'no folder yet: empty, nothing created');
assert.ok(![...files.values()].some((f) => f.properties.dphSuppRoot), 'listing creates nothing');

let progress = 0;
let r = await lib.uploadSupplementary(p, new File(['gene,count\n'], 'Data S2.csv', { type: 'text/csv' }), (a, b) => { progress = a / b; });
assert.equal(progress, 1);
assert.deepEqual([r.count, r.file.name, r.file.mimeType], [1, 'Data S2.csv', 'text/csv']);
const si = await lib.uploadSupplementary(p, new File([new Uint8Array(300)], 'SI.pdf', { type: 'application/pdf' }));
const odd = await lib.uploadSupplementary(p, new File(['?'], 'raw.fcs', { type: '' }));
assert.equal(files.get(odd.file.id).mimeType, 'application/octet-stream', 'unknown type still uploads');
assert.equal(odd.count, 3);
assert.equal(files.get(paper.id).properties.dphSn, '3', 'count kept on the paper');

const suppRoot = [...files.values()].find((f) => f.properties.dphSuppRoot === '1');
assert.equal(suppRoot.name, 'Supplementary');
assert.deepEqual(suppRoot.parents, [rootId]);
const folder = [...files.values()].find((f) => f.properties.dphSuppFor === paper.id);
assert.equal(folder.name, 'Muscle degeneration a single-cell atlas – Ng 2025');
assert.deepEqual(folder.parents, [suppRoot.id]);
assert.ok(!files.get(si.file.id).properties.dphLib, 'a supplementary PDF is not tagged as a library paper');

l = await lib.loadLibrary();
assert.ok(l.folders.some((f) => f.id === mine.id), 'user collection still listed');
assert.ok(!l.folders.some((f) => f.id === suppRoot.id || f.id === folder.id), 'supplementary folders are not collections');
assert.ok(!l.papers.some((x) => x.id === si.file.id), 'a supplementary PDF is not a library paper');
assert.equal(l.papers.find((x) => x.id === paper.id).suppCount, 3);
assert.equal(await lib.suppCount({ properties: files.get(paper.id).properties }), 3);

let list = await lib.listSupplementary(paper.id);
assert.deepEqual(list.map((f) => f.name), ['Data S2.csv', 'raw.fcs', 'SI.pdf']);
await lib.renameSupplementary(odd.file.id, 'Flow S4.fcs');
assert.equal(files.get(odd.file.id).name, 'Flow S4.fcs');
assert.equal(await lib.deleteSupplementary(paper.id, odd.file.id), 2);
assert.equal(files.get(odd.file.id).trashed, true, 'removed file goes to Drive’s trash');
assert.equal(files.get(paper.id).properties.dphSn, '2');

mk({ name: 'Added in Drive.txt', mimeType: 'text/plain', parents: [folder.id], size: 2 }); // added outside Paper Library
list = await lib.listSupplementary(paper.id, 2);
assert.equal(list.length, 3);
assert.equal(files.get(paper.id).properties.dphSn, '3', 'badge count corrected from the real folder');

// Trash keeps them; delete forever removes the folder and its files too
await lib.trashItem(paper.id);
assert.ok(files.has(folder.id), 'trash keeps supplementary files');
await lib.deleteForever(paper.id);
assert.ok(!files.has(paper.id) && !files.has(folder.id) && !files.has(si.file.id), 'delete forever removes its supplementary files');
assert.ok(files.has(suppRoot.id), 'the Supplementary folder itself stays');

// A second paper reuses the same Supplementary folder
const p2 = await lib.uploadPdf(new Blob([new Uint8Array(10)]), 'two.pdf', rootId, {});
await lib.uploadSupplementary({ ...p2, meta: { title: '', authors: [] } }, new File(['x'], 'a.txt', { type: 'text/plain' }));
assert.equal([...files.values()].filter((f) => f.properties.dphSuppRoot === '1').length, 1);
assert.ok([...files.values()].some((f) => f.name === 'two' && f.properties.dphSuppFor === p2.id), 'falls back to the file name');

console.log('ALL DRIVE TESTS PASSED;', log.length, 'fake Drive calls');
