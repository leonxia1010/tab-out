// @vitest-environment jsdom
// tests/dashboard/widgets-weather.test.js
// ─────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/weather.ts — header
// weather widget backed by chrome.storage.local['tabout:weatherData']
// (written by background.js). Coverage:
//   - enabled/disabled gating (no DOM when disabled or lat === null)
//   - WMO code → icon bucket mapping (iconSvgForWeatherCode)
//   - temperature formatting (C↔F conversion, no re-fetch on unit flip)
//   - refresh-weather sendMessage fires on mount when data is stale or
//     on applySettings when location changes
//   - storage.onChanged updates the DOM on background writes
//   - destroy() removes node + listener

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  conditionTextForWeatherCode,
  formatTemperature,
  formatWeatherReadout,
  mountWeather,
  WEATHER_STORAGE_KEY,
} from '../../extension/dashboard/src/widgets/weather.ts';

function installChrome(initialData) {
  const store = new Map();
  if (initialData !== undefined) store.set(WEATHER_STORAGE_KEY, initialData);
  const changeListeners = [];
  const sendMessage = vi.fn();
  const openOptionsPage = vi.fn();

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      openOptionsPage,
    },
    storage: {
      local: {
        get: vi.fn(async (key) => (store.has(key) ? { [key]: store.get(key) } : {})),
        set: vi.fn(async (kv) => {
          for (const [k, v] of Object.entries(kv)) store.set(k, v);
        }),
      },
      onChanged: {
        addListener: vi.fn((cb) => changeListeners.push(cb)),
        removeListener: vi.fn((cb) => {
          const i = changeListeners.indexOf(cb);
          if (i >= 0) changeListeners.splice(i, 1);
        }),
      },
    },
  });

  return {
    store,
    sendMessage,
    openOptionsPage,
    fireChange: (key, newValue, area = 'local') => {
      // Mirror real chrome.storage behaviour: set the value first so
      // listeners that re-read storage (like weather.ts) see the new
      // payload, not the old cached one.
      if (newValue === undefined) store.delete(key);
      else store.set(key, newValue);
      for (const cb of changeListeners.slice()) {
        cb({ [key]: { newValue } }, area);
      }
    },
  };
}

const DISABLED = {
  enabled: false,
  locationLabel: null,
  latitude: null,
  longitude: null,
  unit: 'C',
};

const CONFIGURED = {
  enabled: true,
  locationLabel: 'Boston, MA, US',
  latitude: 42.36,
  longitude: -71.06,
  unit: 'C',
};

const FRESH_DATA = (overrides = {}) => ({
  latitude: 42.36,
  longitude: -71.06,
  temperatureC: 11.5,
  weatherCode: 3,
  fetchedAt: new Date().toISOString(),
  ...overrides,
});

const STALE_DATA = (overrides = {}) => ({
  latitude: 42.36,
  longitude: -71.06,
  temperatureC: 11.5,
  weatherCode: 3,
  fetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  ...overrides,
});

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
});

// The widget's `void (async () => …)` bootstrap chains through several
// awaits (storage.local.get → readWeatherData → mount/render). A single
// `await Promise.resolve()` only drains the first microtask; we need a
// real task boundary to be sure every await in the chain has settled.
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conditionTextForWeatherCode', () => {
  it('maps clear/mostly-clear/partly-cloudy/overcast (0-3)', () => {
    expect(conditionTextForWeatherCode(0)).toBe('Clear');
    expect(conditionTextForWeatherCode(1)).toBe('Mostly clear');
    expect(conditionTextForWeatherCode(2)).toBe('Partly cloudy');
    expect(conditionTextForWeatherCode(3)).toBe('Overcast');
  });
  it('maps fog (45, 48)', () => {
    expect(conditionTextForWeatherCode(45)).toBe('Fog');
    expect(conditionTextForWeatherCode(48)).toBe('Fog');
  });
  it('maps drizzle (51-57) and rain (61-65)', () => {
    for (const code of [51, 53, 55, 56, 57]) {
      expect(conditionTextForWeatherCode(code)).toBe('Drizzle');
    }
    for (const code of [61, 63, 65]) {
      expect(conditionTextForWeatherCode(code)).toBe('Rain');
    }
  });
  it('maps freezing rain (66, 67)', () => {
    expect(conditionTextForWeatherCode(66)).toBe('Freezing rain');
    expect(conditionTextForWeatherCode(67)).toBe('Freezing rain');
  });
  it('maps snow (71-77)', () => {
    for (const code of [71, 73, 75, 77]) {
      expect(conditionTextForWeatherCode(code)).toBe('Snow');
    }
  });
  it('maps showers (80-82) and snow showers (85-86)', () => {
    for (const code of [80, 81, 82]) {
      expect(conditionTextForWeatherCode(code)).toBe('Rain showers');
    }
    for (const code of [85, 86]) {
      expect(conditionTextForWeatherCode(code)).toBe('Snow showers');
    }
  });
  it('maps thunderstorm (95-99)', () => {
    for (const code of [95, 96, 99]) {
      expect(conditionTextForWeatherCode(code)).toBe('Thunderstorm');
    }
  });
  it('defaults unrecognized codes to em dash', () => {
    expect(conditionTextForWeatherCode(999)).toBe('\u2014');
  });
});

