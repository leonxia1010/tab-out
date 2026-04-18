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
  formatTemperature,
  iconSvgForWeatherCode,
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

describe('iconSvgForWeatherCode', () => {
  it('maps clear (0) to sun', () => {
    expect(iconSvgForWeatherCode(0)).toContain('data-icon="sun"');
  });
  it('maps partly-cloudy (1-3) to partly-cloudy', () => {
    for (const code of [1, 2, 3]) {
      expect(iconSvgForWeatherCode(code)).toContain('data-icon="partly-cloudy"');
    }
  });
  it('maps fog (45, 48) to fog', () => {
    expect(iconSvgForWeatherCode(45)).toContain('data-icon="fog"');
    expect(iconSvgForWeatherCode(48)).toContain('data-icon="fog"');
  });
  it('maps drizzle/rain (51-67) to rain', () => {
    for (const code of [51, 55, 61, 65, 67]) {
      expect(iconSvgForWeatherCode(code)).toContain('data-icon="rain"');
    }
  });
  it('maps snow (71-77, 85-86) to snow', () => {
    for (const code of [71, 75, 77, 85, 86]) {
      expect(iconSvgForWeatherCode(code)).toContain('data-icon="snow"');
    }
  });
  it('maps showers (80-82) to shower', () => {
    for (const code of [80, 81, 82]) {
      expect(iconSvgForWeatherCode(code)).toContain('data-icon="shower"');
    }
  });
  it('maps thunderstorm (95-99) to storm', () => {
    for (const code of [95, 96, 99]) {
      expect(iconSvgForWeatherCode(code)).toContain('data-icon="storm"');
    }
  });
  it('defaults unrecognized codes to cloud', () => {
    expect(iconSvgForWeatherCode(999)).toContain('data-icon="cloud"');
  });
});

describe('formatTemperature', () => {
  it('rounds Celsius to the nearest degree with a degree sign', () => {
    expect(formatTemperature(22.3, 'C')).toBe('22\u00b0');
    expect(formatTemperature(22.6, 'C')).toBe('23\u00b0');
  });
  it('converts Celsius to Fahrenheit for the F unit', () => {
    expect(formatTemperature(0, 'F')).toBe('32\u00b0');
    expect(formatTemperature(100, 'F')).toBe('212\u00b0');
    expect(formatTemperature(22, 'F')).toBe('72\u00b0');
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
  it('renders cached data on mount', async () => {
    installChrome(FRESH_DATA({ temperatureC: 22, weatherCode: 0 }));
    const slot = document.getElementById('slot');
    mountWeather(slot, { ...CONFIGURED, unit: 'C' });
    await flush();
    await flush();
    const temp = slot.querySelector('.weather-widget-temp');
    expect(temp.textContent).toBe('22\u00b0');
    const icon = slot.querySelector('[data-icon]');
    expect(icon.dataset.icon).toBe('sun');
  });

  it('shows em-dash placeholder until first data arrives', async () => {
    installChrome();
    const slot = document.getElementById('slot');
    mountWeather(slot, CONFIGURED);
    await flush();
    const temp = slot.querySelector('.weather-widget-temp');
    expect(temp.textContent).toBe('\u2014');
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
    const { sendMessage } = installChrome(FRESH_DATA({ temperatureC: 22 }));
    const slot = document.getElementById('slot');
    const handle = mountWeather(slot, { ...CONFIGURED, unit: 'C' });
    await flush();
    await flush();
    sendMessage.mockClear();

    handle.applySettings({ ...CONFIGURED, unit: 'F' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(slot.querySelector('.weather-widget-temp').textContent).toBe('72\u00b0');
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
    expect(slot.querySelector('.weather-widget-temp').textContent).toBe('5\u00b0');

    env.fireChange(WEATHER_STORAGE_KEY, FRESH_DATA({ temperatureC: 18, weatherCode: 61 }));
    await flush();
    await flush();

    expect(slot.querySelector('.weather-widget-temp').textContent).toBe('18\u00b0');
    expect(slot.querySelector('[data-icon]').dataset.icon).toBe('rain');
  });

  it('ignores storage changes for unrelated keys', async () => {
    const env = installChrome(FRESH_DATA({ temperatureC: 5 }));
    const slot = document.getElementById('slot');
    mountWeather(slot, CONFIGURED);
    await flush();
    await flush();

    env.fireChange('other:key', { x: 1 });
    await flush();
    await flush();

    expect(slot.querySelector('.weather-widget-temp').textContent).toBe('5\u00b0');
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
