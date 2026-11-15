// Tests js/onedrive.js against a small in-memory fake of Microsoft Graph (no account needed).
//   node dev/tests/onedrive.test.mjs
import assert from 'node:assert/strict';

// ---------- fake chrome storage ----------
const mem = { local: {}, session: { msAuth: { token: 'T', expires: Date.now() + 3600e3 } } };
const area = (o) => ({
  async get(k) { const keys = typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(o); return Object.fromEntries(keys.filter((x) => x in o).map((x) => [x, o[x]])); },
  async set(v) { Object.assign(o, v); },
  async remove(k) { for (const x of [].concat(k)) delete o[x]; },
});
globalThis.chrome = { storage: { local: area(mem.local), session: area(mem.session) }, identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' } };

// ---------- fake Graph ----------
let n = 0, tagN = 0;
const items = new Map();
const ROOT = 'driveroot';
items.set(ROOT, { id: ROOT, name: 'root', folder: true, parentId: null });
const tag = () => `"{${++tagN}}"`;
function mk(name, parentId, folder, content) {
  const id = `ID!${++n}`;
  const it = { id, name, parentId, folder, content: content || null, eTag: tag(), cTag: tag(), created: new Date().toISOString() };
  items.set(id, it);
  return it;
}
const kids = (pid) => [...items.values()].filter((i) => i.parentId === pid);
const child = (pid, name) => kids(pid).find((i) => i.name === name);
function out(it) {
  const o = {
    id: it.id, name: it.name, eTag: it.eTag, cTag: it.cTag, webUrl: `https://onedrive.live.com/?id=${it.id}`,
    parentReference: { id: it.parentId }, createdDateTime: it.created, lastModifiedDateTime: it.created,
    lastModifiedBy: { user: { displayName: 'Me' } },
  };
  if (it.folder) o.folder = { childCount: kids(it.id).length };
  else { o.file = { mimeType: it.name.endsWith('.pdf') ? 'application/pdf' : 'application/json', hashes: { quickXorHash: 'h' + it.content.length } }; o.size = it.content.length; o['@microsoft.graph.downloadUrl'] = `https://fake.1drv.com/dl/${it.id}`; }
  return o;
}
const J = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const notFound = () => J(404, { error: { code: 'itemNotFound', message: 'Item not found' } });
function freeName(pid, name) { if (!child(pid, name)) return name; let i = 1; const [b, e] = name.includes('.') ? [name.slice(0, name.lastIndexOf('.')), name.slice(name.lastIndexOf('.'))] : [name, '']; while (child(pid, `${b} ${i}${e}`)) i++; return `${b} ${i}${e}`; }
const sessions = new Map();
const recycleBin = new Set();
const log = [];
let calls412 = 0;

async function graph(url, init = {}) {
  const u = new URL(url);
  const method = init.method || 'GET';
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  log.push(`${method} ${decodeURIComponent(u.pathname)}`);
  if (u.host === 'fake.1drv.com') {
    assert.equal(headers.authorization, undefined, 'no token to storage host');
    const it = items.get(decodeURIComponent(u.pathname.split('/').pop()));
    return it ? new Response(it.content, { status: 200, headers: { 'Content-Length': String(it.content.length) } }) : notFound();
  }
  assert.equal(u.host, 'graph.microsoft.com');
  assert.equal(headers.authorization, 'Bearer T');
  const path = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
  const conflict = u.searchParams.get('@microsoft.graph.conflictBehavior');
  if (path === '/me/drive') return J(200, { quota: { total: 5 * 1024 ** 3, used: 5.2 * 1024 ** 3, state: 'exceeded' } });
  if (globalThis.FULL && method !== 'GET') return J(507, { error: { code: 'quotaLimitReached', message: 'Quota limit reached' } });
  if (path === '/me') return J(200, { displayName: 'Prajwal', mail: null, userPrincipalName: 'p@example.com' });
  const m = path.match(/^\/me\/drive\/(?:items\/([^/:]+)|root)(?::\/(.+?):?)?(\/content|\/children|\/createUploadSession|\/permanentDelete)?$/);
  if (!m) throw new Error('unrouted ' + path);
  const baseId = m[1] || ROOT;
  let [, , relName, op] = m;
  if (!items.has(baseId)) return notFound();
  let target = relName ? child(baseId, relName) : items.get(baseId);
  if (op === '/permanentDelete') {
    if (globalThis.NO_PERMANENT) return J(400, { error: { code: 'invalidRequest', message: 'not supported' } });
    const purge = (id) => { for (const k of kids(id)) purge(k.id); recycleBin.delete(id); items.delete(id); }; purge(target.id); return new Response(null, { status: 204 });
  }
  if (op === '/children' && method === 'GET') return J(200, { value: kids(baseId).map(out) });
  if (op === '/children' && method === 'POST') {
    const b = JSON.parse(init.body);
    const cb = b['@microsoft.graph.conflictBehavior'];
    if (child(baseId, b.name) && cb === 'fail') return J(409, { error: { message: 'nameAlreadyExists' } });
    return J(201, out(mk(cb === 'rename' ? freeName(baseId, b.name) : b.name, baseId, true)));
  }
  if (op === '/createUploadSession') {
    const sid = `s${++n}`;
    const b = JSON.parse(init.body);
    sessions.set(sid, { parentId: relName ? baseId : null, name: relName, id: relName ? null : baseId, cb: b.item?.['@microsoft.graph.conflictBehavior'], parts: [] });
    return J(200, { uploadUrl: `https://fake.1drv.com/up/${sid}` });
  }
  if (op === '/content' && method === 'PUT') {
    const body = Buffer.from(typeof init.body === 'string' ? init.body : await new Response(init.body).arrayBuffer());
    if (target) {
      if (headers['if-match'] && headers['if-match'] !== target.eTag) { calls412++; return J(412, { error: { message: 'precondition failed' } }); }
      if (relName && conflict === 'fail') return J(409, { error: { message: 'exists' } });
      if (relName && conflict === 'rename') return J(201, out(mk(freeName(baseId, relName), baseId, false, body)));
      target.content = body; target.eTag = tag(); target.cTag = tag();
      return J(200, out(target));
    }
    if (!relName) return notFound();
    return J(201, out(mk(relName, baseId, false, body)));
  }
  if (!op && method === 'GET') return target ? J(200, out(target)) : notFound();
  if (!op && method === 'PATCH') {
    const b = JSON.parse(init.body);
    if (b.name) target.name = b.name;
    if (b.parentReference) { target.parentId = b.parentReference.id; if (conflict === 'rename') target.name = freeName(target.parentId, target.name) === target.name ? target.name : target.name; }
    target.eTag = tag();
    return J(200, out(target));
  }
  if (!op && method === 'DELETE') { const del = (id) => { for (const k of kids(id)) del(k.id); recycleBin.add(id); items.delete(id); }; del(target.id); return new Response(null, { status: 204 }); }
  throw new Error('unhandled ' + method + ' ' + path);
}
globalThis.fetch = graph;

// XMLHttpRequest for upload sessions
globalThis.XMLHttpRequest = class {
  constructor() { this.upload = {}; this.h = {}; }
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.h[k.toLowerCase()] = v; }
  async send(blob) {
    assert.equal(this.h.authorization, undefined, 'no token on upload URL');
    const s = sessions.get(this.url.split('/').pop());
    const [, a, b, total] = this.h['content-range'].match(/bytes (\d+)-(\d+)\/(\d+)/).map(Number);
    assert.equal((b - a + 1) % (320 * 1024) === 0 || b + 1 === total, true, 'chunk multiple of 320 KiB');
    s.parts.push(Buffer.from(await blob.arrayBuffer()));
    this.upload.onprogress?.({ lengthComputable: true, loaded: b - a + 1, total: b - a + 1 });
    if (b + 1 < total) { this.status = 202; this.responseText = '{}'; }
    else {
      const content = Buffer.concat(s.parts);
      let it;
      if (s.id) { it = items.get(s.id); it.content = content; it.cTag = tag(); it.eTag = tag(); }
      else it = mk(s.cb === 'rename' ? freeName(s.parentId, s.name) : s.name, s.parentId, false, content);
      this.status = 201; this.responseText = JSON.stringify(out(it));
    }
    this.onload();
  }
};

