// Colour theme: 'system' (follow the operating system), 'light' or 'dark'.
//
// Loaded as a plain <script> in <head> so the theme is applied before the page
// first paints (no white flash in dark mode). The choice lives in localStorage,
// which all Paper Library pages share, and the browser's "storage" event tells
// every other open tab when it changes, so they all switch together.
(function () {
  const KEY = 'paperLibrary.theme';
  const root = document.documentElement;
  let current = 'system';

  function apply(theme) {
    current = theme === 'light' || theme === 'dark' ? theme : 'system';
    if (current === 'system') delete root.dataset.theme; // CSS falls back to prefers-color-scheme
    else root.dataset.theme = current;
    document.dispatchEvent(new CustomEvent('themechange', { detail: current }));
  }

  try {
    apply(localStorage.getItem(KEY));
  } catch {
    apply('system');
  }

  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply(e.newValue);
  });

  window.PaperTheme = {
    get: () => current,
    set(theme) {
      try {
        localStorage.setItem(KEY, theme);
      } catch {}
      apply(theme);
    },
    // System -> Light -> Dark -> System …
    next: () => ({ system: 'light', light: 'dark', dark: 'system' })[current],
  };
})();
