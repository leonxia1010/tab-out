// Thin typed wrappers around chrome.tabs / chrome.windows used by the
// dashboard.
//
// `chromeAvailable()` keeps the dev/test path working: when the page is
// served outside an extension context (vitest, plain localhost), every
// privileged call returns early and state.extensionAvailable stays false
// so the UI renders an empty-tabs fallback instead of crashing.

import {
  getOpenTabs,
  setExtensionAvailable,
  setOpenTabs,
  type DomainGroup,
  type Tab,
} from './state.js';
import { extractHostname } from '../../shared/dist/url.js';

function chromeAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.tabs;
}

// chrome.tabs.remove / update and chrome.windows.update reject when any
// target was closed externally between the time we queried it and the
// time we acted on it — a common race with bulk operations or rapid
// user clicks. For our semantics ("user wants these gone" / "focus this
// if it still exists") a missing target is already success. We swallow
// the rejection and warn, so callers can run their post-action UI work
// unconditionally without try/finally guards everywhere.
async function swallow(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    console.warn(`[tab-out] ${label} rejected (likely already-gone tab):`, err);
  }
}

function tabOutNewtabUrls(): string[] {
  const id = chrome.runtime?.id;
  return id
    ? [`chrome-extension://${id}/dashboard/index.html`, 'chrome://newtab/']
    : ['chrome://newtab/'];
}

function hostnameOf(url: string | undefined): string | null {
  return url ? extractHostname(url) : null;
}

// Schemes where hostname matching is unreliable or meaningless:
//   file://     — no hostname component at all
//   chrome://   — URL parser may return '' or the path segment; either way
//                 matching by hostname over-fires across unrelated system pages
//   chrome-extension:// — hostname is the extension id; two different
//                         extension pages share a hostname, so hostname match
//                         would nuke siblings
// These schemes go through wantedExact (URL identity) in closeTabsByUrls.
const EXACT_ONLY_SCHEME = /^(file|chrome|chrome-extension):\/\//;

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

export async function closeDuplicates(urls: string[]): Promise<void> {
  if (!chromeAvailable() || !urls || urls.length === 0) return;

  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const toClose: number[] = [];

  for (const url of urls) {
    const matching = allTabs.filter((t) => t.url === url);
    if (matching.length <= 1) continue;
    const keep = matching.find((t) => t.active) || matching[0];
    for (const tab of matching) {
      if (tab.id !== keep.id && typeof tab.id === 'number') toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await swallow(chrome.tabs.remove(toClose), 'chrome.tabs.remove');
  await fetchOpenTabs();
}

export async function closeTabOutDupes(): Promise<void> {
  if (!chromeAvailable()) return;

  const newtabUrls = tabOutNewtabUrls();
  // v2.5.0: scope to current window. Per-window scope means each Tab Out
  // dashboard only sees/closes its own window's Tab Out tabs — another
  // window's duplicates are that window's problem.
  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const tabOutTabs = allTabs.filter(
    (t) => !!t.url && newtabUrls.includes(t.url),
  );
  if (tabOutTabs.length <= 1) return;

  const keep = tabOutTabs.find((t) => t.active) || tabOutTabs[0];
  const ids = tabOutTabs
    .filter((t) => t.id !== keep.id)
    .map((t) => t.id)
    .filter((id): id is number => typeof id === 'number');

  if (ids.length > 0) await swallow(chrome.tabs.remove(ids), 'chrome.tabs.remove');
  await fetchOpenTabs();
}

export interface OrganizeResult {
  moves: Array<{ tabId: number; originalIndex: number }>;
  movedCount: number;
}

// v2.5.0 — reorder the current window's tab bar to match the dashboard's
// domain-card order. Pinned tabs stay where Chrome enforces them; Tab Out
// tabs move to the end so the user's tool drops out of the way once the
// reorder lands. Returns a snapshot of every non-pinned tab's original
// index so the caller can reverse the move for a 60s undo flow.
export async function organizeTabs(desiredOrder: ReadonlyArray<DomainGroup>): Promise<OrganizeResult> {
  if (!chromeAvailable()) return { moves: [], movedCount: 0 };

  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const pinnedCount = allTabs.filter((t) => t.pinned).length;
  const tabOutUrls = new Set(tabOutNewtabUrls());

  // Build the desired tabId sequence from the domain cards, then append
  // Tab Out tabs. Skip pinned tabs everywhere — Chrome rejects moves that
  // would violate the "pinned before unpinned" invariant anyway, so
  // filtering upfront keeps the intent explicit.
  const seen = new Set<number>();
  const domainTabIds: number[] = [];
  for (const group of desiredOrder) {
    for (const tab of group.tabs) {
      if (typeof tab.id !== 'number') continue;
      if (seen.has(tab.id)) continue;
      const real = allTabs.find((t) => t.id === tab.id);
      if (!real || real.pinned) continue;
      if (real.url && tabOutUrls.has(real.url)) continue; // Tab Out handled below
      seen.add(tab.id);
      domainTabIds.push(tab.id);
    }
  }

  const tabOutIds = allTabs
    .filter((t) => typeof t.id === 'number' && !t.pinned && !!t.url && tabOutUrls.has(t.url))
    .map((t) => t.id as number);

  // Snapshot BEFORE moving — covers every non-pinned tab so undo can
  // restore positions even for tabs we left in place (e.g. chrome://
  // system pages not represented by any domain card).
  const moves: Array<{ tabId: number; originalIndex: number }> = [];
  for (const t of allTabs) {
    if (typeof t.id === 'number' && !t.pinned) {
      moves.push({ tabId: t.id, originalIndex: t.index });
    }
  }

  const finalOrder = [...domainTabIds, ...tabOutIds];
  if (finalOrder.length === 0) return { moves, movedCount: 0 };

  // chrome.tabs.move with an array + single index places them starting
  // at that index, preserving the array order. Batched into one atomic
  // call so onMoved fires once per tab but the final layout is
  // deterministic.
  await swallow(chrome.tabs.move(finalOrder, { index: pinnedCount }), 'chrome.tabs.move');
  await fetchOpenTabs();
  return { moves, movedCount: finalOrder.length };
}

export async function undoOrganizeTabs(
  moves: ReadonlyArray<{ tabId: number; originalIndex: number }>,
): Promise<void> {
  if (!chromeAvailable() || moves.length === 0) return;

  // Replay in ascending originalIndex order so each move lands at the
  // slot Chrome expects (earlier tabs shifting later ones left-to-right
  // matches how organizeTabs originally consumed the index).
  const sorted = [...moves].sort((a, b) => a.originalIndex - b.originalIndex);
  for (const m of sorted) {
    await swallow(chrome.tabs.move(m.tabId, { index: m.originalIndex }), 'chrome.tabs.move');
  }
  await fetchOpenTabs();
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

