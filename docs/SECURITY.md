# Security, privacy, and how to verify them yourself

Paper Library needs access to your Google Drive, so you shouldn't have to *trust*
it. This page explains the safeguards and how to **check each one yourself**, in
a few minutes, without being a programmer.

## 1. Official source: GitHub only

> **Paper Library is distributed only at <https://github.com/prajwalsingh/paper-library>.**
> It is **not** on the Chrome Web Store, the Edge Add-ons store, or any other website.
> Any copy offered elsewhere is unofficial. Don't install it.

Why GitHub only:
- **No silent updates.** Store extensions update themselves automatically. If a store account were ever hijacked, a malicious update could reach every user overnight. A GitHub install only changes when *you* download a new version, and you can see exactly what changed first.
- **Everything is public.** The code you install is the code in the repository, line for line. There's no build step and no hidden server.
- **Your Drive access goes to your own app.** You create your own Google sign-in client ([SETUP.md](SETUP.md)), so the permission you grant belongs to a Google project that you own. Nobody else, including the author, can use it.

## 2. No data sharing, enforced by Chrome

The extension has **no server** and **no analytics**. The author receives nothing.

A promise alone isn't proof, so the extension also carries a **network lock**: a
Content Security Policy in [`manifest.json`](../manifest.json) that Chrome enforces on every
extension page. It lists the **only** places the extension can send or receive data:

| Allowed destination | Used for |
|---|---|
| `https://www.googleapis.com` | Google Drive API: reading and saving *your* files |
| `https://oauth2.googleapis.com` | Google sign-in (signing out / revoking access) |
| `https://api.crossref.org` | Looking up a paper's title and authors by **DOI or title only** |
| `https://export.arxiv.org` | Looking up a paper's details by **arXiv ID only** |
| `https://graph.microsoft.com` | OneDrive (Microsoft Graph API): reading and saving *your* files (only if you choose OneDrive) |
| `https://login.microsoftonline.com` | Microsoft sign-in (exchanging the sign-in code for a token) |
| `https://api.onedrive.com`, `https://*.1drv.com`, `https://*.sharepoint.com`, `https://*.microsoftpersonalcontent.com` | Microsoft's storage servers. OneDrive gives every download and large upload a short-lived link on one of these; the server name varies per account and region, so the whole Microsoft domain is allowed. Only your own OneDrive files go there. |

Chrome refuses any other connection (data requests, images, frames, form posts)
before it leaves your computer. This also applies to the bundled third-party
libraries, so even a compromised library couldn't send your data elsewhere.

The content script on `drive.google.com` only reads the ID of the file you have
open and adds the "Open in Paper Library" button. It makes no network requests.

## 3. Verify it yourself

### a) Read the lock (30 seconds)
Open [`manifest.json`](../manifest.json) and find `"content_security_policy"`.
After `connect-src`, the only websites listed are the four above.

### b) Watch the traffic live (2 minutes)
1. Open the Paper Library page, right-click → **Inspect** → **Network** tab.
2. Use the extension: open papers, highlight, save.
3. Every request goes to `googleapis.com` (or, with OneDrive, `graph.microsoft.com`, `login.microsoftonline.com` and Microsoft's storage servers), `crossref.org` or `arxiv.org`, and nothing else.

To see the lock in action, type this into the **Console** tab:
```js
fetch('https://example.com')
```
Chrome answers with *"Refused to connect because it violates the document's
Content Security Policy"*.

### c) Run the audit script (needs Python 3; npm for the second part)
```bash
python3 scripts/audit.py          # permissions, the lock, every website and network call in the code
python3 scripts/audit.py --libs   # proves the bundled PDF.js and pdf-lib are byte-for-byte the official npm releases
```

### d) Check your download
Each release has a `.zip.sha256` file next to the zip. Compare:
```bash
sha256sum -c paper-library-vX.Y.Z.zip.sha256      # Linux
shasum -a 256 paper-library-vX.Y.Z.zip            # macOS: compare with the file's contents
Get-FileHash paper-library-vX.Y.Z.zip             # Windows PowerShell
```
`OK` (or matching hashes) means your zip is exactly the published release.

### e) Review your Google permissions anytime
<https://myaccount.google.com/permissions> lists the access you granted to your
own project, and lets you remove it with one click.

## 4. What the permissions are for

| Permission | Why it's needed |
|---|---|
| Google Drive (full access, granted to *your own* client) | Open any PDF you choose, save highlights back into the same file, create the `Paper Library` folders, upload papers |
| `identity` | Shows the Google sign-in window |
| `storage` | Remembers your settings (client ID, colours, zoom, last page read) on your computer |
| Runs on `drive.google.com` | Adds the "Open in Paper Library" button |

## 5. Safety of your files

- Every save creates a **new version** of the same Drive file. Drive keeps older
  versions (by default 30 days / 100 versions; mark important ones *Keep forever*
  under *File → Manage versions*).
- If the file changed somewhere else since you opened it, you're asked before anything is overwritten.
- Deleting a collection never deletes papers, and trashed papers go to Drive's trash (restorable for 30 days).

## Reporting a problem

Please open an issue at <https://github.com/prajwalsingh/paper-library/issues>.
For a security issue, describe it without public exploit details and ask for a private contact.
