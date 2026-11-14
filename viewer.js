// Paper Library — PDF viewer / highlighter page.
//
// Big picture:
//   Drive file ──download──▶ bytes ──splitHighlights──▶ base PDF + highlight list
//   base PDF ──PDF.js──▶ pages on screen (canvas + invisible text layer for selecting)
//   highlight list ──▶ coloured overlay divs (editable)
//   on change ──applyHighlights──▶ new PDF ──PATCH──▶ same Drive file (new revision)

import * as pdfjsLib from './lib/pdfjs/pdf.min.mjs';
import {
  EventBus,
  PDFLinkService,
  PDFFindController,
  PDFViewer,
  PDFHistory,
  LinkTarget,
  FindState,
} from './lib/pdfjs/pdf_viewer.mjs';
import * as auth from './js/auth.js';
import * as drive from './js/drive.js';
import { splitHighlights, applyHighlights, newId } from './js/annotations.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// When this page is served outside the extension (for local testing) we read
// a PDF from ?src=… and keep "saves" in memory instead of talking to Drive.
const IN_EXTENSION = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

const COLORS = [
  { name: 'Yellow', hex: '#ffe14d' },
  { name: 'Green', hex: '#8ff0a4' },
  { name: 'Blue', hex: '#99c1f1' },
  { name: 'Pink', hex: '#f5a3d0' },
  { name: 'Orange', hex: '#ffbe6f' },
  { name: 'Purple', hex: '#dc8add' },
];

