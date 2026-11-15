// Paper Library — supplementary reading mode.
//
//   ┌──────────────────────────┬─┬──────────────────────────────┐
//   │ the paper (viewer.html   │ │ ▸ Supplementary File 1       │
//   │ in a frame: highlights,  │↔│   (PDF in its own viewer,    │
//   │ autosave, everything)    │ │    image, video, table, text)│
//   │                          │ │ ▸ Supplementary File 2 …     │
//   └──────────────────────────┴─┴──────────────────────────────┘
//
// The paper and every supplementary PDF open in the normal viewer, loaded in a
// frame with &embed=1, so highlighting and saving work exactly as usual. Other
// files are downloaded once and shown from memory (blob: URLs); nothing is sent
// anywhere new. Several files can be open at once; each one can be resized.

import { loadProvider } from './js/provider.js';
import { fileKind, mimeFor, fmtSize } from './js/supplementary.js';

const IN_EXTENSION = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const params = new URLSearchParams(location.search);
const paperId = params.get('id');
const CLOUD = await loadProvider(params.get('p') || 'gdrive');
const pq = CLOUD.id === 'gdrive' ? '' : '&p=' + CLOUD.id;
// Outside the extension (demo mode, see dev/serve.py) a fake library stands in for the cloud.
const mock = IN_EXTENSION ? null : await import('./dev/mock-backend.js');
const backend = mock || CLOUD.library;
const files = mock || CLOUD.files; // download(id, onProgress)
const C = (s) => (CLOUD.id === 'gdrive' ? s : s.replace(/Google Drive/g, CLOUD.label).replace(/\bDrive\b/g, CLOUD.short));

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
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// Layout (divider position, which side the paper is on) is remembered per browser.
const LAYOUT_KEY = 'paperLibrary.suppLayout';
const layout = (() => {
  try {
    return { ratio: 0.55, swapped: false, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') };
  } catch {
    return { ratio: 0.55, swapped: false };
  }
})();
function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {}
}
function applyLayout() {
  $('split').style.setProperty('--left', (layout.swapped ? 1 - layout.ratio : layout.ratio) * 100 + '%');
  $('split').classList.toggle('swapped', layout.swapped);
}

const KIND_LABEL = { pdf: 'PDF', image: 'Image', video: 'Video', table: 'Data', text: 'Text' };
const ROW_LIMIT = 2000; // rows drawn for CSV/TSV (the browser slows down with very large tables)
const TEXT_LIMIT = 3 * 1024 * 1024;

const sections = []; // { file, kind, root, body, opened, loaded, blob, url, height }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  applyLayout();
  wireLayout();
  if (!paperId) return location.replace('library.html');
  $('paperFrame').src = mock
    ? 'viewer.html?src=/sample.pdf&embed=1'
    : `viewer.html?id=${encodeURIComponent(paperId)}${pq}&embed=1`;
  $('btnNormal').onclick = () =>
    (location.href = mock ? 'viewer.html?src=/sample.pdf' : `viewer.html?id=${encodeURIComponent(paperId)}${pq}`);
  $('btnExpandAll').onclick = () => sections.forEach((s) => setOpen(s, true));
  $('btnCollapseAll').onclick = () => sections.forEach((s) => setOpen(s, false));
  await loadAll();
}

async function loadAll() {
  showMsg('Loading supplementary files…');
  try {
    if (IN_EXTENSION) await CLOUD.auth.getToken({ interactive: false });
  } catch (e) {
    if (e.code === 'no-client-id') return showMsg(C('Paper Library is not connected to Google Drive yet.'), 'Open Paper Library', () => (location.href = 'library.html'));
    return showMsg(C('Sign in to Google Drive to see the supplementary files.'), 'Sign in', async () => {
      try {
        await CLOUD.auth.getToken({ interactive: true });
        loadAll();
      } catch (err) {
        showMsg('Sign-in did not complete: ' + err.message);
      }
    });
  }
  try {
    const [list] = await Promise.all([backend.listSupplementary(paperId), showPaperTitle()]);
    render(list);
  } catch (e) {
    console.error(e);
    showMsg('Could not load the supplementary files: ' + (e.message || e), 'Try again', loadAll);
  }
}

