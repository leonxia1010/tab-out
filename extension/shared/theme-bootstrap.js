// Runs synchronously before the stylesheet parses to prevent FOUC.
// Mirrors chrome.storage.local['tabout:settings'] via localStorage
// (see shared/src/settings.ts — syncThemeCache + syncLayoutCache +
// syncAuroraCache). 'system' theme, 'masonry' layout, and 'medium'
// aurora are default-absent; CSS handles those via prefers-color-scheme,
// the base .domains rule, and the default body::before gradient
// (multiplier = 1). MV3 CSP script-src 'self' forbids inline scripts —
// must stay external.
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
    if (a === 'off' || a === 'low' || a === 'high') {
      document.documentElement.dataset.aurora = a;
    }
  } catch (_e) {
    // localStorage disabled; stylesheet defaults (system theme, masonry,
    // medium aurora) apply.
  }
})();
