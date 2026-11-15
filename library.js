// Paper Library: a Mendeley-style list of your papers, stored in Google Drive.
//
//   Sidebar "collections"  = Drive folders under "Paper Library"
//   Table rows             = PDFs in those folders (details from Drive file properties)
//   Add PDFs / drop files  = upload into the open collection's folder
//   Open                   = the highlighter viewer (viewer.html?id=…)
//
// When the page is served outside the extension (local testing), an in-memory
// mock of Drive is loaded from ./dev/ instead.

import * as pdfjsLib from './lib/pdfjs/pdf.min.mjs';
import * as auth from './js/auth.js';
import * as drive from './js/drive.js';
import { readHighlights, buildMarkdown, markdownFileName, downloadText } from './js/export.js';

const IN_EXTENSION = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const backend = IN_EXTENSION ? await import('./js/library-drive.js') : await import('./dev/mock-backend.js');

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  isEvalSupported: false,
  cMapUrl: new URL('./lib/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./lib/pdfjs/standard_fonts/', import.meta.url).href,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
};
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
const store = {
  async get(keys) {
    if (IN_EXTENSION) return chrome.storage.local.get(keys);
    const out = {};
    for (const k of keys) {
      try {
        const v = localStorage.getItem('dphlib:' + k);
        if (v != null) out[k] = JSON.parse(v);
      } catch {}
    }
    return out;
  },
  async set(obj) {
    if (IN_EXTENSION) return chrome.storage.local.set(obj);
    for (const [k, v] of Object.entries(obj)) localStorage.setItem('dphlib:' + k, JSON.stringify(v));
  },
};
let prefs = { libView: 'all', libSort: { key: 'added', dir: -1 }, libOpenFolders: [] };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const lib = { root: null, folders: new Map(), papers: new Map(), trashed: new Map() };
const ui = {
  view: 'all', // 'all' | 'added' | 'read' | 'favorites' | 'unsorted' | 'duplicates' | 'trash' | 'coll:<folderId>'
  search: '',
  sort: { key: 'added', dir: -1 },
  sortTouched: false,
  checked: new Set(),
  selectedId: null,
  lastCheckedIndex: -1,
  openFolders: new Set(),
  visible: [], // papers currently in the table, in order
};
const working = new Set(); // paper ids whose details are being read right now

// ---------------------------------------------------------------------------
// Small UI helpers (toast, dialog, screens)
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// Answer of the dialog that is currently open (see dialog()).
let finishDialog = null;

/**
 * Small promise-based dialog. actions: [{label, value, primary, danger}].
 * Each button reports its answer directly; the <dialog> "close" event is only a
 * fallback (e.g. Esc), because some Chrome builds fire it late or not at all.
 */
function dialog({ title, body, actions }) {
  const dlg = $('dialog');
  finishDialog?.(''); // a previous dialog still waiting counts as cancelled
  dlg.querySelector('[data-role=title]').textContent = title;
  const b = dlg.querySelector('[data-role=body]');
  b.replaceChildren();
  if (typeof body === 'string') b.append(el('p', null, body));
  else if (body) b.append(body);
  const a = dlg.querySelector('[data-role=actions]');
  a.replaceChildren(
    ...actions.map((x) => {
      const btn = el('button', 'btn' + (x.primary ? ' primary' : '') + (x.danger ? ' danger' : ''), x.label);
      btn.type = 'button';
      btn.value = x.value;
      btn.onclick = () => closeDialog(x.value);
      return btn;
    })
  );
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    const onClose = () => !dlg.open && finish(dlg.returnValue);
    const finish = (value) => {
      if (finishDialog !== finish) return;
      finishDialog = null;
      dlg.removeEventListener('close', onClose);
      resolve(value);
    };
    finishDialog = finish;
    dlg.addEventListener('close', onClose);
  });
}

/** Closes the open dialog with an answer (what its buttons do). */
function closeDialog(value) {
  const finish = finishDialog;
  if ($('dialog').open) $('dialog').close(value);
  finish?.(value);
}

