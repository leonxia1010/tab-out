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
  effectiveTheme,
  getSettings,
  setSettings,
  onSettingsChange,
  syncThemeCache,
  syncLayoutCache,
  SETTINGS_KEY,
  THEME_CACHE_KEY,
  LAYOUT_CACHE_KEY,
} from '../../extension/shared/src/settings.ts';

function installMocks(initialStorage = {}, initialLocal = {}) {
  const store = new Map(Object.entries(initialStorage));
  const local = new Map(Object.entries(initialLocal));
  const changeListeners = [];

  const storageLocal = {
    get: vi.fn(async (key) => (store.has(key) ? { [key]: store.get(key) } : {})),
    set: vi.fn(async (kv) => {
      for (const [k, v] of Object.entries(kv)) store.set(k, v);
    }),
  };

  vi.stubGlobal('chrome', {
    storage: {
      local: storageLocal,
      onChanged: {
        addListener: vi.fn((cb) => changeListeners.push(cb)),
        removeListener: vi.fn((cb) => {
          const i = changeListeners.indexOf(cb);
          if (i >= 0) changeListeners.splice(i, 1);
        }),
      },
    },
  });

  vi.stubGlobal('localStorage', {
    getItem: vi.fn((k) => (local.has(k) ? local.get(k) : null)),
    setItem: vi.fn((k, v) => local.set(k, String(v))),
    removeItem: vi.fn((k) => local.delete(k)),
  });

  vi.stubGlobal('navigator', { language: 'en-US' });

  function fireChange(changes, area = 'local') {
    for (const cb of changeListeners.slice()) cb(changes, area);
  }

  return { store, local, fireChange, changeListeners };
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

  it('defaults layout to masonry (v2.3.0)', () => {
    installMocks();
    expect(defaultSettings().layout).toBe('masonry');
  });

  it('defaults weather to enabled with no location (v2.6.0)', () => {
    installMocks();
    const d = defaultSettings();
    // enabled:true means a fresh install surfaces the "Set location"
    // prompt in the header instead of hiding the widget entirely.
    expect(d.weather).toEqual({
      enabled: true,
      locationLabel: null,
      latitude: null,
      longitude: null,
      unit: 'C',
    });
  });

  it('defaults countdown to enabled with sound on (v2.6.0)', () => {
    installMocks();
    const d = defaultSettings();
    expect(d.countdown).toEqual({ enabled: true, soundEnabled: true });
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
    const r = normalizeSettings({ theme: 'dark', clock: { format: '24h' }, layout: 'grid' });
    expect(r).toEqual({
      theme: 'dark',
      clock: { format: '24h' },
      layout: 'grid',
      shortcutPins: [],
      shortcutHides: [],
      weather: {
        enabled: true,
        locationLabel: null,
        latitude: null,
        longitude: null,
        unit: 'C',
      },
      countdown: { enabled: true, soundEnabled: true },
    });
  });

  it('fills missing fields with defaults (partial object)', () => {
    installMocks();
    const r = normalizeSettings({ theme: 'light' });
    expect(r.theme).toBe('light');
    expect(r.clock.format === '12h' || r.clock.format === '24h').toBe(true);
    expect(r.layout).toBe('masonry');
  });

  it('rejects invalid layout values and falls back to masonry', () => {
    installMocks();
    expect(normalizeSettings({ layout: 'staircase' }).layout).toBe('masonry');
    expect(normalizeSettings({ layout: 42 }).layout).toBe('masonry');
  });

  // ── shortcut fields (v2.3.0) ────────────────────────────────────────────────
  it('defaults shortcutPins + shortcutHides to empty arrays', () => {
    installMocks();
    const r = normalizeSettings({});
    expect(r.shortcutPins).toEqual([]);
    expect(r.shortcutHides).toEqual([]);
  });

  it('drops malformed shortcutPins entries silently', () => {
    installMocks();
    const r = normalizeSettings({
      shortcutPins: [
        { url: 'https://ok/', title: 'OK' },
        { title: 'no url' },              // dropped
        null,                              // dropped
        'string',                          // dropped
        { url: 'https://no-title/', title: undefined }, // dropped
      ],
    });
    expect(r.shortcutPins).toEqual([{ url: 'https://ok/', title: 'OK' }]);
  });

  it('rejects non-array shortcutPins / shortcutHides and defaults to []', () => {
    installMocks();
    expect(normalizeSettings({ shortcutPins: 'nope' }).shortcutPins).toEqual([]);
    expect(normalizeSettings({ shortcutHides: 42 }).shortcutHides).toEqual([]);
  });

  it('keeps valid shortcutHides strings, drops empty/non-string', () => {
    installMocks();
    const r = normalizeSettings({
      shortcutHides: ['https://a/', '', 'https://b/', null, 42],
    });
    expect(r.shortcutHides).toEqual(['https://a/', 'https://b/']);
  });

  // ── weather (v2.6.0) ──────────────────────────────────────────────────────
  it('keeps valid weather values', () => {
    installMocks();
    const r = normalizeSettings({
      weather: {
        enabled: true,
        locationLabel: 'Boston, MA, US',
        latitude: 42.3601,
        longitude: -71.0589,
        unit: 'F',
      },
    });
    expect(r.weather).toEqual({
      enabled: true,
      locationLabel: 'Boston, MA, US',
      latitude: 42.3601,
      longitude: -71.0589,
      unit: 'F',
    });
  });

  it('rejects out-of-range latitude/longitude and falls back to null', () => {
    installMocks();
    const r = normalizeSettings({
      weather: { enabled: true, latitude: 999, longitude: -200, unit: 'C' },
    });
    expect(r.weather.latitude).toBeNull();
    expect(r.weather.longitude).toBeNull();
  });

  it('rejects non-finite latitude (NaN, string) and clamps to null', () => {
    installMocks();
    const r = normalizeSettings({
      weather: { enabled: true, latitude: NaN, longitude: 'nope', unit: 'C' },
    });
    expect(r.weather.latitude).toBeNull();
    expect(r.weather.longitude).toBeNull();
  });

  it('rejects invalid unit and falls back to C', () => {
    installMocks();
    expect(normalizeSettings({ weather: { unit: 'K' } }).weather.unit).toBe('C');
  });

  it('empty locationLabel string coerces to null', () => {
    installMocks();
    expect(normalizeSettings({ weather: { locationLabel: '' } }).weather.locationLabel).toBeNull();
  });

  it('non-boolean enabled flag falls back to the enabled-by-default true', () => {
    installMocks();
    expect(normalizeSettings({ weather: { enabled: 'yes' } }).weather.enabled).toBe(true);
  });

  // ── countdown (v2.6.0) ────────────────────────────────────────────────────
  it('keeps valid countdown values', () => {
    installMocks();
    const r = normalizeSettings({
      countdown: { enabled: false, soundEnabled: false },
    });
    expect(r.countdown).toEqual({ enabled: false, soundEnabled: false });
  });

  it('countdown non-boolean fields fall back to defaults', () => {
    installMocks();
    const r = normalizeSettings({
      countdown: { enabled: 'true', soundEnabled: 1 },
    });
    expect(r.countdown).toEqual({ enabled: true, soundEnabled: true });
  });
});

