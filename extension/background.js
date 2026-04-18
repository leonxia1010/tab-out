/**
 * background.js — Service Worker
 *
 * Responsibilities (v2.6.0+):
 *   1. Update checker — poll GitHub releases every 48h, write banner
 *      state to chrome.storage.local so the dashboard can render it.
 *   2. Weather refresher — poll Open-Meteo every 30min (when enabled)
 *      and on demand via runtime.sendMessage, write current temperature
 *      + WMO code to chrome.storage.local.
 *   3. Countdown completer — when a countdown alarm fires, clear the
 *      persisted state and raise a chrome.notifications entry so the
 *      user sees the timer finished even outside the dashboard tab.
 *
 * chrome.alarms is used instead of setInterval because service workers
 * can be suspended at any time; alarms survive the suspension.
 *
 * The domain-count action badge shipped in v2.3.0 was retired in
 * v2.5.0: the dashboard became per-window, and a global hostname count
 * on the extension icon no longer matched what any single dashboard
 * showed.
 */

// ─── Shared constants ──────────────────────────────────────────────────────

const SETTINGS_KEY = 'tabout:settings';

// ─── Update checker ────────────────────────────────────────────────────────

const UPDATE_ALARM = 'tabout-update-check';
const UPDATE_STORAGE_KEY = 'tabout:updateStatus';
// Tracks releases, not main commits — README/AGENTS/index.ts all route users
// to the releases page, so anything else would false-positive the banner on
// every doc push.
const GITHUB_RELEASE_URL = 'https://api.github.com/repos/leonxia1010/tab-out/releases/latest';
const UPDATE_CHECK_PERIOD_MIN = 60 * 48; // 48h — once-per-user rate is ~0.02 req/h, nowhere near GitHub's 60 req/h/IP anon limit.

async function checkForUpdate() {
  try {
    const res = await fetch(GITHUB_RELEASE_URL);
    // 404 == repo has no release yet (pre-v2.0.0). Treat the same as a
    // network failure: no-op, retry next alarm.
    if (!res.ok) return;
    const body = await res.json();
    const latestTag = body && body.tag_name;
    if (!latestTag) return;

    const stored = await chrome.storage.local.get(UPDATE_STORAGE_KEY);
    const state = stored[UPDATE_STORAGE_KEY] || {};
    // First run after install: seed currentTag = latestTag so we don't flash
    // an update banner on day one.
    const currentTag = state.currentTag || latestTag;
    const updateAvailable = currentTag !== latestTag;

    await chrome.storage.local.set({
      [UPDATE_STORAGE_KEY]: {
        updateAvailable,
        latestTag,
        currentTag,
        checkedAt: new Date().toISOString(),
        dismissedTag: state.dismissedTag || null,
      },
    });
  } catch {
    // Network / parse failure — no-op, the alarm will fire again in 48h.
  }
}

// ─── Weather refresher ─────────────────────────────────────────────────────

const WEATHER_ALARM = 'tabout-weather-refresh';
const WEATHER_STORAGE_KEY = 'tabout:weatherData';
const WEATHER_REFRESH_PERIOD_MIN = 30;
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
// ipapi.co: free tier is 1k req/day without an API key, well above
// anything this extension will ever issue (one call per install when
// no manual location exists yet).
const IP_GEO_URL = 'https://ipapi.co/json/';

async function tryIpGeolocate() {
  try {
    const res = await fetch(IP_GEO_URL);
    if (!res.ok) return null;
    const body = await res.json();
    // ipapi.co 429 / quota rejections return 200 with { error: true,
    // reason: 'RateLimited' }, so the !res.ok guard alone isn't enough.
    if (!body || body.error) return null;
    const latitude = typeof body.latitude === 'number' ? body.latitude : null;
    const longitude = typeof body.longitude === 'number' ? body.longitude : null;
    if (latitude == null || longitude == null) return null;
    const parts = [];
    if (body.city) parts.push(body.city);
    if (body.region) parts.push(body.region);
    if (body.country_code) parts.push(body.country_code);
    const locationLabel = parts.length > 0 ? parts.join(', ') : 'Your location';
    return { latitude, longitude, locationLabel };
  } catch {
    return null;
  }
}

