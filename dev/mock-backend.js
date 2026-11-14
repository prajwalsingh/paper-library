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
    parentId, collections: [parentId], shortcuts: [], webViewLink: '#',
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

paper(b2i.id, 'Brain2Image: Converting brain signals into images', ['Kavasidis, Isaak', 'Palazzo, Simone', 'Spampinato, Concetto', 'Giordano, Daniela', 'Shah, Mubarak'], 2017, 'Proceedings of the 25th ACM International Conference on Multimedia', { starred: true, read: 2 });
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
