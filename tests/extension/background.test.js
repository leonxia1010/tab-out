// tests/extension/background.test.js
//
// v2.6.0 added two new service-worker responsibilities:
//   - fetchWeatherNow: Open-Meteo polling gated on settings.weather
//   - handleCountdownComplete: post-alarm notification + state cleanup
// Plus the v2.5.0 update-check path (unchanged behaviour).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let checkForUpdate, fetchWeatherNow, handleCountdownComplete, tryIpGeolocate, ensureLocationConfigured, isVersionNewer;

function installChrome() {
  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getURL: vi.fn((p) => `chrome-extension://test/${p}`),
      getManifest: vi.fn(() => ({ version: '2.6.2' })),
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    notifications: {
      create: vi.fn(),
      clear: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
  });
}

beforeEach(async () => {
  // Stub chrome BEFORE import so the SW wiring at module bottom finds it.
  installChrome();
  vi.resetModules();
  ({
    checkForUpdate,
    fetchWeatherNow,
    handleCountdownComplete,
    tryIpGeolocate,
    ensureLocationConfigured,
    isVersionNewer,
  } = await import('../../extension/background.js'));
  await Promise.resolve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkForUpdate', () => {
  let fetchMock, storageGet, storageSet;

  beforeEach(() => {
    storageGet = vi.fn(async () => ({}));
    storageSet = vi.fn(async () => {});
    // eslint-disable-next-line no-undef
    chrome.storage.local.get = storageGet;
    // eslint-disable-next-line no-undef
    chrome.storage.local.set = storageSet;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('writes updateAvailable:true when GitHub latest is newer than the installed manifest version', async () => {
    // Default mock: manifest.version = '2.6.2' → installedTag = 'v2.6.2'.
    chrome.runtime.getManifest.mockReturnValue({ version: '2.6.2' });
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { dismissedTag: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.7.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: true,
        latestTag: 'v2.7.0',
        currentTag: 'v2.6.2',
      }),
    });
  });

  it('writes updateAvailable:false when installed version matches GitHub latest', async () => {
    chrome.runtime.getManifest.mockReturnValue({ version: '2.6.0' });
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { dismissedTag: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.6.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestTag: 'v2.6.0',
        currentTag: 'v2.6.0',
      }),
    });
  });

  it('writes updateAvailable:false when the installed version is AHEAD of the latest GitHub release', async () => {
    // Regression guard: before the v2.6.2 rewrite, a dev build ahead
    // of the public release (currentTag frozen at first-check snapshot)
    // would show a perpetual "update available" banner. Now the
    // manifest-driven currentTag makes the compare honest.
    chrome.runtime.getManifest.mockReturnValue({ version: '2.6.2' });
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { dismissedTag: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.6.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestTag: 'v2.6.0',
        currentTag: 'v2.6.2',
      }),
    });
  });

  it('uses installed manifest version on first run so currentTag reflects reality from day 1', async () => {
    chrome.runtime.getManifest.mockReturnValue({ version: '2.6.0' });
    storageGet.mockResolvedValue({});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.6.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestTag: 'v2.6.0',
        currentTag: 'v2.6.0',
      }),
    });
  });

  it('does not write storage and does not throw when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(checkForUpdate()).resolves.toBeUndefined();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('does not write storage when response is 404 (no release published yet)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await checkForUpdate();
    expect(storageSet).not.toHaveBeenCalled();
  });
});

describe('isVersionNewer', () => {
  it('returns true when the left version is strictly newer', () => {
    expect(isVersionNewer('v2.7.0', 'v2.6.2')).toBe(true);
    expect(isVersionNewer('v2.6.2', 'v2.6.1')).toBe(true);
    expect(isVersionNewer('v3.0.0', 'v2.99.99')).toBe(true);
  });

  it('returns false for equal versions', () => {
    expect(isVersionNewer('v2.6.2', 'v2.6.2')).toBe(false);
  });

  it('returns false when the left version is older', () => {
    expect(isVersionNewer('v2.6.0', 'v2.6.2')).toBe(false);
    expect(isVersionNewer('v2.6.0', 'v3.0.0')).toBe(false);
  });

  it('handles tags with or without the leading v', () => {
    expect(isVersionNewer('2.6.2', 'v2.6.1')).toBe(true);
    expect(isVersionNewer('v2.6.2', '2.6.1')).toBe(true);
  });

  it('returns false when either input is missing', () => {
    expect(isVersionNewer(null, 'v2.6.0')).toBe(false);
    expect(isVersionNewer('v2.6.0', null)).toBe(false);
    expect(isVersionNewer('', 'v2.6.0')).toBe(false);
  });
});

