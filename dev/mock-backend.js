// In-memory stand-in for js/library-drive.js, used when library.html is served
// outside the extension (see dev/serve.py). Lets you work on the UI without a
// Google account. Nothing here is sent anywhere.

let n = 0;
const id = () => 'mock' + String(++n).padStart(4, '0');
const root = { id: 'root', name: 'Paper Library' };
const folders = [];
const papers = [];
const blobs = new Map();
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

function folder(name, parentId = 'root') {
  const f = { id: id(), name, parentId };
  folders.push(f);
  return f;
}
function paper(parentId, title, authors, year, source, extra = {}) {
  const p = {
    id: id(), name: (extra.name || title.slice(0, 40)) + '.pdf', size: 900000 + n * 1000, md5: 'md5-' + n,
    created: daysAgo(extra.added ?? 10 + n * 5), modified: daysAgo(1), starred: !!extra.starred,
    parentId, collections: [parentId], shortcuts: [], webViewLink: '#', suppCount: 0,
    meta: { title, authors, year, source, doi: null, arxivId: null, status: extra.status ?? 'auto', lastRead: extra.read != null ? daysAgo(extra.read) : null },
  };
  if (extra.status === null) Object.assign(p.meta, { title: '', authors: [], year: null, source: '' });
  papers.push(p);
  return p;
}

const neuro = folder('Neuroscience');
const b2i = folder('Brain2Image', neuro.id);
folder('Brain2Video', neuro.id);
const da = folder('Domain Adaptation');
const rep = folder('Representation Learning');
const diff = folder('Diffusion Models');
const adv = folder('Adversarial Learning');

const b2iPaper = paper(b2i.id, 'Brain2Image: Converting brain signals into images', ['Kavasidis, Isaak', 'Palazzo, Simone', 'Spampinato, Concetto', 'Giordano, Daniela', 'Shah, Mubarak'], 2017, 'Proceedings of the 25th ACM International Conference on Multimedia', { starred: true, read: 2 });
paper(b2i.id, 'Generative Adversarial Networks Conditioned by Brain Signals', ['Palazzo, Simone', 'Spampinato, Concetto', 'Kavasidis, Isaak', 'Giordano, Daniela', 'Shah, Mubarak'], 2017, 'IEEE International Conference on Computer Vision (ICCV)');
paper(b2i.id, 'Deep learning human mind for automated visual classification', ['Spampinato, Concetto', 'Palazzo, Simone', 'Kavasidis, Isaak'], 2017, 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR)', { read: 9 });
paper(b2i.id, 'ThoughtViz: Visualizing human thoughts using generative adversarial network', ['Tirupattur, Praveen', 'Rawat, Yogesh Singh', 'Spampinato, Concetto', 'Shah, Mubarak'], 2018, 'Proceedings of the 26th ACM International Conference on Multimedia');
paper(neuro.id, 'Recurrence is required to capture the representational dynamics of the human visual system', ['Kietzmann, Tim C.', 'Spoerer, Courtney J.', 'Sörensen, Lynn K. A.', 'Cichy, Radoslaw M.', 'Hauk, Olaf', 'Kriegeskorte, Nikolaus'], 2019, 'Proceedings of the National Academy of Sciences', { read: 4 });
paper(neuro.id, 'High-dimensional geometry of population responses in visual cortex', ['Stringer, Carsen', 'Pachitariu, Marius', 'Steinmetz, Nicholas', 'Carandini, Matteo', 'Harris, Kenneth D.'], 2019, 'Nature');
paper(da.id, 'In Search of Lost Domain Generalization', ['Gulrajani, Ishaan', 'Lopez-Paz, David'], 2021, 'International Conference on Learning Representations (ICLR)', { starred: true, read: 1 });
paper(da.id, 'Domain-Adversarial Training of Neural Networks', ['Ganin, Yaroslav', 'Ustinova, Evgeniya', 'Ajakan, Hana', 'Germain, Pascal', 'Larochelle, Hugo'], 2016, 'Journal of Machine Learning Research');
paper(da.id, 'Deep Visual Domain Adaptation: A Survey', ['Wang, Mei', 'Deng, Weihong'], 2018, 'Neurocomputing');
paper(rep.id, 'Learning Transferable Visual Models From Natural Language Supervision', ['Radford, Alec', 'Kim, Jong Wook', 'Hallacy, Chris', 'Ramesh, Aditya'], 2021, 'International Conference on Machine Learning (ICML)', { read: 3 });
paper(rep.id, 'A Simple Framework for Contrastive Learning of Visual Representations', ['Chen, Ting', 'Kornblith, Simon', 'Norouzi, Mohammad', 'Hinton, Geoffrey'], 2020, 'International Conference on Machine Learning (ICML)');
paper(rep.id, 'Masked Autoencoders Are Scalable Vision Learners', ['He, Kaiming', 'Chen, Xinlei', 'Xie, Saining', 'Li, Yanghao', 'Dollár, Piotr', 'Girshick, Ross'], 2022, 'IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)', { added: 3 });
paper(diff.id, 'Denoising Diffusion Probabilistic Models', ['Ho, Jonathan', 'Jain, Ajay', 'Abbeel, Pieter'], 2020, 'Advances in Neural Information Processing Systems (NeurIPS)', { added: 2 });
paper(diff.id, 'High-Resolution Image Synthesis with Latent Diffusion Models', ['Rombach, Robin', 'Blattmann, Andreas', 'Lorenz, Dominik', 'Esser, Patrick', 'Ommer, Björn'], 2022, 'IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)', { added: 2 });
paper(adv.id, 'Adversarial Examples that Fool both Computer Vision and Time-Limited Humans', ['Elsayed, Gamaleldin F.', 'Shankar, Shreya', 'Cheung, Brian', 'Papernot, Nicolas'], 2018, 'Advances in Neural Information Processing Systems (NeurIPS)');
paper(adv.id, 'Explaining and Harnessing Adversarial Examples', ['Goodfellow, Ian J.', 'Shlens, Jonathon', 'Szegedy, Christian'], 2015, 'International Conference on Learning Representations (ICLR)', { read: 20 });
paper('root', 'Reading Papers Where They Live: Highlighting PDFs Directly in Google Drive', ['Example, Ada', 'Sample, Ben'], 2026, 'Demo document (docs/demo-paper.pdf)', { name: 'Reading Papers Where They Live', added: 0 });

