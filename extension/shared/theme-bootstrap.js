// Runs synchronously before the stylesheet parses to prevent FOUC.
// Mirrors chrome.storage.local['tabout:settings'] via localStorage
// (see shared/src/settings.ts — syncThemeCache + syncLayoutCache +
// syncAuroraCache). 'system' theme, 'masonry' layout, and 'on' aurora
// are default-absent; CSS handles those via prefers-color-scheme, the
// base .domains rule, and the default body::before gradient.
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
    var a = localStorage.getItem('tabout:aurora-cache');
    if (a === 'off') {
      document.documentElement.dataset.aurora = 'off';
    }
  } catch (_e) {
    // localStorage disabled; stylesheet defaults (system theme, masonry,
    // aurora on) apply.
  }
})();
