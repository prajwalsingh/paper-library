// Reading and writing real PDF highlight annotations with pdf-lib.
//
// Why real annotations (and not a separate notes file)? A /Highlight
// annotation is part of the PDF standard, so the highlights you make here also
// show up in Evince/Papers, Okular, Adobe Reader, Zotero, Chrome's viewer and
// Drive's own preview — and highlights made in those apps show up here.
//
// Workflow:
//   1. splitHighlights(original): pull every /Highlight annotation out of the
//      PDF into plain JS objects and return the PDF *without* them ("base").
//      The viewer renders the base PDF and draws highlights itself as an
//      editable overlay (so you can recolor / delete any highlight, old or new).
//   2. applyHighlights(base, highlights): on save, write the current list of
//      highlights back into the base PDF as proper annotations.

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  PDFNumber,
  PDFString,
  PDFHexString,
  PDFRef,
} from '../lib/pdf-lib/pdf-lib.esm.min.js';

const N = (s) => PDFName.of(s);

function num(obj) {
  return obj instanceof PDFNumber ? obj.asNumber() : 0;
}

function text(obj) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return '';
}

function numbers(arr) {
  if (!(arr instanceof PDFArray)) return [];
  return arr.asArray().map(num);
}

function colorToHex(comps) {
  let rgb;
  if (comps.length === 3) rgb = comps;
  else if (comps.length === 1) rgb = [comps[0], comps[0], comps[0]];
  else if (comps.length === 4) {
    const [c, m, y, k] = comps;
    rgb = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  } else return '#ffe14d';
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

// PDF date "D:20261102143000+05'30'" <-> JS Date.
function toPdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function fromPdfDate(s) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)).toISOString();
}

// QuadPoints come in groups of 8 numbers (4 corners). We store each quad as
// its bounding rectangle [x1, y1, x2, y2] — highlights on normal text are
// axis-aligned, so nothing is lost.
function quadsToRects(q) {
  const rects = [];
  for (let i = 0; i + 7 < q.length; i += 8) {
    const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
    const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return rects;
}

function deleteIfRef(context, obj) {
  if (obj instanceof PDFRef) context.delete(obj);
}

export function newId() {
  return 'dph-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Removes all /Highlight annotations from the PDF.
 * Returns { baseBytes, highlights } — highlights as plain objects:
 *   { id, page, rects: [[x1,y1,x2,y2], ...], color: '#rrggbb', opacity, note, author, modified }
 * Coordinates are PDF user-space points (origin bottom-left of the page).
 */
export async function splitHighlights(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const highlights = [];

  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (!annots) return;

    const removed = new Set(); // refs/dicts of highlights we pulled out
    const entries = annots.asArray().map((raw) => ({ raw, dict: ctx.lookup(raw) }));

    for (const { raw, dict } of entries) {
      if (!(dict instanceof PDFDict) || dict.get(N('Subtype')) !== N('Highlight')) continue;
      let rects = quadsToRects(numbers(dict.lookup(N('QuadPoints'))));
      if (!rects.length) {
        const r = numbers(dict.lookup(N('Rect')));
        if (r.length === 4) rects = [[Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]];
      }
      const ca = dict.lookup(N('CA'));
      highlights.push({
        id: text(dict.lookup(N('NM'))) || newId(),
        page: pageIndex,
        rects,
        color: colorToHex(numbers(dict.lookup(N('C')))),
        opacity: ca instanceof PDFNumber ? ca.asNumber() : 1,
        note: text(dict.lookup(N('Contents'))),
        author: text(dict.lookup(N('T'))),
        modified: fromPdfDate(text(dict.lookup(N('M')))),
      });
      removed.add(raw);
      removed.add(dict);
    }
    if (!removed.size) return;

    const keep = [];
    for (const { raw, dict } of entries) {
      if (removed.has(raw)) {
        // Drop the annotation object and its appearance streams entirely so
        // the file doesn't accumulate dead objects over many save cycles.
        const ap = dict.lookup(N('AP'));
        if (ap instanceof PDFDict) {
          for (const k of ['N', 'D', 'R']) deleteIfRef(ctx, ap.get(N(k)));
          deleteIfRef(ctx, dict.get(N('AP')));
        }
        deleteIfRef(ctx, raw);
        continue;
      }
      // The pop-up note window attached to a highlight goes with it.
      if (dict instanceof PDFDict && dict.get(N('Subtype')) === N('Popup')) {
        const parent = dict.get(N('Parent'));
        if (parent && (removed.has(parent) || removed.has(ctx.lookup(parent)))) {
          deleteIfRef(ctx, raw);
          continue;
        }
      }
      keep.push(raw);
    }
    if (keep.length) page.node.set(N('Annots'), ctx.obj(keep));
    else page.node.delete(N('Annots'));
  });

  const baseBytes = highlights.length ? await doc.save() : bytes;
  return { baseBytes, highlights };
}

/** Writes highlights into the base PDF and returns the new PDF bytes. */
export async function applyHighlights(baseBytes, highlights, { author = '' } = {}) {
  const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();

  for (const h of highlights) {
    const page = pages[h.page];
    if (!page || !h.rects.length) continue;
    const rects = h.rects;
    const bbox = [
      Math.min(...rects.map((r) => r[0])),
      Math.min(...rects.map((r) => r[1])),
      Math.max(...rects.map((r) => r[2])),
      Math.max(...rects.map((r) => r[3])),
    ].map((v) => +v.toFixed(3));
    // Corner order (upper-left, upper-right, lower-left, lower-right) is the
    // one Acrobat, Evince/Poppler and PDF.js all expect in practice.
    const quadPoints = rects.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1].map((v) => +v.toFixed(3)));
    const [r, g, b] = hexToRgb(h.color);
    const opacity = h.opacity ?? 1;

    // Appearance stream: tells every viewer exactly how to draw the highlight.
    // "Multiply" blending tints the paper but keeps the black text crisp, like
    // a real highlighter pen.
    const content =
      `/GS0 gs\n${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} rg\n` +
      rects.map(([x1, y1, x2, y2]) => `${x1.toFixed(3)} ${y1.toFixed(3)} ${(x2 - x1).toFixed(3)} ${(y2 - y1).toFixed(3)} re f`).join('\n');
    const ap = ctx.stream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: bbox,
      Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: opacity, ca: opacity } } },
    });

    const fields = {
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: bbox,
      QuadPoints: quadPoints,
      C: [r, g, b],
      CA: opacity,
      F: 4, // print flag: highlight shows up when the PDF is printed
      P: page.ref,
      NM: PDFString.of(h.id),
      M: PDFString.of(toPdfDate(h.modified ? new Date(h.modified) : new Date())),
      AP: { N: ctx.register(ap) },
    };
    const who = h.author || author;
    if (who) fields.T = PDFHexString.fromText(who);
    if (h.note) fields.Contents = PDFHexString.fromText(h.note);
    page.node.addAnnot(ctx.register(ctx.obj(fields)));
  }
  return doc.save();
}
