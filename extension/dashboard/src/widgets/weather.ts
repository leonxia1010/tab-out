// Weather widget — Open-Meteo-backed temperature readout in the header.
//
// Data flow:
//   background.js fetchWeatherNow() → chrome.storage.local['tabout:weatherData']
//   this widget reads the key on mount, subscribes via
//   chrome.storage.onChanged, and sendMessage('refresh-weather') when
//   cached data is stale (>30min) or the user just changed location.
//
// The widget never calls fetch() itself — all network lives in the
// service worker so the dashboard tab can't deny/slow the request and
// so background alarms remain the single refresh source of truth.

import { anchorPopoverTo, el } from '../../../shared/dist/dom-utils.js';
import type { TemperatureUnit, WeatherSettings } from '../../../shared/dist/settings.js';

export interface WeatherHandle {
  destroy(): void;
  applySettings(next: WeatherSettings): void;
}

export interface WeatherData {
  latitude: number;
  longitude: number;
  temperatureC: number;
  weatherCode: number;
  fetchedAt: string;
}

export const WEATHER_STORAGE_KEY = 'tabout:weatherData';
const STALE_MS = 30 * 60 * 1000;
const POPOVER_ID = 'taboutWeatherPopover';
const POPOVER_GAP_PX = 8;

// WMO code → human-readable condition text. Condensed from the full
// WMO table to ~10 buckets covering the atmospheric phenomena users
// actually care about in a header readout. The widget shows this
// alongside the temperature ("+77°F · Partly cloudy"), so we reach for
// words instead of glyphs — words render identically across platforms
// and don't need a legend.
export function conditionTextForWeatherCode(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 65) return 'Rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain showers';
  if (code >= 85 && code <= 86) return 'Snow showers';
  if (code >= 95 && code <= 99) return 'Thunderstorm';
  return '\u2014';
}

// Temperature readout matches the header mock: "+77°F" / "-5°C" /
// "0°C" (no prefix for zero). Rounded to the nearest integer; JS
// turns `-0` into `'0'` on coercion, so there's no stray "-0".
export function formatTemperature(tempC: number, unit: TemperatureUnit): string {
  const v = unit === 'F' ? tempC * 1.8 + 32 : tempC;
  const rounded = Math.round(v);
  const prefix = rounded > 0 ? '+' : '';
  return `${prefix}${rounded}\u00b0${unit}`;
}

export function formatWeatherReadout(
  data: Pick<WeatherData, 'temperatureC' | 'weatherCode'>,
  unit: TemperatureUnit,
): string {
  return `${formatTemperature(data.temperatureC, unit)} \u00b7 ${conditionTextForWeatherCode(data.weatherCode)}`;
}

function shouldRender(settings: WeatherSettings): boolean {
  return settings.enabled && settings.latitude !== null && settings.longitude !== null;
}

async function readWeatherData(): Promise<WeatherData | null> {
  try {
    const result = await chrome.storage.local.get(WEATHER_STORAGE_KEY);
    const v = (result as Record<string, unknown>)[WEATHER_STORAGE_KEY];
    if (!v || typeof v !== 'object') return null;
    const d = v as Partial<WeatherData>;
    if (typeof d.temperatureC !== 'number' || !Number.isFinite(d.temperatureC)) return null;
    if (typeof d.weatherCode !== 'number') return null;
    if (typeof d.fetchedAt !== 'string') return null;
    return {
      latitude: typeof d.latitude === 'number' ? d.latitude : 0,
      longitude: typeof d.longitude === 'number' ? d.longitude : 0,
      temperatureC: d.temperatureC,
      weatherCode: d.weatherCode,
      fetchedAt: d.fetchedAt,
    };
  } catch {
    return null;
  }
}

function requestRefresh(force = false): void {
  try {
    chrome.runtime?.sendMessage?.({ type: 'refresh-weather', force }, () => {
      // swallow lastError: the fetch is fire-and-forget — if the SW
      // rejected or isn't listening, the next alarm cycle catches up.
      void chrome.runtime?.lastError;
    });
  } catch {
    // chrome.runtime absent (dev pages, tests without stub) — nothing to do.
  }
}