// ── Weather refresher (v2.6.0) ──────────────────────────────────────────────
describe('fetchWeatherNow', () => {
  let fetchMock, storageGet, storageSet;

  beforeEach(() => {
    storageGet = vi.fn(async () => ({}));
    storageSet = vi.fn(async () => {});
    // eslint-disable-next-line no-undef
    chrome.storage.local.get = storageGet;
    // eslint-disable-next-line no-undef
    chrome.storage.local.set = storageSet;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('writes tabout:weatherData when API returns current payload', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': {
        weather: {
          enabled: true,
          latitude: 42.36,
          longitude: -71.06,
          unit: 'C',
          locationLabel: 'Boston, MA, US',
        },
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ current: { temperature_2m: 11.5, weather_code: 3 } }),
    });

    await fetchWeatherNow();

    expect(storageSet).toHaveBeenCalledWith({
      'tabout:weatherData': expect.objectContaining({
        latitude: 42.36,
        longitude: -71.06,
        temperatureC: 11.5,
        weatherCode: 3,
      }),
    });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toMatch(/api\.open-meteo\.com/);
    expect(url).toMatch(/latitude=42\.36/);
    expect(url).toMatch(/longitude=-71\.06/);
  });

  it('seeds IP geo even when tabout:settings has not been written yet (fresh install)', async () => {
    // Storage returns `{}` — the key was never written because the
    // user hasn't touched Settings. This is the exact shape a brand-
    // new install shows when the weather alarm fires 15s after install.
    storageGet.mockResolvedValue({});
    fetchMock
      .mockResolvedValueOnce({
        // ipwho.is (primary provider)
        ok: true,
        json: async () => ({ success: true, latitude: 40.71, longitude: -74.0, city: 'New York', country_code: 'US' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ current: { temperature_2m: 15, weather_code: 2 } }),
      });

    await fetchWeatherNow();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toMatch(/ipwho\.is/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/api\.open-meteo\.com/);
    const settingsWrite = storageSet.mock.calls.find((c) => 'tabout:settings' in c[0]);
    expect(settingsWrite[0]['tabout:settings'].weather.latitude).toBe(40.71);
  });

  it('seeds IP geo on pre-v2.6 upgrade (settings exists but has no weather key)', async () => {
    // Legacy shape from v2.5.x and earlier: the settings object is
    // present but predates the weather feature, so `weather` is
    // undefined. ensureLocationConfigured used to bail on `!w`;
    // fetchWeatherNow now backfills defaults so the IP seed still
    // runs for an upgraded user who never touches Settings.
    storageGet.mockResolvedValue({
      'tabout:settings': { theme: 'dark', clock: { format: '24h' } },
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, latitude: -33.87, longitude: 151.21, city: 'Sydney', country_code: 'AU' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ current: { temperature_2m: 18, weather_code: 0 } }),
      });

    await fetchWeatherNow();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toMatch(/ipwho\.is/);
    const settingsWrite = storageSet.mock.calls.find((c) => 'tabout:settings' in c[0]);
    expect(settingsWrite[0]['tabout:settings'].weather.latitude).toBe(-33.87);
    // Pre-existing theme/clock preserved through the synthesis.
    expect(settingsWrite[0]['tabout:settings'].theme).toBe('dark');
  });

  it('is a no-op when weather.enabled is false', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': {
        weather: { enabled: false, latitude: 42, longitude: -71, unit: 'C' },
      },
    });
    await fetchWeatherNow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('auto-configures location via IP geo when lat/lon are null, then fetches weather', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': { weather: { enabled: true, latitude: null, longitude: null, locationLabel: null, unit: 'C' } },
    });
    fetchMock
      .mockResolvedValueOnce({
        // ipwho.is first (primary provider)
        ok: true,
        json: async () => ({ success: true, latitude: 5, longitude: 10, city: 'Anywhere', country_code: 'US' }),
      })
      .mockResolvedValueOnce({
        // open-meteo second
        ok: true,
        json: async () => ({ current: { temperature_2m: 20, weather_code: 1 } }),
      });

    await fetchWeatherNow();

    // Two network calls: ipwho.is, then open-meteo.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toMatch(/ipwho\.is/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/api\.open-meteo\.com/);

    // Two storage writes: settings update (with new lat/lon), then weather data.
    const settingsWrite = storageSet.mock.calls.find((c) => 'tabout:settings' in c[0]);
    expect(settingsWrite[0]['tabout:settings'].weather.latitude).toBe(5);
    const weatherWrite = storageSet.mock.calls.find((c) => 'tabout:weatherData' in c[0]);
    expect(weatherWrite[0]['tabout:weatherData']).toEqual(
      expect.objectContaining({ temperatureC: 20, weatherCode: 1 }),
    );
  });

  it('is a no-op when lat/lon are null and every IP-geo provider fails', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': { weather: { enabled: true, latitude: null, longitude: null, unit: 'C' } },
    });
    // Same 500 response for all three providers; open-meteo never runs.
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await fetchWeatherNow();
    // Three provider attempts (ipwho.is, geojs.io, ipapi.co), then stops.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const weatherWrite = storageSet.mock.calls.find((c) => 'tabout:weatherData' in c[0]);
    expect(weatherWrite).toBeUndefined();
  });

  it('swallows network errors without writing storage', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': { weather: { enabled: true, latitude: 1, longitude: 1, unit: 'C' } },
    });
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(fetchWeatherNow()).resolves.toBeUndefined();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('skips storage write when API response has no `current` block', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': { weather: { enabled: true, latitude: 1, longitude: 1, unit: 'C' } },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await fetchWeatherNow();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('skips storage write when temperature_2m is not a number', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': { weather: { enabled: true, latitude: 1, longitude: 1, unit: 'C' } },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ current: { temperature_2m: 'warm', weather_code: 0 } }),
    });
    await fetchWeatherNow();
    expect(storageSet).not.toHaveBeenCalled();
  });
});

