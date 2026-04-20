// Pure tab operations used by both dashboard and popup.
//
// Moved out of dashboard/src/extension-bridge.ts in v2.7.0 so the
// toolbar popup can call the exact same implementations. Functions here
// MUST stay pure with respect to dashboard state — no imports from
// dashboard/src. Callers own their own refresh (dashboard adds
// `await fetchOpenTabs()` after each call; popup closes after each
// click so no refresh is needed).

import { extractHostname } from './url.js';
import type { DomainGroup } from './tab-types.js';

export function chromeAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.tabs;
}

// chrome.tabs.remove / update and chrome.windows.update reject when any
// target was closed externally between the time we queried it and the
// time we acted on it — a common race with bulk operations or rapid
// user clicks. For our semantics ("user wants these gone" / "focus this
// if it still exists") a missing target is already success. We swallow
// the rejection and warn, so callers can run their post-action UI work
// unconditionally without try/finally guards everywhere.
export async function swallow(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    console.warn(`[tab-out] ${label} rejected (likely already-gone tab):`, err);
  }
}

export function tabOutNewtabUrls(): string[] {
  const id = chrome.runtime?.id;
  return id
    ? [`chrome-extension://${id}/dashboard/index.html`, 'chrome://newtab/']
    : ['chrome://newtab/'];
}

export function hostnameOf(url: string | undefined): string | null {
  return url ? extractHostname(url) : null;
}

// Schemes where hostname matching is unreliable or meaningless:
//   file://     — no hostname component at all
//   chrome://   — URL parser may return '' or the path segment; either way
//                 matching by hostname over-fires across unrelated system pages
//   chrome-extension:// — hostname is the extension id; two different
//                         extension pages share a hostname, so hostname match
//                         would nuke siblings
// These schemes go through exact-URL match in closeTabsByUrls.
export const EXACT_ONLY_SCHEME = /^(file|chrome|chrome-extension):\/\//;

// v2.7.0 — per-URL dedup scoped to the current window. Keeps one copy
// per URL using priority: pinned > active > first. Before v2.7.0 a
// pinned duplicate could be closed if the active copy lived elsewhere;
// that was a pre-existing dashboard gap now fixed uniformly for every
// caller.
export async function closeDuplicates(urls: string[]): Promise<void> {
  if (!chromeAvailable() || !urls || urls.length === 0) return;

  const allTabs = await chrome.tabs.query({ currentWindow: true });
  const toClose: number[] = [];

  for (const url of urls) {
    const matching = allTabs.filter((t) => t.url === url);
    if (matching.length <= 1) continue;
    const keep =
      matching.find((t) => t.pinned) ||
      matching.find((t) => t.active) ||
      matching[0];
    for (const tab of matching) {
      if (tab.id !== keep.id && typeof tab.id === 'number' && !tab.pinned) {
        toClose.push(tab.id);
      }
    }
  }

  if (toClose.length > 0) await swallow(chrome.tabs.remove(toClose), 'chrome.tabs.remove');
}

// Per-window collapse of multiple Tab Out dashboard tabs down to one.
// Another window's duplicates are that window's problem.
export async function closeTabOutDupes(): Promise<void> {
  if (!chromeAvailable()) return;

  const newtabUrls = tabOutNewtabUrls();
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
}

export interface OrganizeResult {
  moves: Array<{ tabId: number; originalIndex: number }>;
  movedCount: number;
}

// v2.5.0 — reorder the current window's tab bar to match the dashboard's
// domain-card order. Pinned tabs stay where Chrome enforces them; Tab Out
// tabs move to the end so the user's tool drops out of the way once the
// reorder lands. Returns a snapshot of every non-pinned tab's original
// index so the caller can reverse the move for a 60s undo flow
// (dashboard only — popup discards the snapshot).
export async function organizeTabs(
  desiredOrder: ReadonlyArray<DomainGroup>,
): Promise<OrganizeResult> {
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
}
