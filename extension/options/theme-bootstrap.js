// Runs synchronously before the stylesheet parses to prevent FOUC.
// Mirrors chrome.storage.local['tabout:settings'].theme via localStorage
// (see shared/src/settings.ts#syncThemeCache). 'system' is absent from
// the cache key, so prefers-color-scheme in CSS handles that case.
// MV3 CSP script-src 'self' forbids inline scripts — must stay external.
(function () {
  try {
    var t = localStorage.getItem('tabout:theme-cache');
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
    }
  } catch (_e) {
    // localStorage disabled; stylesheet's prefers-color-scheme default applies.
  }
})();