describe('formatTemperature', () => {
  it('positive temperature gets a + prefix', () => {
    expect(formatTemperature(22.3, 'C')).toBe('+22\u00b0C');
    expect(formatTemperature(22.6, 'C')).toBe('+23\u00b0C');
  });
  it('zero has no prefix', () => {
    expect(formatTemperature(0, 'C')).toBe('0\u00b0C');
  });
  it('negative keeps the minus sign only (no double prefix)', () => {
    expect(formatTemperature(-5, 'C')).toBe('-5\u00b0C');
  });
  it('converts Celsius to Fahrenheit with the F unit suffix', () => {
    expect(formatTemperature(0, 'F')).toBe('+32\u00b0F');
    expect(formatTemperature(100, 'F')).toBe('+212\u00b0F');
    expect(formatTemperature(22, 'F')).toBe('+72\u00b0F');
    expect(formatTemperature(-30, 'F')).toBe('-22\u00b0F');
  });
});

describe('formatWeatherReadout', () => {
  it('composes "+temp°unit · condition"', () => {
    expect(formatWeatherReadout({ temperatureC: 25, weatherCode: 2 }, 'F')).toBe('+77\u00b0F \u00b7 Partly cloudy');
    expect(formatWeatherReadout({ temperatureC: 0, weatherCode: 0 }, 'C')).toBe('0\u00b0C \u00b7 Clear');
  });
});

describe('mountWeather — gating', () => {
  it('does not append a node when weather.enabled is false', async () => {
    installChrome();
    const slot = document.getElementById('slot');
    mountWeather(slot, DISABLED);
    await flush();
    expect(slot.querySelector('.weather-widget')).toBeNull();
  });

  it('does not append a node when latitude is null', async () => {
    installChrome();
    const slot = document.getElementById('slot');
    mountWeather(slot, { ...CONFIGURED, latitude: null });
    await flush();
    expect(slot.querySelector('.weather-widget')).toBeNull();
  });

  it('appends a button when enabled with latitude/longitude set', async () => {
    installChrome();
    const slot = document.getElementById('slot');
    mountWeather(slot, CONFIGURED);
    await flush();
    const btn = slot.querySelector('.weather-widget');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Weather');
  });
});

describe('mountWeather — rendering', () => {
  it('renders "+temp°unit · condition" from cached data on mount', async () => {
    installChrome(FRESH_DATA({ temperatureC: 22, weatherCode: 0 }));
    const slot = document.getElementById('slot');
    mountWeather(slot, { ...CONFIGURED, unit: 'C' });
    await flush();
    await flush();
    const readout = slot.querySelector('.weather-widget-readout');
    expect(readout.textContent).toBe('+22\u00b0C \u00b7 Clear');
  });

  it('shows em-dash placeholder until first data arrives', async () => {
    installChrome();
    const slot = document.getElementById('slot');
    mountWeather(slot, CONFIGURED);
    await flush();
    const readout = slot.querySelector('.weather-widget-readout');
    expect(readout.textContent).toBe('\u2014');
  });
});

