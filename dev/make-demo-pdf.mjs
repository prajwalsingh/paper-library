// Generates docs/demo-paper.pdf: a made-up, copyright-free "paper" used for
// screenshots and for trying the viewer in dev mode.  Run: node dev/make-demo-pdf.mjs
import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from '../lib/pdf-lib/pdf-lib.esm.min.js';

const doc = await PDFDocument.create();
doc.setTitle('Reading Papers Where They Live');
doc.setAuthor('Ada Example; Ben Sample');
const serif = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);

const W = 612, H = 792, M = 72, LW = W - 2 * M;
let page, y;
function newPage() { page = doc.addPage([W, H]); y = H - M; }
function wrap(text, font, size, width) {
  const words = text.split(/\s+/); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) > width) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur); return lines;
}
function para(text, { font = serif, size = 10.5, lead = 13.5, indent = 0, center = false, gap = 8 } = {}) {
  for (const line of wrap(text, font, size, LW - indent)) {
    if (y < M + 20) newPage();
    const x = center ? (W - font.widthOfTextAtSize(line, size)) / 2 : M + indent;
    page.drawText(line, { x, y, size, font, color: rgb(0, 0, 0) }); y -= lead;
  }
  y -= gap;
}
function heading(t) { y -= 6; para(t, { font: bold, size: 12.5, lead: 16, gap: 4 }); }

newPage();
page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 2.5 });
y -= 14;
para('Reading Papers Where They Live:', { font: bold, size: 17, lead: 21, center: true, gap: 0 });
para('Highlighting PDFs Directly in Google Drive', { font: bold, size: 17, lead: 21, center: true, gap: 6 });
page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.8 });
y -= 10;
para('Ada Example and Ben Sample', { font: bold, size: 11, center: true, gap: 0 });
para('Institute of Imaginary Studies', { size: 10.5, center: true, gap: 0 });
para('ada@example.org, ben@example.org', { font: italic, size: 10, center: true, gap: 14 });
para('Abstract', { font: bold, size: 12, center: true, gap: 4 });
const abs = 'Researchers keep their papers in cloud storage but read them in desktop tools, so highlights and notes end up scattered across machines and formats. We describe a small browser extension that opens PDFs stored in Google Drive in a familiar desktop-style viewer and writes every highlight back into the same file as a standard PDF annotation. Because the annotations follow the PDF standard, they remain visible in any other reader. A companion library view organises papers into collections that are ordinary Drive folders, and reads titles, authors and years automatically from DOIs and arXiv identifiers. The whole system runs in the browser and stores nothing outside the user\'s own Drive.';
const saveY = y; y = saveY; for (const line of wrap(abs, serif, 10.5, LW - 60)) { page.drawText(line, { x: M + 30, y, size: 10.5, font: serif }); y -= 13.5; } y -= 12;

heading('1   Introduction');
para('Reading a paper is rarely a single pass. We skim the abstract, return to the method, and later search for the one sentence that justified a design decision. Highlights are the memory of that process. When they live inside an application-specific database, they disappear the moment we switch tools, computers or institutions.');
para('Cloud drives have become the default place where papers accumulate: they are shared by supervisors, collected by reading groups and synced across laptops. Yet most cloud viewers offer little more than a preview. Annotating means downloading a copy, editing it locally and uploading it again, which quickly produces several diverging versions of the same document.');
para('Our goal is simple: open the paper where it already lives, highlight it with the comfort of a desktop reader, and save the result straight back to the same file. Nothing else should be required of the reader.');
heading('2   Design');
para('Three decisions shape the system. First, highlights are stored as real PDF annotations rather than in a side database, so they travel with the file and appear in every viewer. Second, every save replaces the content of the same Drive file, which keeps links, sharing settings and folder locations intact while Drive retains older versions. Third, the library is nothing more than a tree of Drive folders with a few hidden properties attached to each file.');
para('A practical consequence is that the extension can be removed at any time without losing anything: the papers, their folders and their highlights remain readable by ordinary tools.');
heading('3   Reading and Highlighting');
para('Pages are rendered by an open-source PDF engine together with an invisible text layer that the browser can select. When the reader selects a sentence, the screen rectangles of the selection are converted into page coordinates and stored as a highlight. Existing highlights, including those created in other applications, are drawn as an editable overlay so that they can be recoloured, annotated with a note or removed.');
para('Saving happens automatically a few seconds after the last change. Before uploading, the extension checks whether the file was modified elsewhere in the meantime and asks the reader what to do if it was.');
heading('4   A Library Made of Folders');
para('Collections correspond one-to-one to Drive folders. Uploading a folder of papers recreates its structure, and each paper\'s title, authors, year and venue are looked up from public bibliographic services using only its identifier. The details are stored on the file itself, so moving a paper between folders never loses them.');
heading('5   Conclusion');
para('Keeping papers, highlights and organisation in one place that the reader already owns removes a surprising amount of friction from everyday research. The approach generalises to any storage service that exposes files and folders through an API.');
heading('References');
para('[1] A. Example. On the half-life of highlights. Journal of Imaginary Results, 12(3):1-10, 2024.', { size: 9.5, lead: 12, gap: 3 });
para('[2] B. Sample and A. Example. Folders are all you need. In Proceedings of the Workshop on Plausible Systems, 2025.', { size: 9.5, lead: 12, gap: 3 });

const pages = doc.getPages();
pages.forEach((p, i) => p.drawText(String(i + 1), { x: W / 2 - 3, y: 40, size: 10, font: serif }));
fs.mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../docs/demo-paper.pdf', import.meta.url), await doc.save());
console.log('wrote docs/demo-paper.pdf,', pages.length, 'pages');