// ---------- the tests ----------
const od = await import(new URL('../../js/onedrive.js', import.meta.url));
const blob = (size, fill = 7) => new Blob([new Uint8Array(size).fill(fill)], { type: 'application/pdf' });

let lib = await od.loadLibrary();
assert.equal(lib.root.name, 'Paper Library');
assert.equal(mem.local.msLibraryRootId, lib.root.id);
assert.deepEqual([lib.folders.length, lib.papers.length, lib.trashed.length], [0, 0, 0]);
const rootId = lib.root.id;

const neuro = await od.createFolder('Neuroscience', rootId);
const sub = await od.createFolder('Brain2Image', neuro.id);
let progress = 0;
const big = await od.uploadPdf(blob(23 * 1024 * 1024), 'big paper.pdf', neuro.id, {}, (l, t) => { progress = l / t; });
assert.equal(progress, 1, 'progress reaches 100%');
assert.equal(big.size, 23 * 1024 * 1024);
const small = await od.uploadPdf(blob(1000), 'small.pdf', rootId, {});
const dupName = await od.uploadPdf(blob(1000), 'small.pdf', rootId, {});
assert.equal(dupName.name, 'small 1.pdf', 'name clash renamed');
assert.equal(small.md5, dupName.md5, 'same content → same hash → duplicate');

