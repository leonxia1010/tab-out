// Runs synchronously before the stylesheet parses to prevent FOUC.
// Mirrors chrome.storage.local['tabout:settings'] via localStorage
// (see shared/src/settings.ts — syncThemeCache + syncLayoutCache).
// 'system' theme and 'masonry' layout are default-absent; CSS handles
// those via prefers-color-scheme and the base .domains rule.
// MV3 CSP script-src 'self' forbids inline scripts — must stay external.
(function () {
  try {
    var t = localStorage.getItem('tabout:theme-cache');
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
    }
    var l = localStorage.getItem('tabout:layout-cache');
    if (l === 'grid') {
      document.documentElement.dataset.layout = 'grid';
    }
  } catch (_e) {
    // localStorage disabled; stylesheet defaults (system theme, masonry) apply.
  }
})();
