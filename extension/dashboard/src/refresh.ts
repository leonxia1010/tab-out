// Auto-refresh wiring: subscribe to chrome.tabs.on* and re-render the
// dashboard when the set of displayable tabs actually changes. Before this
// module the dashboard only called fetchOpenTabs() once on page load, so any
// tab opened/closed outside the dashboard left the UI stale until manual
// refresh.
//
// Design: signature-based dedup. closeTabsByUrls / closeDuplicates /
// closeTabOutDupes already call fetchOpenTabs() after chrome.tabs.remove
// (extension-bridge.ts), so when a local close handler returns, openTabs is
// already in sync with reality. The onRemoved event chrome fires here will
// then trigger scheduleRefresh, but the signature captured before/after the
// 500ms debounce fetch will be identical — so we skip renderStaticDashboard
// entirely and local chip fade / animateCardOut animations run to completion
// without being stomped by replaceChildren().
//
// External changes (cmd+t, cmd+w, foreign navigation) flip the signature and
// go through the normal render + waterfall path.
//
// This replaces a previous attempt (PR #33, suppressRefresh + isSelf +
// status=complete filter) that stacked three special cases and still leaked.

import { renderOpenTabsOnly } from './renderers.js';
import { fetchOpenTabs } from './extension-bridge.js';
import { getOpenTabs } from './state.js';
import { getDisplayableTabs } from './utils.js';

const REFRESH_DEBOUNCE_MS = 500;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// Signature covers ONLY displayable tabs (excludes isTabOut, about:, edge:,
// brave:). Matches what renderStaticDashboard actually draws, so signature
// change <=> visible UI change. chrome://newtab/ is already isTabOut=true via
// fetchOpenTabs, so onCreated(url="") for a fresh cmd+t tab does NOT shift
// signature until the user navigates — no spurious waterfall for empty
// new-tab pages.
//
// Hostname-based (not full URL): the left grid groups cards by domain, so
// the visible-UI-change invariant is about hostname identity, not path. An
// i18n redirect like jiangren.com.au/ -> /en or a SPA route change within
// github.com does not change which cards exist — signature stays and we
// skip the render. Malformed URLs fall back to the raw string (still acts
// as a set-identity anchor).
function displayableSignature(): string {
  return getDisplayableTabs(getOpenTabs())
    .map((t) => {
      const raw = t.url || '';
      if (!raw) return '';
      try { return new URL(raw).hostname; } catch { return raw; }
    })
    .filter(Boolean)
    .sort()
    .join('|');
}

export function scheduleRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const before = displayableSignature();
    await fetchOpenTabs();
    const after = displayableSignature();
    if (before === after) return;
    await renderOpenTabsOnly();
  }, REFRESH_DEBOUNCE_MS);
}

export function attachTabsListeners(): void {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;
  chrome.tabs.onCreated.addListener(() => scheduleRefresh());
  chrome.tabs.onRemoved.addListener(() => scheduleRefresh());
  chrome.tabs.onUpdated.addListener((_id, change) => {
    // Only react to url changes. title/status/favicon/pinned/audible either
    // duplicate the url event or (status=complete on slow loads) land long
    // after the url event and cause a second spurious waterfall.
    if (change.url) scheduleRefresh();
  });
}
