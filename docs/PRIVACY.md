# Privacy policy: Paper Library

_Last updated: 14 November 2026_

Paper Library is a browser extension that runs entirely in your browser.
**It has no server, collects no analytics, and the developer receives none of your data.**
It is distributed only at <https://github.com/prajwalsingh/paper-library>.

## What the extension accesses

| Data | Why | Where it goes |
|---|---|---|
| PDF files in your Google Drive | To display them, save your highlights into them, and upload new papers | Read from and written to **your own Google Drive** only |
| Folder names, file names, stars, trash state in Drive | To show your library and its collections | Your Google Drive only |
| Paper details (title, authors, year, source, DOI, arXiv ID, last-read time) | To show the library table | Stored as hidden properties on **your own Drive files** |
| Your Google account's email address and name | To show which account is signed in, to label your highlights with your name, and to renew sign-in silently | Kept in the extension's local browser storage |
| A short-lived Google access token | To call the Google Drive API on your behalf | Kept in browser session storage and cleared when the browser closes |
| Your OAuth client ID and preferences (colours, zoom, last page read) | Settings | Local browser storage |

## Third parties

- **Google** (accounts.google.com, googleapis.com): sign-in and the Google Drive API, under [Google's privacy policy](https://policies.google.com/privacy).
- **Crossref** (api.crossref.org) and **arXiv** (export.arxiv.org): public bibliographic databases used to fill in paper details. They receive **only** a DOI, an arXiv identifier, or a paper title, with no account information, and **never** the PDF or its text.

Nothing is sold, shared, or used for advertising.

**This is enforced, not just promised:** the extension's Content Security Policy in `manifest.json` makes Chrome block every connection except to the four services above. See [SECURITY.md](SECURITY.md) for how to verify this yourself.
 The extension doesn't track browsing.
Its content script runs only on `drive.google.com`, to add the "Open in Paper Library" button. It makes no network requests.

## Your control

- Revoke access at any time: <https://myaccount.google.com/permissions>, or use **Settings → Sign out** in the library.
- Removing the extension deletes its local storage. Your papers, folders and highlights stay in your Drive as ordinary files.

## Contact

Questions or concerns: open an issue at <https://github.com/prajwalsingh/paper-library/issues>.

This policy is published at <https://github.com/prajwalsingh/paper-library/blob/main/docs/PRIVACY.md>.