// ── IP geolocation fallback (v2.6.0) ────────────────────────────────────────
describe('tryIpGeolocate', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns lat/lon/label from a successful ipwho.is response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        latitude: 42.36,
        longitude: -71.06,
        city: 'Boston',
        region: 'Massachusetts',
        country_code: 'US',
      }),
    });
    const geo = await tryIpGeolocate();
    expect(geo).toEqual({
      latitude: 42.36,
      longitude: -71.06,
      locationLabel: 'Boston, Massachusetts, US',
    });
  });

  it('falls through ipwho.is → geojs.io when the primary blocks the request', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        // geojs returns strings for coords; parser must cast.
        json: async () => ({ latitude: '35.68', longitude: '139.69', city: 'Tokyo', country_code: 'JP' }),
      });
    const geo = await tryIpGeolocate();
    expect(geo).toEqual({
      latitude: 35.68,
      longitude: 139.69,
      locationLabel: 'Tokyo, JP',
    });
    expect(fetchMock.mock.calls[0][0]).toMatch(/ipwho\.is/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/geojs\.io/);
  });

  it('returns null on network failure across all providers', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await tryIpGeolocate()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null when latitude is missing or non-numeric in every provider', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, latitude: 'nope', longitude: 0, city: 'X' }),
    });
    expect(await tryIpGeolocate()).toBeNull();
  });

  it('falls back to "Your location" when city/region/country are absent', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, latitude: 1, longitude: 2 }),
    });
    const geo = await tryIpGeolocate();
    expect(geo.locationLabel).toBe('Your location');
  });
});

