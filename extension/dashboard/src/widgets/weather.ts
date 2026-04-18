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
// Hover-close grace period: lets the cursor bridge the ~8px gap
// between trigger and popover without the popover snapping shut.
const HOVER_CLOSE_DELAY_MS = 150;

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

// The widget mounts whenever the feature is enabled. Location gating
// lives in renderDisplay → when it's null, we surface a "Set weather
// location" prompt that drops the user straight into Settings.
function shouldRender(settings: WeatherSettings): boolean {
  return settings.enabled;
}

function hasLocation(settings: WeatherSettings): boolean {
  return settings.latitude !== null && settings.longitude !== null;
}

function openOptionsPage(): void {
  try {
    chrome.runtime?.openOptionsPage?.();
  } catch {
    // options page not reachable in this context; nothing to do.
  }
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
  let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelHoverClose(): void {
    if (hoverCloseTimer != null) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  }

  function scheduleHoverClose(): void {
    cancelHoverClose();
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = null;
      try {
        popover?.hidePopover?.();
      } catch {
        // Popover already closed by click-outside / Escape — benign.
      }
    }, HOVER_CLOSE_DELAY_MS);
  }

  function showPopoverSafe(): void {
    if (!popover) return;
    try {
      if (!popover.matches(':popover-open')) popover.showPopover?.();
    } catch {
      // showPopover throws InvalidStateError if already open or not
      // connected; both are benign for this hover-driven path.
    }
  }

  function buildTrigger(): HTMLButtonElement {
    readoutSlot = el('span', { className: 'weather-widget-readout' }, ['\u2014']);
    const btn = el('button', {
      type: 'button',
      className: 'weather-widget',
      'aria-label': 'Weather',
    }, [readoutSlot]) as HTMLButtonElement;
    // Popover triggers on BOTH click and hover (users asked for
    // hover). Native `popovertarget` only responds to click, so we
    // drive showPopover() manually and keep popover="auto" so click-
    // outside + Escape still close it for free.
    //
    // In setup mode (no location configured) the button is a
    // Settings shortcut instead, so hover/click route to
    // openOptionsPage() — no popover would carry useful info there.
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === 'setup') {
        openOptionsPage();
        return;
      }
      showPopoverSafe();
    });
    btn.addEventListener('mouseenter', () => {
      if (btn.dataset.mode === 'setup') return;
      cancelHoverClose();
      showPopoverSafe();
    });
    btn.addEventListener('mouseleave', () => {
      if (btn.dataset.mode === 'setup') return;
      scheduleHoverClose();
    });
    return btn;
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
      openOptionsPage();
    });
    const pop = el('div', {
      id: POPOVER_ID,
      className: 'weather-popover',
      popover: 'auto',
      role: 'dialog',
    }, [popoverLocation, popoverTemp, hint]) as HTMLElement;
    // Hover bridge: moving into the popover cancels the pending close
    // so users can click the "Open settings" link; leaving again
    // schedules it fresh.
    pop.addEventListener('mouseenter', cancelHoverClose);
    pop.addEventListener('mouseleave', scheduleHoverClose);
    return pop;
  }

  function renderDisplay(): void {
    if (!trigger || !readoutSlot || !popoverLocation || !popoverTemp) return;

    if (!hasLocation(settings)) {
      // Setup mode: prompt the user to configure a location. The
      // button acts as a direct Settings shortcut; the hover/click
      // handlers short-circuit when dataset.mode === 'setup'.
      readoutSlot.textContent = 'Set weather location';
      trigger.dataset.mode = 'setup';
      trigger.classList.add('weather-widget-prompt');
      popoverLocation.textContent = '\u2014';
      popoverTemp.textContent = '';
      return;
    }

    delete trigger.dataset.mode;
    trigger.classList.remove('weather-widget-prompt');

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

  // Mount synchronously so the header cluster DOM order matches the
  // index.ts call order — reading data first (via await) would let
  // any sibling widget mounted after us (countdown) append its node
  // before ours, visually swapping weather and countdown in the row.
  if (shouldRender(settings)) mount();

  void (async () => {
    data = await readWeatherData();
    if (destroyed) return;
    renderDisplay();
    if (shouldRender(settings) && hasLocation(settings) && isStale(data)) {
      requestRefresh(false);
    }
  })();

  return {
    destroy(): void {
      destroyed = true;
      cancelHoverClose();
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