async function showPaperTitle() {
  try {
    let title, authors, year;
    if (mock) {
      const p = (await mock.loadLibrary()).papers.find((x) => x.id === paperId);
      ({ title, authors, year } = p?.meta || {});
      title ||= p?.name;
    } else {
      const meta = await CLOUD.files.getMetadata(paperId);
      const d = await CLOUD.library.paperDetails(meta).catch(() => ({}));
      ({ title, authors, year } = d);
      title ||= meta.name;
    }
    $('paperTitle').textContent = title || 'Paper';
    $('paperTitle').title = title || '';
    $('paperSub').textContent = [(authors || [])[0]?.split(',')[0] + ((authors || []).length > 1 ? ' et al.' : ''), year].filter((x) => x && x !== 'undefined').join(' · ');
    document.title = `${title} – supplementary reading`;
  } catch (e) {
    console.warn('Could not read the paper title', e);
    $('paperTitle').textContent = 'Paper';
  }
}

function showMsg(text, buttonLabel, onClick) {
  const m = $('suppMsg');
  m.replaceChildren(el('div', null, text));
  if (buttonLabel) {
    const b = el('button', 'btn primary', buttonLabel);
    b.onclick = onClick;
    m.append(b);
  }
  m.hidden = false;
  $('suppList').hidden = true;
}

// ---------------------------------------------------------------------------
// The accordion
// ---------------------------------------------------------------------------
function render(list) {
  $('suppHeading').textContent = `Supplementary files · ${list.length}`;
  if (!list.length) {
    return showMsg(
      'This paper has no supplementary files yet. In the library, select the paper and use “+ Add files” under Supplementary files in the details panel.',
      'Open Paper Library',
      () => (location.href = 'library.html')
    );
  }
  $('suppMsg').hidden = true;
  const acc = $('suppList');
  acc.hidden = false;
  acc.replaceChildren();
  sections.length = 0;
  for (const file of list) {
    const s = makeSection(file);
    sections.push(s);
    acc.append(s.root);
  }
  const first = sections.find((s) => s.file.id === params.get('open')) || sections[0];
  setOpen(first, true);
  first.root.scrollIntoView({ block: 'nearest' });
}

function makeSection(file) {
  const kind = fileKind(file.name, file.mimeType);
  const root = el('section', 'acc-sec');
  const head = el('div', 'acc-head');
  const toggle = el('button', 'acc-toggle');
  toggle.title = file.name;
  toggle.append(icon('tri'), el('span', 's-kind k-' + kind, KIND_LABEL[kind] || ext(file.name) || 'File'), el('span', 'acc-name', file.name), el('span', 'acc-size', fmtSize(file.size)));
  const actions = el('div', 'acc-actions');
  if (kind === 'pdf' && !mock) {
    const b = el('button', 'tb-btn');
    b.title = 'Open in a new tab';
    b.append(icon('external'));
    b.onclick = () => window.open(`viewer.html?id=${encodeURIComponent(file.id)}${pq}&supp=1`, '_blank');
    actions.append(b);
  }
  const dl = el('button', 'tb-btn');
  dl.title = 'Download';
  dl.append(icon('download'));
  actions.append(dl);
  if (file.webViewLink && file.webViewLink !== '#') {
    const b = el('button', 'tb-btn');
    b.title = C('Show in Drive');
    b.append(icon('cloud'));
    b.onclick = () => window.open(file.webViewLink, '_blank', 'noopener');
    actions.append(b);
  }
  head.append(toggle, actions);
  const body = el('div', 'acc-body');
  const grip = el('div', 'acc-resize');
  grip.title = 'Drag to resize';
  root.append(head, body, grip);
  const s = { file, kind, root, body, opened: false, loaded: false, blob: null, url: null, height: 0 };
  toggle.onclick = () => setOpen(s, !s.opened);
  dl.onclick = () => downloadFile(s);
  wireRowResize(s, grip);
  return s;
}

const ext = (name) => name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '';

function setOpen(s, open) {
  s.opened = open;
  s.root.classList.toggle('open', open);
  fitHeights();
  if (!open) return;
  if (!s.loaded) {
    s.loaded = true;
    show(s).catch((e) => {
      console.error(e);
      s.loaded = false;
      s.body.replaceChildren(el('div', 'acc-status err', `Could not open “${s.file.name}”: ${e.message || e}`));
    });
  }
}