describe('ensureLocationConfigured', () => {
  let fetchMock, storageSet;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    storageSet = vi.fn(async () => {});
    // eslint-disable-next-line no-undef
    chrome.storage.local.set = storageSet;
  });

  it('fills in missing lat/lon from IP geo and writes the result back', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ latitude: 1.1, longitude: 2.2, city: 'A' }),
    });

    const next = await ensureLocationConfigured({
      weather: { enabled: true, latitude: null, longitude: null, locationLabel: null, unit: 'C' },
    });
    expect(next.weather.latitude).toBe(1.1);
    expect(next.weather.longitude).toBe(2.2);
    expect(next.weather.locationLabel).toBe('A');
    expect(storageSet).toHaveBeenCalled();
  });

  it('does NOT overwrite a manually-picked location', async () => {
    const orig = {
      weather: { enabled: true, latitude: 35, longitude: 139, locationLabel: 'Tokyo', unit: 'C' },
    };
    const next = await ensureLocationConfigured(orig);
    expect(next).toBe(orig); // same reference, no rewrite
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('is a no-op when weather is disabled', async () => {
    const orig = {
      weather: { enabled: false, latitude: null, longitude: null, unit: 'C' },
    };
    const next = await ensureLocationConfigured(orig);
    expect(next).toBe(orig);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves an existing locationLabel even when IP geo has a different city', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ latitude: 1, longitude: 2, city: 'IpCity' }),
    });
    const next = await ensureLocationConfigured({
      weather: { enabled: true, latitude: null, longitude: null, locationLabel: 'Saved label', unit: 'C' },
    });
    expect(next.weather.locationLabel).toBe('Saved label');
  });
});

// ── Countdown completer (v2.6.0) ────────────────────────────────────────────
describe('handleCountdownComplete', () => {
  let storageGet, storageSet, storageRemove, notificationsCreate;

  beforeEach(() => {
    storageGet = vi.fn(async () => ({}));
    storageSet = vi.fn(async () => {});
    storageRemove = vi.fn(async () => {});
    notificationsCreate = vi.fn();
    // eslint-disable-next-line no-undef
    chrome.storage.local.get = storageGet;
    // eslint-disable-next-line no-undef
    chrome.storage.local.set = storageSet;
    // eslint-disable-next-line no-undef
    chrome.storage.local.remove = storageRemove;
    // eslint-disable-next-line no-undef
    chrome.notifications.create = notificationsCreate;
  });

  it('clears state and posts a notification when fresh state exists', async () => {
    const now = Date.now();
    storageGet.mockResolvedValue({
      'tabout:countdownState': { endsAt: now, durationMs: 25 * 60_000, paused: false },
    });

    await handleCountdownComplete();

    expect(storageRemove).toHaveBeenCalledWith('tabout:countdownState');
    expect(notificationsCreate).toHaveBeenCalledTimes(1);
    const [id, opts] = notificationsCreate.mock.calls[0];
    expect(id).toBe('tabout-countdown-done');
    expect(opts.type).toBe('basic');
    expect(opts.title).toBe('Countdown complete');
    expect(opts.message).toMatch(/25-minute/);
  });

  it('is a no-op when state is already cleared', async () => {
    storageGet.mockResolvedValue({});
    await handleCountdownComplete();
    expect(storageRemove).not.toHaveBeenCalled();
    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('suppresses notification when state is older than 24h (browser restart)', async () => {
    const endsAt = Date.now() - 25 * 60 * 60 * 1000;
    storageGet.mockResolvedValue({
      'tabout:countdownState': { endsAt, durationMs: 5 * 60_000, paused: false },
    });

    await handleCountdownComplete();

    // State still gets removed (don't leak) but notification is suppressed.
    expect(storageRemove).toHaveBeenCalledWith('tabout:countdownState');
    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('rounds up sub-minute durations to 1 in the notification copy', async () => {
    storageGet.mockResolvedValue({
      'tabout:countdownState': { endsAt: Date.now(), durationMs: 30_000, paused: false },
    });

    await handleCountdownComplete();

    const opts = notificationsCreate.mock.calls[0][1];
    expect(opts.message).toMatch(/1-minute/);
  });
});
