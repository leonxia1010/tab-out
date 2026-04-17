// Shared settings module — imported by both dashboard and options page.
//
// Storage shape (chrome.storage.local['tabout:settings']):
//   { theme: 'system' | 'light' | 'dark', clock: { format: '12h' | '24h' } }
//
// Theme FOUC invariant: localStorage['tabout:theme-cache'] mirrors the
// resolved explicit theme ('light' or 'dark' only; 'system' clears the
// key so CSS prefers-color-scheme takes over). theme-bootstrap.js reads
// localStorage synchronously before the stylesheet parses.

export type ThemeMode = 'system' | 'light' | 'dark';
export type ClockFormat = '12h' | '24h';

export interface ToutSettings {
  theme: ThemeMode;
  clock: { format: ClockFormat };
}

export const SETTINGS_KEY = 'tabout:settings';
export const THEME_CACHE_KEY = 'tabout:theme-cache';

function inferClockFormat(): ClockFormat {
  try {
    return navigator.language?.startsWith('en-US') ? '12h' : '24h';
  } catch {
    return '24h';
  }
}

export function defaultSettings(): ToutSettings {
  return { theme: 'system', clock: { format: inferClockFormat() } };
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

export async function setSettings(patch: Partial<ToutSettings>): Promise<ToutSettings> {
  const current = await getSettings();
  const next: ToutSettings = {
    theme: patch.theme ?? current.theme,
    clock: { format: patch.clock?.format ?? current.clock.format },
  };
  await storage().set({ [SETTINGS_KEY]: next });
  syncThemeCache(next.theme);
  return next;
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

export function onSettingsChange(cb: (next: ToutSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    const next = normalizeSettings(changes[SETTINGS_KEY].newValue);
    syncThemeCache(next.theme);
    cb(next);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