await od.saveMeta(big.id, { title: 'A big paper', authors: ['Doe, Jane', 'Roe, R.'], year: 2024, source: 'NeurIPS', doi: '10.1/x' }, 'auto');
await od.setStarred(big.id, true);
const sc = await od.addShortcut(big.id, sub.id, big.name);
await od.markRead(big.id);
await od.markMetaFailed(small.id);

// Another tab/computer writes the index meanwhile → our next write must re-read and merge.
const idx = child(rootId, '.paper-library.json');
const other = JSON.parse(idx.content.toString());
other.papers['ID!other'] = { title: 'written elsewhere' };
idx.content = Buffer.from(JSON.stringify(other)); idx.eTag = tag();
await od.saveMeta(dupName.id, { title: 'Dup' }, 'manual');
assert.equal(calls412, 1, 'conflict detected once');
const merged = JSON.parse(child(rootId, '.paper-library.json').content.toString());
assert.equal(merged.papers['ID!other'].title, 'written elsewhere', 'other writer kept');
assert.equal(merged.papers[dupName.id].title, 'Dup', 'our change applied');
assert.equal(merged.papers[big.id].starred, true);

// Parallel writes from this page are queued, not lost
await Promise.all([od.setStarred(small.id, true), od.setStarred(dupName.id, true), od.markRead(small.id)]);

lib = await od.loadLibrary();
assert.deepEqual(lib.folders.map((f) => f.name).sort(), ['Brain2Image', 'Neuroscience']);
let p = lib.papers.find((x) => x.id === big.id);
assert.equal(p.meta.title, 'A big paper');
assert.deepEqual(p.meta.authors, ['Doe, Jane', 'Roe, R.']);
assert.equal(p.meta.year, 2024);
assert.equal(p.meta.status, 'auto');
assert.ok(p.meta.lastRead);
assert.equal(p.starred, true);
assert.deepEqual(p.collections, [neuro.id, sub.id]);
assert.equal(p.shortcuts[0].id, sc.id);
assert.equal(lib.papers.find((x) => x.id === small.id).meta.status, 'failed');
assert.equal(lib.papers.find((x) => x.id === small.id).starred, true);
assert.equal(lib.papers.find((x) => x.id === dupName.id).starred, true);
assert.equal(lib.papers.length, 3, '.paper-library.json is not a paper');

// remove from 2nd collection: only this paper
await od.addShortcut(small.id, sub.id);
await od.deleteShortcut(sc.id);
lib = await od.loadLibrary();
assert.deepEqual(lib.papers.find((x) => x.id === big.id).collections, [neuro.id]);
assert.deepEqual(lib.papers.find((x) => x.id === small.id).collections, [rootId, sub.id], 'other paper keeps its collection');

// trash + restore
await od.trashItem(small.id);
lib = await od.loadLibrary();
assert.ok(!lib.papers.some((x) => x.id === small.id));
assert.equal(lib.trashed.map((x) => x.id).join(), small.id);
assert.ok(!lib.folders.some((f) => f.name === '.trash'), 'trash folder hidden');
await od.restoreItem(small.id);
lib = await od.loadLibrary();
assert.equal(lib.papers.find((x) => x.id === small.id).parentId, rootId);
assert.equal(lib.trashed.length, 0);

