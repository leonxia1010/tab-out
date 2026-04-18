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

import { anchorPopoverTo, el, iconNode } from '../../../shared/dist/dom-utils.js';
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

// Stroke-width 1.5 to match Heroicons outline family (sun, cloud, moon
// already ship there — we draw the weather-specific glyphs in the same
// visual register so the header set reads uniform).
const SVG_BASE = 'xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"';

// 8-bucket WMO code → icon map. Condensing the full WMO table to 8
// glyphs trades resolution for header clarity — a user can tell
// "sunny vs. rainy vs. snowing" at a glance but doesn't need "light
// drizzle vs. moderate drizzle" parsed off a 16x16 icon.
const SVG_SUN = `<svg ${SVG_BASE} data-icon="sun"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.636 5.636l1.061 1.061M17.303 17.303l1.061 1.061M5.636 18.364l1.061-1.061M17.303 6.697l1.061-1.061"/></svg>`;
const SVG_PARTLY = `<svg ${SVG_BASE} data-icon="partly-cloudy"><circle cx="8" cy="8" r="3"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 3v1M3 8h1M4.9 4.9l.7.7M11.1 4.9l-.7.7M13.5 11a4 4 0 1 1 3.5 6H8a3.5 3.5 0 0 1 0-7 4 4 0 0 1 5.5 1Z"/></svg>`;
const SVG_CLOUD = `<svg ${SVG_BASE} data-icon="cloud"><path stroke-linecap="round" stroke-linejoin="round" d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.8-1A4 4 0 0 1 17 18H7Z"/></svg>`;
const SVG_FOG = `<svg ${SVG_BASE} data-icon="fog"><path stroke-linecap="round" stroke-linejoin="round" d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.8-1A4 4 0 0 1 17 14H7ZM3 18h18M5 21h14"/></svg>`;
const SVG_RAIN = `<svg ${SVG_BASE} data-icon="rain"><path stroke-linecap="round" stroke-linejoin="round" d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.8-1A4 4 0 0 1 17 14H7ZM9 18l-1 3M13 18l-1 3M17 18l-1 3"/></svg>`;
const SVG_SNOW = `<svg ${SVG_BASE} data-icon="snow"><path stroke-linecap="round" stroke-linejoin="round" d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.8-1A4 4 0 0 1 17 14H7ZM8 18v3M8 19.5l-1 .5M8 19.5l1 .5M12 18v3M12 19.5l-1 .5M12 19.5l1 .5M16 18v3M16 19.5l-1 .5M16 19.5l1 .5"/></svg>`;
const SVG_SHOWER = `<svg ${SVG_BASE} data-icon="shower"><path stroke-linecap="round" stroke-linejoin="round" d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.8-1A4 4 0 0 1 17 14H7ZM8 17l-2 4M12 17l-2 4M16 17l-2 4"/></svg>`;
const SVG_STORM = `<svg ${SVG_BASE} data-icon="storm"><path stroke-linecap="round" stroke-linejoin="round" d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.8-1A4 4 0 0 1 17 14H7ZM13 15l-3 4h3l-2 3"/></svg>`;

export function iconSvgForWeatherCode(code: number): string {
  if (code === 0) return SVG_SUN;
  if (code >= 1 && code <= 3) return SVG_PARTLY;
  if (code === 45 || code === 48) return SVG_FOG;
  if (code >= 51 && code <= 67) return SVG_RAIN;
  if (code >= 71 && code <= 77) return SVG_SNOW;
  if (code >= 80 && code <= 82) return SVG_SHOWER;
  if (code >= 85 && code <= 86) return SVG_SNOW;
  if (code >= 95 && code <= 99) return SVG_STORM;
  return SVG_CLOUD;
}

export function formatTemperature(tempC: number, unit: TemperatureUnit): string {
  const v = unit === 'F' ? tempC * 1.8 + 32 : tempC;
  return `${Math.round(v)}\u00b0`;
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
  let iconSlot: HTMLElement | null = null;
  let tempSlot: HTMLElement | null = null;
  let popoverLocation: HTMLElement | null = null;
  let popoverTemp: HTMLElement | null = null;

  function buildTrigger(): HTMLButtonElement {
    iconSlot = el('span', { className: 'weather-widget-icon', 'aria-hidden': 'true' });
    tempSlot = el('span', { className: 'weather-widget-temp' }, ['\u2014']);
    return el('button', {
      type: 'button',
      className: 'weather-widget',
      'aria-label': 'Weather',
      popovertarget: POPOVER_ID,
    }, [iconSlot, tempSlot]) as HTMLButtonElement;
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
    if (!trigger || !iconSlot || !tempSlot || !popoverLocation || !popoverTemp) return;
    if (!data) {
      iconSlot.replaceChildren(iconNode(SVG_CLOUD));
      tempSlot.textContent = '\u2014';
      popoverLocation.textContent = settings.locationLabel ?? '\u2014';
      popoverTemp.textContent = 'Loading\u2026';
      return;
    }
    iconSlot.replaceChildren(iconNode(iconSvgForWeatherCode(data.weatherCode)));
    tempSlot.textContent = formatTemperature(data.temperatureC, settings.unit);
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
    iconSlot = null;
    tempSlot = null;
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
