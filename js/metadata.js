// Automatic paper metadata (title, authors, year, source) — like Mendeley's
// "details" pane.
//
// Why two stages?
//   1. readPdfMetadata(): look only at the PDF itself. A PDF usually carries a
//      *stable identifier* (a DOI printed on page 1, or the arXiv stamp in the
//      left margin) plus enough layout clues (the biggest text near the top is
//      the title) for a decent guess. This works offline and leaks nothing.
//   2. lookupOnline(): turn the identifier into clean, curated metadata from a
//      public database (Crossref for DOIs, arXiv for preprints). Identifiers are
//      exact, so these answers are trustworthy. Without an identifier we fall
//      back to a Crossref title search, but only accept it when the returned
//      title really matches our guess — a wrong paper is worse than no paper.
//
// Only the DOI / arXiv id / title guess is ever sent over the network — never
// the PDF text and never any user identifier.
//
// This module does not import PDF.js: it receives an already-loaded
// PDFDocumentProxy, so it works with the browser build (extension) and the
// legacy build (Node tests) alike.

const FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const clean = (s) => String(s || '').replace(/[\u0000-\u001f­]/g, ' ').replace(/\s+/g, ' ').trim();

// Lowercase, strip accents/punctuation: lets "Deep CORAL: Correlation…" match
// "Deep CORAL - correlation…" when comparing titles.
function normalizeTitle(s) {
  return clean(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/<[^>]+>/g, ' ') // Crossref titles sometimes contain <i>…</i>
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Title similarity in [0, 1]. Edit-distance ratio on normalized strings,
 * with one extra rule: a long guess that is an exact *prefix* of the found
 * title also counts (filenames and PDF guesses are often cut off after the
 * first line, e.g. "Deep CORAL: Correlation Alignment for Deep").
 */
export function titleSimilarity(guess, found) {
  const a = normalizeTitle(guess);
  const b = normalizeTitle(found);
  if (!a || !b) return 0;
  const ratio = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const aw = a.split(' ').length;
  if (aw >= 4 && b.startsWith(a + ' ') && a.length >= 0.45 * b.length) return Math.max(ratio, 0.9);
  return ratio;
}

// ---------------------------------------------------------------------------
// Author names -> "Last, First" (Mendeley style)
// ---------------------------------------------------------------------------

// Lowercase particles belong to the last name: "Laurens van der Maaten" ->
// "van der Maaten, Laurens".
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'da', 'di', 'du', 'dos', 'la', 'le', 'bin', 'al', 'ter', 'ten']);
const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i;

export function toLastFirst(name) {
  const n = clean(name).replace(/\s*\d+$/, '');
  if (!n) return '';
  if (n.includes(',')) return n; // already "Last, First"
  const parts = n.split(' ');
  if (parts.length === 1) return n;
  let suffix = '';
  if (SUFFIX.test(parts[parts.length - 1]) && parts.length > 2) suffix = ' ' + parts.pop();
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  const last = parts.slice(i).join(' ') + suffix;
  const first = parts.slice(0, i).join(' ');
  return first ? `${last}, ${first}` : last;
}

