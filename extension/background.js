/**
 * background.js — Service Worker
 *
 * Two independent concerns live here:
 *   1. Domain-count badge (phase 3 PR M). The badge color/text reflects how
 *      many unique http(s) hostnames are currently open.
 *   2. Update checker (phase 4 PR-B). Polls GitHub every 48h for new commits
 *      on main and writes the result to chrome.storage.local so the dashboard
 *      can render the update banner. chrome.alarms is used instead of
 *      setInterval because service workers can be suspended at any time.
 *
 * Badge color bands:
 *   1-3 domains → green  (#3d7a4a, focused)
 *   4-6 domains → amber  (#b8892e, busy)
 *   7+ domains  → red    (#b35a5a, overloaded)
 */

// ─── Badge ─────────────────────────────────────────────────────────────────

function getDomainCount(tabs) {
  const domains = new Set();
  for (const t of tabs) {
    const url = t && t.url;
    if (!url || !/^https?:\/\//.test(url)) continue;
    try { domains.add(new URL(url).hostname); }
    catch { /* malformed URL — skip */ }
  }
  return domains.size;
}

function colorForCount(count) {
  if (count <= 3) return '#3d7a4a';
  if (count <= 6) return '#b8892e';
  return '#b35a5a';
}

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = getDomainCount(tabs);
    if (count === 0) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: colorForCount(count) });
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Update checker ────────────────────────────────────────────────────────

const UPDATE_ALARM = 'tabout-update-check';
const UPDATE_STORAGE_KEY = 'tabout:updateStatus';
const GITHUB_COMMITS_URL = 'https://api.github.com/repos/leonxia1010/tab-out/commits/main';
const UPDATE_CHECK_PERIOD_MIN = 60 * 48; // 48h — once-per-user rate is ~0.02 req/h, nowhere near GitHub's 60 req/h/IP anon limit.

async function checkForUpdate() {
  try {
    const res = await fetch(GITHUB_COMMITS_URL);
    if (!res.ok) return;
    const body = await res.json();
    const latestSha = body && body.sha;
    if (!latestSha) return;

    const stored = await chrome.storage.local.get(UPDATE_STORAGE_KEY);
    const state = stored[UPDATE_STORAGE_KEY] || {};
    // First run after install: seed currentSha = latestSha so we don't flash
    // an update banner on day one.
    const currentSha = state.currentSha || latestSha;
    const updateAvailable = currentSha !== latestSha;

    await chrome.storage.local.set({
      [UPDATE_STORAGE_KEY]: {
        updateAvailable,
        latestSha,
        currentSha,
        checkedAt: new Date().toISOString(),
        dismissedSha: state.dismissedSha || null,
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
  chrome.runtime.onInstalled.addListener(updateBadge);
  chrome.runtime.onStartup.addListener(updateBadge);
  chrome.tabs.onCreated.addListener(updateBadge);
  chrome.tabs.onRemoved.addListener(updateBadge);
  chrome.tabs.onUpdated.addListener(updateBadge);
  updateBadge();

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
  module.exports = { getDomainCount, colorForCount, updateBadge, checkForUpdate };
}
