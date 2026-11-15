// Exporting a paper's highlights and notes as Markdown.
//
// Why Markdown? It is plain text, so it opens anywhere, and note apps
// (Obsidian, Notion, Logseq, VS Code…) render it directly. A literature-review
// note can then quote exactly what you highlighted, with page numbers.
//
// Used by the viewer (highlights already in memory) and by the library
// (highlights read from the PDF with PDF.js, without opening the viewer).
// Nothing here touches the network: the file is made in the browser and
// handed to the browser's own download.

// Same palette as the viewer, so a highlight gets its familiar colour name.
const COLORS = [
  { name: 'Yellow', hex: '#ffe14d', mark: '🟨' },
  { name: 'Green', hex: '#8ff0a4', mark: '🟩' },
  { name: 'Blue', hex: '#99c1f1', mark: '🟦' },
  { name: 'Pink', hex: '#f5a3d0', mark: '🩷' },
  { name: 'Orange', hex: '#ffbe6f', mark: '🟧' },
  { name: 'Purple', hex: '#dc8add', mark: '🟪' },
];

/** Nearest palette colour, so highlights made in other apps still get a name. */
export function colorName(hex) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  const [r, g, b] = rgb(hex || '#ffe14d');
  let best = COLORS[0];
  let bestDist = Infinity;
  for (const c of COLORS) {
    const [r2, g2, b2] = rgb(c.hex);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bestDist) [best, bestDist] = [c, d];
  }
  return best;
}

// ---------------------------------------------------------------------------
// Finding the words under a highlight
// ---------------------------------------------------------------------------
// A highlight only stores rectangles (PDF coordinates), not text. We look at
// PDF.js's text items (each with a position and width) and keep the
// characters that fall inside each rectangle.

/** Text covered by `rects`, given a page's PDF.js text items. */
export function textInRects(items, rects) {
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
    // "repre-" + "sentation" → "representation" (a word split at the line end)
    if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1) + line;
    else out += (out ? ' ' : '') + line;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Reading highlights with PDF.js (library: no pdf-lib, no full download)
// ---------------------------------------------------------------------------

/**
 * Highlights of an open PDF.js document, in the same shape the viewer uses
 * ({ page, rects, color, note, text }). PDF.js loads only the pages it needs.
 */
export async function readHighlights(pdfDoc) {
  const out = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const annots = (await page.getAnnotations()).filter((a) => a.subtype === 'Highlight');
    if (!annots.length) continue;
    const items = (await page.getTextContent()).items.filter((it) => it.str);
    for (const a of annots) {
      const rects = quadRects(a.quadPoints);
      if (!rects.length && a.rect) rects.push(a.rect);
      out.push({
        page: i - 1,
        rects,
        color: a.color ? '#' + [...a.color].map((v) => v.toString(16).padStart(2, '0')).join('') : '#ffe14d',
        note: a.contentsObj?.str || '',
        text: textInRects(items, rects),
      });
    }
  }
  return out;
}

// PDF.js gives QuadPoints as one flat list, 8 numbers (4 corners) per line of
// the highlight. The corner order differs between apps, so take min/max.
function quadRects(q) {
  const rects = [];
  for (let i = 0; q && i + 7 < q.length; i += 8) {
    const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
    const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Building the Markdown
// ---------------------------------------------------------------------------

/** Reading order: by page, then top to bottom (PDF y grows upwards). */
export function sortHighlights(list) {
  const top = (h) => Math.max(...h.rects.map((r) => r[3]), 0);
  return [...list].sort((a, b) => a.page - b.page || top(b) - top(a));
}

const quote = (s) => s.split('\n').map((l) => '> ' + l).join('\n');

/**
 * @param paper { title, authors[], year, source, doi, arxivId, fileName }
 * @param highlights [{ page, color, note, text }]
 */
export function buildMarkdown(paper, highlights) {
  const title = paper.title || (paper.fileName || 'Untitled').replace(/\.pdf$/i, '');
  const lines = [`# ${title}`, ''];

  const facts = [];
  if (paper.authors?.length) facts.push(`**Authors:** ${paper.authors.join('; ')}`);
  if (paper.year) facts.push(`**Year:** ${paper.year}`);
  if (paper.source) facts.push(`**Source:** ${paper.source}`);
  if (paper.doi) facts.push(`**DOI:** [${paper.doi}](https://doi.org/${paper.doi})`);
  if (paper.arxivId) facts.push(`**arXiv:** [${paper.arxivId}](https://arxiv.org/abs/${paper.arxivId})`);
  if (paper.fileName) facts.push(`**File:** ${paper.fileName}`);
  // Two trailing spaces = a line break in Markdown, so each fact gets its own line.
  if (facts.length) lines.push(facts.join('  \n'), '');

  const sorted = sortHighlights(highlights);
  const notes = sorted.filter((h) => h.note).length;
  lines.push(
    `## Highlights (${sorted.length}${notes ? `, ${notes} with notes` : ''})`,
    ''
  );
  if (!sorted.length) lines.push('_No highlights in this paper yet._', '');

  let lastPage = -1;
  for (const h of sorted) {
    if (h.page !== lastPage) {
      lines.push(`### Page ${h.page + 1}`, '');
      lastPage = h.page;
    }
    const c = colorName(h.color);
    const text = h.text?.trim() || '_(no text found under this highlight, e.g. a figure or scanned page)_';
    lines.push(quote(`${c.mark} ${text}`), '');
    if (h.note?.trim()) lines.push(`**Note:** ${h.note.trim().replace(/\n+/g, '  \n')}`, '');
  }

  const today = new Date().toISOString().slice(0, 10);
  lines.push('---', `_Exported from Paper Library on ${today}._`, '');
  return lines.join('\n');
}

/** A safe file name: "Title (2023) - highlights.md". */
export function markdownFileName(paper) {
  const base = (paper.title || (paper.fileName || 'paper').replace(/\.pdf$/i, ''))
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${base}${paper.year ? ` (${paper.year})` : ''} - highlights.md`;
}

/** Hand the text to the browser's normal download (no extra permission needed). */
export function downloadText(fileName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
