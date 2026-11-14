// Runs on drive.google.com and adds a floating "Open in Paper Library" button.
//
// Drive is a single-page app: the URL and selection change without page
// loads, so we simply re-check every ~800 ms which file is "current":
//   1. a file opened on its own page (…/file/d/<id>/view), or
//   2. the file selected in a folder / preview (rows carry data-id).

(() => {
  const BTN_ID = 'dph-open-button';
  let currentId = null;
  let autoOpen = false;
  const autoOpened = new Set();

  chrome.storage.local.get('autoOpen').then((v) => (autoOpen = !!v.autoOpen));
  chrome.storage.onChanged.addListener((c) => {
    if (c.autoOpen) autoOpen = !!c.autoOpen.newValue;
  });

  function idFromUrl() {
    const m = location.href.match(/\/file\/d\/([\w-]{20,})/) || location.href.match(/[?&]id=([\w-]{20,})/);
    return m ? m[1] : null;
  }

  function selectedItem() {
    const els = document.querySelectorAll('[aria-selected="true"][data-id]');
    if (els.length !== 1) return null;
    const el = els[0];
    const id = el.getAttribute('data-id');
    if (!/^[\w-]{20,}$/.test(id)) return null;
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
    return { id, label };
  }

  function looksLikePdf(label) {
    return /\.pdf\b/i.test(label) || /PDF/.test(label);
  }

  function button() {
    let b = document.getElementById(BTN_ID);
    if (b) return b;
    b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.innerHTML = '<span class="dph-swatch"></span><span class="dph-label">Open in Paper Library</span>';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentId) chrome.runtime.sendMessage({ type: 'open-in-highlighter', fileId: currentId });
    });
    document.documentElement.appendChild(b);
    return b;
  }

  function tick() {
    const urlId = idFromUrl();
    let id = urlId;
    let pdfHint = urlId ? looksLikePdf(document.title) : false;
    if (!id) {
      const sel = selectedItem();
      if (sel && looksLikePdf(sel.label)) {
        id = sel.id;
        pdfHint = true;
      }
    }
    currentId = id;
    const b = button();
    b.hidden = !id;
    b.title = id ? 'Read and highlight this PDF; highlights are saved back to Drive' : '';

    // Optional: jump straight to the highlighter when a PDF's own page opens.
    if (autoOpen && urlId && pdfHint && !autoOpened.has(urlId)) {
      autoOpened.add(urlId);
      chrome.runtime.sendMessage({ type: 'open-in-highlighter', fileId: urlId, sameTab: true });
    }
  }

  tick();
  setInterval(tick, 800);
})();