// restore when its collection was deleted meanwhile → top level
await od.moveItem(dupName.id, rootId, sub.id);
await od.trashItem(dupName.id);
await od.trashItem(sub.id); // folder → DELETE
await od.restoreItem(dupName.id);
lib = await od.loadLibrary();
assert.equal(lib.papers.find((x) => x.id === dupName.id).parentId, rootId);
assert.ok(!lib.folders.some((f) => f.id === sub.id));
assert.deepEqual(lib.papers.find((x) => x.id === small.id).collections, [rootId], 'deleted 2nd collection ignored');

// rename + move collection
await od.renameItem(neuro.id, 'Neuro');
const top2 = await od.createFolder('Other', rootId);
await od.moveItem(neuro.id, rootId, top2.id);
lib = await od.loadLibrary();
assert.equal(lib.folders.find((f) => f.id === neuro.id).parentId, top2.id);
assert.equal(lib.folders.find((f) => f.id === neuro.id).name, 'Neuro');

// viewer side
const about = await od.getAbout();
assert.equal(about.emailAddress, 'p@example.com');
const meta = await od.getMetadata(small.id);
assert.equal(meta.mimeType, 'application/pdf');
assert.deepEqual(meta.parents, [rootId]);
let seen = 0;
const bytes = await od.download(small.id, (l) => { seen = l; });
assert.equal(bytes.length, 1000); assert.equal(seen, 1000);
const up1 = await od.updateContent(small.id, new Uint8Array(2000).fill(1));
assert.notEqual(up1.headRevisionId, meta.headRevisionId, 'cTag changes after save');
assert.equal(items.get(small.id).content.length, 2000);
const up2 = await od.updateContent(small.id, new Uint8Array(6 * 1024 * 1024).fill(2));
assert.equal(items.get(small.id).content.length, 6 * 1024 * 1024, 'large save via upload session');
assert.equal(up2.id, small.id);
const copy = await od.createFile('small.pdf', new Uint8Array(10), meta.parents);
assert.equal(copy.name, 'small 2.pdf');
const copy2 = await od.createFile('loose.pdf', new Uint8Array(10));
assert.equal(items.get(copy2.id).parentId, ROOT);
const det = await od.paperDetails({ id: big.id });
assert.equal(det.title, 'A big paper');
const src = await od.pdfSource(big.id);
assert.match(src.url, /fake\.1drv\.com/);
assert.equal(src.httpHeaders, undefined);

// a fresh page finds the existing root and index by stored id
mem.local.msLibraryRootId = 'gone';
lib = await od.loadLibrary();
assert.equal(lib.root.id, rootId, 'falls back to the folder by name');

// delete forever: permanent when OneDrive allows it, otherwise recycle bin + a link to empty it
const gone1 = await od.uploadPdf(blob(500), 'gone1.pdf', rootId, {});
await od.saveMeta(gone1.id, { title: 'Gone' }, 'manual');
await od.trashItem(gone1.id);
let res = await od.deleteForever(gone1.id);
assert.deepEqual(res, { permanent: true, recycleBinUrl: null });
assert.ok(!items.has(gone1.id) && !recycleBin.has(gone1.id), 'skipped the recycle bin');
assert.equal(JSON.parse(child(rootId, '.paper-library.json').content.toString()).papers[gone1.id], undefined, 'index entry removed');
const gone2 = await od.uploadPdf(blob(500), 'gone2.pdf', rootId, {});
await od.trashItem(gone2.id);
globalThis.NO_PERMANENT = true;
res = await od.deleteForever(gone2.id);
globalThis.NO_PERMANENT = false;
assert.equal(res.permanent, false);
assert.equal(res.recycleBinUrl, 'https://onedrive.live.com/?v=recyclebin');
assert.ok(recycleBin.has(gone2.id), 'fell back to the recycle bin');
lib = await od.loadLibrary();
assert.ok(!lib.trashed.some((x) => [gone1.id, gone2.id].includes(x.id)), 'gone from Trash');