async function askName(title, value = '', okLabel = 'Create') {
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      closeDialog('ok');
    }
  });
  setTimeout(() => input.select(), 30);
  const r = await dialog({ title, body: input, actions: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', primary: true }] });
  const name = input.value.trim().replace(/[\\/]/g, '-');
  return r === 'ok' && name ? name : null;
}

function showScreen(name) {
  $('lib').hidden = name !== 'lib';
  $('loading').hidden = name !== 'loading';
  $('home').hidden = name !== 'home';
}

function fail(e, what = 'That') {
  console.error(e);
  toast(`${what} failed: ${e.message || e}`, 6000);
}

// ---------------------------------------------------------------------------
// Boot: setup → sign-in → load
// ---------------------------------------------------------------------------
async function boot() {
  prefs = { ...prefs, ...(await store.get(Object.keys(prefs))) };
  ui.view = prefs.libView;
  ui.sort = prefs.libSort;
  ui.openFolders = new Set(prefs.libOpenFolders);
  wire();
  if (!IN_EXTENSION) {
    $('userEmail').textContent = 'Demo mode (fake Drive)';
    return loadLibrary();
  }

  $('redirectUri').textContent = auth.redirectUri();
  const clientId = await auth.getClientId();
  if (!clientId) return showSetup();
  try {
    await auth.getToken({ interactive: false });
  } catch {
    return showSignin();
  }
  return loadLibrary();
}

function showSetup() {
  showScreen('home');
  $('setupCard').hidden = false;
  $('signinCard').hidden = true;
}

function showSignin() {
  showScreen('home');
  $('setupCard').hidden = true;
  $('signinCard').hidden = false;
}

async function loadLibrary({ quiet = false } = {}) {
  if (!quiet) showScreen('loading');
  try {
    if (IN_EXTENSION && !$('userEmail').textContent) {
      drive
        .getAbout()
        .then((u) => {
          $('userEmail').textContent = u.emailAddress;
          auth.rememberAccount(u.emailAddress);
        })
        .catch(() => {});
    }
    const data = await backend.loadLibrary();
    lib.root = data.root;
    lib.folders = new Map(data.folders.map((f) => [f.id, f]));
    lib.papers = new Map(data.papers.map((p) => [p.id, p]));
    lib.trashed = new Map(data.trashed.map((p) => [p.id, p]));
    if (ui.view.startsWith('coll:') && !lib.folders.has(ui.view.slice(5))) ui.view = 'all';
    showScreen('lib');
    renderAll();
    queueUnreadDetails();
  } catch (e) {
    if (e instanceof auth.AuthError) return showSignin();
    showScreen('home');
    $('setupCard').hidden = true;
    $('signinCard').hidden = false;
    $('signinError').textContent = 'Could not load the library: ' + e.message;
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Which papers does the current view show?
// ---------------------------------------------------------------------------
const DAY = 86400_000;

function folderPath(id) {
  const names = [];
  for (let f = lib.folders.get(id); f; f = lib.folders.get(f.parentId)) names.unshift(f.name);
  return names;
}

function inLibraryFolder(p) {
  return p.collections.some((c) => lib.folders.has(c));
}

function duplicateGroups(papers) {
  // Two papers are duplicates if they share the exact file bytes (Drive's MD5
  // checksum), the same DOI, or the same normalised title.
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const keyOwner = new Map();
  const parent = new Map(papers.map((p) => [p.id, p.id]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  for (const p of papers) {
    const keys = [p.md5 && 'm:' + p.md5, p.meta.doi && 'd:' + p.meta.doi.toLowerCase(), norm(p.meta.title).length > 15 && 't:' + norm(p.meta.title)];
    for (const k of keys.filter(Boolean)) {
      if (keyOwner.has(k)) parent.set(find(p.id), find(keyOwner.get(k)));
      else keyOwner.set(k, p.id);
    }
  }
  const groups = new Map();
  for (const p of papers) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function papersForView(view = ui.view) {
  const all = [...lib.papers.values()];
  if (view === 'all') return all;
  if (view === 'added') return all.filter((p) => Date.now() - Date.parse(p.created) < 30 * DAY);
  if (view === 'read') return all.filter((p) => p.meta.lastRead);
  if (view === 'favorites') return all.filter((p) => p.starred);
  if (view === 'unsorted') return all.filter((p) => !inLibraryFolder(p));
  if (view === 'duplicates') return duplicateGroups(all).flat();
  if (view === 'trash') return [...lib.trashed.values()];
  if (view.startsWith('coll:')) {
    const id = view.slice(5);
    return all.filter((p) => p.collections.includes(id));
  }
  return all;
}

const firstAuthor = (p) => p.meta.authors[0] || '';
const displayTitle = (p) => p.meta.title || p.name.replace(/\.pdf$/i, '');
const SORTERS = {
  authors: (a, b) => collator.compare(firstAuthor(a), firstAuthor(b)),
  year: (a, b) => (a.meta.year || 0) - (b.meta.year || 0),
  title: (a, b) => collator.compare(displayTitle(a), displayTitle(b)),
  source: (a, b) => collator.compare(a.meta.source || '', b.meta.source || ''),
  added: (a, b) => (a.created || '').localeCompare(b.created || ''),
  read: (a, b) => (a.meta.lastRead || '').localeCompare(b.meta.lastRead || ''),
};

function computeVisible() {
  let list = papersForView();
  const terms = ui.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    list = list.filter((p) => {
      const hay = [p.meta.title, p.meta.authors.join(' '), p.meta.source, p.meta.year, p.name].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (ui.view === 'duplicates') return list; // keep groups together
  let { key, dir } = ui.sort;
  if (ui.view === 'read' && !ui.sortTouched) [key, dir] = ['read', -1];
  if (ui.view === 'added' && !ui.sortTouched) [key, dir] = ['added', -1];
  const cmp = SORTERS[key] || SORTERS.added;
  return list.sort((a, b) => dir * cmp(a, b) || SORTERS.title(a, b));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderNav();
  renderTree();
  renderTable();
  renderDetails();
}

const renderSoon = debounce(() => {
  renderNav();
  renderTable();
  renderDetails();
}, 120);

function viewName(view = ui.view) {
  const names = { all: 'All References', added: 'Recently Added', read: 'Recently Read', favorites: 'Favorites', unsorted: 'Unsorted', duplicates: 'Duplicates', trash: 'Trash' };
  return names[view] || folderPath(view.slice(5)).join(' / ');
}

function renderNav() {
  for (const li of $('navList').children) {
    const v = li.dataset.view;
    li.classList.toggle('active', ui.view === v);
    const n = v === 'duplicates' ? papersForView(v).length : papersForView(v).length;
    li.querySelector('.n').textContent = n || '';
  }
}

function renderTree() {
  const kids = new Map();
  for (const f of lib.folders.values()) {
    if (!kids.has(f.parentId)) kids.set(f.parentId, []);
    kids.get(f.parentId).push(f);
  }
  const build = (parentId) => {
    const ul = el('ul');
    for (const f of (kids.get(parentId) || []).sort((a, b) => collator.compare(a.name, b.name))) {
      const li = el('li');
      li.dataset.id = f.id;
      const hasKids = kids.has(f.id);
      if (ui.openFolders.has(f.id)) li.classList.add('open');
      const node = el('div', 'node' + (ui.view === 'coll:' + f.id ? ' active' : ''));
      node.dataset.folder = f.id;
      node.draggable = true; // drag onto another collection or the COLLECTIONS heading to move it
      const twist = el('span', 'twist' + (hasKids ? '' : ' leaf'));
      twist.append(icon('tri'));
      twist.dataset.twist = f.id;
      const more = el('button', 'tb-btn more');
      more.title = 'Collection actions';
      more.dataset.more = f.id;
      more.append(icon('more'));
      node.append(twist, el('span', 'label', f.name), more);
      li.append(node);
      if (hasKids) li.append(build(f.id));
      ul.append(li);
    }
    return ul;
  };
  const tree = $('tree');
  tree.replaceChildren(...build(lib.root.id).children);
}

function renderCrumbs() {
  const c = $('crumbs');
  c.replaceChildren();
  const add = (text, view) => {
    if (c.childNodes.length) c.append(el('span', 'sep', '/'));
    const a = el(view ? 'a' : 'span', view ? '' : 'cur', text);
    if (view) a.onclick = () => setView(view);
    c.append(a);
  };
  if (!ui.view.startsWith('coll:')) {
    add(viewName(), null);
  } else {
    add('All References', 'all');
    const chain = [];
    for (let f = lib.folders.get(ui.view.slice(5)); f; f = lib.folders.get(f.parentId)) chain.unshift(f);
    chain.forEach((f, i) => add(f.name, i === chain.length - 1 ? null : 'coll:' + f.id));
  }
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString() : '';
}

function rowFor(p, dupFirst) {
  const tr = el('tr');
  tr.dataset.id = p.id;
  tr.draggable = ui.view !== 'trash';
  if (ui.checked.has(p.id)) tr.classList.add('checked');
  if (ui.selectedId === p.id) tr.classList.add('selected');
  if (dupFirst) tr.classList.add('dup-first');

  const tdCheck = el('td', 'c-check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = ui.checked.has(p.id);
  cb.dataset.check = '1';
  tdCheck.append(cb);

  const tdDot = el('td', 'c-dot');
  if (!p.meta.lastRead && ui.view !== 'trash') {
    const d = el('span', 'dot');
    d.title = 'Unread';
    tdDot.append(d);
  }

  const tdStar = el('td', 'c-star');
  const star = el('button', 'star-btn' + (p.starred ? ' on' : ''));
  star.dataset.star = '1';
  star.title = p.starred ? 'Remove from Favorites' : 'Add to Favorites (stars the file in Drive)';
  star.append(icon(p.starred ? 'star-fill' : 'star'));
  tdStar.append(star);

  const authors = p.meta.authors.join('; ');
  const tdAuthors = el('td', 'c-authors', authors);
  tdAuthors.title = authors;
  const tdYear = el('td', 'c-year', p.meta.year ? String(p.meta.year) : '');
  const tdTitle = el('td', 'c-title');
  if (working.has(p.id)) {
    tdTitle.append(el('span', 'working', 'Reading details… '), document.createTextNode(displayTitle(p)));
  } else {
    tdTitle.textContent = displayTitle(p);
    if (!p.meta.title) tdTitle.classList.add('pending');
  }
  tdTitle.title = displayTitle(p);
  const tdSource = el('td', 'c-source', p.meta.source || '');
  tdSource.title = p.meta.source || '';
  const tdAdded = el('td', 'c-added', fmtDate(p.created));
  const tdFile = el('td', 'c-file');
  const fb = el('button', 'file-btn');
  fb.dataset.open = '1';
  fb.title = 'Open and highlight';
  fb.append(icon('pdf'));
  tdFile.append(fb);

  tr.append(tdCheck, tdDot, tdStar, tdAuthors, tdYear, tdTitle, tdSource, tdAdded, tdFile);
  return tr;
}

function renderTable() {
  renderCrumbs();
  ui.visible = computeVisible();
  const ids = new Set(ui.visible.map((p) => p.id));
  for (const id of ui.checked) if (!ids.has(id)) ui.checked.delete(id);

  let groupStart = new Set();
  if (ui.view === 'duplicates') {
    for (const g of duplicateGroups([...lib.papers.values()])) groupStart.add(g[0].id);
  }
  $('rows').replaceChildren(...ui.visible.map((p) => rowFor(p, groupStart.has(p.id))));

  for (const th of document.querySelectorAll('#paperTable th.sortable')) {
    const on = th.dataset.sort === ui.sort.key && (ui.sortTouched || !['read', 'added'].includes(ui.view) || ui.view === 'all');
    th.classList.toggle('sorted', on);
    th.classList.toggle('desc', on && ui.sort.dir < 0);
  }

  const empty = $('emptyState');
  empty.hidden = ui.visible.length > 0;
  if (!ui.visible.length) {
    const msgs = {
      all: 'Your library is empty. Click <b>Add PDFs</b>, drop PDFs here, or use <b>Import folder</b> to upload a folder of papers (its subfolders become collections).',
      added: 'Nothing added in the last 30 days.',
      read: 'Papers you open appear here.',
      favorites: 'Click the ☆ next to a paper to add it here. (It stars the file in Drive too.)',
      unsorted: 'Every paper is in a collection.',
      duplicates: 'No duplicates found.',
      trash: 'Trash is empty. (Drive deletes trashed files for good after 30 days.)',
    };
    empty.innerHTML = ui.search
      ? 'No papers match your search.'
      : msgs[ui.view] || 'This collection is empty. Drag papers here from the list, or drop PDFs from your computer.';
  }
  $('checkAll').checked = ui.visible.length > 0 && ui.visible.every((p) => ui.checked.has(p.id));
  $('checkAll').indeterminate = !$('checkAll').checked && ui.visible.some((p) => ui.checked.has(p.id));
  renderBulk();
}

function renderBulk() {
  const n = ui.checked.size;
  $('bulkBar').hidden = n === 0;
  $('bulkCount').textContent = `${n} selected`;
  const trash = ui.view === 'trash';
  const inColl = ui.view.startsWith('coll:');
  for (const b of $('bulkBar').querySelectorAll('[data-bulk]')) {
    const k = b.dataset.bulk;
    b.hidden = trash ? !['restore', 'clear'].includes(k) : k === 'restore' || (k === 'remove' && !inColl);
  }
}

function renderDetails() {
  const p = lib.papers.get(ui.selectedId) || lib.trashed.get(ui.selectedId);
  $('details').hidden = !p;
  $('lib').classList.toggle('details-open', !!p);
  if (!p) return;
  const m = p.meta;
  // Don't overwrite what the user is typing.
  if (!$('details').contains(document.activeElement) || $('details').dataset.id !== p.id) {
    $('dTitle').value = m.title || '';
    $('dAuthors').value = m.authors.join('\n');
    $('dYear').value = m.year || '';
    $('dSource').value = m.source || '';
    $('dDoi').value = m.doi || '';
    $('dArxiv').value = m.arxivId || '';
  }
  $('details').dataset.id = p.id;
  const statusText = {
    auto: 'Details found automatically — check and correct if needed.',
    manual: 'Details edited by you.',
    failed: 'Could not find details automatically. Fill them in, or add a DOI / arXiv ID and click “Look up online”.',
  };
  $('dStatus').textContent = working.has(p.id) ? 'Reading details…' : statusText[m.status] || 'Details not read yet.';
  $('dFile').textContent = p.name;
  const chips = $('dColls');
  chips.replaceChildren();
  for (const c of p.collections) {
    if (!lib.folders.has(c)) continue;
    const isShortcut = p.shortcuts.some((s) => s.parentId === c);
    const chip = el('span', 'chip' + (isShortcut ? ' shortcut' : ''), folderPath(c).join(' / '));
    chip.title = isShortcut ? 'Also listed here (Drive shortcut)' : 'The file lives in this Drive folder';
    chips.append(chip);
  }
  if (!lib.folders.has(p.parentId)) {
    const chip = el('span', 'chip', 'Unsorted');
    chip.title = 'The file lives in the library root folder';
    chips.prepend(chip);
  }
  const isTrash = lib.trashed.has(p.id);
  for (const id of ['dSave', 'dLookup', 'dOpen']) $(id).disabled = isTrash;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function setView(view) {
  ui.view = view;
  ui.sortTouched = false;
  ui.checked.clear();
  prefs.libView = view;
  store.set({ libView: view });
  if (view.startsWith('coll:')) {
    // Make sure the collection is visible in the tree.
    for (let f = lib.folders.get(lib.folders.get(view.slice(5))?.parentId); f; f = lib.folders.get(f.parentId)) ui.openFolders.add(f.id);
  }
  renderNav();
  renderTree();
  renderTable();
  $('tableWrap').scrollTop = 0;
}

function currentFolderId() {
  return ui.view.startsWith('coll:') ? ui.view.slice(5) : lib.root.id;
}

function openPaper(p) {
  const url = `viewer.html?id=${encodeURIComponent(p.id)}`;
  window.open(IN_EXTENSION ? url : `viewer.html?src=/sample.pdf&name=${encodeURIComponent(p.name)}`, '_blank');
  p.meta.lastRead = new Date().toISOString(); // the viewer also records this on Drive
  renderSoon();
}

async function toggleStar(p) {
  p.starred = !p.starred;
  renderSoon();
  try {
    await backend.setStarred(p.id, p.starred);
  } catch (e) {
    p.starred = !p.starred;
    renderSoon();
    fail(e, 'Starring');
  }
}

async function movePapers(ids, targetId) {
  let n = 0;
  for (const id of ids) {
    const p = lib.papers.get(id);
    if (!p || p.parentId === targetId) continue;
    try {
      // If the paper was already listed there as a shortcut, the real file replaces it.
      const sc = p.shortcuts.find((s) => s.parentId === targetId);
      if (sc) {
        await backend.deleteShortcut(sc.id);
        p.shortcuts = p.shortcuts.filter((s) => s !== sc);
      }
      await backend.moveItem(p.id, p.parentId, targetId);
      p.collections = p.collections.filter((c) => c !== p.parentId && c !== targetId);
      p.collections.push(targetId);
      p.parentId = targetId;
      n++;
    } catch (e) {
      fail(e, 'Moving ' + p.name);
    }
  }
  if (n) toast(`Moved ${n} paper${n > 1 ? 's' : ''} to ${targetId === lib.root.id ? 'Unsorted' : lib.folders.get(targetId)?.name}`);
  renderSoon();
}

async function addToCollection(ids, folderId) {
  let n = 0;
  for (const id of ids) {
    const p = lib.papers.get(id);
    if (!p || p.collections.includes(folderId)) continue;
    try {
      const sc = await backend.addShortcut(p.id, folderId, p.name);
      p.shortcuts.push(sc);
      p.collections.push(folderId);
      n++;
    } catch (e) {
      fail(e, 'Adding ' + p.name);
    }
  }
  if (n) toast(`Added ${n} paper${n > 1 ? 's' : ''} to ${lib.folders.get(folderId)?.name} (as Drive shortcuts)`);
  renderSoon();
}

async function removeFromCollection(ids, folderId) {
  for (const id of ids) {
    const p = lib.papers.get(id);
    if (!p) continue;
    try {
      const sc = p.shortcuts.find((s) => s.parentId === folderId);
      if (sc) {
        await backend.deleteShortcut(sc.id);
        p.shortcuts = p.shortcuts.filter((s) => s !== sc);
        p.collections = p.collections.filter((c) => c !== folderId);
      } else if (p.parentId === folderId) {
        // The file itself lives here: move it back to the library root ("Unsorted").
        await backend.moveItem(p.id, folderId, lib.root.id);
        p.collections = p.collections.filter((c) => c !== folderId);
        p.collections.push(lib.root.id);
        p.parentId = lib.root.id;
      }
    } catch (e) {
      fail(e, 'Removing ' + p.name);
    }
  }
  renderSoon();
}

async function trashPapers(ids) {
  let n = 0;
  for (const id of ids) {
    const p = lib.papers.get(id);
    if (!p) continue;
    try {
      await backend.trashItem(p.id);
      lib.papers.delete(id);
      lib.trashed.set(id, p);
      ui.checked.delete(id);
      if (ui.selectedId === id) ui.selectedId = null;
      n++;
    } catch (e) {
      fail(e, 'Trashing ' + p.name);
    }
  }
  if (n) toast(`Moved ${n} paper${n > 1 ? 's' : ''} to Trash`);
  renderSoon();
}

async function restorePapers(ids) {
  for (const id of ids) {
    const p = lib.trashed.get(id);
    if (!p) continue;
    try {
      await backend.restoreItem(p.id);
      lib.trashed.delete(id);
      lib.papers.set(id, p);
      ui.checked.delete(id);
    } catch (e) {
      fail(e, 'Restoring ' + p.name);
    }
  }
  renderSoon();
}

/** Dialog with the collection tree; resolves to a folder id or null. */
/**
 * Dialog with the collection tree; resolves to a folder id or null.
 * rootLabel: offer the library root under this name; preselect: initially
 * chosen id; exclude: ids that can't be chosen (e.g. a collection's own subtree).
 */
async function pickCollection(title, { allowRoot = false, rootLabel = 'Unsorted (library root)', preselect = null, exclude = new Set(), okLabel = 'OK', note = '' } = {}) {
  const box = el('div', 'picker tree');
  let chosen = null;
  const kids = new Map();
  for (const f of lib.folders.values()) {
    if (!kids.has(f.parentId)) kids.set(f.parentId, []);
    kids.get(f.parentId).push(f);
  }
  const addNode = (f, depth, label) => {
    if (exclude.has(f.id)) return; // also hides its sub-collections
    const node = el('div', 'node', label ?? f.name);
    node.style.paddingLeft = 8 + depth * 18 + 'px';
    if (f.id === preselect) {
      node.classList.add('chosen');
      chosen = f.id;
    }
    node.onclick = () => {
      box.querySelectorAll('.chosen').forEach((n) => n.classList.remove('chosen'));
      node.classList.add('chosen');
      chosen = f.id;
    };
    box.append(node);
    for (const k of (kids.get(f.id) || []).sort((a, b) => collator.compare(a.name, b.name))) addNode(k, depth + 1);
  };
  if (allowRoot) {
    addNode({ id: lib.root.id }, 0, rootLabel); // also adds every collection under it
  } else {
    for (const k of (kids.get(lib.root.id) || []).sort((a, b) => collator.compare(a.name, b.name))) addNode(k, 0);
  }
  if (!lib.folders.size && !allowRoot) {
    toast('Create a collection first.');
    return null;
  }
  let body = box;
  if (note) {
    body = el('div');
    body.append(el('p', 'muted small', note), box);
  }
  const r = await dialog({ title, body, actions: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', primary: true }] });
  return r === 'ok' ? chosen : null;
}

/**
 * Where should an imported folder go? Asks every time (Top level preselected),
 * so a folder never ends up nested just because a collection happened to be open.
 */
async function importDestination(items) {
  const tops = [...new Set(items.filter((i) => i.path.length).map((i) => i.path[0]))];
  if (!tops.length) return currentFolderId(); // loose PDFs: the open collection, as before
  const what = tops.length === 1 ? `“${tops[0]}”` : `${tops.length} folders`;
  return pickCollection(`Import ${what} into…`, {
    allowRoot: true,
    rootLabel: 'Top level (a new collection)',
    preselect: lib.root.id,
    okLabel: 'Import',
    note: `${what} becomes a collection (its subfolders become sub-collections) inside the place you choose.`,
  });
}

/** Moves a collection (Drive folder) with everything in it under another collection or the top level. */
async function moveCollection(id, newParentId) {
  const f = lib.folders.get(id);
  if (!f || f.parentId === newParentId) return;
  if (subtree(id).includes(newParentId)) return toast('A collection can’t be moved inside itself.');
  try {
    await backend.moveItem(id, f.parentId, newParentId);
    f.parentId = newParentId;
    if (newParentId !== lib.root.id) ui.openFolders.add(newParentId);
    saveOpenFolders();
    renderTree();
    renderCrumbs();
    toast(`Moved “${f.name}” to ${newParentId === lib.root.id ? 'the top level' : `“${lib.folders.get(newParentId).name}”`}`);
  } catch (e) {
    fail(e, 'Moving the collection');
  }
}

async function chooseCollectionMove(id) {
  const f = lib.folders.get(id);
  const target = await pickCollection(`Move “${f.name}” to…`, {
    allowRoot: true,
    rootLabel: 'Top level',
    preselect: f.parentId,
    exclude: new Set(subtree(id)),
    okLabel: 'Move',
    note: 'The collection moves with all its papers and sub-collections (the Drive folder is moved).',
  });
  if (target) moveCollection(id, target);
}

// ----- Collections -----
async function newCollection(parentId = lib.root.id) {
  const name = await askName(parentId === lib.root.id ? 'New collection' : `New collection inside “${lib.folders.get(parentId).name}”`);
  if (!name) return;
  try {
    const f = await backend.createFolder(name, parentId);
    lib.folders.set(f.id, f);
    if (parentId !== lib.root.id) ui.openFolders.add(parentId);
    saveOpenFolders();
    setView('coll:' + f.id);
  } catch (e) {
    fail(e, 'Creating the collection');
  }
}

async function renameCollection(id) {
  const f = lib.folders.get(id);
  const name = await askName('Rename collection', f.name, 'Rename');
  if (!name || name === f.name) return;
  try {
    await backend.renameItem(id, name);
    f.name = name;
    renderTree();
    renderCrumbs();
  } catch (e) {
    fail(e, 'Renaming');
  }
}

function subtree(id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const f of lib.folders.values()) if (f.parentId === ids[i]) ids.push(f.id);
  return ids;
}

async function deleteCollection(id) {
  const f = lib.folders.get(id);
  const ids = new Set(subtree(id));
  const inside = [...lib.papers.values()].filter((p) => p.collections.some((c) => ids.has(c)));
  const r = await dialog({
    title: `Delete collection “${f.name}”?`,
    body:
      `Its ${ids.size > 1 ? ids.size - 1 + ' sub-collections and ' : ''}folder${ids.size > 1 ? 's go' : ' goes'} to the Drive trash. ` +
      `The ${inside.length} paper${inside.length === 1 ? '' : 's'} in it stay in your library (under Unsorted, or their other collections).`,
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete collection', value: 'ok', danger: true }],
  });
  if (r !== 'ok') return;
  try {
    for (const p of inside) {
      for (const sc of p.shortcuts.filter((s) => ids.has(s.parentId))) {
        await backend.deleteShortcut(sc.id);
        p.shortcuts = p.shortcuts.filter((s) => s !== sc);
        p.collections = p.collections.filter((c) => c !== sc.parentId);
      }
      if (ids.has(p.parentId)) {
        await backend.moveItem(p.id, p.parentId, lib.root.id);
        p.collections = p.collections.filter((c) => c !== p.parentId);
        p.collections.push(lib.root.id);
        p.parentId = lib.root.id;
      }
    }
    await backend.trashItem(id);
    for (const fid of ids) lib.folders.delete(fid);
    if (ui.view.startsWith('coll:') && ids.has(ui.view.slice(5))) ui.view = 'all';
    renderAll();
    toast(`Deleted “${f.name}”`);
  } catch (e) {
    fail(e, 'Deleting the collection');
  }
}

function saveOpenFolders() {
  store.set({ libOpenFolders: [...ui.openFolders] });
}

// ---------------------------------------------------------------------------
// Background tasks: uploads and reading paper details
// ---------------------------------------------------------------------------
const tasks = { uploads: [], meta: { total: 0, done: 0 } };

function renderTasks() {
  const ups = tasks.uploads;
  const upDone = ups.filter((t) => ['done', 'skipped', 'error'].includes(t.state)).length;
  const metaLeft = tasks.meta.total - tasks.meta.done;
  const busy = upDone < ups.length || metaLeft > 0;
  const box = $('tasks');
  if (!busy && !ups.some((t) => t.state === 'error')) {
    box.hidden = true;
    if (ups.length) {
      const skipped = ups.filter((t) => t.state === 'skipped').length;
      toast(`Upload finished: ${ups.length - skipped} added${skipped ? `, ${skipped} skipped (already in that collection)` : ''}.`, 5000);
    }
    tasks.uploads = [];
    tasks.meta = { total: 0, done: 0 };
    return;
  }
  box.hidden = false;
  const parts = [];
  if (ups.length) parts.push(`Uploading ${Math.min(upDone + 1, ups.length)} of ${ups.length}`);
  if (metaLeft > 0) parts.push(`Reading details ${tasks.meta.done + 1} of ${tasks.meta.total}`);
  if (!busy) parts.push('Finished with errors');
  $('tasksTitle').textContent = parts.join(' · ');
  const active = ups.find((t) => t.state === 'uploading');
  const frac = ups.length ? (upDone + (active?.progress || 0)) / ups.length : tasks.meta.done / Math.max(1, tasks.meta.total);
  $('tasksBar').style.width = Math.round(frac * 100) + '%';
  const list = $('tasksList');
  if (!list.hidden) {
    list.replaceChildren(
      ...ups.map((t) => {
        const li = el('li', t.state === 'error' ? 'err' : t.state === 'done' ? 'done' : '');
        li.append(el('span', 't-name', t.path.concat(t.file.name).join(' / ')));
        const st = t.state === 'uploading' ? Math.round((t.progress || 0) * 100) + '%' : t.state === 'error' ? 'failed' : t.state;
        const s = el('span', 't-state', st);
        if (t.error) s.title = t.error;
        li.append(s);
        return li;
      })
    );
  }
}
const renderTasksSoon = debounce(renderTasks, 100);

const folderPromises = new Map();
/** Finds or creates the folder path (e.g. ["Neuroscience","Brain2Image"]) under baseId. */
async function ensurePath(baseId, names) {
  let cur = baseId;
  for (const name of names) {
    const key = cur + '/' + name;
    if (!folderPromises.has(key)) {
      const parent = cur;
      folderPromises.set(
        key,
        (async () => {
          const existing = [...lib.folders.values()].find((f) => f.parentId === parent && f.name === name);
          if (existing) return existing.id;
          const f = await backend.createFolder(name, parent);
          lib.folders.set(f.id, f);
          renderTree();
          return f.id;
        })()
      );
    }
    try {
      cur = await folderPromises.get(key);
    } catch (e) {
      folderPromises.delete(key);
      throw e;
    }
  }
  return cur;
}

let uploadWorkers = 0;
function enqueueUploads(items, baseFolderId) {
  const pdfs = items.filter(({ file }) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
  if (!pdfs.length) return toast('No PDF files found in what you dropped.');
  for (const it of pdfs) tasks.uploads.push({ ...it, baseFolderId, state: 'queued', progress: 0 });
  renderTasks();
  // Two uploads at a time: faster than one, gentle on Drive's rate limits.
  while (uploadWorkers < 2) {
    uploadWorkers++;
    uploadWorker().finally(() => uploadWorkers--);
  }
}

async function uploadWorker() {
  for (;;) {
    const t = tasks.uploads.find((x) => x.state === 'queued');
    if (!t) return;
    t.state = 'uploading';
    renderTasksSoon();
    try {
      const folderId = await ensurePath(t.baseFolderId, t.path);
      const dup = [...lib.papers.values()].some((p) => p.collections.includes(folderId) && p.name === t.file.name && p.size === t.file.size);
      if (dup) {
        t.state = 'skipped';
        continue;
      }
      const p = await backend.uploadPdf(t.file, t.file.name, folderId, {}, (loaded, total) => {
        t.progress = loaded / total;
        renderTasksSoon();
      });
      lib.papers.set(p.id, p);
      t.state = 'done';
      renderSoon();
      queueDetails(p, () => t.file.arrayBuffer());
    } catch (e) {
      console.error(e);
      t.state = 'error';
      t.error = e.message;
    } finally {
      renderTasksSoon();
    }
  }
}

// ----- Reading details (title/authors/year/source) -----
let metadataModule;
async function metadataReader() {
  if (metadataModule === undefined) {
    try {
      metadataModule = await import('./js/metadata.js');
    } catch (e) {
      console.warn('metadata reader not available yet', e);
      metadataModule = null;
    }
  }
  return metadataModule;
}

const metaQueue = [];
let metaRunning = false;

/** getBytes: optional () => ArrayBuffer (we have the file locally right after upload). */
function queueDetails(p, getBytes = null, { front = false } = {}) {
  if (working.has(p.id) || metaQueue.some((j) => j.p.id === p.id)) return;
  const job = { p, getBytes };
  front ? metaQueue.unshift(job) : metaQueue.push(job);
  tasks.meta.total++;
  renderTasksSoon();
  runMetaQueue();
}

function queueUnreadDetails() {
  for (const p of lib.papers.values()) if (!p.meta.status) queueDetails(p);
}

async function runMetaQueue() {
  if (metaRunning) return;
  metaRunning = true;
  while (metaQueue.length) {
    const job = metaQueue.shift();
    working.add(job.p.id);
    renderSoon();
    try {
      await readDetails(job);
    } catch (e) {
      console.warn('Reading details failed for', job.p.name, e);
    } finally {
      working.delete(job.p.id);
      tasks.meta.done++;
      renderSoon();
      renderTasksSoon();
    }
  }
  metaRunning = false;
}

async function readDetails({ p, getBytes }) {
  const reader = await metadataReader();
  if (!reader) return;
  // Right after an upload we still have the bytes; otherwise PDF.js fetches
  // only the parts of the file it needs (first page + info) from Drive.
  const src = getBytes ? { data: new Uint8Array(await getBytes()) } : await backend.pdfSource(p.id);
  const doc = await pdfjsLib.getDocument({ ...PDF_OPTS, ...src }).promise;
  let meta;
  try {
    meta = await reader.extractMetadata(doc, { fileName: p.name, online: true });
  } finally {
    doc.destroy();
  }
  if (meta?.title && meta.via !== 'filename') {
    await backend.saveMeta(p.id, meta, 'auto');
    p.meta = { ...p.meta, ...meta, authors: meta.authors || [], status: 'auto' };
  } else {
    // Keep the filename-based title out of Drive so a later lookup can still try.
    await backend.markMetaFailed(p.id);
    p.meta = { ...p.meta, status: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------
const PAPERS_MIME = 'application/x-dph-papers';
const FOLDER_MIME = 'application/x-dph-folder';

/** Files and folders dropped from the computer -> [{file, path:[dirs]}]. */
async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: [] }));
  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, path.concat(entry.name));
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, []);
  return out;
}

function draggedPaperIds(e) {
  try {
    return JSON.parse(e.dataTransfer.getData(PAPERS_MIME) || '[]');
  } catch {
    return [];
  }
}

function wireDragDrop() {
  const rows = $('rows');
  rows.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const ids = ui.checked.has(tr.dataset.id) ? [...ui.checked] : [tr.dataset.id];
    e.dataTransfer.setData(PAPERS_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'copyMove';
    const ghost = el('div', 'chip', `${ids.length} paper${ids.length > 1 ? 's' : ''}`);
    ghost.style.cssText = 'position:fixed;top:-100px';
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove());
  });

  const isFiles = (e) => [...e.dataTransfer.types].includes('Files');
  const isPapers = (e) => [...e.dataTransfer.types].includes(PAPERS_MIME);

  // Sidebar targets: collections, Unsorted, Favorites, Trash; while dragging a
  // collection, other collections and the COLLECTIONS heading (= top level).
  const side = $('libSide');
  let draggingFolder = null; // getData() isn't readable during dragover, so remember it here
  $('tree').addEventListener('dragstart', (e) => {
    const node = e.target.closest?.('.node[data-folder]');
    if (!node) return;
    draggingFolder = node.dataset.folder;
    e.dataTransfer.setData(FOLDER_MIME, draggingFolder);
    e.dataTransfer.effectAllowed = 'move';
  });
  $('tree').addEventListener('dragend', () => {
    draggingFolder = null;
    side.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
  });
  const folderTargetOf = (e) => {
    const t = e.target.closest('.node[data-folder], .side-heading');
    if (!t) return null;
    const dest = t.dataset.folder || lib.root.id;
    return subtree(draggingFolder).includes(dest) || lib.folders.get(draggingFolder)?.parentId === dest ? null : t;
  };
  const targetOf = (e) => e.target.closest('.node[data-folder], #navList li[data-view]');
  side.addEventListener('dragover', (e) => {
    if (draggingFolder) {
      const t = folderTargetOf(e);
      side.querySelectorAll('.drop-hover').forEach((n) => n !== t && n.classList.remove('drop-hover'));
      if (!t) return;
      e.preventDefault();
      t.classList.add('drop-hover');
      return;
    }
    const t = targetOf(e);
    if (!t || !(isFiles(e) || isPapers(e))) return;
    const v = t.dataset.view;
    if (v && (isFiles(e) || !['unsorted', 'favorites', 'trash'].includes(v))) return;
    e.preventDefault();
    side.querySelectorAll('.drop-hover').forEach((n) => n !== t && n.classList.remove('drop-hover'));
    t.classList.add('drop-hover');
  });
  side.addEventListener('dragleave', (e) => targetOf(e)?.classList.remove('drop-hover'));
  side.addEventListener('drop', async (e) => {
    if (draggingFolder) {
      const t = folderTargetOf(e);
      const id = draggingFolder;
      draggingFolder = null;
      side.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
      if (!t) return;
      e.preventDefault();
      return moveCollection(id, t.dataset.folder || lib.root.id);
    }
    const t = targetOf(e);
    if (!t) return;
    e.preventDefault();
    t.classList.remove('drop-hover');
    if (isFiles(e)) return enqueueUploads(await filesFromDrop(e.dataTransfer), t.dataset.folder);
    const ids = draggedPaperIds(e);
    if (t.dataset.folder) return movePapers(ids, t.dataset.folder);
    if (t.dataset.view === 'unsorted') return movePapers(ids, lib.root.id);
    if (t.dataset.view === 'trash') return trashPapers(ids);
    if (t.dataset.view === 'favorites') for (const id of ids) if (!lib.papers.get(id)?.starred) toggleStar(lib.papers.get(id));
  });

  // Main area: files from the computer upload into the open collection.
  const main = $('libMain');
  let depth = 0;
  main.addEventListener('dragenter', (e) => {
    if (!isFiles(e) || ui.view === 'trash') return;
    depth++;
    $('dropTarget').textContent = ui.view.startsWith('coll:') ? lib.folders.get(ui.view.slice(5)).name : 'Unsorted';
    $('dropOverlay').hidden = false;
  });
  main.addEventListener('dragleave', (e) => {
    if (!isFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      $('dropOverlay').hidden = true;
    }
  });
  main.addEventListener('dragover', (e) => {
    if (isFiles(e) && ui.view !== 'trash') e.preventDefault();
  });
  main.addEventListener('drop', async (e) => {
    depth = 0;
    $('dropOverlay').hidden = true;
    if (!isFiles(e) || ui.view === 'trash') return;
    e.preventDefault();
    const items = await filesFromDrop(e.dataTransfer);
    const dest = await importDestination(items);
    if (dest) enqueueUploads(items, dest);
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
let collMenuFor = null;
let uploadTargetFolder = null;

function wire() {
  // Sidebar navigation
  $('navList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-view]');
    if (li) setView(li.dataset.view);
  });
  $('tree').addEventListener('click', (e) => {
    const twist = e.target.closest('[data-twist]');
    const more = e.target.closest('[data-more]');
    const node = e.target.closest('.node[data-folder]');
    if (twist && !twist.classList.contains('leaf')) {
      const id = twist.dataset.twist;
      ui.openFolders.has(id) ? ui.openFolders.delete(id) : ui.openFolders.add(id);
      saveOpenFolders();
      twist.closest('li').classList.toggle('open');
    } else if (more) {
      e.stopPropagation();
      collMenuFor = more.dataset.more;
      const m = $('collMenu');
      const r = more.getBoundingClientRect();
      m.hidden = false;
      m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + 'px';
      m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
    } else if (node) {
      setView('coll:' + node.dataset.folder);
    }
  });
  $('collMenu').addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
    $('collMenu').hidden = true;
    if (!cmd || !collMenuFor) return;
    if (cmd === 'new') newCollection(collMenuFor);
    if (cmd === 'rename') renameCollection(collMenuFor);
    if (cmd === 'move') chooseCollectionMove(collMenuFor);
    if (cmd === 'delete') deleteCollection(collMenuFor);
    if (cmd === 'upload') {
      uploadTargetFolder = collMenuFor;
      $('fileInput').click();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#collMenu, [data-more]')) $('collMenu').hidden = true;
  });
  $('newCollection').onclick = () => newCollection(lib.root.id);

  // Header
  $('search').addEventListener(
    'input',
    debounce((e) => {
      ui.search = e.target.value.trim();
      renderTable();
    }, 120)
  );
  $('btnRefresh').onclick = () => loadLibrary({ quiet: true }).then(() => toast('Library reloaded from Drive'));
  $('btnAdd').onclick = () => {
    uploadTargetFolder = null;
    $('fileInput').click();
  };
  $('fileInput').addEventListener('change', (e) => {
    const files = [...e.target.files].map((file) => ({ file, path: [] }));
    e.target.value = '';
    enqueueUploads(files, uploadTargetFolder || currentFolderId());
  });
  $('btnImportFolder').onclick = () => $('folderInput').click();
  $('folderInput').addEventListener('change', (e) => {
    // webkitRelativePath is e.g. "Domain Adaptation/sub/x.pdf". The chosen
    // folder itself becomes a collection (inside the open one), and its
    // subfolders become sub-collections — same as dragging the folder in.
    const files = [...e.target.files].map((file) => {
      const parts = file.webkitRelativePath.split('/');
      return { file, path: parts.slice(0, -1) };
    });
    e.target.value = '';
    importDestination(files).then((dest) => dest && enqueueUploads(files, dest));
  });

  // Table header: sort, select all
  $('paperTable').querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.sort;
    ui.sort = { key, dir: ui.sort.key === key && ui.sortTouched ? -ui.sort.dir : key === 'added' ? -1 : 1 };
    ui.sortTouched = true;
    store.set({ libSort: ui.sort });
    renderTable();
  });
  $('checkAll').addEventListener('change', (e) => {
    for (const p of ui.visible) e.target.checked ? ui.checked.add(p.id) : ui.checked.delete(p.id);
    renderTable();
  });

  // Rows
  const rows = $('rows');
  rows.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const p = lib.papers.get(id) || lib.trashed.get(id);
    const index = ui.visible.findIndex((x) => x.id === id);
    if (e.target.closest('[data-check]')) {
      if (e.shiftKey && ui.lastCheckedIndex >= 0) {
        const [a, b] = [Math.min(index, ui.lastCheckedIndex), Math.max(index, ui.lastCheckedIndex)];
        for (let i = a; i <= b; i++) ui.checked.add(ui.visible[i].id);
      } else {
        ui.checked.has(id) ? ui.checked.delete(id) : ui.checked.add(id);
      }
      ui.lastCheckedIndex = index;
      renderTable();
      return;
    }
    if (e.target.closest('[data-star]')) return lib.papers.has(id) && toggleStar(p);
    if (e.target.closest('[data-open]')) return lib.papers.has(id) && openPaper(p);
    ui.selectedId = id;
    rows.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
    tr.classList.add('selected');
    renderDetails();
  });
  rows.addEventListener('dblclick', (e) => {
    const id = e.target.closest('tr')?.dataset.id;
    if (id && lib.papers.has(id) && !e.target.closest('[data-check],[data-star]')) openPaper(lib.papers.get(id));
  });

  // Bulk actions
  $('bulkBar').addEventListener('click', async (e) => {
    const k = e.target.closest('[data-bulk]')?.dataset.bulk;
    const ids = [...ui.checked];
    if (k === 'clear') {
      ui.checked.clear();
      return renderTable();
    }
    if (k === 'move') {
      const t = await pickCollection(`Move ${ids.length} paper${ids.length > 1 ? 's' : ''} to…`, { allowRoot: true });
      if (t) movePapers(ids, t);
    }
    if (k === 'add') {
      const t = await pickCollection(`Also list ${ids.length} paper${ids.length > 1 ? 's' : ''} in…`);
      if (t) addToCollection(ids, t);
    }
    if (k === 'remove') removeFromCollection(ids, ui.view.slice(5));
    if (k === 'lookup') {
      for (const id of ids) queueDetails(lib.papers.get(id), null, { front: true });
      toast(`Looking up details for ${ids.length} paper${ids.length > 1 ? 's' : ''}…`);
    }
    if (k === 'trash') trashPapers(ids);
    if (k === 'restore') restorePapers(ids);
  });

  // Details panel
  $('detClose').onclick = () => {
    ui.selectedId = null;
    renderTable();
    renderDetails();
  };
  $('dSave').onclick = async () => {
    const p = lib.papers.get(ui.selectedId);
    if (!p) return;
    const meta = {
      title: $('dTitle').value.replace(/\s+/g, ' ').trim(),
      authors: $('dAuthors').value.split('\n').map((s) => s.trim()).filter(Boolean),
      year: parseInt($('dYear').value, 10) || null,
      source: $('dSource').value.trim(),
      doi: $('dDoi').value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') || null,
      arxivId: $('dArxiv').value.trim().replace(/^arxiv:/i, '') || null,
    };
    try {
      await backend.saveMeta(p.id, meta, 'manual');
      p.meta = { ...p.meta, ...meta, status: 'manual' };
      renderSoon();
      toast('Details saved to Drive');
    } catch (e) {
      fail(e, 'Saving details');
    }
  };
  $('dLookup').onclick = async () => {
    const p = lib.papers.get(ui.selectedId);
    if (!p) return;
    const reader = await metadataReader();
    if (!reader) return toast('The metadata reader is not installed yet.');
    const doi = $('dDoi').value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const arxivId = $('dArxiv').value.trim().replace(/^arxiv:/i, '');
    if (doi || arxivId) {
      // The user typed an identifier: look that up directly.
      $('dStatus').textContent = 'Looking up…';
      const found = await reader.lookupOnline({ doi: doi || null, arxivId: arxivId || null, title: $('dTitle').value.trim() });
      if (!found) return ($('dStatus').textContent = 'Nothing found for that DOI / arXiv ID.');
      $('dTitle').value = found.title || '';
      $('dAuthors').value = (found.authors || []).join('\n');
      $('dYear').value = found.year || '';
      $('dSource').value = found.source || '';
      $('dDoi').value = found.doi || doi;
      $('dArxiv').value = found.arxivId || arxivId;
      $('dStatus').textContent = `Found via ${found.via}. Click “Save details” to keep it.`;
    } else {
      queueDetails(p, null, { front: true });
    }
  };
  $('dOpen').onclick = () => lib.papers.has(ui.selectedId) && openPaper(lib.papers.get(ui.selectedId));
  $('dDrive').onclick = () => {
    const p = lib.papers.get(ui.selectedId) || lib.trashed.get(ui.selectedId);
    if (p) window.open(p.webViewLink || `https://drive.google.com/file/d/${p.id}/view`, '_blank');
  };

  $('dExport').onclick = async () => {
    const p = lib.papers.get(ui.selectedId) || lib.trashed.get(ui.selectedId);
    if (!p) return;
    $('dExport').disabled = true;
    toast('Reading highlights…', 10_000);
    let doc;
    try {
      // Same partial loading as for details: PDF.js fetches only the parts it needs.
      doc = await pdfjsLib.getDocument({ ...PDF_OPTS, ...(await backend.pdfSource(p.id)) }).promise;
      const highlights = await readHighlights(doc);
      const paper = { ...p.meta, fileName: p.name };
      downloadText(markdownFileName(paper), buildMarkdown(paper, highlights));
      toast(highlights.length ? `Exported ${highlights.length} highlight${highlights.length === 1 ? '' : 's'}.` : 'This paper has no highlights yet; exported its details only.');
    } catch (e) {
      fail(e, 'Export');
    } finally {
      doc?.destroy();
      $('dExport').disabled = false;
    }
  };

  // Tasks panel
  $('tasksToggle').onclick = () => {
    $('tasksList').hidden = !$('tasksList').hidden;
    $('tasksToggle').textContent = $('tasksList').hidden ? 'Details' : 'Hide';
    renderTasks();
  };

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if ($('lib').hidden || $('dialog').open) return;
    const inField = e.target.closest?.('input, textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === '/' && !inField) {
      e.preventDefault();
      $('search').focus();
    } else if (inField) {
      if (e.key === 'Escape') e.target.blur();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      ui.visible.forEach((p) => ui.checked.add(p.id));
      renderTable();
    } else if (e.key === 'Delete' && ui.view !== 'trash') {
      const ids = ui.checked.size ? [...ui.checked] : ui.selectedId ? [ui.selectedId] : [];
      if (ids.length) trashPapers(ids);
    } else if (e.key === 'Enter' && lib.papers.has(ui.selectedId)) {
      openPaper(lib.papers.get(ui.selectedId));
    } else if (e.key === 'Escape') {
      ui.checked.clear();
      ui.selectedId = null;
      renderTable();
      renderDetails();
    }
  });

  // Theme: click cycles System -> Light -> Dark (shared with the viewer, see js/theme.js)
  const THEME_UI = { system: ['auto', 'Theme: System (follows your computer)'], light: ['sun', 'Theme: Light'], dark: ['moon', 'Theme: Dark'] };
  const syncThemeBtn = () => {
    const [name, label] = THEME_UI[window.PaperTheme.get()];
    $('btnTheme').replaceChildren(icon(name));
    $('btnTheme').title = label + ' — click to change';
  };
  $('btnTheme').onclick = () => {
    window.PaperTheme.set(window.PaperTheme.next());
    toast(THEME_UI[window.PaperTheme.get()][1]);
  };
  document.addEventListener('themechange', syncThemeBtn);
  syncThemeBtn();

  // Settings
  $('btnSettings').onclick = showSettings;

  // Setup / sign-in
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      navigator.clipboard.writeText($(b.dataset.copy).textContent);
      toast('Copied');
    };
  });
  $('saveClientId').onclick = async () => {
    const v = $('clientIdInput').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) return toast('That doesn’t look like an OAuth client ID (…apps.googleusercontent.com).', 4000);
    await auth.setClientId(v);
    showSignin();
  };
  $('signinBtn').onclick = async () => {
    $('signinError').textContent = '';
    try {
      await auth.getToken({ interactive: true });
      await loadLibrary();
    } catch (e) {
      $('signinError').textContent = 'Sign-in failed: ' + e.message + ' — check the client ID and redirect URI in the setup steps.';
    }
  };

  wireDragDrop();
}

