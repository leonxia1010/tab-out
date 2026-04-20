// Dashboard-local chrome.tabs/chrome.windows wrappers + re-exports of
// the pure tab operations that v2.7.0 moved to `shared/src/tab-ops.ts`.
//
// `chromeAvailable()` (from shared) keeps the dev/test path working:
// when the page is served outside an extension context (vitest, plain
// localhost), every privileged call returns early and
// state.extensionAvailable stays false so the UI renders an empty-tabs
// fallback instead of crashing.

import {
  getOpenTabs,
  setExtensionAvailable,
  setOpenTabs,
  type Tab,
} from './state.js';
import {
  EXACT_ONLY_SCHEME,
  chromeAvailable,
  closeDuplicates,
  closeTabOutDupes,
  hostnameOf,
  organizeTabs,
  swallow,
  tabOutNewtabUrls,
  undoOrganizeTabs,
} from '../../shared/dist/tab-ops.js';

export { closeDuplicates, closeTabOutDupes, organizeTabs, undoOrganizeTabs };
export type { OrganizeResult } from '../../shared/dist/tab-ops.js';

export async function fetchOpenTabs(): Promise<void> {
  if (!chromeAvailable()) {
    setOpenTabs([]);
    setExtensionAvailable(false);
    return;
  }

  const newtabUrls = tabOutNewtabUrls();
  // v2.5.0 per-window scope: dashboard shows only tabs in its own window.
  // Every tab-query call site in this file uses the same filter so the
  // state, close actions, and dupe banner all agree on "this window".
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const simple: Tab[] = tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    // index is chrome's tab position within its window. Preserving it
    // lets groupTabsByDomain sort cards by first-seen (min index per
    // group) — a stable ordering that the PR 3 diff layer can rely on.
    index: t.index,
    windowId: t.windowId,
    active: t.active,
    isTabOut: !!t.url && newtabUrls.includes(t.url),
  }));

  setOpenTabs(simple);
  setExtensionAvailable(true);
}

export async function closeTabsByUrls(
  urls: string[],
  exact = false,
  skipSelf = true,
): Promise<void> {
  if (!chromeAvailable() || !urls || urls.length === 0) return;

  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const selfUrls = skipSelf ? new Set(tabOutNewtabUrls()) : null;
  let matched: chrome.tabs.Tab[];

  if (exact) {
    const wanted = new Set(urls);
    matched = allTabs.filter((t) => !!t.url && wanted.has(t.url));
  } else {
    const wantedHosts = new Set<string>();
    const wantedExact = new Set<string>();
    for (const u of urls) {
      if (EXACT_ONLY_SCHEME.test(u)) wantedExact.add(u);
      else {
        const h = hostnameOf(u);
        if (h) wantedHosts.add(h);
      }
    }
    matched = allTabs.filter((t) => {
      const url = t.url || '';
      if (EXACT_ONLY_SCHEME.test(url)) return wantedExact.has(url);
      const h = hostnameOf(url);
      return !!h && wantedHosts.has(h);
    });
  }

  const ids = matched
    .filter((t) => !selfUrls || !(t.url && selfUrls.has(t.url)))
    .map((t) => t.id)
    .filter((id): id is number => typeof id === 'number');

  if (ids.length > 0) await swallow(chrome.tabs.remove(ids), 'chrome.tabs.remove');
  await fetchOpenTabs();
}

export async function focusTab(url: string): Promise<void> {
  if (!chromeAvailable() || !url) return;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  let matches = allTabs.filter((t) => t.url === url);
  if (matches.length === 0) {
    const targetHost = hostnameOf(url);
    if (targetHost) {
      matches = allTabs.filter((t) => hostnameOf(t.url) === targetHost);
    }
  }
  if (matches.length === 0) return;

  // Prefer a match outside the current window so it actually switches.
  const match =
    matches.find((t) => t.windowId !== currentWindow.id) || matches[0];
  if (typeof match.id !== 'number') return;

  await swallow(chrome.tabs.update(match.id, { active: true }), 'chrome.tabs.update');
  if (typeof match.windowId === 'number') {
    await swallow(chrome.windows.update(match.windowId, { focused: true }), 'chrome.windows.update');
  }
}

export function checkTabOutDupes(): void {
  const tabOutTabs = getOpenTabs().filter((t) => t.isTabOut);

  const banner = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = String(tabOutTabs.length);
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}
