// Service worker: opens the viewer tab.
//  - Toolbar icon on a Drive file page -> opens that file.
//  - Toolbar icon anywhere else -> opens the Paper Library.
//  - Message from the Drive page button (content.js) -> opens that file.

const VIEWER = chrome.runtime.getURL('viewer.html');
const LIBRARY = chrome.runtime.getURL('library.html');

function driveIdFromUrl(url) {
  if (!url || !/^https:\/\/drive\.google\.com\//.test(url)) return null;
  const m = url.match(/\/file\/d\/([\w-]{20,})/) || url.match(/[?&]id=([\w-]{20,})/);
  return m ? m[1] : null;
}

function openViewer(fileId, nextToTab) {
  const url = fileId ? `${VIEWER}?id=${encodeURIComponent(fileId)}` : LIBRARY;
  chrome.tabs.create({
    url,
    ...(nextToTab ? { index: nextToTab.index + 1, openerTabId: nextToTab.id } : {}),
  });
}

chrome.action.onClicked.addListener((tab) => {
  openViewer(driveIdFromUrl(tab.url), tab);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'open-in-highlighter' && msg.fileId) {
    if (msg.sameTab && sender.tab) {
      chrome.tabs.update(sender.tab.id, { url: `${VIEWER}?id=${encodeURIComponent(msg.fileId)}` });
    } else {
      openViewer(msg.fileId, sender.tab);
    }
  }
});
