/**
 * background.js — Service Worker
 *
 * Sole responsibility (v2.5.0+): poll GitHub every 48h for the latest
 * release and write the result to chrome.storage.local so the dashboard
 * can render the update banner. chrome.alarms is used instead of
 * setInterval because service workers can be suspended at any time.
 *
 * The domain-count action badge shipped in v2.3.0 was retired in
 * v2.5.0: the dashboard became per-window, and a global hostname count
 * on the extension icon no longer matched what any single dashboard
 * showed.
 */

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
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM) void checkForUpdate();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkForUpdate };
}