/**
 * A file opened on its own fills the panel; two open files share it. Files you
 * resized yourself keep their height.
 */
function fitHeights() {
  const open = sections.filter((x) => x.opened);
  const auto = open.filter((x) => !x.userSized);
  const avail = $('suppList').clientHeight - sections.length * 41 - open.length * 8 - open.filter((x) => x.userSized).reduce((t, x) => t + x.height, 0);
  for (const x of auto) {
    x.height = Math.max(260, Math.round(avail / Math.min(auto.length, 2)));
    x.body.style.height = x.height + 'px';
  }
}

/** File bytes as a Blob, downloaded once (with progress shown in the section). */
async function blobOf(s) {
  if (s.blob) return s.blob;
  const status = el('div', 'acc-status', 'Downloading…');
  if (s.opened) s.body.replaceChildren(status);
  const bytes = await files.download(s.file.id, (loaded, total) => {
    status.textContent = total ? `Downloading… ${Math.round((loaded / total) * 100)}% of ${fmtSize(total)}` : `Downloading… ${fmtSize(loaded)}`;
  });
  s.blob = new Blob([bytes], { type: mimeFor(s.file.name, s.file.mimeType) });
  return s.blob;
}

const urlOf = async (s) => (s.url ||= URL.createObjectURL(await blobOf(s)));

async function show(s) {
  const { file, kind, body } = s;
  if (kind === 'pdf') {
    // The normal viewer, so supplementary PDFs can be highlighted too.
    const f = el('iframe');
    f.title = file.name;
    f.src = mock
      ? `viewer.html?src=${encodeURIComponent(await urlOf(s))}&embed=1&supp=1&name=${encodeURIComponent(file.name)}`
      : `viewer.html?id=${encodeURIComponent(file.id)}${pq}&embed=1&supp=1`;
    body.replaceChildren(f);
  } else if (kind === 'image') {
    const wrap = el('div', 'img-wrap');
    wrap.title = 'Click to switch between fit and actual size';
    const img = el('img');
    img.alt = file.name;
    img.src = await urlOf(s);
    wrap.append(img);
    wrap.onclick = () => wrap.classList.toggle('actual');
    body.replaceChildren(wrap);
  } else if (kind === 'video') {
    const v = el('video');
    v.controls = true;
    v.preload = 'metadata';
    v.src = await urlOf(s);
    body.replaceChildren(v);
  } else if (kind === 'table') {
    const text = await (await blobOf(s)).text();
    body.replaceChildren(...renderTable(text, /\.tsv$/i.test(file.name) ? '\t' : null));
  } else if (kind === 'text') {
    const blob = await blobOf(s);
    const pre = el('pre', 'text-view', await blob.slice(0, TEXT_LIMIT).text());
    const parts = [pre];
    if (blob.size > TEXT_LIMIT) parts.push(el('div', 'table-note', `Showing the first ${fmtSize(TEXT_LIMIT)} of ${fmtSize(blob.size)}. Download the file to see all of it.`));
    body.replaceChildren(...parts);
  } else {
    body.replaceChildren(fileCard(s));
  }
}

function fileCard(s) {
  const { file } = s;
  const card = el('div', 'file-card');
  card.append(el('span', 's-kind big-kind', ext(file.name) || 'File'), el('div', null, file.name));
  const office = /\.(docx?|xlsx?|pptx?|odt|ods)$/i.test(file.name);
  card.append(el('p', null, office
    ? 'Word and Excel files can’t be shown here yet (planned for a later version). Download it, or open it in your cloud.'
    : /\.tiff?$/i.test(file.name)
      ? 'Chrome can’t display TIFF images. Download it, or open it in your cloud.'
      : 'This kind of file can’t be shown here. Download it, or open it in your cloud.'));
  const row = el('div', 'row');
  const dl = el('button', 'btn primary');
  dl.append(icon('download'), document.createTextNode('Download'));
  dl.onclick = () => downloadFile(s);
  row.append(dl);
  if (file.webViewLink && file.webViewLink !== '#') {
    const open = el('button', 'btn');
    open.append(icon('cloud'), document.createTextNode(C('Show in Drive')));
    open.onclick = () => window.open(file.webViewLink, '_blank', 'noopener');
    row.append(open);
  }
  card.append(row);
  return card;
}

