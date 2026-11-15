// Which cloud holds your library: Google Drive (the default) or OneDrive.
//
// Each provider is three modules with the same function names:
//   auth    → sign-in (getToken, getClientId, signOut, …)
//   files   → single files for the viewer (getMetadata, download, updateContent, …)
//   library → the library (loadLibrary, createFolder, saveMeta, uploadPdf, …)
// The viewer and the library only talk to these, so they work the same on both.
//
// Each cloud keeps its own library, client ID and sign-in. Switching changes
// which one you see; nothing is copied or deleted.

export const PROVIDERS = {
  gdrive: {
    id: 'gdrive',
    label: 'Google Drive',
    short: 'Drive',
    load: async () => {
      const [auth, files, library] = await Promise.all([
        import('./auth.js'),
        import('./drive.js'),
        import('./library-drive.js'),
      ]);
      return { auth, files, library };
    },
  },
  onedrive: {
    id: 'onedrive',
    label: 'OneDrive',
    short: 'OneDrive',
    load: async () => {
      const [auth, od] = await Promise.all([import('./ms-auth.js'), import('./onedrive.js')]);
      return { auth, files: od, library: od };
    },
  },
};

/** The provider chosen in Settings ('gdrive' if never chosen, so existing users see no change). */
export async function getProviderId() {
  if (typeof chrome === 'undefined' || !chrome.storage) return 'gdrive';
  const { provider } = await chrome.storage.local.get('provider');
  return PROVIDERS[provider] ? provider : 'gdrive';
}

export async function setProviderId(id) {
  await chrome.storage.local.set({ provider: PROVIDERS[id] ? id : 'gdrive' });
}

/** Loads a provider's modules: { id, label, short, auth, files, library }. */
export async function loadProvider(id) {
  const p = PROVIDERS[id] || PROVIDERS.gdrive;
  return { ...p, ...(await p.load()) };
}

/** Replaces "Google Drive" / "Drive" in labels marked with data-cloud (static HTML text). */
export function relabel(rootEl, provider) {
  if (provider.id === 'gdrive') return;
  const swap = (s) => s.replace(/Google Drive/g, provider.label).replace(/\bDrive\b/g, provider.short);
  for (const el of rootEl.querySelectorAll('[data-cloud]')) {
    if (el.title) el.title = swap(el.title);
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) n.textContent = swap(n.textContent);
  }
}