async function showSettings() {
  const body = el('div');
  const auto = el('label', 'menu-check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = IN_EXTENSION ? !!(await chrome.storage.local.get('autoOpen')).autoOpen : false;
  cb.onchange = () => IN_EXTENSION && chrome.storage.local.set({ autoOpen: cb.checked });
  auto.append(cb, document.createTextNode(' Open PDFs in the highlighter automatically when I open them on drive.google.com'));
  const failed = [...lib.papers.values()].filter((p) => p.meta.status === 'failed');
  body.append(auto);
  const p = el('p', 'muted small', `Library folder in Drive: “${lib.root?.name || 'Paper Library'}”. Account: ${$('userEmail').textContent || '—'}.`);
  body.append(p);
  const actions = [
    { label: 'Close', value: 'close', primary: true },
    { label: 'Open library folder in Drive', value: 'folder' },
    ...(failed.length ? [{ label: `Retry details for ${failed.length} paper${failed.length > 1 ? 's' : ''}`, value: 'retry' }] : []),
    { label: 'Change OAuth client ID', value: 'client' },
    { label: 'Sign out', value: 'signout' },
  ];
  const r = await dialog({ title: 'Settings', body, actions });
  if (r === 'folder') window.open(`https://drive.google.com/drive/folders/${lib.root.id}`, '_blank');
  if (r === 'retry') failed.forEach((x) => queueDetails(x));
  if (r === 'client') {
    $('clientIdInput').value = await auth.getClientId();
    showSetup();
  }
  if (r === 'signout') {
    await auth.signOut();
    location.reload();
  }
}

boot().catch((e) => {
  console.error(e);
  toast('Something went wrong: ' + e.message, 8000);
});