describe('effectiveTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns light/dark unchanged when set explicitly', () => {
    expect(effectiveTheme('light')).toBe('light');
    expect(effectiveTheme('dark')).toBe('dark');
  });

  it('returns dark when system prefers dark', () => {
    vi.stubGlobal('window', {
      matchMedia: (q) => ({ matches: q.includes('dark') }),
    });
    expect(effectiveTheme('system')).toBe('dark');
  });

  it('returns light when system prefers light', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    });
    expect(effectiveTheme('system')).toBe('light');
  });

  it('falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('window', {});
    expect(effectiveTheme('system')).toBe('light');
  });
});

describe('getSettings', () => {
  it('returns defaults when storage key absent', async () => {
    installMocks({});
    const s = await getSettings();
    expect(s.theme).toBe('system');
  });

  it('returns normalized stored settings', async () => {
    installMocks({ [SETTINGS_KEY]: { theme: 'dark', clock: { format: '24h' }, layout: 'grid' } });
    expect(await getSettings()).toEqual({
      theme: 'dark',
      clock: { format: '24h' },
      layout: 'grid',
      shortcutPins: [],
      shortcutHides: [],
      weather: {
        enabled: true,
        locationLabel: null,
        latitude: null,
        longitude: null,
        unit: 'C',
      },
      countdown: { enabled: true, soundEnabled: true },
    });
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
    const { store } = installMocks({ [SETTINGS_KEY]: { theme: 'light', clock: { format: '12h' }, layout: 'masonry' } });
    await setSettings({ theme: 'dark' });
    expect(store.get(SETTINGS_KEY)).toEqual({
      theme: 'dark',
      clock: { format: '12h' },
      layout: 'masonry',
      shortcutPins: [],
      shortcutHides: [],
      weather: {
        enabled: true,
        locationLabel: null,
        latitude: null,
        longitude: null,
        unit: 'C',
      },
      countdown: { enabled: true, soundEnabled: true },
    });
  });

  it('persists shortcutPins and shortcutHides patches', async () => {
    const { store } = installMocks({});
    await setSettings({
      shortcutPins: [{ url: 'https://a/', title: 'A' }],
      shortcutHides: ['https://b/'],
    });
    const saved = store.get(SETTINGS_KEY);
    expect(saved.shortcutPins).toEqual([{ url: 'https://a/', title: 'A' }]);
    expect(saved.shortcutHides).toEqual(['https://b/']);
  });

  it('normalizes patched shortcutPins (drops garbage entries)', async () => {
    const { store } = installMocks({});
    await setSettings({
      shortcutPins: [
        { url: 'https://ok/', title: 'OK' },
        { title: 'no url' },
      ],
    });
    expect(store.get(SETTINGS_KEY).shortcutPins).toEqual([
      { url: 'https://ok/', title: 'OK' },
    ]);
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

  it('persists layout and writes the layout cache on grid', async () => {
    const { store, local } = installMocks({});
    await setSettings({ layout: 'grid' });
    expect(store.get(SETTINGS_KEY).layout).toBe('grid');
    expect(local.get(LAYOUT_CACHE_KEY)).toBe('grid');
  });

  it('clears layout cache when setting layout back to masonry', async () => {
    const { local } = installMocks({}, { [LAYOUT_CACHE_KEY]: 'grid' });
    await setSettings({ layout: 'masonry' });
    expect(local.has(LAYOUT_CACHE_KEY)).toBe(false);
  });

  // Without withLock, two concurrent setSettings calls both read the same
  // snapshot and the later write clobbers the earlier patch (classic
  // read-modify-write race across the two storage awaits). Regression guard
  // for the dashboard + options concurrent-write scenario.
  it('serializes concurrent setSettings calls (no patch lost)', async () => {
    const { store } = installMocks({
      [SETTINGS_KEY]: { theme: 'system', clock: { format: '24h' }, layout: 'masonry' },
    });
    await Promise.all([
      setSettings({ theme: 'dark' }),
      setSettings({ clock: { format: '12h' } }),
    ]);
    const saved = store.get(SETTINGS_KEY);
    expect(saved.theme).toBe('dark');
    expect(saved.clock.format).toBe('12h');
  });

  it('serializes concurrent shortcut pin + hide writes', async () => {
    const { store } = installMocks({});
    await Promise.all([
      setSettings({ shortcutPins: [{ url: 'https://a/', title: 'A' }] }),
      setSettings({ shortcutHides: ['https://b/'] }),
    ]);
    const saved = store.get(SETTINGS_KEY);
    expect(saved.shortcutPins).toEqual([{ url: 'https://a/', title: 'A' }]);
    expect(saved.shortcutHides).toEqual(['https://b/']);
  });

  // v2.6.0 — spread-merge on the new nested keys. Without the spread,
  // a `{ weather: { unit: 'F' } }` patch would drop lat/lon/enabled.
  it('weather spread-merge preserves siblings when unit changes', async () => {
    const { store } = installMocks({
      [SETTINGS_KEY]: {
        theme: 'system',
        clock: { format: '12h' },
        layout: 'masonry',
        weather: {
          enabled: true,
          locationLabel: 'Boston, MA, US',
          latitude: 42.36,
          longitude: -71.06,
          unit: 'C',
        },
      },
    });
    await setSettings({ weather: { unit: 'F' } });
    const saved = store.get(SETTINGS_KEY);
    expect(saved.weather).toEqual({
      enabled: true,
      locationLabel: 'Boston, MA, US',
      latitude: 42.36,
      longitude: -71.06,
      unit: 'F',
    });
  });

  it('countdown spread-merge preserves siblings', async () => {
    const { store } = installMocks({
      [SETTINGS_KEY]: {
        theme: 'system',
        clock: { format: '12h' },
        layout: 'masonry',
        countdown: { enabled: true, soundEnabled: true },
      },
    });
    await setSettings({ countdown: { soundEnabled: false } });
    const saved = store.get(SETTINGS_KEY);
    expect(saved.countdown).toEqual({ enabled: true, soundEnabled: false });
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

describe('syncLayoutCache', () => {
  it('writes "grid" to localStorage', () => {
    const { local } = installMocks();
    syncLayoutCache('grid');
    expect(local.get(LAYOUT_CACHE_KEY)).toBe('grid');
  });

  it('removes the key on "masonry" so default stylesheet rule applies', () => {
    const { local } = installMocks({}, { [LAYOUT_CACHE_KEY]: 'grid' });
    syncLayoutCache('masonry');
    expect(local.has(LAYOUT_CACHE_KEY)).toBe(false);
  });

  it('swallows localStorage failures silently', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => syncLayoutCache('grid')).not.toThrow();
    expect(() => syncLayoutCache('masonry')).not.toThrow();
  });
});

// onSettingsChange is the dashboard ↔ options cross-page sync hook —
// storage.onChanged fires when one page writes via setSettings and the
// other page's listener receives the normalized shape. Production path
// is covered only by manual integration; these tests lock the wiring.
describe('onSettingsChange', () => {
  it('forwards normalized newValue when SETTINGS_KEY changes on local', () => {
    const { fireChange } = installMocks();
    const cb = vi.fn();
    onSettingsChange(cb);

    fireChange({
      [SETTINGS_KEY]: {
        newValue: { theme: 'dark', clock: { format: '12h' }, layout: 'grid' },
      },
    }, 'local');

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({
      theme: 'dark',
      clock: { format: '12h' },
      layout: 'grid',
      shortcutPins: [],
      shortcutHides: [],
      weather: {
        enabled: true,
        locationLabel: null,
        latitude: null,
        longitude: null,
        unit: 'C',
      },
      countdown: { enabled: true, soundEnabled: true },
    });
  });

  it('ignores changes for unrelated keys', () => {
    const { fireChange } = installMocks();
    const cb = vi.fn();
    onSettingsChange(cb);

    fireChange({ 'some:other:key': { newValue: { theme: 'dark' } } }, 'local');
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores changes on non-local storage areas', () => {
    const { fireChange } = installMocks();
    const cb = vi.fn();
    onSettingsChange(cb);

    fireChange({ [SETTINGS_KEY]: { newValue: { theme: 'dark' } } }, 'sync');
    expect(cb).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function that detaches the listener', () => {
    const { fireChange, changeListeners } = installMocks();
    const cb = vi.fn();
    const unsub = onSettingsChange(cb);
    expect(changeListeners).toHaveLength(1);

    unsub();
    expect(changeListeners).toHaveLength(0);
    fireChange({ [SETTINGS_KEY]: { newValue: { theme: 'dark' } } }, 'local');
    expect(cb).not.toHaveBeenCalled();
  });

  it('mirrors theme + layout to localStorage so bootstrap scripts stay synced', () => {
    const { fireChange, local } = installMocks();
    onSettingsChange(() => {});

    fireChange({
      [SETTINGS_KEY]: {
        newValue: { theme: 'dark', clock: { format: '24h' }, layout: 'grid' },
      },
    }, 'local');

    expect(local.get(THEME_CACHE_KEY)).toBe('dark');
    expect(local.get(LAYOUT_CACHE_KEY)).toBe('grid');
  });
});
