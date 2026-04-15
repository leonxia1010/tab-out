/**
 * background.js — Service Worker for Domain-Count Badge
 *
 * Phase 3 PR M — Source of truth swapped from the deleted localhost server's
 * /api/stats to chrome.tabs directly. The badge now counts unique http(s)
 * hostnames currently open. Color signal stays the same so users see no
 * behavioral change:
 *   1-3 domains → green  (#3d7a4a, focused)
 *   4-6 domains → amber  (#b8892e, busy)
 *   7+ domains  → red    (#b35a5a, overloaded)
 *
 * Event-driven only — the old 60s setInterval poll is gone because the data
 * source is chrome.tabs itself; tab events are sufficient signal.
 */

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

// Service-worker wiring. Guarded so importing this file from vitest (where
// chrome is mocked but listener registration is irrelevant) does not crash.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(updateBadge);
  chrome.runtime.onStartup.addListener(updateBadge);
  chrome.tabs.onCreated.addListener(updateBadge);
  chrome.tabs.onRemoved.addListener(updateBadge);
  chrome.tabs.onUpdated.addListener(updateBadge);
  updateBadge();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getDomainCount, colorForCount, updateBadge };
}
