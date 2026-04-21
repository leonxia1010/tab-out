// Shared settings module — imported by both dashboard and options page.
//
// Storage shape (chrome.storage.local['tabout:settings']):
//   { theme, clock: { format }, layout, shortcutPins, shortcutHides,
//     weather: { enabled, locationLabel, latitude, longitude, unit },
//     countdown: { enabled, soundEnabled } }
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

import { createLock, storage } from './storage.js';
import { DEFAULT_PRIORITY_HOSTNAMES, effectiveDomain } from './domain-grouping.js';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ClockFormat = '12h' | '24h';
export type Layout = 'masonry' | 'grid';
export type TemperatureUnit = 'C' | 'F';

export interface ShortcutPin {
  url: string;
  title: string;
}

export interface WeatherSettings {
  enabled: boolean;
  locationLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  unit: TemperatureUnit;
}

export interface CountdownSettings {
  enabled: boolean;
  soundEnabled: boolean;
}

export interface ToutSettings {
  theme: ThemeMode;
  clock: { format: ClockFormat };
  layout: Layout;
  priorityHostnames: string[];
  shortcutPins: ShortcutPin[];
  shortcutHides: string[];
  weather: WeatherSettings;
  countdown: CountdownSettings;
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
    priorityHostnames: [...DEFAULT_PRIORITY_HOSTNAMES],
    shortcutPins: [],
    shortcutHides: [],
    weather: {
      // Default ON so a fresh install surfaces the "Set location"
      // onboarding hint in the header. Location still starts null —
      // the widget shows a clickable prompt that opens Settings
      // directly. Users who don't want a weather readout can flip
      // the toggle off in Settings, which unmounts the node entirely.
      enabled: true,
      locationLabel: null,
      latitude: null,
      longitude: null,
      unit: 'C',
    },
    countdown: {
      enabled: true,
      soundEnabled: true,
    },
  };
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

function isTemperatureUnit(v: unknown): v is TemperatureUnit {
  return v === 'C' || v === 'F';
}

// Latitude/longitude must be finite real numbers in valid ranges — NaN,
// strings, or out-of-range values all fall back to null so the widget
// mount guard (`latitude === null`) trips and skips rendering.
function isFiniteLatitude(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}

function isFiniteLongitude(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

function normalizeWeather(v: unknown): WeatherSettings {
  const d = defaultSettings().weather;
  if (!v || typeof v !== 'object') return d;
  const r = v as Partial<WeatherSettings>;
  const lat = isFiniteLatitude(r.latitude) ? r.latitude : null;
  const lon = isFiniteLongitude(r.longitude) ? r.longitude : null;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    locationLabel: typeof r.locationLabel === 'string' && r.locationLabel.length > 0
      ? r.locationLabel
      : null,
    latitude: lat,
    longitude: lon,
    unit: isTemperatureUnit(r.unit) ? r.unit : d.unit,
  };
}

function normalizeCountdown(v: unknown): CountdownSettings {
  const d = defaultSettings().countdown;
  if (!v || typeof v !== 'object') return d;
  const r = v as Partial<CountdownSettings>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    soundEnabled: typeof r.soundEnabled === 'boolean' ? r.soundEnabled : d.soundEnabled,
  };
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

// Priority hostnames are stored card-key form (post-effectiveDomain), so a
// user typing "twitter.com" lands as "x.com" and actually matches the
// collapsed group. Lowercase + trim because hostnames are case-insensitive
// and trailing whitespace from paste is a common papercut. Dedupe
// preserves first occurrence so editing-by-reorder in the options UI is
// stable.
export function normalizePriorityHostnames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const normalized = effectiveDomain(raw.trim().toLowerCase());
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
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
    priorityHostnames: r.priorityHostnames === undefined
      ? d.priorityHostnames
      : normalizePriorityHostnames(r.priorityHostnames),
    shortcutPins: normalizeShortcutPins(r.shortcutPins),
    shortcutHides: normalizeShortcutHides(r.shortcutHides),
    weather: normalizeWeather(r.weather),
    countdown: normalizeCountdown(r.countdown),
  };
}

// Resolve the mode the user actually sees. 'system' folds through the
// prefers-color-scheme media query; explicit light/dark pass through.
// Lives in shared/ because both the dashboard (theme widget icon sync)
// and the options page (future "Follow system (currently dark)" hint)
// need the same resolution rule — duplicating it would invite drift.
export function effectiveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
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
// Reads (getSettings) stay lock-free; deferredTabs uses its own lock in
// api.ts so the two write streams don't starve each other.
const withLock = createLock();

export function setSettings(patch: Partial<ToutSettings>): Promise<ToutSettings> {
  return withLock(async () => {
    const current = await getSettings();
    const next: ToutSettings = {
      theme: patch.theme ?? current.theme,
      // Spread-merge so clock stays forward-compatible: adding a second
      // field (e.g. `showSeconds`) later means callers can patch just
      // `format` without wiping siblings. Explicit-field pick would
      // silently drop the rest on every unrelated setSettings call.
      clock: { ...current.clock, ...(patch.clock ?? {}) },
      layout: patch.layout ?? current.layout,
      // Arrays: normalize the patch so callers can pass raw input
      // without bypassing the defensive shape check.
      priorityHostnames: patch.priorityHostnames
        ? normalizePriorityHostnames(patch.priorityHostnames)
        : current.priorityHostnames,
      shortcutPins: patch.shortcutPins
        ? normalizeShortcutPins(patch.shortcutPins)
        : current.shortcutPins,
      shortcutHides: patch.shortcutHides
        ? normalizeShortcutHides(patch.shortcutHides)
        : current.shortcutHides,
      // Same spread-merge reasoning as clock: callers can patch
      // `{ weather: { unit: 'F' } }` without clobbering lat/lon/enabled.
      weather: normalizeWeather({ ...current.weather, ...(patch.weather ?? {}) }),
      countdown: normalizeCountdown({ ...current.countdown, ...(patch.countdown ?? {}) }),
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