// A plausible personal name: 2–5 words, each starting with an uppercase
// letter (or a lowercase particle), no digits, no institution words.
const NAME_WORD = /^(\p{Lu}[\p{L}'’.-]*|\p{Lu}\.)$/u;
const NOT_A_NAME = /\b(universit\w*|institut\w*|department|dept|school|college|faculty|academy|laborator\w*|lab|labs|research|center|centre|hospital|foundation|inc|ltd|corp|google|meta|facebook|microsoft|deepmind|openai|nvidia|amazon|engineering|science|sciences|technology|intelligence|computer|computing|informatics|mathematics|physics|neuroscience|psychology|cognitive|brain|region|city|street|abstract|introduction|supplementary|material|equal|contribution|correspond\w*|email|conference|proceedings|journal|arxiv|preprint|review|anonymous|author|authors|admin|user|neural|network|networks|data|model|models|vision|learning)\b/i;

function looksLikeName(s) {
  if (!s || s.length > 60 || /\d|@|[(){}[\]]/.test(s) || NOT_A_NAME.test(s)) return false;
  const words = s.split(' ');
  if (words.length < 2 || words.length > 5) return false;
  // ALL-CAPS words are section headings or acronyms, not names.
  if (words.some((w) => /^\p{Lu}{3,}$/u.test(w))) return false;
  if (words.length === 2 && /^\p{Lu}{2}$/u.test(words[0])) return false; // "UC Berkeley", "KU Leuven"
  return words.every((w) => NAME_WORD.test(w) || PARTICLES.has(w.toLowerCase()));
}

// Split an author string like "A. Smith, B. Jones and C. Lee" into names.
function splitAuthorString(s) {
  return clean(s)
    .replace(/[∗*†‡§¶♯♮⋆✉]+/g, ' ')
    .split(/\s*(?:,|;|&|\band\b|·|•|\s{2,})\s*/i)
    .map((p) => clean(p.replace(/\d+$/, '')))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Turning PDF.js text items into lines
// ---------------------------------------------------------------------------

/**
 * PDF.js gives us text "items" (runs of text with one font and position).
 * A title can be split into many items (small caps, kerning), so we glue
 * items that sit on the same baseline into lines and remember each line's
 * font size — the size is our main signal for "this is the title".
 */
function buildLines(items) {
  const lines = [];
  const rotated = []; // vertical text, e.g. the arXiv stamp in the left margin
  let cur = null;
  for (const it of items) {
    if (!it.str || !it.str.trim()) {
      if (it.hasEOL && cur) cur.eol = true;
      continue;
    }
    const [a, b, c, d, x, y] = it.transform;
    if (Math.abs(b) > Math.abs(a) + 0.01) {
      rotated.push(it.str);
      continue;
    }
    const size = Math.hypot(c, d) || it.height || 0;
    // Same line = close baseline (superscripts sit a little higher) and the
    // item continues to the right of the previous one.
    const sameLine = cur && !cur.eol && Math.abs(y - cur.y) < Math.max(size, cur.firstSize) * 0.6 && x >= cur.xEnd - size;
    if (!sameLine) {
      cur = { text: '', plain: '', y, x, xEnd: x, firstSize: size, size: 0, chars: 0, sizeChars: new Map(), eol: false };
      lines.push(cur);
    }
    // Insert a space when there is a visible gap between items.
    const gap = cur.text && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && x - cur.xEnd > size * 0.15 ? ' ' : '';
    cur.text += gap + it.str;
    // `plain` swaps raised, smaller items (affiliation superscripts like "1",
    // "a,b", "∗") for a comma. Without this "Spoerer" + superscript "a"
    // reads as one word "Spoerera" in the author line.
    const isSup = cur.chars > 0 && size < cur.firstSize * 0.8 && y > cur.y + size * 0.2;
    cur.plain += isSup ? ' , ' : gap + it.str;
    cur.xEnd = x + (it.width || 0);
    const n = it.str.trim().length;
    const key = Math.round(size * 10) / 10;
    cur.sizeChars.set(key, (cur.sizeChars.get(key) || 0) + n);
    cur.chars += n;
    if (it.hasEOL) cur.eol = true;
  }
  for (const l of lines) {
    // A line's size = the size carrying most of its characters, so one
    // superscript "∗" or a big drop-cap does not change it.
    let best = 0, bestN = -1;
    for (const [s, n] of l.sizeChars) if (n > bestN || (n === bestN && s > best)) { best = s; bestN = n; }
    l.size = best;
    l.text = clean(l.text);
    l.plain = clean(l.plain);
    delete l.sizeChars;
  }
  return { lines: lines.filter((l) => l.text), rotated: rotated.join(' ') };
}

async function readPage(pdfDoc, n) {
  if (n > pdfDoc.numPages) return null;
  try {
    const page = await pdfDoc.getPage(n);
    const tc = await page.getTextContent();
    const [, y0, , y1] = page.view;
    const { lines, rotated } = buildLines(tc.items);
    return { lines, rotated, height: y1 - y0, bottom: y0, text: lines.map((l) => l.text).join('\n') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/gi;

function tidyDoi(d) {
  // Trailing punctuation is almost never part of a DOI ("…/abc123)." in text).
  let doi = d.replace(/[).,;:\]}'"]+$/, '');
  // Keep a closing ")" if the DOI itself has an opening "(" (Elsevier style).
  if ((d.match(/\(/g) || []).length > (doi.match(/\)/g) || []).length && d.slice(doi.length).startsWith(')')) doi += ')';
  return doi.replace(/^doi:\s*/i, '');
}

function findDois(text) {
  return [...String(text || '').matchAll(DOI_RE)].map((m) => tidyDoi(m[1]));
}

// arXiv ids: new style 2007.01434(v1), old style cs/0601001 or math.GT/0309136.
const ARXIV_PREFIXED = /arxiv\s*[:.]?\s*(?:abs\/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?/gi;
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?/gi;
const ARXIV_BARE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/g;

function validNewArxiv(id) {
  const m = /^(\d{2})(\d{2})\.(\d{4,5})$/.exec(id);
  if (!m) return true; // old style, already constrained by the regex
  const mm = +m[2];
  // 4-digit numbers were used until 2014-12, 5-digit from 2015-01.
  return mm >= 1 && mm <= 12 && (m[3].length === 5) === (+m[1] >= 15);
}

function findArxiv(text, { bare = false } = {}) {
  const res = [];
  const s = String(text || '');
  for (const re of [ARXIV_PREFIXED, ARXIV_URL, ...(bare ? [ARXIV_BARE] : [])]) {
    for (const m of s.matchAll(re)) if (validNewArxiv(m[1])) res.push({ id: m[1], version: m[2] || '' });
  }
  return res;
}

function arxivYear(id) {
  const m = /(?:^|\/)(\d{2})\d{2}(?:\.|\d)/.exec(id || '');
  if (!m) return null;
  const yy = +m[1];
  return yy >= 91 ? 1900 + yy : 2000 + yy;
}

// DataCite DOIs for arXiv (10.48550/arXiv.2007.01434) are not in Crossref —
// treat them as an arXiv id instead.
function arxivFromDoi(doi) {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(doi || '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Title / authors / venue guesses from the page layout
// ---------------------------------------------------------------------------

// Lines that are big or near the top but are not the title.
const JUNK_LINE = new RegExp(
  [
    '^arxiv', 'preprint', 'under review', 'published as', 'accepted (at|to|as)', 'conference paper',
    'proceedings of', 'workshop', 'open access', 'computer vision foundation', 'copyright', '©',
    'journal of', 'transactions on', 'vol(ume)?\\.? ?\\d', '^doi', 'https?:', 'www\\.', '@',
    '^(article|research article|letter|review|original article|technical report|supplementary)$',
    '^(abstract|introduction|contents)$', '^page \\d', '^\\d+$', 'licen[cs]e', 'creative commons',
    'available online', 'received:', 'downloaded from', 'nature (neuroscience|communications)$',
  ].join('|'),
  'i'
);

// Venue clues printed in page headers/footers, mapped to a readable name.
const VENUES = [
  [/neural information processing systems|neurips|\bnips\b/i, 'Advances in Neural Information Processing Systems'],
  [/\biclr\b|international conference on learning representations/i, 'International Conference on Learning Representations'],
  [/\bicml\b|international conference on machine learning/i, 'International Conference on Machine Learning'],
  [/\bcvpr\b|computer vision and pattern recognition/i, 'IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)'],
  [/\biccv\b|international conference on computer vision/i, 'IEEE/CVF International Conference on Computer Vision (ICCV)'],
  [/\beccv\b|european conference on computer vision/i, 'European Conference on Computer Vision (ECCV)'],
  [/\bwacv\b|winter conference on applications of computer vision/i, 'IEEE/CVF Winter Conference on Applications of Computer Vision (WACV)'],
  [/transactions on machine learning research|\btmlr\b/i, 'Transactions on Machine Learning Research'],
  [/journal of machine learning research|\bjmlr\b/i, 'Journal of Machine Learning Research'],
  [/\baaai\b/i, 'AAAI Conference on Artificial Intelligence'],
  [/\bijcai\b/i, 'International Joint Conference on Artificial Intelligence'],
  [/\baistats\b|artificial intelligence and statistics/i, 'International Conference on Artificial Intelligence and Statistics'],
  [/conference on robot learning|\bcorl\b/i, 'Conference on Robot Learning'],
  [/\bsiggraph\b/i, 'SIGGRAPH'],
];

function guessVenue(lines) {
  for (const l of lines) {
    for (const [re, name] of VENUES) {
      if (re.test(l.text)) {
        const y = /\b(19[89]\d|20[0-4]\d)\b/.exec(l.text);
        return { source: name, year: y ? +y[1] : null };
      }
    }
  }
  return null;
}

function stripMarkers(s) {
  return clean(String(s).replace(/[∗*†‡§¶⋆✉]+/g, ' ').replace(/\s\d{1,2}(,\d{1,2})*$/, ''));
}

/**
 * Title guess: the biggest-font block of lines in the upper part of page 1.
 * Consecutive lines with (almost) the same size and small vertical gaps form
 * one block, which handles titles that wrap over two or three lines.
 */
function guessTitle(page) {
  if (!page || !page.lines.length) return null;
  // Manuscripts written in Word/Docs sometimes just say "Title: …".
  const labelled = page.lines.find((l) => /^title\s*:\s*\S/i.test(l.text));
  if (labelled) return { title: stripMarkers(labelled.text.replace(/^title\s*:\s*/i, '')), size: labelled.size, lastY: labelled.y, bodySize: labelled.size, labelled: true };
  const top = page.bottom + page.height;
  const area = page.lines.filter((l) => l.y > page.bottom + page.height * 0.3 && l.y < top - 10);

  // "Body size" = the font size carrying most characters on the page.
  const counts = new Map();
  for (const l of page.lines) counts.set(l.size, (counts.get(l.size) || 0) + l.chars);
  const bodySize = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

  const blocks = [];
  for (const l of area) {
    const prev = blocks[blocks.length - 1];
    const last = prev?.lines[prev.lines.length - 1];
    if (last && Math.abs(l.size - last.size) <= last.size * 0.08 && last.y - l.y > 0 && last.y - l.y < last.size * 2.2) {
      prev.lines.push(l);
    } else {
      blocks.push({ lines: [l], size: l.size });
    }
  }

  let best = null;
  for (const b of blocks) {
    const texts = b.lines.map((l) => l.text).filter((t) => !JUNK_LINE.test(t));
    if (!texts.length) continue;
    let text = '';
    for (const t of texts) text = text.endsWith('-') ? text + t : clean(text + ' ' + t);
    text = stripMarkers(text);
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 10 || text.split(' ').length < 2 || text.length > 300) continue;
    if (b.size < bodySize * 1.15) continue; // not visibly bigger than the body text
    if (!best || b.size > best.size + 0.01) best = { text, size: b.size, lastY: b.lines[b.lines.length - 1].y, block: b };
  }
  if (!best) return null;
  return { title: best.text, size: best.size, lastY: best.lastY, bodySize };
}

/**
 * Authors guess: names in the few lines right under the title, before the
 * abstract. Affiliations, emails and footnote markers are filtered out; only
 * strings that look like personal names survive. Online data usually
 * replaces this, so it errs on the side of returning nothing.
 */
function guessAuthorsFromLayout(page, t) {
  if (!page || !t) return [];
  const authLine = page.lines.find((l) => /^authors?\s*:/i.test(l.text));
  if (authLine) return splitAuthorString(authLine.plain.replace(/^authors?\s*:\s*/i, '')).filter(looksLikeName).map(toLastFirst);
  const below = page.lines.filter((l) => l.y < t.lastY - 1 && l.y > t.lastY - t.size * 12).sort((a, b) => b.y - a.y);
  const names = [];
  for (const l of below.slice(0, 8)) {
    if (/^(abstract|introduction|a b s t r a c t)\b/i.test(l.text) || l.size >= t.size * 0.98) break;
    for (const p of splitAuthorString(l.plain.replace(/\S+@\S+/g, ' ').replace(/\{[^}]*\}/g, ' '))) {
      const n = stripMarkers(p.replace(/[\d,]+$/, ''));
      if (looksLikeName(n)) names.push(toLastFirst(n));
    }
  }
  return [...new Set(names)].slice(0, 40);
}

// Info-dict titles are often junk left by the authoring tool.
function plausibleInfoTitle(s) {
  const t = clean(s);
  if (t.length < 10 || t.length > 300 || t.split(' ').length < 2) return false;
  return !/^(microsoft (word|powerpoint)|untitled|document\d*$|title$|slide|presentation|pii:|doi:|arxiv)|\.(pdf|docx?|tex|dvi|ps|indd)\b|[\\/]|formatting instructions|template|^paper title|^manuscript|^submission|^\d+$/i.test(t);
}

function plausibleInfoAuthors(s) {
  const names = splitAuthorString(s).filter(looksLikeName);
  return names.length ? names.map(toLastFirst) : [];
}

// "3.When and How Does CLIP …_.pdf" -> "When and How Does CLIP …?"
export function titleFromFileName(fileName) {
  let t = String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '');
  t = t.replace(/[\r\n]+/g, ' ');
  t = t.replace(/__[0-9a-f]{6,}$/i, ''); // "…__0003a96d27": duplicate-copy hash suffix
  t = t.replace(/^\d+(?:_\d+)*\s*[._)\-]\s*/, ''); // leading "3." / "7_1." numbering
  t = t.replace(/[_ ](main|supp|supplementary|final|camera[_ ]?ready)$/i, '');
  t = t.replace(/_ /g, ': ').replace(/_$/, '?').replace(/_/g, ' ');
  return clean(t);
}

// ---------------------------------------------------------------------------
// 1. Read what the PDF itself says
// ---------------------------------------------------------------------------

export async function readPdfMetadata(pdfDoc, { fileName = '' } = {}) {
  let info = {};
  let xmp = null;
  try {
    const md = await pdfDoc.getMetadata();
    info = md?.info || {};
    xmp = md?.metadata || null;
  } catch { /* no metadata is fine */ }
  const xmpGet = (k) => {
    try { const v = xmp?.get(k); return Array.isArray(v) ? v.join(' ') : v || ''; } catch { return ''; }
  };

  const p1 = await readPage(pdfDoc, 1);
  const p2 = await readPage(pdfDoc, 2);

  // --- DOI: metadata first (set deliberately by publishers), then page 1,
  // then page 2 up to a "References" heading. Later pages are skipped
  // because their DOIs belong to cited papers.
  const metaDoiText = [xmpGet('prism:doi'), xmpGet('dc:identifier'), xmpGet('pdfx:doi'), info.doi, info.Subject, info.Keywords].join(' ');
  const p2text = (p2?.text || '').split(/\n\s*(references|bibliography)\s*\n/i)[0];
  let doi = findDois(metaDoiText)[0] || findDois(p1?.text)[0] || findDois(p2text)[0] || null;

  // --- arXiv id: the vertical margin stamp is the most reliable spot; the
  // stamp text often has no "arXiv:" prefix glued on, so bare ids are OK
  // there. Elsewhere we require the "arXiv" prefix or an arxiv.org URL.
  const fromDoi = arxivFromDoi(doi);
  if (fromDoi) doi = null;
  const ax =
    findArxiv(p1?.rotated, { bare: true })[0] ||
    findArxiv((p1?.lines || []).filter((l) => l.y > p1.bottom + p1.height * 0.85).map((l) => l.text).join(' '))[0] ||
    findArxiv(fileName.replace(/^.*[\\/]/, ''), { bare: true })[0] ||
    findArxiv(p1?.text)[0] ||
    null;
  const arxivId = fromDoi || ax?.id || null;

  // --- Title: layout guess vs. info dict. When both agree we keep the info
  // title (cleaner: no hyphenation or line-break artefacts).
  const t = guessTitle(p1);
  const infoTitle = plausibleInfoTitle(info.Title) ? clean(info.Title) : '';
  let title = t?.title || '';
  if (infoTitle && (!title || titleSimilarity(infoTitle, title) > 0.8)) title = infoTitle;

  // --- Authors: info dict when it looks like real names, else layout.
  let authors = plausibleInfoAuthors(info.Author);
  if (!authors.length) authors = guessAuthorsFromLayout(p1, t);

  // --- Venue + year: page-1 header/footer lines only (body text may mention
  // other venues). Year priority: venue line > arXiv id > © line > file date.
  const edge = (p1?.lines || []).filter((l) => l.y > p1.bottom + p1.height * 0.85 || l.y < p1.bottom + p1.height * 0.18);
  const venue = guessVenue(edge);
  const copy = /(?:©|\(c\)|copyright)\s*(19[89]\d|20[0-4]\d)/i.exec(p1?.text || '');
  const created = /^D:(\d{4})/.exec(info.CreationDate || '');
  const year = venue?.year || arxivYear(arxivId) || (copy ? +copy[1] : null) || (created ? +created[1] : null) || null;
  const source = venue?.source || (arxivId ? 'arXiv' : '');

  return { title, authors, year, source, doi, arxivId };
}

// ---------------------------------------------------------------------------
// 2. Online lookup
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with a timeout that also respects the caller's AbortSignal.
// Returns null on any failure: the library must keep working offline.
async function getText(url, { fetchImpl, signal }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) return null;
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (res.status === 429 && attempt === 0) { await sleep(2000); continue; } // rate limited: one polite retry
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
  return null;
}

async function getJson(url, opts) {
  const t = await getText(url, opts);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

function crossrefYear(m) {
  for (const k of ['published-print', 'published-online', 'issued', 'published', 'created']) {
    const y = m?.[k]?.['date-parts']?.[0]?.[0];
    if (y) return +y;
  }
  return null;
}

function fromCrossref(m) {
  // Crossref strings may contain markup and entities ("&amp;", "<i>").
  const txt = (s) => decodeXml(String(s || '').replace(/<[^>]+>/g, ''));
  const title = txt([m.title?.[0], m.subtitle?.[0]].filter(Boolean).join(': '));
  const authors = (m.author || [])
    .map((a) => (a.family ? txt(a.given ? `${a.family}, ${a.given}` : a.family) : txt(a.name)))
    .filter(Boolean);
  let source = txt(m['container-title']?.[0] || m.event?.name || '');
  // Preprint servers register "posted-content" without a container.
  if (!source && m.type === 'posted-content') source = /^10\.1101\//.test(m.DOI) ? 'bioRxiv' : clean(m.institution?.[0]?.name || m.publisher || '');
  return { title, authors, year: crossrefYear(m), source, doi: m.DOI ? m.DOI.toLowerCase() : null, arxivId: null, via: 'crossref' };
}

async function crossrefByDoi(doi, opts) {
  const j = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, opts);
  return j?.message?.title?.length ? fromCrossref(j.message) : null;
}

// Tiny Atom parser: regexes are enough for arXiv's fixed feed format and work
// in Node too (no DOMParser there).
function decodeXml(s) {
  return clean(String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&'));
}
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml); return m ? decodeXml(m[1]) : ''; };

async function arxivById(id, opts) {
  const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`, opts);
  const entry = xml && /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) return null;
  const title = tag(entry, 'title');
  if (!title || /^error$/i.test(title) || !/<id>[^<]*arxiv\.org\/abs\//.test(entry)) return null;
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => toLastFirst(decodeXml(m[1])));
  // <published> is the date of version 1 = when the paper first appeared.
  const year = +(tag(entry, 'published').slice(0, 4)) || arxivYear(id);
  return {
    title, authors, year,
    source: 'arXiv',
    doi: tag(entry, 'arxiv:doi') || null,
    arxivId: id,
    journalRef: tag(entry, 'arxiv:journal_ref'),
    via: 'arxiv',
  };
}

// Crossref record types that are not "the paper" (reviews, figures, …).
const BAD_TYPES = new Set(['peer-review', 'component', 'dataset', 'grant', 'journal-issue', 'journal', 'proceedings', 'report-component']);

async function crossrefByTitle(title, authors, opts) {
  let q = `query.bibliographic=${encodeURIComponent(title)}`;
  const last = authors?.[0]?.split(',')[0];
  if (last) q += `&query.author=${encodeURIComponent(last)}`;
  const j = await getJson(`https://api.crossref.org/works?${q}&rows=5`, opts);
  const items = (j?.message?.items || []).filter((m) => m.title?.length && !BAD_TYPES.has(m.type));
  let best = null;
  for (const m of items) {
    const cand = fromCrossref(m);
    const sim = Math.max(titleSimilarity(title, cand.title), titleSimilarity(title, m.title[0]));
    // Prefer the published version over a preprint copy when both match.
    const score = sim + (m.type === 'posted-content' ? -0.01 : 0);
    if (sim >= 0.9 && (!best || score > best.score)) best = { score, cand };
  }
  return best?.cand || null;
}

export async function lookupOnline({ doi, arxivId, title, authors } = {}, { fetchImpl = fetch, signal } = {}) {
  const opts = { fetchImpl, signal };
  try {
    // An exact identifier beats any search; fall through to the next method
    // only if a lookup fails (offline, 404, rate limit).
    if (doi) {
      const r = await crossrefByDoi(doi, opts);
      if (r) return { ...r, arxivId: arxivId || null };
    }
    if (arxivId) {
      const id = arxivId.replace(/v\d+$/, '');
      const a = await arxivById(id, opts);
      if (a) {
        const { journalRef, ...rest } = a;
        // If arXiv knows the published DOI, ask Crossref for the venue and the
        // publication year (the arXiv year is only the preprint year).
        if (a.doi && !arxivFromDoi(a.doi)) {
          const c = await crossrefByDoi(a.doi, opts);
          if (c) return { ...rest, source: c.source || rest.source, year: c.year || rest.year, doi: c.doi, via: 'arxiv' };
        }
        // journal_ref is free text like "Journal of Machine Learning Research
        // 2016, vol. 17, p. 1-35": keep the name, and its year is the
        // publication year.
        if (journalRef) {
          const name = journalRef.replace(/[,;(].*$/, '').replace(/[\s\d:.-]+$/, '').trim();
          if (name.length > 2) rest.source = name;
          const y = /\b(19[89]\d|20[0-4]\d)\b/.exec(journalRef);
          if (y && +y[1] >= rest.year) rest.year = +y[1];
        }
        return rest;
      }
    }
    if (title && normalizeTitle(title).split(' ').length >= 3) {
      return await crossrefByTitle(title, authors, opts);
    }
  } catch { /* never throw: the caller just keeps the PDF guess */ }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Convenience: both, merged
// ---------------------------------------------------------------------------

export async function extractMetadata(pdfDoc, { fileName = '', online = true, fetchImpl = fetch, signal } = {}) {
  const pdf = await readPdfMetadata(pdfDoc, { fileName });
  pdf.fileTitle = titleFromFileName(fileName);
  // A supplement's page 1 just says "Supplementary Material". Looking that up
  // would either fail or return the *main* paper, so stay offline and let the
  // filename name it.
  const generic = /^(supplementary|supplemental|appendix)\b.{0,25}$/i.test(pdf.title);
  if (generic) {
    pdf.title = '';
    pdf.fileTitle = pdf.fileTitle.replace(/^supp(lementary)?\b[\s:-]*/i, '').replace(/[-_ ]supp(lementary)?$/i, '') + ' (Supplementary Material)';
  }
  let found = null;
  if (online && !generic) {
    found = await lookupOnline(pdf, { fetchImpl, signal });
    // The layout guess may be wrong (e.g. a journal banner) while the filename
    // is right: retry the title search once with the filename title.
    if (!found && !pdf.doi && !pdf.arxivId && pdf.fileTitle && titleSimilarity(pdf.fileTitle, pdf.title) < 0.9) {
      found = await lookupOnline({ title: pdf.fileTitle }, { fetchImpl, signal });
    }
  }
  // Many PDFs are the camera-ready version ("Published as a conference paper
  // at ICLR 2024") while the online record is the preprint (arXiv, bioRxiv).
  // The venue printed in the PDF is then the better source and year.
  const preprint = /^(arxiv|biorxiv|medrxiv|psyarxiv|research square|ssrn)\b/i;
  if (found && preprint.test(found.source || '') && pdf.source && !preprint.test(pdf.source)) {
    found = { ...found, source: pdf.source, year: pdf.year || found.year };
  }
  const pick = (k) => (found && (Array.isArray(found[k]) ? found[k].length : found[k]) ? found[k] : pdf[k]);
  const title = pick('title') || pdf.fileTitle || '';
  return {
    title,
    authors: pick('authors') || [],
    year: pick('year') || null,
    source: pick('source') || '',
    doi: pick('doi') || null,
    arxivId: pick('arxivId') || null,
    via: found ? found.via : pdf.title ? 'pdf' : 'filename',
  };
}