export function mountWeather(
  container: HTMLElement,
  initialSettings: WeatherSettings,
): WeatherHandle {
  let settings: WeatherSettings = initialSettings;
  let data: WeatherData | null = null;
  let destroyed = false;

  // Elements mount lazily: widget stays unmounted while disabled / not
  // configured so the header cluster doesn't reserve empty width.
  let trigger: HTMLButtonElement | null = null;
  let popover: HTMLElement | null = null;
  let readoutSlot: HTMLElement | null = null;
  let popoverLocation: HTMLElement | null = null;
  let popoverTemp: HTMLElement | null = null;

  function buildTrigger(): HTMLButtonElement {
    readoutSlot = el('span', { className: 'weather-widget-readout' }, ['\u2014']);
    return el('button', {
      type: 'button',
      className: 'weather-widget',
      'aria-label': 'Weather',
      popovertarget: POPOVER_ID,
    }, [readoutSlot]) as HTMLButtonElement;
  }

  function buildPopover(): HTMLElement {
    popoverLocation = el('div', { className: 'weather-popover-location' }, ['\u2014']);
    popoverTemp = el('div', { className: 'weather-popover-temp' }, ['\u2014']);
    const hint = el('a', {
      className: 'weather-popover-hint',
      href: '#',
      'data-action': 'open-options',
    }, ['Open settings to change location']);
    hint.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        chrome.runtime?.openOptionsPage?.();
      } catch {
        // options page not reachable in this context; nothing to do.
      }
    });
    return el('div', {
      id: POPOVER_ID,
      className: 'weather-popover',
      popover: 'auto',
      role: 'dialog',
    }, [popoverLocation, popoverTemp, hint]) as HTMLElement;
  }

  function renderDisplay(): void {
    if (!trigger || !readoutSlot || !popoverLocation || !popoverTemp) return;
    if (!data) {
      readoutSlot.textContent = '\u2014';
      popoverLocation.textContent = settings.locationLabel ?? '\u2014';
      popoverTemp.textContent = 'Loading\u2026';
      return;
    }
    readoutSlot.textContent = formatWeatherReadout(data, settings.unit);
    popoverLocation.textContent = settings.locationLabel ?? '\u2014';
    popoverTemp.textContent = formatTemperature(data.temperatureC, settings.unit);
  }

  function mount(): void {
    if (trigger) return;
    trigger = buildTrigger();
    popover = buildPopover();
    container.appendChild(trigger);
    container.appendChild(popover);
    anchorPopoverTo(trigger, popover, POPOVER_GAP_PX);
    renderDisplay();
  }

  function unmount(): void {
    trigger?.remove();
    popover?.remove();
    trigger = null;
    popover = null;
    readoutSlot = null;
    popoverLocation = null;
    popoverTemp = null;
  }

  function isStale(d: WeatherData | null): boolean {
    if (!d) return true;
    const ts = Date.parse(d.fetchedAt);
    return !Number.isFinite(ts) || (Date.now() - ts) > STALE_MS;
  }

  // background.js writes tabout:weatherData — onChanged is how the widget
  // hears back after a refresh. Same listener is the cross-tab sync path.
  const onStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (destroyed) return;
    if (area !== 'local' || !(WEATHER_STORAGE_KEY in changes)) return;
    void (async () => {
      data = await readWeatherData();
      renderDisplay();
    })();
  };
  chrome.storage.onChanged.addListener(onStorageChange);

  void (async () => {
    data = await readWeatherData();
    if (shouldRender(settings)) {
      mount();
      if (isStale(data)) requestRefresh(false);
    }
  })();

  return {
    destroy(): void {
      destroyed = true;
      chrome.storage.onChanged.removeListener(onStorageChange);
      unmount();
    },
    applySettings(next: WeatherSettings): void {
      if (destroyed) return;
      const prev = settings;
      settings = next;

      const show = shouldRender(next);
      if (!show) {
        unmount();
        return;
      }
      if (!trigger) mount();

      const locationChanged =
        prev.latitude !== next.latitude || prev.longitude !== next.longitude;
      const justEnabled = !prev.enabled && next.enabled;
      if (locationChanged || justEnabled) {
        requestRefresh(true);
      }
      renderDisplay();
    },
  };
}