// supplementary files: one folder per paper inside "Supplementary", never shown as a collection
const mine = await od.createFolder('Supplementary', rootId); // the user's own collection with that name stays theirs
const host = await od.uploadPdf(blob(800), 'host.pdf', rootId, {});
const hostPaper = { ...host, meta: { title: 'Muscle degeneration: a single-cell atlas', authors: ['Ng, Ann', 'Li, Bo'], year: 2025 } };
assert.equal(await od.suppCount({ id: host.id }), 0);
assert.deepEqual(await od.listSupplementary(host.id), [], 'no folder yet: empty, nothing created');
let sr = await od.uploadSupplementary(hostPaper, new File(['gene,count\nMYOD1,12\n'], 'Data S2.csv', { type: 'text/csv' }));
assert.equal(sr.count, 1);
assert.equal(sr.file.name, 'Data S2.csv');
const movie = await od.uploadSupplementary(hostPaper, new File([new Uint8Array(5 * 1024 * 1024).fill(3)], 'Movie S1.mp4', { type: 'video/mp4' }), (l, t) => { progress = l / t; });
assert.equal(movie.count, 2);
assert.equal(movie.file.size, 5 * 1024 * 1024, 'large file via upload session');
const si = await od.uploadSupplementary(hostPaper, new File([new Uint8Array(300)], 'SI.pdf', { type: 'application/pdf' }));
const again = await od.uploadSupplementary(hostPaper, new File(['x'], 'Data S2.csv', { type: 'text/csv' }));
assert.equal(again.file.name, 'Data S2 1.csv', 'name clash renamed');
assert.equal(again.count, 4);
const suppRoot = items.get(JSON.parse(child(rootId, '.paper-library.json').content.toString()).suppRoot);
assert.equal(suppRoot.name, 'Supplementary 1', 'did not take over the user’s own “Supplementary” collection');
const hostFolder = kids(suppRoot.id)[0];
assert.equal(hostFolder.name, 'Muscle degeneration a single-cell atlas – Ng 2025', 'readable name, no “:”');
let sl = await od.listSupplementary(host.id);
assert.deepEqual(sl.map((f) => f.name), ['Data S2 1.csv', 'Data S2.csv', 'Movie S1.mp4', 'SI.pdf']);
lib = await od.loadLibrary();
assert.ok(lib.folders.some((f) => f.id === mine.id), 'user collection still listed');
assert.ok(!lib.folders.some((f) => f.id === suppRoot.id || f.id === hostFolder.id), 'supplementary folders are not collections');
assert.ok(!lib.papers.some((x) => x.id === si.file.id), 'a supplementary PDF is not a library paper');
assert.equal(lib.papers.find((x) => x.id === host.id).suppCount, 4);
assert.equal(await od.suppCount({ id: host.id }), 4);
await od.renameSupplementary(again.file.id, 'Data S3.csv');
assert.equal(items.get(again.file.id).name, 'Data S3.csv');
assert.equal(await od.deleteSupplementary(host.id, again.file.id), 3);
assert.ok(recycleBin.has(again.file.id), 'removed file goes to the recycle bin');
mk('Added in OneDrive.txt', hostFolder.id, false, Buffer.from('hi')); // added outside Paper Library
sl = await od.listSupplementary(host.id, 3);
assert.equal(sl.length, 4);
assert.equal(await od.suppCount({ id: host.id }), 4, 'badge count corrected from the real folder');
// trash keeps them; delete forever removes the folder too
await od.trashItem(host.id);
lib = await od.loadLibrary();
assert.equal(lib.trashed.find((x) => x.id === host.id).suppCount, 4);
assert.ok(items.has(hostFolder.id), 'trash keeps supplementary files');
await od.deleteForever(host.id);
assert.ok(!items.has(hostFolder.id) && !items.has(si.file.id), 'delete forever removes its supplementary files');
assert.ok(items.has(suppRoot.id), 'the Supplementary folder itself stays');

// a full OneDrive gives a clear message with the numbers
globalThis.FULL = true;
await assert.rejects(od.createFolder('X', rootId), (e) => /OneDrive is full \(5\.2 GB of 5\.0 GB used\)/.test(e.message));
globalThis.FULL = false;

console.log('ALL ONEDRIVE TESTS PASSED;', log.length, 'fake Graph calls');
