// Auto-refresh wiring: subscribe to chrome.tabs.on* and re-render the
// dashboard on changes. Before this module the dashboard only called
// fetchOpenTabs() once on page load, so any tab opened/closed outside the
// dashboard (cmd+t in another window, external cmd+w) left the UI stale
// until the user manually refreshed.
//
// Design notes:
//   - 500ms debounce lets local close animations (chip fade ~200ms + card
//     animateCardOut ~300ms) complete before mount() re-renders the grid.
//     Without it the listener would yank chips mid-animation.
//   - onUpdated fires on favicon / pinned / audible churn too; we filter
//     down to url / title / status=complete so we don't re-render dozens
//     of times per page load.
//   - scheduleRefresh and attachTabsListeners are exported for tests.

import { renderStaticDashboard } from './renderers.js';

const REFRESH_DEBOUNCE_MS = 500;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void renderStaticDashboard();
  }, REFRESH_DEBOUNCE_MS);
}

export function attachTabsListeners(): void {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;
  chrome.tabs.onCreated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    if (change.url || change.title || change.status === 'complete') {
      scheduleRefresh();
    }
  });
}