describe('mountWeather — refresh triggers', () => {
  it('requests a refresh when cached data is stale on mount', async () => {
    const { sendMessage } = installChrome(STALE_DATA());
    mountWeather(document.getElementById('slot'), CONFIGURED);
    await flush();
    await flush();
    expect(sendMessage).toHaveBeenCalled();
    const msg = sendMessage.mock.calls[0][0];
    expect(msg.type).toBe('refresh-weather');
  });

  it('does NOT request a refresh when cached data is fresh', async () => {
    const { sendMessage } = installChrome(FRESH_DATA());
    mountWeather(document.getElementById('slot'), CONFIGURED);
    await flush();
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('requests a refresh when applySettings changes lat/lon', async () => {
    const { sendMessage } = installChrome(FRESH_DATA());
    const handle = mountWeather(document.getElementById('slot'), CONFIGURED);
    await flush();
    await flush();
    sendMessage.mockClear();

    handle.applySettings({ ...CONFIGURED, latitude: 40.71, longitude: -74.01, locationLabel: 'NYC' });
    expect(sendMessage).toHaveBeenCalled();
    const msg = sendMessage.mock.calls[0][0];
    expect(msg.force).toBe(true);
  });

  it('does NOT re-fetch when only the unit changes (C↔F is display-side)', async () => {
    const { sendMessage } = installChrome(FRESH_DATA({ temperatureC: 22, weatherCode: 0 }));
    const slot = document.getElementById('slot');
    const handle = mountWeather(slot, { ...CONFIGURED, unit: 'C' });
    await flush();
    await flush();
    sendMessage.mockClear();

    handle.applySettings({ ...CONFIGURED, unit: 'F' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(slot.querySelector('.weather-widget-readout').textContent).toBe('+72\u00b0F \u00b7 Clear');
  });

  it('requests a refresh when applySettings flips enabled from false to true', async () => {
    const { sendMessage } = installChrome(FRESH_DATA());
    const slot = document.getElementById('slot');
    const handle = mountWeather(slot, { ...CONFIGURED, enabled: false });
    await flush();
    await flush();

    handle.applySettings(CONFIGURED);
    expect(sendMessage).toHaveBeenCalled();
    expect(slot.querySelector('.weather-widget')).not.toBeNull();
  });
});

describe('mountWeather — storage sync', () => {
  it('updates the DOM when storage.onChanged fires for WEATHER_STORAGE_KEY', async () => {
    const env = installChrome(FRESH_DATA({ temperatureC: 5, weatherCode: 0 }));
    const slot = document.getElementById('slot');
    mountWeather(slot, CONFIGURED);
    await flush();
    await flush();
    expect(slot.querySelector('.weather-widget-readout').textContent).toBe('+5\u00b0C \u00b7 Clear');

    env.fireChange(WEATHER_STORAGE_KEY, FRESH_DATA({ temperatureC: 18, weatherCode: 61 }));
    await flush();
    await flush();

    expect(slot.querySelector('.weather-widget-readout').textContent).toBe('+18\u00b0C \u00b7 Rain');
  });

  it('ignores storage changes for unrelated keys', async () => {
    const env = installChrome(FRESH_DATA({ temperatureC: 5, weatherCode: 0 }));
    const slot = document.getElementById('slot');
    mountWeather(slot, CONFIGURED);
    await flush();
    await flush();

    env.fireChange('other:key', { x: 1 });
    await flush();
    await flush();

    expect(slot.querySelector('.weather-widget-readout').textContent).toBe('+5\u00b0C \u00b7 Clear');
  });
});

describe('mountWeather — lifecycle', () => {
  it('destroy() removes the widget and detaches the storage listener', async () => {
    installChrome(FRESH_DATA());
    const slot = document.getElementById('slot');
    const handle = mountWeather(slot, CONFIGURED);
    await flush();
    await flush();
    expect(slot.querySelector('.weather-widget')).not.toBeNull();

    handle.destroy();
    expect(slot.querySelector('.weather-widget')).toBeNull();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
  });

  it('applySettings disabling removes the mounted node', async () => {
    installChrome(FRESH_DATA());
    const slot = document.getElementById('slot');
    const handle = mountWeather(slot, CONFIGURED);
    await flush();
    await flush();
    expect(slot.querySelector('.weather-widget')).not.toBeNull();

    handle.applySettings(DISABLED);
    expect(slot.querySelector('.weather-widget')).toBeNull();
  });
});
