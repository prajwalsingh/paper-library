// Supplementary files: shared helpers for both clouds and both pages.
//
// Each paper can have extra files (figures, data tables, methods, videos…).
// They live in one folder per paper, inside a "Supplementary" folder in the
// library:  Paper Library/Supplementary/<Title – Author Year>/
//
// The folder name is only for people browsing their cloud. The link between a
// paper and its folder is the paper's file ID (which never changes when the
// paper is renamed or moved), stored in a Drive property or the OneDrive index.

/** How the supplementary page shows a file: 'pdf' | 'image' | 'video' | 'table' | 'text' | 'other'. */
export function fileKind(name = '', mimeType = '') {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (mimeType.startsWith('application/vnd.google-apps')) return 'other'; // Google Docs etc. have no file bytes
  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  // Images Chrome can draw by itself (TIFF is not one of them).
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'm4v', 'ogv', 'mov'].includes(ext)) return 'video';
  if (['csv', 'tsv'].includes(ext)) return 'table';
  if (TEXT_EXT.has(ext) || mimeType.startsWith('text/')) return 'text';
  return 'other';
}

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'tex', 'bib',
  'py', 'r', 'rmd', 'm', 'jl', 'js', 'ts', 'c', 'h', 'cpp', 'java', 'sh', 'sql', 'ipynb',
  'fasta', 'fa', 'fna', 'faa', 'fastq', 'fq', 'gff', 'gff3', 'gtf', 'bed', 'vcf', 'sam', 'pdb', 'mtx',
]);

/** MIME type for display (blob URLs need one so <img>/<video> know what they get). */
export function mimeFor(name = '', fallback = '') {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  return {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  }[ext] || fallback || 'application/octet-stream';
}

/** Readable folder name: "Brain2Image: Converting brain… – Kavasidis 2017" (no characters clouds reject). */
export function suppFolderName(paper) {
  const m = paper.meta || {};
  const title = (m.title || (paper.name || 'Paper').replace(/\.pdf$/i, '')).trim();
  const first = (m.authors?.[0] || '').split(',')[0].trim();
  const tail = [first, m.year].filter(Boolean).join(' ');
  const short = title.length > 80 ? title.slice(0, 79).trimEnd() + '…' : title;
  return (tail ? `${short} – ${tail}` : short).replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Paper';
}

export function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return (b / 1024 ** 3).toFixed(2) + ' GB';
}