// Writes IP-derived lat/lon into tabout:settings when the user hasn't
// picked a location yet. Manual picks always win — this only fills in
// null-valued fields so a user who typed "Tokyo" never sees their
// setting overwritten by an IP-guess. Returns the (possibly unchanged)
// settings so the caller can use them without a second read.
async function ensureLocationConfigured(settings) {
  const w = settings && settings.weather;
  if (!w || !w.enabled) return settings;
  if (typeof w.latitude === 'number' && typeof w.longitude === 'number') return settings;
  const geo = await tryIpGeolocate();
  if (!geo) return settings;
  const next = {
    ...settings,
    weather: {
      ...w,
      latitude: geo.latitude,
      longitude: geo.longitude,
      locationLabel: w.locationLabel || geo.locationLabel,
    },
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function fetchWeatherNow() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    let settings = stored[SETTINGS_KEY];
    if (!settings) return;
    // Opportunistic IP-geo fallback: a first-run user with
    // weather.enabled=true but no manual location picks gets a
    // reasonable starting point so the widget hydrates without a
    // trip through Settings. Subsequent calls are a cheap field
    // check — no extra network once a location is set.
    settings = await ensureLocationConfigured(settings);
    const w = settings && settings.weather;
    if (!w || !w.enabled) return;
    if (typeof w.latitude !== 'number' || typeof w.longitude !== 'number') return;

    const url = `${OPEN_METEO_URL}?latitude=${encodeURIComponent(w.latitude)}&longitude=${encodeURIComponent(w.longitude)}&current=temperature_2m,weather_code`;
    const res = await fetch(url);
    if (!res.ok) return;
    const body = await res.json();
    const current = body && body.current;
    if (!current) return;
    const temperatureC = current.temperature_2m;
    const weatherCode = current.weather_code;
    if (typeof temperatureC !== 'number' || typeof weatherCode !== 'number') return;

    await chrome.storage.local.set({
      [WEATHER_STORAGE_KEY]: {
        latitude: w.latitude,
        longitude: w.longitude,
        temperatureC,
        weatherCode,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch {
    // Network / parse failure — alarm will retry in WEATHER_REFRESH_PERIOD_MIN.
  }
}

// ─── Countdown completer ───────────────────────────────────────────────────

const COUNTDOWN_ALARM = 'tabout-countdown-complete';
const COUNTDOWN_STORAGE_KEY = 'tabout:countdownState';
// Browser-restart case: the alarm API can fire a late alarm whose
// `endsAt` is hours or days in the past. Firing a "your timer is done"
// notification in that window would feel like spam, so we silently
// drop state for anything older than 24h.
const COUNTDOWN_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const COUNTDOWN_NOTIFICATION_ID = 'tabout-countdown-done';

async function handleCountdownComplete() {
  try {
    const stored = await chrome.storage.local.get(COUNTDOWN_STORAGE_KEY);
    const state = stored[COUNTDOWN_STORAGE_KEY];
    if (!state) return; // user reset before alarm fired
    await chrome.storage.local.remove(COUNTDOWN_STORAGE_KEY);

    const endsAt = typeof state.endsAt === 'number' ? state.endsAt : 0;
    if (Date.now() - endsAt > COUNTDOWN_STALE_THRESHOLD_MS) return;

    const durationMin = Math.max(1, Math.round((state.durationMs || 0) / 60_000));
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create(COUNTDOWN_NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: 'Countdown complete',
        message: `Your ${durationMin}-minute timer finished.`,
        requireInteraction: false,
      });
    }
  } catch {
    // storage or notifications unavailable — silent degrade.
  }
}

// ─── Service-worker wiring ─────────────────────────────────────────────────
// Guarded so importing this file from vitest (where chrome is mocked but
// listener registration is irrelevant) does not crash.

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  // 60s initial delay avoids racing the install; then period kicks in.
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(UPDATE_ALARM, {
      when: Date.now() + 60_000,
      periodInMinutes: UPDATE_CHECK_PERIOD_MIN,
    });
    chrome.alarms.create(WEATHER_ALARM, {
      when: Date.now() + 15_000,
      periodInMinutes: WEATHER_REFRESH_PERIOD_MIN,
    });
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM) void checkForUpdate();
    else if (alarm.name === WEATHER_ALARM) void fetchWeatherNow();
    else if (alarm.name === COUNTDOWN_ALARM) void handleCountdownComplete();
  });

  // Dashboard widget → SW refresh trigger. `force` is informational; the
  // handler itself does one fetch regardless because the rate (30-min
  // polling + occasional manual refresh) is well under the Open-Meteo
  // anonymous rate limit (no hard cap, "reasonable use" on their docs).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'refresh-weather') {
      void fetchWeatherNow().then(() => sendResponse({ ok: true }));
      return true; // keep port open for async sendResponse
    }
    return false;
  });

  // Respond to settings changes: a user flipping weather.enabled on or
  // moving to a new location shouldn't have to wait up to 30 min for
  // the next alarm. Fires one fetch on the transition edges only.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    const prev = changes[SETTINGS_KEY].oldValue && changes[SETTINGS_KEY].oldValue.weather;
    const next = changes[SETTINGS_KEY].newValue && changes[SETTINGS_KEY].newValue.weather;
    if (!next) return;
    const locChanged = !prev || prev.latitude !== next.latitude || prev.longitude !== next.longitude;
    const enabledEdge = (!prev || !prev.enabled) && next.enabled;
    if (next.enabled && (locChanged || enabledEdge)) {
      void fetchWeatherNow();
    }
  });

  // Tapping the notification just dismisses it — the dashboard already
  // routes the user's attention back on its own when they switch tabs.
  if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener((notifId) => {
      if (notifId === COUNTDOWN_NOTIFICATION_ID) {
        chrome.notifications.clear(notifId);
      }
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    checkForUpdate,
    fetchWeatherNow,
    handleCountdownComplete,
    tryIpGeolocate,
    ensureLocationConfigured,
  };
}