const DEFAULT_PREFS = {
  autosave: true,
  night: false,
  color: COLORS[0].hex,
  sidebarOpen: true,
  sidebarTab: 'thumbs',
  positions: {},
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// ---------------------------------------------------------------------------
// Preferences (chrome.storage in the extension, localStorage when testing)
// ---------------------------------------------------------------------------
const store = {
  async get(keys) {
    if (IN_EXTENSION) return chrome.storage.local.get(keys);
    const out = {};
    for (const k of keys) {
      try {
        const v = localStorage.getItem('dph:' + k);
        if (v != null) out[k] = JSON.parse(v);
      } catch {}
    }
    return out;
  },
  async set(obj) {
    if (IN_EXTENSION) return chrome.storage.local.set(obj);
    for (const [k, v] of Object.entries(obj)) {
      try {
        localStorage.setItem('dph:' + k, JSON.stringify(v));
      } catch {}
    }
  },
};
let prefs = { ...DEFAULT_PREFS };
function setPref(key, value) {
  prefs[key] = value;
  store.set({ [key]: value });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  fileId: null,
  meta: null,
  revisionId: null,
  editable: true,
  cannotWrite: null, // reason string when the PDF can't be rewritten
  baseBytes: null,
  highlights: [],
  lastSavedJson: '[]',
  saving: false,
  saveQueued: false,
  saveError: null,
  saveTimer: null,
  undo: [],
  redo: [],
  selectedId: null,
  flashId: null,
  hlMode: false,
  pendingSelection: null,
  user: null,
  leaving: false,
};

let pdfDoc, pdfViewer, eventBus, linkService, pdfHistory;

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function showScreen(name) {
  $('app').hidden = name !== 'app';
  $('loading').hidden = name !== 'loading';
  $('errorScreen').hidden = name !== 'error';
}

function setLoading(text, fraction) {
  $('loadingText').textContent = text;
  $('loadingBar').parentElement.hidden = fraction == null;
  if (fraction != null) $('loadingBar').style.width = Math.round(fraction * 100) + '%';
}

function showError(err) {
  console.error(err);
  showScreen('error');
  $('errorText').textContent = err?.message || String(err);
  document.title = 'Error – Paper Library';
}

let toastTimer;
function toast(msg, ms = 2800) {
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  prefs = { ...DEFAULT_PREFS, ...(await store.get(Object.keys(DEFAULT_PREFS))) };
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const src = params.get('src');
  wireStaticUi();

  if (!IN_EXTENSION) {
    if (src) return openDocument({ kind: 'url', src, name: params.get('name') });
    return showError(new Error('Open this page through the Chrome extension.'));
  }
  if (id) return openDocument({ kind: 'drive', id });
  location.replace('library.html'); // no file given: show the library
}

function waitForSignIn(message) {
  return new Promise((resolve) => {
    showScreen('loading');
    setLoading(message, null);
    document.querySelector('#loading .spinner').hidden = true;
    const btn = $('loadingSignin');
    btn.hidden = false;
    btn.onclick = async () => {
      try {
        await auth.getToken({ interactive: true });
        btn.hidden = true;
        document.querySelector('#loading .spinner').hidden = false;
        resolve();
      } catch (e) {
        setLoading('Sign-in did not complete: ' + e.message, null);
      }
    };
  });
}

async function loadUser() {
  try {
    state.user = await drive.getAbout();
    await auth.rememberAccount(state.user.emailAddress);
  } catch (e) {
    console.warn('Could not read account info', e);
  }
}

async function openDocument(source) {
  showScreen('loading');
  setLoading('Connecting to Google Drive…', null);
  try {
    let bytes, meta;
    if (source.kind === 'drive') {
      try {
        await auth.getToken({ interactive: false });
      } catch (e) {
        if (e.code === 'no-client-id') return location.replace('library.html');
        await waitForSignIn('Sign in to Google Drive to open this PDF.');
      }
      setLoading('Connecting to Google Drive…', null);
      [meta] = await Promise.all([drive.getMetadata(source.id), loadUser()]);
      if (meta.mimeType !== 'application/pdf') {
        throw new Error(`“${meta.name}” is not a PDF file (type: ${meta.mimeType}).`);
      }
      if (meta.capabilities?.canDownload === false) {
        throw new Error('The owner of this file has disabled downloading, so it can only be viewed inside Drive.');
      }
      document.title = meta.name;
      setLoading(`Downloading “${meta.name}”…`, 0);
      bytes = await drive.download(meta.id, (loaded, total) => {
        setLoading(`Downloading “${meta.name}”…`, total ? loaded / total : null);
      });
    } else {
      const res = await fetch(source.src);
      if (!res.ok) throw new Error(`Could not fetch ${source.src}: ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
      meta = { id: 'local', name: source.name || decodeURIComponent(source.src.split('/').pop()), capabilities: { canEdit: true }, headRevisionId: 'local' };
      state.user = { displayName: 'Demo user' };
    }

    state.fileId = meta.id;
    state.meta = meta;
    state.revisionId = meta.headRevisionId;
    if (source.kind === 'drive' && state.editable) {
      // Remember when this paper was last opened (shown in the library as Recently Read).
      drive.patchMetadata(meta.id, { properties: { dphLr: new Date().toISOString() } }).catch(() => {});
    }
    state.editable = meta.capabilities?.canEdit !== false;
    document.title = meta.name;

    setLoading('Reading highlights…', null);
    let base = bytes;
    let highlights = [];
    try {
      ({ baseBytes: base, highlights } = await splitHighlights(bytes));
    } catch (e) {
      console.warn('pdf-lib could not parse this PDF; opening read-only', e);
      state.cannotWrite =
        'This PDF is encrypted or uses features the editor cannot rewrite, so highlights cannot be saved into it.';
    }
    state.baseBytes = base;
    state.highlights = highlights;
    state.lastSavedJson = serialize();

    setLoading('Rendering…', null);
    await initViewer(base);
    showScreen('app');
    updateStatus();
    showBannerIfNeeded();
    $('viewerContainer').focus();
  } catch (e) {
    if (e instanceof auth.AuthError && e.code === 'needs-sign-in') {
      await waitForSignIn('Your Google session expired. Sign in again to continue.');
      return openDocument(source);
    }
    showError(e);
  }
}

function showBannerIfNeeded() {
  const b = $('banner');
  let msg = '';
  if (state.cannotWrite) msg = state.cannotWrite + ' You can still read it here.';
  else if (!state.editable)
    msg = 'You have view-only access to this file. Highlights can’t be saved into it — use Menu → “Save a copy to Drive”.';
  b.textContent = msg;
  b.hidden = !msg;
}

// ---------------------------------------------------------------------------
// PDF.js viewer
// ---------------------------------------------------------------------------
async function initViewer(baseBytes) {
  const container = $('viewerContainer');
  eventBus = new EventBus();
  linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer',
  });
  const findController = new PDFFindController({ eventBus, linkService });
  pdfViewer = new PDFViewer({
    container,
    viewer: $('viewer'),
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    maxCanvasPixels: 2 ** 25,
  });
  linkService.setViewer(pdfViewer);
  pdfHistory = new PDFHistory({ linkService, eventBus });
  linkService.setHistory(pdfHistory);

  const task = pdfjsLib.getDocument({
    data: baseBytes.slice(), // PDF.js takes ownership of the buffer; keep our copy for saving
    cMapUrl: new URL('./lib/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./lib/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false,
  });
  task.onPassword = (update, reason) => {
    const pw = prompt(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'Wrong password. Try again:' : 'This PDF is password-protected. Password:');
    if (pw == null) task.destroy();
    else update(pw);
  };
  pdfDoc = await task.promise;

  eventBus.on('pagesinit', onPagesInit);
  eventBus.on('pagerendered', ({ pageNumber }) => renderPageHighlights(pageNumber - 1));
  eventBus.on('pagechanging', ({ pageNumber }) => {
    $('pageInput').value = pageNumber;
    $('btnPrev').disabled = pageNumber <= 1;
    $('btnNext').disabled = pageNumber >= pdfViewer.pagesCount;
    markCurrentThumb(pageNumber);
    rememberPosition();
  });
  eventBus.on('scalechanging', ({ scale, presetValue }) => {
    syncZoomSelect(scale, presetValue);
    rememberPosition();
  });
  eventBus.on('updatefindmatchescount', ({ matchesCount }) => showFindCount(matchesCount));
  eventBus.on('updatefindcontrolstate', ({ state: fs, matchesCount }) => {
    if (fs === FindState.NOT_FOUND) {
      $('findCount').textContent = 'No matches';
      $('findCount').classList.add('notfound');
    } else showFindCount(matchesCount);
  });

  pdfViewer.setDocument(pdfDoc);
  linkService.setDocument(pdfDoc);
  pdfHistory.initialize({ fingerprint: pdfDoc.fingerprints[0], resetHistory: true, updateUrl: false });
  $('pageCount').textContent = pdfDoc.numPages;
  $('docTitle').textContent = state.meta.name;
  $('docTitle').title = state.meta.name;
}

function onPagesInit() {
  const pos = prefs.positions?.[state.fileId];
  pdfViewer.currentScaleValue = pos?.scale || 'auto';
  if (pos?.page > 1 && pos.page <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = pos.page;
  $('btnPrev').disabled = pdfViewer.currentPageNumber <= 1;
  $('btnNext').disabled = pdfViewer.currentPageNumber >= pdfViewer.pagesCount;
  buildThumbnails();
  buildOutline();
  renderHighlightList();
  fillHighlightTexts(state.highlights);
  updateUndoButtons();
}

const rememberPosition = debounce(() => {
  if (!pdfViewer || !state.fileId) return;
  const positions = { ...(prefs.positions || {}) };
  delete positions[state.fileId];
  positions[state.fileId] = { page: pdfViewer.currentPageNumber, scale: pdfViewer.currentScaleValue };
  const keys = Object.keys(positions);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete positions[k];
  setPref('positions', positions);
}, 800);

function syncZoomSelect(scale, presetValue) {
  const sel = $('zoomSelect');
  const custom = $('customZoom');
  const value = presetValue || String(scale);
  const match = [...sel.options].find((o) => o !== custom && (o.value === value || Number(o.value) === Number(value)));
  if (match) {
    custom.hidden = true;
    sel.value = match.value;
  } else {
    custom.hidden = false;
    custom.textContent = Math.round(scale * 100) + '%';
    sel.value = 'custom';
  }
}

function refitIfPreset() {
  if (!pdfViewer?.pdfDocument) return;
  const v = pdfViewer.currentScaleValue;
  if (['auto', 'page-width', 'page-fit'].includes(v)) pdfViewer.currentScaleValue = v;
}

// ---------------------------------------------------------------------------
// Geometry helpers: screen pixels <-> PDF points
// ---------------------------------------------------------------------------
function pageBox(pv) {
  const r = pv.div.getBoundingClientRect();
  return { left: r.left + pv.div.clientLeft, top: r.top + pv.div.clientTop, width: pv.div.clientWidth, height: pv.div.clientHeight };
}

function clientToPdf(pv, x, y) {
  const b = pageBox(pv);
  const vp = pv.viewport;
  return vp.convertToPdfPoint(((x - b.left) * vp.width) / b.width, ((y - b.top) * vp.height) / b.height);
}

/** Merge per-word/per-span rectangles into one rectangle per line. */
function mergeLineRects(rects) {
  rects = rects.filter((r) => r[2] - r[0] > 0.3 && r[3] - r[1] > 0.3);
  rects.sort((a, b) => b[3] + b[1] - (a[3] + a[1]) || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const h = r[3] - r[1];
    const m = out.find((o) => {
      const oh = o[3] - o[1];
      const overlap = Math.min(o[3], r[3]) - Math.max(o[1], r[1]);
      const gap = Math.max(r[0] - o[2], o[0] - r[2]);
      return overlap > 0.5 * Math.min(h, oh) && gap < 1.2 * Math.max(h, oh);
    });
    if (m) {
      m[0] = Math.min(m[0], r[0]);
      m[1] = Math.min(m[1], r[1]);
      m[2] = Math.max(m[2], r[2]);
      m[3] = Math.max(m[3], r[3]);
    } else out.push([...r]);
  }
  return out.map((r) => r.map((v) => Math.round(v * 100) / 100));
}

/**
 * Turns the browser text selection into highlight rectangles, grouped by page.
 * We walk the selected text nodes of PDF.js's (invisible) text layer and ask
 * the browser for their on-screen boxes, then convert those to PDF points.
 */
function selectionToPageRects(range) {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue.trim() && range.intersectsNode(n) && n.parentElement?.closest('.textLayer')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const byPage = new Map();
  const sub = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const pageDiv = n.parentElement.closest('.page');
    const pageIndex = Number(pageDiv?.dataset.pageNumber) - 1;
    if (!(pageIndex >= 0)) continue;
    sub.selectNodeContents(n);
    if (n === range.startContainer) sub.setStart(n, range.startOffset);
    if (n === range.endContainer) sub.setEnd(n, range.endOffset);
    if (sub.collapsed || !sub.toString().trim()) continue;
    const pv = pdfViewer.getPageView(pageIndex);
    const list = byPage.get(pageIndex) || [];
    for (const r of sub.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const [x1, y1] = clientToPdf(pv, r.left, r.top);
      const [x2, y2] = clientToPdf(pv, r.right, r.bottom);
      list.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
    }
    byPage.set(pageIndex, list);
  }
  const out = new Map();
  for (const [page, rects] of byPage) {
    const merged = mergeLineRects(rects);
    if (merged.length) out.set(page, merged);
  }
  return out;
}

function hitTest(pageIndex, x, y) {
  const tol = 1;
  for (let i = state.highlights.length - 1; i >= 0; i--) {
    const h = state.highlights[i];
    if (h.page !== pageIndex) continue;
    if (h.rects.some((r) => x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol)) return h;
  }
  return null;
}

function highlightAtEvent(e) {
  const pageDiv = e.target.closest?.('.page');
  if (!pageDiv) return null;
  const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
  const pv = pdfViewer.getPageView(pageIndex);
  if (!pv) return null;
  const [x, y] = clientToPdf(pv, e.clientX, e.clientY);
  return hitTest(pageIndex, x, y);
}

// ---------------------------------------------------------------------------
// Highlight overlay rendering
// ---------------------------------------------------------------------------
function renderPageHighlights(pageIndex) {
  const pv = pdfViewer?.getPageView(pageIndex);
  const wrapper = pv?.div?.querySelector('.canvasWrapper');
  if (!wrapper) return;
  let layer = wrapper.querySelector(':scope > .hlLayer');
  if (!layer) {
    layer = el('div', 'hlLayer');
    wrapper.append(layer);
  }
  const vp = pv.viewport;
  const frag = document.createDocumentFragment();
  for (const h of state.highlights) {
    if (h.page !== pageIndex) continue;
    for (const r of h.rects) {
      const [a, b, c, d] = vp.convertToViewportRectangle(r);
      const div = el('div', 'hl');
      div.dataset.id = h.id;
      div.style.left = (Math.min(a, c) / vp.width) * 100 + '%';
      div.style.top = (Math.min(b, d) / vp.height) * 100 + '%';
      div.style.width = (Math.abs(c - a) / vp.width) * 100 + '%';
      div.style.height = (Math.abs(d - b) / vp.height) * 100 + '%';
      div.style.background = h.color;
      if ((h.opacity ?? 1) < 1) div.style.opacity = h.opacity;
      if (h.id === state.selectedId) div.classList.add('selected');
      if (h.id === state.flashId) div.classList.add('flash');
      frag.append(div);
    }
  }
  layer.replaceChildren(frag);
}

function renderAllHighlightLayers() {
  if (!pdfViewer) return;
  for (let i = 0; i < pdfViewer.pagesCount; i++) renderPageHighlights(i);
}

// ---------------------------------------------------------------------------
// Highlight text (for the sidebar list) from PDF.js text content
// ---------------------------------------------------------------------------
const textCache = new Map();
function pageTextItems(pageIndex) {
  if (!textCache.has(pageIndex)) {
    textCache.set(
      pageIndex,
      pdfDoc
        .getPage(pageIndex + 1)
        .then((p) => p.getTextContent())
        .then((tc) => tc.items.filter((it) => it.str))
    );
  }
  return textCache.get(pageIndex);
}

function textInRects(items, rects) {
  const lines = [];
  for (const [x1, y1, x2, y2] of rects) {
    const parts = [];
    for (const it of items) {
      const [, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || it.width <= 0) continue;
      const h = it.height || Math.abs(d);
      const overlap = Math.min(y2, f + 0.85 * h) - Math.max(y1, f - 0.25 * h);
      if (overlap < 0.4 * Math.min(h, y2 - y1)) continue;
      const ox1 = Math.max(x1, e);
      const ox2 = Math.min(x2, e + it.width);
      const n = it.str.length;
      if (ox2 - ox1 < 0.4 * (it.width / n)) continue;
      const s = Math.max(0, Math.round(((ox1 - e) / it.width) * n));
      const t = Math.min(n, Math.round(((ox2 - e) / it.width) * n));
      if (t > s) parts.push({ x: ox1, s: it.str.slice(s, t) });
    }
    parts.sort((p, q) => p.x - q.x);
    lines.push(parts.map((p) => p.s).join('').trim());
  }
  return joinLines(lines);
}

function joinLines(lines) {
  let out = '';
  for (const line of lines) {
    if (!line) continue;
    if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1) + line;
    else out += (out ? ' ' : '') + line;
  }
  return out.replace(/\s+/g, ' ').trim();
}

async function fillHighlightTexts(list) {
  const todo = list.filter((h) => !h.text);
  if (!todo.length) return;
  for (const h of todo) {
    try {
      h.text = textInRects(await pageTextItems(h.page), h.rects);
    } catch {}
  }
  renderHighlightList();
}

// ---------------------------------------------------------------------------
// Editing highlights (+ undo/redo)
// ---------------------------------------------------------------------------
function serialize() {
  return JSON.stringify(state.highlights.map(({ text, ...h }) => h));
}

function pushUndo() {
  state.undo.push(structuredClone(state.highlights));
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(structuredClone(state.highlights));
  state.highlights = state.undo.pop();
  hidePopovers();
  changed();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(structuredClone(state.highlights));
  state.highlights = state.redo.pop();
  hidePopovers();
  changed();
}

function updateUndoButtons() {
  $('btnUndo').disabled = !state.undo.length;
  $('btnRedo').disabled = !state.redo.length;
}

/** Call after any change to state.highlights. */
function changed({ list = true } = {}) {
  renderAllHighlightLayers();
  if (list) renderHighlightList();
  updateThumbMarks();
  updateUndoButtons();
  onDirty();
}

function createHighlights(parts, color, selectedText) {
  if (!parts.size) return;
  pushUndo();
  const now = new Date().toISOString();
  const created = [];
  for (const [page, rects] of parts) {
    const h = {
      id: newId(),
      page,
      rects,
      color,
      opacity: 1,
      note: '',
      author: state.user?.displayName || '',
      modified: now,
      text: parts.size === 1 ? (selectedText || '').replace(/\s+/g, ' ').trim() : '',
    };
    state.highlights.push(h);
    created.push(h);
  }
  changed();
  fillHighlightTexts(created);
  return created;
}

function deleteHighlight(id) {
  const i = state.highlights.findIndex((h) => h.id === id);
  if (i < 0) return;
  pushUndo();
  state.highlights.splice(i, 1);
  if (state.selectedId === id) state.selectedId = null;
  hidePopovers();
  changed();
}

function recolorHighlight(id, color) {
  const h = state.highlights.find((x) => x.id === id);
  if (!h || h.color === color) return;
  pushUndo();
  h.color = color;
  h.modified = new Date().toISOString();
  setPref('color', color);
  updateColorUi();
  changed();
}

function selectHighlight(id, { at } = {}) {
  state.selectedId = id;
  renderAllHighlightLayers();
  document.querySelectorAll('.hl-item').forEach((n) => n.classList.toggle('selected', n.dataset.id === id));
  if (id && at) showHlPopover(id, at);
}

function goToHighlight(h) {
  const top = Math.max(...h.rects.map((r) => r[3]));
  const left = Math.min(...h.rects.map((r) => r[0]));
  pdfViewer.scrollPageIntoView({
    pageNumber: h.page + 1,
    destArray: [null, { name: 'XYZ' }, left - 40, top + 80, null],
    allowNegativeOffset: true,
  });
  state.flashId = h.id;
  renderPageHighlights(h.page);
  setTimeout(() => {
    if (state.flashId === h.id) {
      state.flashId = null;
      renderPageHighlights(h.page);
    }
  }, 1300);
}

// ---------------------------------------------------------------------------
// Saving to Drive
// ---------------------------------------------------------------------------
function isDirty() {
  return serialize() !== state.lastSavedJson;
}

function onDirty() {
  updateStatus();
  clearTimeout(state.saveTimer);
  if (prefs.autosave && canSaveInPlace() && isDirty()) {
    // Wait for a pause in editing so a burst of highlights becomes one Drive revision.
    state.saveTimer = setTimeout(() => save(), 2500);
  }
}

function canSaveInPlace() {
  return state.editable && !state.cannotWrite;
}

function updateStatus() {
  const s = $('saveStatus');
  const t = $('saveText');
  let cls, text, title;
  if (state.cannotWrite) [cls, text, title] = ['readonly', 'Read only', state.cannotWrite];
  else if (!state.editable) [cls, text, title] = ['readonly', 'View only', 'You can’t edit this Drive file. Use Menu → Save a copy.'];
  else if (state.saving) [cls, text, title] = ['saving', 'Saving…', 'Uploading to Google Drive'];
  else if (state.saveError) {
    const signIn = state.saveError.code === 'needs-sign-in';
    [cls, text, title] = ['error', signIn ? 'Sign in to save' : 'Save failed – retry', state.saveError.message];
  } else if (isDirty()) [cls, text, title] = ['dirty', prefs.autosave ? 'Saving soon…' : 'Unsaved changes', 'Click to save to Drive now (Ctrl S)'];
  else [cls, text, title] = ['saved', 'Saved to Drive', state.lastSavedAt ? `Last saved ${state.lastSavedAt.toLocaleTimeString()}` : 'All highlights are in the Drive file'];
  s.className = 'save-status ' + cls;
  t.textContent = text;
  s.title = title;
}

async function buildPdfBytes() {
  if (state.cannotWrite) throw new Error(state.cannotWrite);
  return applyHighlights(state.baseBytes, state.highlights, { author: state.user?.displayName || '' });
}

async function save({ force = false, manual = false } = {}) {
  clearTimeout(state.saveTimer);
  if (!canSaveInPlace()) {
    if (manual) toast(state.cannotWrite || 'View-only file: use Menu → “Save a copy to Drive”.');
    return;
  }
  if (state.saving) {
    state.saveQueued = true;
    return;
  }
  const snapshot = serialize();
  if (!force && snapshot === state.lastSavedJson) {
    if (manual) toast('All highlights are already saved to Drive.');
    return;
  }
  state.saving = true;
  state.saveError = null;
  updateStatus();
  let conflictMeta = null;
  try {
    const bytes = await buildPdfBytes();
    if (IN_EXTENSION) {
      // Someone (or another device) changed the file since we opened it?
      const current = await drive.getMetadata(state.fileId);
      if (!force && state.revisionId && current.headRevisionId && current.headRevisionId !== state.revisionId) {
        conflictMeta = current;
      } else {
        const updated = await drive.updateContent(state.fileId, bytes);
        state.revisionId = updated.headRevisionId;
        state.meta = { ...state.meta, ...updated };
        state.lastSavedJson = snapshot;
        state.lastSavedAt = new Date();
      }
    } else {
      await sleep(300);
      window.__savedBytes = bytes; // local test mode
      state.lastSavedJson = snapshot;
      state.lastSavedAt = new Date();
    }
  } catch (e) {
    console.error('Save failed', e);
    state.saveError = e;
    if (manual) toast('Save failed: ' + e.message, 5000);
  } finally {
    state.saving = false;
    updateStatus();
  }
  if (conflictMeta) return handleConflict(conflictMeta);
  if (state.saveQueued) {
    state.saveQueued = false;
    if (isDirty()) save();
  }
}

async function handleConflict(current) {
  const who = current.lastModifyingUser?.displayName;
  const when = current.modifiedTime ? new Date(current.modifiedTime).toLocaleString() : '';
  const choice = await dialog({
    title: 'This PDF changed on Drive',
    body:
      `The file was modified${who ? ' by ' + who : ''}${when ? ' on ' + when : ''} after you opened it here. ` +
      'Overwriting replaces that version with yours (Drive keeps the old one under “Manage versions”).',
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Reload from Drive', value: 'reload' },
      { label: 'Save as copy', value: 'copy' },
      { label: 'Overwrite', value: 'overwrite', primary: true },
    ],
  });
  if (choice === 'overwrite') return save({ force: true, manual: true });
  if (choice === 'copy') return saveCopy();
  if (choice === 'reload') {
    state.leaving = true;
    location.reload();
    return;
  }
  // Cancel: stop autosaving into a conflict until the user decides.
  state.saveError = new Error('Not saved: the file changed on Drive. Click to choose what to do.');
  updateStatus();
}

async function saveCopy() {
  if (!IN_EXTENSION) return toast('Not available in local test mode.');
  const input = el('input');
  input.type = 'text';
  input.style.width = '100%';
  input.value = state.meta.name.replace(/\.pdf$/i, '') + ' (highlighted).pdf';
  const wrap = el('div');
  wrap.append(el('p', null, 'Name for the new file (saved next to the original when possible):'), input);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      closeDialog('ok');
    }
  });
  setTimeout(() => input.select(), 50);
  const choice = await dialog({
    title: 'Save a copy to Drive',
    body: wrap,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save copy', value: 'ok', primary: true },
    ],
  });
  if (choice !== 'ok') return;
  try {
    toast('Saving a copy…');
    const bytes = await buildPdfBytes();
    let created;
    try {
      created = await drive.createFile(input.value.trim() || 'Highlighted.pdf', bytes, state.meta.parents);
    } catch (e) {
      created = await drive.createFile(input.value.trim() || 'Highlighted.pdf', bytes); // e.g. no write access to that folder
    }
    state.leaving = true;
    location.href = `viewer.html?id=${encodeURIComponent(created.id)}`;
  } catch (e) {
    toast('Could not save a copy: ' + e.message, 5000);
  }
}

async function downloadPdf() {
  try {
    const bytes = await buildPdfBytes().catch(() => state.baseBytes);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = el('a');
    a.href = url;
    a.download = state.meta.name || 'document.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    toast('Download failed: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Sidebar: thumbnails, outline, highlight list
// ---------------------------------------------------------------------------
let thumbObserver;
async function buildThumbnails() {
  const panel = $('panel-thumbs');
  panel.replaceChildren();
  thumbObserver?.disconnect();
  const first = await pdfDoc.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  const ratio = vp1.height / vp1.width;
  thumbObserver = new IntersectionObserver(
    (entries) => entries.forEach((en) => en.isIntersecting && renderThumb(en.target)),
    { root: panel, rootMargin: '400px 0px' }
  );
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const t = el('div', 'thumb');
    t.dataset.page = i;
    const box = el('div', 'tcanvas');
    box.style.height = Math.round(120 * ratio) + 'px';
    t.append(box, el('span', 'tnum', String(i)));
    t.addEventListener('click', () => {
      linkService.goToPage(i);
    });
    panel.append(t);
    thumbObserver.observe(t);
  }
  markCurrentThumb(pdfViewer.currentPageNumber);
  updateThumbMarks();
}

async function renderThumb(t) {
  if (t.dataset.rendered) return;
  t.dataset.rendered = '1';
  thumbObserver.unobserve(t);
  const page = await pdfDoc.getPage(Number(t.dataset.page));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (120 * (window.devicePixelRatio || 1)) / base.width });
  const canvas = el('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const box = t.querySelector('.tcanvas');
  box.style.height = Math.round((120 * base.height) / base.width) + 'px';
  box.replaceChildren(canvas);
}

function markCurrentThumb(n) {
  const panel = $('panel-thumbs');
  panel.querySelector('.thumb.current')?.classList.remove('current');
  const t = panel.querySelector(`.thumb[data-page="${n}"]`);
  if (!t) return;
  t.classList.add('current');
  if (!panel.hidden && !document.body.classList.contains('sidebar-closed')) t.scrollIntoView({ block: 'nearest' });
}

function updateThumbMarks() {
  const firstColor = new Map();
  for (const h of state.highlights) if (!firstColor.has(h.page)) firstColor.set(h.page, h.color);
  document.querySelectorAll('#panel-thumbs .thumb').forEach((t) => {
    const c = firstColor.get(Number(t.dataset.page) - 1);
    let mark = t.querySelector('.tmark');
    if (c && !mark) t.append((mark = el('span', 'tmark')));
    if (mark) {
      if (c) mark.style.background = c;
      else mark.remove();
    }
  });
}

async function buildOutline() {
  const panel = $('panel-outline');
  panel.replaceChildren();
  const outline = await pdfDoc.getOutline();
  if (!outline?.length) {
    panel.append(el('div', 'side-empty', 'This document has no outline.'));
    return;
  }
  const build = (items, depth) => {
    const ul = el('ul', depth === 0 ? 'outline' : '');
    for (const item of items) {
      const li = el('li');
      const row = el('div', 'oi');
      if (item.items?.length) {
        const tog = el('button', 'otoggle');
        tog.innerHTML = '<svg><use href="#i-down"/></svg>';
        tog.addEventListener('click', () => li.classList.toggle('collapsed'));
        row.append(tog);
        if (depth >= 1) li.classList.add('collapsed');
      } else row.append(el('span', 'ospacer'));
      const a = el('a', null, item.title);
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (item.dest) linkService.goToDestination(item.dest);
        else if (item.url) window.open(item.url, '_blank', 'noopener');
      });
      row.append(a);
      li.append(row);
      if (item.items?.length) li.append(build(item.items, depth + 1));
      ul.append(li);
    }
    return ul;
  };
  panel.append(build(outline, 0));
}

function renderHighlightList() {
  const panel = $('panel-highlights');
  const n = state.highlights.length;
  $('hlCount').textContent = n ? `(${n})` : '';
  panel.replaceChildren();
  if (!n) {
    panel.append(el('div', 'side-empty', 'No highlights yet. Select text and pick a colour, or press H to turn on the highlighter.'));
    return;
  }
  const sorted = [...state.highlights].sort(
    (a, b) => a.page - b.page || Math.max(...b.rects.map((r) => r[3])) - Math.max(...a.rects.map((r) => r[3]))
  );
  let lastPage = -1;
  for (const h of sorted) {
    if (h.page !== lastPage) {
      panel.append(el('div', 'hl-group', `Page ${h.page + 1}`));
      lastPage = h.page;
    }
    const item = el('div', 'hl-item');
    item.tabIndex = 0;
    item.dataset.id = h.id;
    item.style.setProperty('--c', h.color);
    if (h.id === state.selectedId) item.classList.add('selected');
    item.append(el('div', 'htext', h.text || '…'));
    if (h.note) {
      const note = el('div', 'hnote');
      note.innerHTML = '<svg><use href="#i-note"/></svg>';
      note.append(el('span', null, h.note));
      item.append(note);
    }
    const del = el('button', 'icon-btn hdel');
    del.title = 'Delete highlight';
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHighlight(h.id);
    });
    item.append(del);
    item.addEventListener('click', () => {
      goToHighlight(h);
      selectHighlight(h.id);
    });
    panel.append(item);
  }
}

function setSidebarTab(tab) {
  setPref('sidebarTab', tab);
  document.querySelectorAll('.side-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of ['thumbs', 'outline', 'highlights']) $('panel-' + t).hidden = t !== tab;
}

function toggleSidebar(open = document.body.classList.contains('sidebar-closed')) {
  document.body.classList.toggle('sidebar-closed', !open);
  $('btnSidebar').classList.toggle('active', open);
  setPref('sidebarOpen', open);
  requestAnimationFrame(refitIfPreset);
}

// ---------------------------------------------------------------------------
// Popovers
// ---------------------------------------------------------------------------
function makeSwatches(container, current, onPick) {
  container.replaceChildren(
    ...COLORS.map((c) => {
      const b = el('button', 'swatch' + (c.hex === current ? ' current' : ''));
      b.type = 'button';
      b.title = c.name;
      b.style.setProperty('--c', c.hex);
      b.addEventListener('click', () => onPick(c.hex));
      return b;
    })
  );
}

function placePopover(pop, x, y) {
  pop.hidden = false;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8);
  let top = y;
  if (top + h > innerHeight - 8) top = Math.max(8, y - h - 40);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function showSelPopover(range, parts, text) {
  state.pendingSelection = { parts, text };
  const rects = range.getClientRects();
  const last = rects[rects.length - 1] || range.getBoundingClientRect();
  const pop = $('selPopover');
  makeSwatches(pop.querySelector('[data-role=sel-swatches]'), null, (color) => {
    const sel = state.pendingSelection;
    if (!sel) return;
    setPref('color', color);
    updateColorUi();
    createHighlights(sel.parts, color, sel.text);
    getSelection().removeAllRanges();
    hidePopovers();
  });
  placePopover(pop, last.right, last.bottom + 10);
}

let noteUndoPushed = false;
function showHlPopover(id, at) {
  const h = state.highlights.find((x) => x.id === id);
  if (!h) return;
  const pop = $('hlPopover');
  pop.dataset.id = id;
  makeSwatches(pop.querySelector('[data-role=hl-swatches]'), h.color, (color) => {
    recolorHighlight(id, color);
    showHlPopover(id, null);
  });
  const ta = pop.querySelector('[data-role=note]');
  ta.value = h.note || '';
  ta.readOnly = !!state.cannotWrite;
  noteUndoPushed = false;
  const when = h.modified ? new Date(h.modified).toLocaleString() : '';
  pop.querySelector('[data-role=meta]').textContent = [h.author, when, `page ${h.page + 1}`].filter(Boolean).join(' · ');
  if (at) placePopover(pop, at.x, at.y + 14);
}

function hidePopovers() {
  $('selPopover').hidden = true;
  $('hlPopover').hidden = true;
  $('colorMenu').hidden = true;
  $('mainMenu').hidden = true;
  state.pendingSelection = null;
}

// ---------------------------------------------------------------------------
// Highlighter tool & colour
// ---------------------------------------------------------------------------
function setHlMode(on) {
  state.hlMode = on;
  $('btnHlMode').classList.toggle('active', on);
  document.body.classList.toggle('hl-mode-on', on);
}

function updateColorUi() {
  $('hlColorDot').style.background = prefs.color;
  document.body.style.setProperty('--hl-color', prefs.color);
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------
function openFind() {
  $('findbar').hidden = false;
  $('findInput').focus();
  $('findInput').select();
}
function closeFind() {
  $('findbar').hidden = true;
  eventBus?.dispatch('findbarclose', { source: window });
  $('viewerContainer').focus();
}
function runFind(type, findPrevious = false) {
  $('findCount').classList.remove('notfound');
  eventBus.dispatch('find', {
    source: window,
    type,
    query: $('findInput').value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}
function showFindCount(mc) {
  const c = $('findCount');
  c.classList.remove('notfound');
  c.textContent = mc?.total ? `${mc.current} of ${mc.total}` : '';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireStaticUi() {
  // Restore preferences
  document.body.classList.toggle('night', !!prefs.night);
  $('optNight').checked = !!prefs.night;
  $('optAutosave').checked = !!prefs.autosave;
  document.body.classList.toggle('sidebar-closed', !prefs.sidebarOpen);
  $('btnSidebar').classList.toggle('active', !!prefs.sidebarOpen);
  setSidebarTab(prefs.sidebarTab || 'thumbs');
  updateColorUi();

  // Toolbar
  $('btnSidebar').onclick = () => toggleSidebar();
  $('btnBack').onclick = () => pdfHistory?.back();
  $('btnPrev').onclick = () => pdfViewer?.previousPage();
  $('btnNext').onclick = () => pdfViewer?.nextPage();
  $('pageInput').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (n >= 1 && n <= pdfViewer.pagesCount) linkService.goToPage(n);
    else e.target.value = pdfViewer.currentPageNumber;
  });
  $('pageInput').addEventListener('focus', (e) => e.target.select());
  $('btnZoomIn').onclick = () => pdfViewer?.increaseScale();
  $('btnZoomOut').onclick = () => pdfViewer?.decreaseScale();
  $('zoomSelect').addEventListener('change', (e) => {
    if (e.target.value !== 'custom') pdfViewer.currentScaleValue = e.target.value;
    $('viewerContainer').focus();
  });
  $('btnHlMode').onclick = () => setHlMode(!state.hlMode);
  $('btnColor').onclick = (e) => {
    const m = $('colorMenu');
    if (!m.hidden) return (m.hidden = true);
    hidePopovers();
    makeSwatches(m.querySelector('[data-role=menu-swatches]'), prefs.color, (c) => {
      setPref('color', c);
      updateColorUi();
      setHlMode(true);
      m.hidden = true;
    });
    const r = e.currentTarget.getBoundingClientRect();
    placePopover(m, r.left + r.width / 2, r.bottom + 6);
  };
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  $('btnFind').onclick = () => ($('findbar').hidden ? openFind() : closeFind());
  $('saveStatus').onclick = async () => {
    if (state.saveError?.code === 'needs-sign-in') {
      try {
        await auth.getToken({ interactive: true });
      } catch (e) {
        return toast('Sign-in failed: ' + e.message);
      }
    }
    if (!canSaveInPlace()) return toast(state.cannotWrite || 'View-only file: use Menu → “Save a copy to Drive”.', 4000);
    save({ manual: true });
  };
  $('btnMenu').onclick = (e) => {
    const m = $('mainMenu');
    if (!m.hidden) return (m.hidden = true);
    hidePopovers();
    const r = e.currentTarget.getBoundingClientRect();
    m.hidden = false;
    m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
    m.style.top = r.bottom + 6 + 'px';
  };

  // Main menu
  $('mainMenu').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (!action) return;
    $('mainMenu').hidden = true;
    ({
      save: () => save({ manual: true }),
      copy: saveCopy,
      download: downloadPdf,
      drive: () => window.open(state.meta?.webViewLink || `https://drive.google.com/file/d/${state.fileId}/view`, '_blank'),
      reload: () => location.reload(),
      home: () => (location.href = 'library.html'),
      shortcuts: showShortcuts,
    })[action]?.();
  });
  $('optAutosave').addEventListener('change', (e) => {
    setPref('autosave', e.target.checked);
    onDirty();
  });
  // Theme: System / Light / Dark (shared with the library page, see js/theme.js)
  const syncThemeSeg = () =>
    document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === window.PaperTheme.get()));
  $('themeSeg').addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme-set]')?.dataset.themeSet;
    if (t) window.PaperTheme.set(t);
  });
  document.addEventListener('themechange', syncThemeSeg);
  syncThemeSeg();
  $('optNight').addEventListener('change', (e) => {
    setPref('night', e.target.checked);
    document.body.classList.toggle('night', e.target.checked);
  });

  // Sidebar tabs
  document.querySelectorAll('.side-tabs button').forEach((b) => (b.onclick = () => setSidebarTab(b.dataset.tab)));

  // Find bar
  $('findInput').addEventListener('input', () => runFind(''));
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runFind('again', e.shiftKey);
    if (e.key === 'Escape') closeFind();
  });
  $('findNext').onclick = () => runFind('again', false);
  $('findPrev').onclick = () => runFind('again', true);
  $('findClose').onclick = closeFind;

  // Popovers: keep the text selection alive while clicking their buttons
  for (const id of ['selPopover', 'colorMenu']) {
    $(id).addEventListener('mousedown', (e) => e.preventDefault());
  }
  $('selPopover').addEventListener('click', (e) => {
    if (e.target.closest('[data-action=copy]')) {
      navigator.clipboard.writeText(state.pendingSelection?.text || getSelection().toString());
      toast('Copied');
      hidePopovers();
    }
  });
  const hlPop = $('hlPopover');
  hlPop.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    const h = state.highlights.find((x) => x.id === hlPop.dataset.id);
    if (!h) return;
    if (action === 'delete') deleteHighlight(h.id);
    if (action === 'copy') {
      navigator.clipboard.writeText(h.text || '');
      toast('Copied');
    }
  });
  const noteTa = hlPop.querySelector('[data-role=note]');
  const noteChanged = debounce(() => changed(), 400);
  noteTa.addEventListener('input', () => {
    const h = state.highlights.find((x) => x.id === hlPop.dataset.id);
    if (!h) return;
    if (!noteUndoPushed) {
      pushUndo();
      noteUndoPushed = true;
    }
    h.note = noteTa.value;
    h.modified = new Date().toISOString();
    noteChanged();
  });
  noteTa.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hidePopovers();
      $('viewerContainer').focus();
    }
  });

  // Selecting text / clicking highlights on the pages
  const container = $('viewerContainer');
  container.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    setTimeout(() => onPointerUp(e), 0);
  });
  container.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.popover')) hidePopovers();
  });
  let hoverRaf = 0;
  container.addEventListener('pointermove', (e) => {
    if (hoverRaf || e.buttons) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      document.body.classList.toggle('over-hl', !!(pdfViewer && highlightAtEvent(e)));
    });
  });
  container.addEventListener(
    'scroll',
    () => {
      $('selPopover').hidden = true;
      $('colorMenu').hidden = true;
      if (document.activeElement !== noteTa) $('hlPopover').hidden = true;
    },
    { passive: true }
  );
  document.addEventListener('selectionchange', () => {
    if (getSelection().isCollapsed) $('selPopover').hidden = true;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.popover, #btnMenu, #btnColor')) {
      $('mainMenu').hidden = true;
      $('colorMenu').hidden = true;
    }
  });

  // Ctrl + mouse wheel / trackpad pinch zoom around the cursor
  let zoomAcc = 1;
  container.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !pdfViewer) return;
      e.preventDefault();
      zoomAcc *= Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002));
      if (Math.abs(Math.log(zoomAcc)) < 0.04) return;
      pdfViewer.updateScale({ scaleFactor: zoomAcc, origin: [e.clientX, e.clientY], drawingDelay: 300 });
      zoomAcc = 1;
    },
    { passive: false }
  );

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', debounce(refitIfPreset, 150));

  // Never lose work: warn on close, and flush autosave when the tab is hidden.
  window.addEventListener('beforeunload', (e) => {
    if (state.leaving || !pdfViewer || !canSaveInPlace()) return;
    if (state.saving || isDirty()) {
      e.preventDefault();
      e.returnValue = '';
      save();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && prefs.autosave && canSaveInPlace() && isDirty()) save();
  });

  // Home page
  $('errorRetry').onclick = () => location.reload();
  $('errorHome').onclick = () => (location.href = 'library.html');
}

