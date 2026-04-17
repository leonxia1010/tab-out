// Shared settings module — imported by both dashboard and options page.
//
// Storage shape (chrome.storage.local['tabout:settings']):
//   { theme, clock: { format }, layout }
//
// Theme FOUC invariant: localStorage['tabout:theme-cache'] mirrors the
// resolved explicit theme ('light' or 'dark' only; 'system' clears the
// key so CSS prefers-color-scheme takes over). theme-bootstrap.js reads
// localStorage synchronously before the stylesheet parses.
//
// Layout FOUC invariant (v2.3.0): localStorage['tabout:layout-cache']
// mirrors layout. 'masonry' is the default — the cache key is cleared
// so absent key ≡ masonry, and the stylesheet's base rule handles it.
// Only 'grid' writes to the cache.

export type ThemeMode = 'system' | 'light' | 'dark';
export type ClockFormat = '12h' | '24h';
export type Layout = 'masonry' | 'grid';

export interface ShortcutPin {
  url: string;
  title: string;
}

export interface ToutSettings {
  theme: ThemeMode;
  clock: { format: ClockFormat };
  layout: Layout;
  shortcutPins: ShortcutPin[];
  shortcutHides: string[];
}

export const SETTINGS_KEY = 'tabout:settings';
export const THEME_CACHE_KEY = 'tabout:theme-cache';
export const LAYOUT_CACHE_KEY = 'tabout:layout-cache';

function inferClockFormat(): ClockFormat {
  try {
    return navigator.language?.startsWith('en-US') ? '12h' : '24h';
  } catch {
    return '24h';
  }
}

export function defaultSettings(): ToutSettings {
  return {
    theme: 'system',
    clock: { format: inferClockFormat() },
    layout: 'masonry',
    shortcutPins: [],
    shortcutHides: [],
  };
}

function storage(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local unavailable');
  }
  return chrome.storage.local;
}

function isTheme(v: unknown): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

function isClockFormat(v: unknown): v is ClockFormat {
  return v === '12h' || v === '24h';
}

function isLayout(v: unknown): v is Layout {
  return v === 'masonry' || v === 'grid';
}

function isShortcutPin(v: unknown): v is ShortcutPin {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<ShortcutPin>;
  return typeof p.url === 'string' && p.url.length > 0
    && typeof p.title === 'string';
}

function normalizeShortcutPins(v: unknown): ShortcutPin[] {
  if (!Array.isArray(v)) return [];
  // Drop malformed entries silently so one garbage row can't break the
  // whole list; mirror the defensive parse of DeferredTab rows.
  return v.filter(isShortcutPin).map((p) => ({ url: p.url, title: p.title }));
}

function normalizeShortcutHides(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

// Defensive parse: missing or malformed fields fall back to defaults.
// Mirrors api.ts#isDeferredRow discipline — normalize at the boundary
// so downstream code can trust the shape.
export function normalizeSettings(raw: unknown): ToutSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<ToutSettings>;
  return {
    theme: isTheme(r.theme) ? r.theme : d.theme,
    clock: {
      format: r.clock && isClockFormat(r.clock.format) ? r.clock.format : d.clock.format,
    },
    layout: isLayout(r.layout) ? r.layout : d.layout,
    shortcutPins: normalizeShortcutPins(r.shortcutPins),
    shortcutHides: normalizeShortcutHides(r.shortcutHides),
  };
}

export async function getSettings(): Promise<ToutSettings> {
  try {
    const result = await storage().get(SETTINGS_KEY);
    return normalizeSettings((result as Record<string, unknown>)[SETTINGS_KEY]);
  } catch {
    return defaultSettings();
  }
}

// Serialize every read-modify-write against tabout:settings. dashboard and
// options can run concurrently and both call setSettings (pin toggles,
// hide toggles, theme / layout radios). Without a lock:
//
//   dashboard pin → getSettings (snapshot A) → yield
//   options unhide → getSettings (snapshot A too) → yield
//   dashboard set  ← snapshot A + pin
//   options set    ← snapshot A + unhide — wipes the pin
//
// Same race api.ts#withLock solves for deferredTabs; same fix here.
// Reads (getSettings) stay lock-free.
let pendingWrite: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = pendingWrite.then(fn, fn);
  pendingWrite = next.catch(() => {});
  return next;
}

export function setSettings(patch: Partial<ToutSettings>): Promise<ToutSettings> {
  return withLock(async () => {
    const current = await getSettings();
    const next: ToutSettings = {
      theme: patch.theme ?? current.theme,
      clock: { format: patch.clock?.format ?? current.clock.format },
      layout: patch.layout ?? current.layout,
      // Arrays: normalize the patch so callers can pass raw input
      // without bypassing the defensive shape check.
      shortcutPins: patch.shortcutPins
        ? normalizeShortcutPins(patch.shortcutPins)
        : current.shortcutPins,
      shortcutHides: patch.shortcutHides
        ? normalizeShortcutHides(patch.shortcutHides)
        : current.shortcutHides,
    };
    await storage().set({ [SETTINGS_KEY]: next });
    syncThemeCache(next.theme);
    syncLayoutCache(next.layout);
    return next;
  });
}

// Mirror of settings.theme in localStorage so theme-bootstrap.js can
// apply the right data-theme before first paint. 'system' clears the
// key — the stylesheet's prefers-color-scheme media query handles it.
export function syncThemeCache(theme: ThemeMode): void {
  try {
    if (theme === 'system') {
      localStorage.removeItem(THEME_CACHE_KEY);
    } else {
      localStorage.setItem(THEME_CACHE_KEY, theme);
    }
  } catch {
    // localStorage disabled; bootstrap script will fall back to the
    // prefers-color-scheme default. Silent degrade is acceptable.
  }
}

// Mirror of settings.layout. 'masonry' is the default — clear the key
// so the base stylesheet rule handles it without needing data-layout.
// Only 'grid' writes, and only then does theme-bootstrap.js set the
// data-layout attribute pre-paint.
export function syncLayoutCache(layout: Layout): void {
  try {
    if (layout === 'masonry') {
      localStorage.removeItem(LAYOUT_CACHE_KEY);
    } else {
      localStorage.setItem(LAYOUT_CACHE_KEY, layout);
    }
  } catch {
    // Silent degrade — stylesheet default (masonry) applies.
  }
}

export function onSettingsChange(cb: (next: ToutSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    const next = normalizeSettings(changes[SETTINGS_KEY].newValue);
    syncThemeCache(next.theme);
    syncLayoutCache(next.layout);
    cb(next);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
