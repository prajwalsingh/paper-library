// Regenerates docs/screenshots/*.png using headless Google Chrome and the dev
// server (fake Drive + docs/demo-paper.pdf). No Google account involved.
//
//   python3 dev/serve.py &        # in one terminal
//   node dev/take-screenshots.mjs # in another (needs google-chrome on PATH)
//
// It talks to Chrome through the DevTools Protocol (the same channel Chrome's
// own DevTools use), so no extra npm packages are needed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8765';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const PORT = 9339;
const W = 1440;
const H = 860;
const SCALE = 1.5;

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dph-shots-'));
const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function open(url, dark = false) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url });
  await sleep(2500);
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log('saved', name);
}

// Wait for Chrome's DevTools endpoint, then attach to the first page.
let target;
for (let i = 0; i < 50 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
  if (!target) await sleep(200);
}
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
};
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });

const clickNav = (view) => `document.querySelector('#navList li[data-view=${view}]').click();`;
const clickFolder = (name) =>
  `[...document.querySelectorAll('.node[data-folder]')].find(n => n.querySelector('.label').textContent === ${JSON.stringify(name)}).click();`;
const expandFolder = (name) =>
  `[...document.querySelectorAll('.node[data-folder]')].find(n => n.querySelector('.label').textContent === ${JSON.stringify(name)}).querySelector('[data-twist]').click();`;
const selectRow = (titleStart) =>
  `[...document.querySelectorAll('#rows tr')].find(r => r.querySelector('.c-title').textContent.startsWith(${JSON.stringify(titleStart)})).querySelector('.c-title').click();`;

try {
  // 1. Library overview (light)
  await open(`${BASE}/library.html`);
  await sleep(1500);
  await evaluate(`localStorage.clear(); ${clickNav('all')} ${expandFolder('Neuroscience')}`);
  await sleep(300);
  await shot('library.png');

  // 2. Collection + details panel (light)
  await evaluate(`${clickFolder('Brain2Image')} await new Promise(r => setTimeout(r, 200)); ${selectRow('Brain2Image')}`);
  await sleep(400);
  await shot('library-details.png');

  // 3. Library in dark mode with a multi-selection
  await open(`${BASE}/library.html`, true);
  await evaluate(`${clickFolder('Domain Adaptation')} await new Promise(r => setTimeout(r, 200));
    [...document.querySelectorAll('#rows tr [data-check]')].slice(0, 2).forEach(c => c.click());`);
  await sleep(400);
  await shot('library-dark.png');

  // 4. Viewer with highlights, a note pop-up and the highlights sidebar
  await open(`${BASE}/viewer.html?src=/sample.pdf&name=Reading%20Papers%20Where%20They%20Live.pdf`);
  await sleep(1500);
  await evaluate(`
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    localStorage.clear();
    document.querySelector('.side-tabs [data-tab=highlights]').click();
    for (let i = 0; i < 50 && !document.querySelector('.page[data-page-number="1"] .textLayer span'); i++) await wait(200);
    const spans = () => [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')];
    async function highlight(startText, endText, colorIndex) {
      const all = spans();
      const a = all.find(s => s.textContent.includes(startText));
      const b = all.find(s => s.textContent.includes(endText));
      const range = document.createRange();
      const ta = a.firstChild, tb = b.firstChild;
      range.setStart(ta, ta.textContent.indexOf(startText));
      range.setEnd(tb, tb.textContent.indexOf(endText) + endText.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const r = range.getBoundingClientRect();
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: r.right, clientY: r.bottom }));
      await wait(150);
      document.querySelectorAll('#selPopover .swatch')[colorIndex].click();
      await wait(250);
    }
    await highlight('writes every highlight', 'standard PDF annotation', 0);
    await highlight('Highlights are the memory', 'that process', 2);
    await highlight('open the paper where it already lives', 'back to the same file', 1);
    await highlight('highlights are stored as real PDF annotations', 'appear in every viewer', 3);
    // Open the pop-up of the green highlight and add a note
    const hl = [...document.querySelectorAll('.hlLayer .hl')].find(d => d.style.background.includes('143, 240, 164') || d.style.background.includes('8ff0a4'));
    hl.scrollIntoView({ block: 'center' });
    await wait(400);
    const box = hl.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + 30, box.top + box.height / 2);
    getSelection().removeAllRanges();
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: box.left + 30, clientY: box.top + box.height / 2 }));
    await wait(200);
    const ta = document.querySelector('#hlPopover textarea');
    ta.value = 'Core idea: highlights saved straight back into the Drive file.';
    ta.dispatchEvent(new Event('input'));
    await wait(3800); // autosave finishes -> "Saved"
  `);
  await shot('viewer.png');

  // 5. Viewer, dark + night mode off, find bar open
  await open(`${BASE}/viewer.html?src=/sample.pdf&name=Reading%20Papers%20Where%20They%20Live.pdf`, true);
  await sleep(1200);
  await evaluate(`
    document.querySelector('.side-tabs [data-tab=thumbs]').click();
    document.getElementById('btnFind').click();
    const i = document.getElementById('findInput'); i.value = 'highlight'; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 900));
  `);
  await shot('viewer-dark.png');

  // 6. First-run setup screen (shown inside the extension before sign-in)
  await open(`${BASE}/library.html`);
  await evaluate(`
    document.getElementById('lib').hidden = true;
    document.getElementById('loading').hidden = true;
    document.getElementById('home').hidden = false;
    document.getElementById('setupCard').hidden = false;
    document.getElementById('redirectUri').textContent = 'https://hadmfffnocpeglonjioajbpdfbkbjekf.chromiumapp.org/';
  `);
  await sleep(200);
  await shot('setup.png');

  // 7. The same screen with OneDrive chosen
  await open(`${BASE}/library.html?p=onedrive`);
  await evaluate(`
    document.getElementById('lib').hidden = true;
    document.getElementById('loading').hidden = true;
    document.getElementById('home').hidden = false;
    document.getElementById('msSetupCard').hidden = false;
    document.getElementById('msRedirectUri').textContent = 'https://hadmfffnocpeglonjioajbpdfbkbjekf.chromiumapp.org/';
  `);
  await sleep(200);
  await shot('setup-onedrive.png');
} catch (e) {
  console.error('Screenshot step failed:', e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
  await sleep(800); // let Chrome release its profile folder
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}