function onPointerUp(e) {
  if (!pdfViewer) return;
  const sel = getSelection();
  if (sel.isCollapsed || !sel.rangeCount) {
    if (e.target.closest('.annotationLayer a, .popover')) return;
    const h = highlightAtEvent(e);
    if (h) selectHighlight(h.id, { at: { x: e.clientX, y: e.clientY } });
    else if (state.selectedId) selectHighlight(null);
    return;
  }
  const range = sel.getRangeAt(0);
  if (!$('viewer').contains(range.commonAncestorContainer)) return;
  const parts = selectionToPageRects(range);
  if (!parts.size) return;
  const text = sel.toString();
  if (state.hlMode) {
    createHighlights(parts, prefs.color, text);
    sel.removeAllRanges();
  } else {
    showSelPopover(range, parts, text);
  }
}

function onKeyDown(e) {
  if ($('app').hidden || $('dialog').open) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]');

  if (mod && key === 's') {
    e.preventDefault();
    if (!canSaveInPlace()) toast(state.cannotWrite || 'View-only file: use Menu → “Save a copy to Drive”.');
    else save({ manual: true });
  } else if (mod && key === 'f') {
    e.preventDefault();
    openFind();
  } else if (mod && (key === '=' || key === '+')) {
    e.preventDefault();
    pdfViewer.increaseScale();
  } else if (mod && key === '-') {
    e.preventDefault();
    pdfViewer.decreaseScale();
  } else if (mod && key === '0') {
    e.preventDefault();
    pdfViewer.currentScaleValue = 'auto';
  } else if (inField) {
    return;
  } else if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) {
    e.preventDefault();
    redo();
  } else if (!mod && !e.altKey && key === 'h') {
    setHlMode(!state.hlMode);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
    e.preventDefault();
    deleteHighlight(state.selectedId);
  } else if (e.key === 'Escape') {
    hidePopovers();
    if (state.selectedId) selectHighlight(null);
    else if (state.hlMode) setHlMode(false);
    if (!$('findbar').hidden) closeFind();
  } else if (e.key === 'F9') {
    e.preventDefault();
    toggleSidebar();
  } else if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    pdfHistory.back();
  } else if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    pdfHistory.forward();
  }
}

function showShortcuts() {
  const rows = [
    ['Select text', 'Pick a colour in the pop-up to highlight'],
    ['H', 'Highlighter tool on/off (select = highlight)'],
    ['Click a highlight', 'Change colour, add a note, delete'],
    ['Delete', 'Delete the selected highlight'],
    ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'],
    ['Ctrl S', 'Save to Drive now'],
    ['Ctrl F', 'Find in document'],
    ['Ctrl + / Ctrl − / Ctrl 0', 'Zoom in / out / automatic'],
    ['Ctrl + mouse wheel', 'Zoom around the cursor'],
    ['Alt ← / Alt →', 'Back / forward after following a link'],
    ['F9', 'Show / hide sidebar'],
  ];
  const table = el('table');
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('td', null, k), el('td', null, v));
    table.append(tr);
  }
  dialog({ title: 'Keyboard shortcuts', body: table, actions: [{ label: 'Close', value: 'close', primary: true }] });
}

boot().catch(showError);
