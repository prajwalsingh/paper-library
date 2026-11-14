# Development

No build step. The extension is plain JavaScript modules, HTML and CSS.
Edit a file, then click **reload ⟳** on the extension in `chrome://extensions`.

## Demo mode (no Google account)

`viewer.html` and `library.html` also run in a normal browser tab. Outside the
extension, the library loads `dev/mock-backend.js`, an in-memory fake Drive with
sample papers, and the viewer opens a PDF from a URL:

```bash
python3 dev/serve.py
```

- Library: <http://127.0.0.1:8765/library.html>
- Viewer: <http://127.0.0.1:8765/viewer.html?src=/sample.pdf> (`/sample.pdf` is `docs/demo-paper.pdf`, or pass another PDF: `python3 dev/serve.py path/to.pdf`)

In demo mode, saves stay in memory (`window.__savedBytes` holds the last saved
PDF). Online lookups of arXiv entries fail in a normal tab because arXiv doesn't
allow cross-site requests. The installed extension is allowed to make them.

## Project structure

| Path | What it does |
|---|---|
| `manifest.json` | Extension definition: permissions, content script, and the fixed `key` (gives every unpacked install the same ID) |
| `background.js` | Service worker: opens the library or the viewer from the toolbar icon and the Drive button |
| `content.js`, `content.css` | "Open in Paper Library" button on drive.google.com |
| `viewer.html` / `.css` / `.js` | PDF viewer and highlighter (PDF.js viewer components, overlay, saving) |
| `library.html` / `.css` / `.js` | Paper Library UI (collections, table, details, uploads, background tasks) |
| `js/auth.js` | Google sign-in with `chrome.identity.launchWebAuthFlow`, token cache |
| `js/drive.js` | Drive REST calls: download, update content in place, metadata |
| `js/library-drive.js` | Library ↔ Drive mapping: root folder, folder tree, properties (chunked), shortcuts, resumable upload |
| `js/annotations.js` | Splits `/Highlight` annotations out of a PDF and writes them back (pdf-lib) |
| `js/metadata.js` | Reads DOI/arXiv/title from page 1 and looks them up in Crossref/arXiv |
| `lib/pdfjs/` | PDF.js 4.10.38 (`pdfjs-dist`): renderer, worker, viewer components, fonts, cMaps |
| `lib/pdf-lib/` | pdf-lib 1.17.1 (ESM build) |
| `dev/` | Demo mode (`serve.py`, `mock-backend.js`), the demo PDF generator, and the screenshot script |
| `docs/` | Setup guide, security & privacy, screenshots, demo PDF |
| `scripts/package.sh` | Builds the release zip and its SHA-256 checksum |
| `scripts/audit.py` | Lists permissions, the network lock, every website and network call; `--libs` verifies the bundled libraries against npm |

## Screenshots

`docs/screenshots/` is generated, so it never shows anyone's real data:

```bash
python3 dev/serve.py &               # demo server
node dev/take-screenshots.mjs        # README screenshots (1440×860 @1.5x)
```

It drives headless Google Chrome through the DevTools Protocol, so no npm
packages are needed (Node 22+ for the built-in `WebSocket`). To change the demo
paper, edit and run `node dev/make-demo-pdf.mjs`.

## Releasing

1. Bump `"version"` in `manifest.json`.
2. Run `python3 scripts/audit.py --libs` and check that it reports no unexpected hosts and identical libraries.
3. `./scripts/package.sh` builds `dist/paper-library-v<version>.zip`, which contains only the files the extension needs, plus `…zip.sha256`.
4. Create a GitHub release with tag `v<version>`, attach **both** files, and list the changes.

Distribution is GitHub only (see [SECURITY.md](SECURITY.md)). Don't publish builds anywhere else.

## The network lock

`manifest.json` → `content_security_policy.extension_pages` lists the only hosts the
extension may contact (`connect-src`). If a new feature needs another service, add it
there **and** to the tables in `README.md`, `docs/SECURITY.md` and `docs/PRIVACY.md`.
`dev/serve.py` sends the same policy, so demo mode breaks in the same way the
extension would if something isn't allowed.

## Updating the bundled libraries

```bash
npm pack pdfjs-dist@<version> pdf-lib@<version>
```

Copy over `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `web/pdf_viewer.mjs`,
`web/pdf_viewer.css`, `web/images/`, `cmaps/` and `standard_fonts/` from
pdfjs-dist, and `dist/pdf-lib.esm.min.js` from pdf-lib. Then test highlighting,
search and saving in demo mode. PDF.js 5+ renames some viewer APIs and needs
`wasmUrl` for JPEG2000 images.
