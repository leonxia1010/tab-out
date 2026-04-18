// tests/extension/background.test.js
//
// v2.6.0 added two new service-worker responsibilities:
//   - fetchWeatherNow: Open-Meteo polling gated on settings.weather
//   - handleCountdownComplete: post-alarm notification + state cleanup
// Plus the v2.5.0 update-check path (unchanged behaviour).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let checkForUpdate, fetchWeatherNow, handleCountdownComplete;

function installChrome() {
  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getURL: vi.fn((p) => `chrome-extension://test/${p}`),
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
  ({ checkForUpdate, fetchWeatherNow, handleCountdownComplete } =
    await import('../../extension/background.js'));
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

  it('writes updateAvailable:true when fetched tag differs from stored currentTag', async () => {
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { currentTag: 'v2.0.0', dismissedTag: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.1' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: true,
        latestTag: 'v2.0.1',
        currentTag: 'v2.0.0',
      }),
    });
  });

  it('writes updateAvailable:false when fetched tag matches stored currentTag', async () => {
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { currentTag: 'v2.0.0', dismissedTag: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestTag: 'v2.0.0',
        currentTag: 'v2.0.0',
      }),
    });
  });

  it('seeds currentTag = latestTag on first run so the banner does not flash on install', async () => {
    storageGet.mockResolvedValue({});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestTag: 'v2.0.0',
        currentTag: 'v2.0.0',
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

  it('is a no-op when latitude is missing (not yet configured)', async () => {
    storageGet.mockResolvedValue({
      'tabout:settings': { weather: { enabled: true, latitude: null, longitude: null, unit: 'C' } },
    });
    await fetchWeatherNow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
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
