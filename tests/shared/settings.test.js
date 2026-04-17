// tests/shared/settings.test.js
//
// shared/src/settings.ts is the only module shared by dashboard + options.
// We test the pure normalizer + the storage round-trip (chrome.storage.local
// + localStorage mirror for the theme cache). onSettingsChange is a thin
// listener wrapper — covered by manual integration, not here.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  defaultSettings,
  normalizeSettings,
  getSettings,
  setSettings,
  syncThemeCache,
  SETTINGS_KEY,
  THEME_CACHE_KEY,
} from '../../extension/shared/src/settings.ts';

function installMocks(initialStorage = {}, initialLocal = {}) {
  const store = new Map(Object.entries(initialStorage));
  const local = new Map(Object.entries(initialLocal));

  const storageLocal = {
    get: vi.fn(async (key) => (store.has(key) ? { [key]: store.get(key) } : {})),
    set: vi.fn(async (kv) => {
      for (const [k, v] of Object.entries(kv)) store.set(k, v);
    }),
  };

  vi.stubGlobal('chrome', {
    storage: {
      local: storageLocal,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });

  vi.stubGlobal('localStorage', {
    getItem: vi.fn((k) => (local.has(k) ? local.get(k) : null)),
    setItem: vi.fn((k, v) => local.set(k, String(v))),
    removeItem: vi.fn((k) => local.delete(k)),
  });

  vi.stubGlobal('navigator', { language: 'en-US' });

  return { store, local };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('defaultSettings', () => {
  it('returns the v2.1.0 shape with system theme', () => {
    installMocks();
    const d = defaultSettings();
    expect(d.theme).toBe('system');
    expect(d.clock.format === '12h' || d.clock.format === '24h').toBe(true);
  });

  it('picks 12h when navigator.language is en-US', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(defaultSettings().clock.format).toBe('12h');
    vi.unstubAllGlobals();
  });

  it('picks 24h when navigator.language is anything else', () => {
    vi.stubGlobal('navigator', { language: 'de-DE' });
    expect(defaultSettings().clock.format).toBe('24h');
    vi.unstubAllGlobals();
  });
});

describe('normalizeSettings', () => {
  it('falls back to defaults when raw is null/undefined/primitive', () => {
    installMocks();
    expect(normalizeSettings(null).theme).toBe('system');
    expect(normalizeSettings(undefined).theme).toBe('system');
    expect(normalizeSettings(42).theme).toBe('system');
    expect(normalizeSettings('nope').theme).toBe('system');
  });

  it('rejects invalid theme values', () => {
    installMocks();
    expect(normalizeSettings({ theme: 'purple' }).theme).toBe('system');
    expect(normalizeSettings({ theme: 0 }).theme).toBe('system');
  });

  it('rejects invalid clock formats', () => {
    installMocks();
    const r = normalizeSettings({ clock: { format: 'military' } });
    expect(r.clock.format === '12h' || r.clock.format === '24h').toBe(true);
  });

  it('preserves valid values', () => {
    installMocks();
    const r = normalizeSettings({ theme: 'dark', clock: { format: '24h' } });
    expect(r).toEqual({ theme: 'dark', clock: { format: '24h' } });
  });

  it('fills missing fields with defaults (partial object)', () => {
    installMocks();
    const r = normalizeSettings({ theme: 'light' });
    expect(r.theme).toBe('light');
    expect(r.clock.format === '12h' || r.clock.format === '24h').toBe(true);
  });
});

describe('getSettings', () => {
  it('returns defaults when storage key absent', async () => {
    installMocks({});
    const s = await getSettings();
    expect(s.theme).toBe('system');
  });

  it('returns normalized stored settings', async () => {
    installMocks({ [SETTINGS_KEY]: { theme: 'dark', clock: { format: '24h' } } });
    expect(await getSettings()).toEqual({ theme: 'dark', clock: { format: '24h' } });
  });

  it('drops garbage fields from storage and defaults them', async () => {
    installMocks({ [SETTINGS_KEY]: { theme: 'rainbow', clock: null, extra: 'ignored' } });
    const s = await getSettings();
    expect(s.theme).toBe('system');
    expect(s.clock.format === '12h' || s.clock.format === '24h').toBe(true);
  });
});

describe('setSettings', () => {
  it('writes the merged shape back to chrome.storage.local', async () => {
    const { store } = installMocks({ [SETTINGS_KEY]: { theme: 'light', clock: { format: '12h' } } });
    await setSettings({ theme: 'dark' });
    expect(store.get(SETTINGS_KEY)).toEqual({ theme: 'dark', clock: { format: '12h' } });
  });

  it('updates localStorage theme cache on explicit light/dark', async () => {
    const { local } = installMocks({});
    await setSettings({ theme: 'dark' });
    expect(local.get(THEME_CACHE_KEY)).toBe('dark');
  });

  it('clears localStorage theme cache on system theme', async () => {
    const { local } = installMocks({}, { [THEME_CACHE_KEY]: 'dark' });
    await setSettings({ theme: 'system' });
    expect(local.has(THEME_CACHE_KEY)).toBe(false);
  });

  it('returns the resolved settings', async () => {
    installMocks({});
    const result = await setSettings({ theme: 'light' });
    expect(result.theme).toBe('light');
  });
});

describe('syncThemeCache', () => {
  it('writes "dark" to localStorage', () => {
    const { local } = installMocks();
    syncThemeCache('dark');
    expect(local.get(THEME_CACHE_KEY)).toBe('dark');
  });

  it('writes "light" to localStorage', () => {
    const { local } = installMocks();
    syncThemeCache('light');
    expect(local.get(THEME_CACHE_KEY)).toBe('light');
  });

  it('removes the key on "system" so CSS media query takes over', () => {
    const { local } = installMocks({}, { [THEME_CACHE_KEY]: 'dark' });
    syncThemeCache('system');
    expect(local.has(THEME_CACHE_KEY)).toBe(false);
  });

  it('swallows localStorage failures silently', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => syncThemeCache('dark')).not.toThrow();
  });
});