// Supplementary files of the Brain2Image paper (made up, so demo mode shows every kind).
const supp = new Map(); // paperId → [{ id, name, mimeType, size, modified, webViewLink }]
function addSupp(paperId, name, mimeType, content) {
  const f = { id: id(), name, mimeType, size: content?.size || 0, modified: daysAgo(3), webViewLink: '#' };
  if (content) blobs.set(f.id, content);
  if (!supp.has(paperId)) supp.set(paperId, []);
  supp.get(paperId).push(f);
  papers.find((p) => p.id === paperId).suppCount = supp.get(paperId).length;
}
{
  const bars = [['Pixel', 0.62], ['Brain2Image', 0.83], ['Real', 0.91]];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 260" font-family="sans-serif">
<rect width="420" height="260" fill="#fff"/><text x="210" y="26" text-anchor="middle" font-size="15" font-weight="bold">Figure S1. Inception score by method</text>
${bars.map(([n, v], k) => `<rect x="${70 + k * 110}" y="${230 - v * 180}" width="70" height="${v * 180}" fill="${['#99c1f1', '#3584e4', '#1a5fb4'][k]}"/><text x="${105 + k * 110}" y="248" text-anchor="middle" font-size="12">${n}</text><text x="${105 + k * 110}" y="${222 - v * 180}" text-anchor="middle" font-size="12">${v.toFixed(2)}</text>`).join('')}
<line x1="50" y1="230" x2="400" y2="230" stroke="#333"/></svg>`;
  const rows = ['trial,subject,class,channel_O1_uV,channel_O2_uV,predicted,correct'];
  const classes = ['dog', 'cat', 'piano', 'airliner', 'mushroom', 'pizza'];
  for (let t = 1; t <= 60; t++) {
    const c = classes[t % 6];
    const ok = t % 7 !== 0;
    rows.push([t, 1 + (t % 6), c, (12 + Math.sin(t) * 5).toFixed(2), (10 + Math.cos(t) * 4).toFixed(2), ok ? c : classes[(t + 1) % 6], ok].join(','));
  }
  addSupp(b2iPaper.id, 'Supplementary Information.pdf', 'application/pdf', null);
  addSupp(b2iPaper.id, 'Figure S1 – Inception scores.svg', 'image/svg+xml', new Blob([svg], { type: 'image/svg+xml' }));
  addSupp(b2iPaper.id, 'Data S2 – EEG classification trials.csv', 'text/csv', new Blob([rows.join('\n')], { type: 'text/csv' }));
  addSupp(b2iPaper.id, 'Methods S3 – EEG preprocessing.txt', 'text/plain', new Blob([
    'Supplementary Methods\n\n1. Recording\nEEG was recorded with 128 channels at 1 kHz while subjects viewed ImageNet images for 0.5 s each.\n\n' +
    '2. Preprocessing\nBand-pass filter 14–71 Hz; notch at 50 Hz; trials with amplitude above 100 µV rejected.\n\n' +
    '3. Encoder\nLSTM, 128 hidden units, trained with cross-entropy on 40 classes.\n'], { type: 'text/plain' }));
  addSupp(b2iPaper.id, 'Table S4 – Hyperparameters.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Blob(['PK'], { type: 'application/octet-stream' }));
  supp.get(b2iPaper.id)[0].size = 412000; // the PDF's bytes come from /sample.pdf
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (i) => papers.find((p) => p.id === i) || folders.find((f) => f.id === i);
const clone = (x) => structuredClone(x);

export async function ensureRoot() { return root; }
export async function loadLibrary() {
  await sleep(250);
  return { root, folders: clone(folders), papers: clone(papers.filter((p) => !p.trashed)), trashed: clone(papers.filter((p) => p.trashed)) };
}
export async function createFolder(name, parentId) { await sleep(100); return clone(folder(name, parentId)); }
export async function renameItem(i, name) { find(i).name = name; }
export async function trashItem(i) { const x = find(i); if (x) x.trashed = true; }
export async function deleteForever(i) { const k = papers.findIndex((p) => p.id === i); if (k >= 0) papers.splice(k, 1); supp.delete(i); await sleep(80); return { permanent: true }; }
export async function restoreItem(i) { const x = find(i); if (x) x.trashed = false; }
export async function setStarred(i, s) { find(i).starred = s; }
export async function moveItem(i, from, to) {
  const x = find(i);
  x.parentId = to;
  if (x.collections) x.collections = [to];
}
export async function addShortcut(targetId, parentId) { return { id: id(), parentId }; }
export async function deleteShortcut() {}
export async function saveMeta(i, meta, status) { const p = find(i); p.meta = { ...p.meta, ...meta, status }; }
export async function markMetaFailed(i) { find(i).meta.status = 'failed'; }
export async function markRead() {}
export async function uploadPdf(blob, name, parentId, props, onProgress) {
  for (let k = 1; k <= 5; k++) { await sleep(100); onProgress?.((k * blob.size) / 5, blob.size); }
  const p = paper(parentId, '', [], null, '', { name: name.replace(/\.pdf$/i, ''), status: null, added: 0 });
  p.size = blob.size;
  blobs.set(p.id, blob);
  return clone(p);
}
export async function pdfSource(i) {
  return blobs.has(i) ? { data: new Uint8Array(await blobs.get(i).arrayBuffer()) } : { url: '/sample.pdf' };
}

// Supplementary files
export async function suppCount(meta) { return supp.get(meta.id)?.length || 0; }
export async function listSupplementary(paperId) {
  await sleep(150);
  return clone((supp.get(paperId) || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
}
export async function uploadSupplementary(paper, file, onProgress) {
  for (let k = 1; k <= 4; k++) { await sleep(80); onProgress?.((k * file.size) / 4, file.size); }
  addSupp(paper.id, file.name, file.type, file);
  return { file: clone(supp.get(paper.id).at(-1)), count: supp.get(paper.id).length };
}
export async function renameSupplementary(fileId, name) {
  for (const list of supp.values()) for (const f of list) if (f.id === fileId) f.name = name;
}
export async function deleteSupplementary(paperId, fileId) {
  const list = (supp.get(paperId) || []).filter((f) => f.id !== fileId);
  supp.set(paperId, list);
  return list.length;
}
/** File bytes (the viewer module's download, for the supplementary page). */
export async function download(fileId) {
  const b = blobs.get(fileId);
  if (b) return new Uint8Array(await b.arrayBuffer());
  return new Uint8Array(await (await fetch('/sample.pdf')).arrayBuffer());
}