async function downloadFile(s) {
  try {
    if (!s.blob) toast(`Downloading “${s.file.name}”…`);
    const a = el('a');
    a.href = await urlOf(s);
    a.download = s.file.name;
    document.body.append(a);
    a.click();
    a.remove();
  } catch (e) {
    toast(`Download failed: ${e.message || e}`, 6000);
  }
}

// ---------------------------------------------------------------------------
// CSV / TSV as a table
// ---------------------------------------------------------------------------
/** Splits delimited text into rows; handles "quoted, fields" and "" escapes. Stops after `limit` rows. */
function parseDelimited(text, delim, limit = Infinity) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= limit) return rows;
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function guessDelimiter(text) {
  const nl = text.indexOf('\n');
  const line = text.slice(0, nl < 0 ? 2000 : nl);
  const count = (ch) => line.split(ch).length - 1;
  return [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
}

function renderTable(text, delim) {
  delim ||= guessDelimiter(text);
  const rows = parseDelimited(text.replace(/^﻿/, ''), delim, ROW_LIMIT + 1);
  const totalLines = (text.match(/\n/g) || []).length + (text.endsWith('\n') ? 0 : 1);
  const [header = [], ...data] = rows;
  const table = el('table', 'data-table');
  const thead = el('thead');
  const htr = el('tr');
  htr.append(el('th', 'rn', '#'), ...header.map((h) => el('th', null, h)));
  thead.append(htr);
  const tbody = el('tbody');
  const isNum = (v) => v !== '' && !Number.isNaN(Number(v));
  data.slice(0, ROW_LIMIT).forEach((r, k) => {
    const tr = el('tr');
    tr.append(el('th', 'rn', String(k + 1)));
    for (let c = 0; c < Math.max(r.length, header.length); c++) {
      const v = r[c] ?? '';
      tr.append(el('td', isNum(v) ? 'num' : null, v));
    }
    tbody.append(tr);
  });
  table.append(thead, tbody);
  const wrap = el('div', 'table-wrap');
  wrap.append(table);
  const shown = Math.min(data.length, ROW_LIMIT);
  const total = Math.max(totalLines - 1, shown);
  const note = el('div', 'table-note',
    total > shown ? `Showing the first ${shown.toLocaleString()} of about ${total.toLocaleString()} rows. Download the file to see all of it.` : `${shown.toLocaleString()} rows · ${header.length} columns`);
  return [wrap, note];
}

// ---------------------------------------------------------------------------
// Resizing: the divider between the panes, and each open file's height
// ---------------------------------------------------------------------------
function drag(handle, { rows = false, onMove, onEnd }) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    document.body.classList.add('dragging');
    document.body.classList.toggle('rows', rows);
    const move = (ev) => onMove(ev);
    const up = () => {
      handle.classList.remove('active');
      document.body.classList.remove('dragging', 'rows');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onEnd?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function wireLayout() {
  const split = $('split');
  const divider = $('divider');
  const setRatio = (r) => {
    layout.ratio = Math.min(0.85, Math.max(0.15, r));
    applyLayout();
  };
  drag(divider, {
    onMove: (e) => {
      const box = split.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width; // where the divider is, from the left
      setRatio(layout.swapped ? 1 - x : x);
    },
    onEnd: saveLayout,
  });
  divider.addEventListener('dblclick', () => {
    setRatio(0.5);
    saveLayout();
  });
  divider.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -0.03, ArrowRight: 0.03 }[e.key];
    if (!step) return;
    e.preventDefault();
    setRatio(layout.ratio + (layout.swapped ? -step : step));
    saveLayout();
  });
  $('btnSwap').onclick = () => {
    layout.swapped = !layout.swapped;
    applyLayout();
    saveLayout();
  };
}

function wireRowResize(s, grip) {
  let startY = 0;
  let startH = 0;
  grip.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    startH = s.body.getBoundingClientRect().height;
  });
  drag(grip, {
    rows: true,
    onMove: (e) => {
      s.userSized = true;
      s.height = Math.max(120, Math.round(startH + e.clientY - startY));
      s.body.style.height = s.height + 'px';
    },
  });
}

boot();
