// Tab Out dashboard — direct chrome.tabs/windows wrapper (Phase 3 PR J).
//
// Phase 2 ran the dashboard inside an iframe and routed every privileged
// call through window.postMessage to extension/newtab.js. PR K moved the
// dashboard into the extension page itself, so chrome.tabs.* is now in
// scope and the bridge collapses into thin typed wrappers.
//
// `chromeAvailable()` keeps the dev/test path working: when the page is
// served outside an extension context (vitest, plain localhost), every
// privileged call returns early and state.extensionAvailable stays false
// so the UI renders an empty-tabs fallback instead of crashing.

import {
  getOpenTabs,
  setExtensionAvailable,
  setOpenTabs,
  type Tab,
} from './state.js';
import { getMissions, type Mission } from './api.js';

function chromeAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.tabs;
}

function tabOutNewtabUrls(): string[] {
  const id = chrome.runtime?.id;
  return id
    ? [`chrome-extension://${id}/dashboard/index.html`, 'chrome://newtab/']
    : ['chrome://newtab/'];
}

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

export async function fetchOpenTabs(): Promise<void> {
  if (!chromeAvailable()) {
    setOpenTabs([]);
    setExtensionAvailable(false);
    return;
  }

  const newtabUrls = tabOutNewtabUrls();
  const tabs = await chrome.tabs.query({});
  const simple: Tab[] = tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
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
): Promise<void> {
  if (!chromeAvailable() || !urls || urls.length === 0) return;

  const allTabs = await chrome.tabs.query({});
  let ids: number[];

  if (exact) {
    const wanted = new Set(urls);
    ids = allTabs
      .filter((t) => !!t.url && wanted.has(t.url))
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number');
  } else {
    const wantedHosts: string[] = [];
    const wantedExact = new Set<string>();
    for (const u of urls) {
      if (u.startsWith('file://')) wantedExact.add(u);
      else {
        const h = hostnameOf(u);
        if (h) wantedHosts.push(h);
      }
    }
    ids = allTabs
      .filter((t) => {
        const url = t.url || '';
        if (url.startsWith('file://')) return wantedExact.has(url);
        const h = hostnameOf(url);
        return !!h && wantedHosts.includes(h);
      })
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number');
  }

  if (ids.length > 0) await chrome.tabs.remove(ids);
  await fetchOpenTabs();
}

export async function focusTabsByUrls(urls: string[]): Promise<void> {
  if (!chromeAvailable() || !urls || urls.length === 0) return;

  const wantedHosts = urls.map(hostnameOf).filter((h): h is string => !!h);
  if (wantedHosts.length === 0) return;

  const allTabs = await chrome.tabs.query({});
  const match = allTabs.find((t) => {
    const h = hostnameOf(t.url);
    return !!h && wantedHosts.includes(h);
  });
  if (!match || typeof match.id !== 'number') return;

  await chrome.tabs.update(match.id, { active: true });
  if (typeof match.windowId === 'number') {
    await chrome.windows.update(match.windowId, { focused: true });
  }
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

  await chrome.tabs.update(match.id, { active: true });
  if (typeof match.windowId === 'number') {
    await chrome.windows.update(match.windowId, { focused: true });
  }
}

export async function closeDuplicates(urls: string[]): Promise<void> {
  if (!chromeAvailable() || !urls || urls.length === 0) return;

  const allTabs = await chrome.tabs.query({});
  const toClose: number[] = [];

  for (const url of urls) {
    const matching = allTabs.filter((t) => t.url === url);
    if (matching.length <= 1) continue;
    const keep = matching.find((t) => t.active) || matching[0];
    for (const tab of matching) {
      if (tab.id !== keep.id && typeof tab.id === 'number') toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

export async function closeTabOutDupes(): Promise<void> {
  if (!chromeAvailable()) return;

  const newtabUrls = tabOutNewtabUrls();
  const allTabs = await chrome.tabs.query({});
  const tabOutTabs = allTabs.filter(
    (t) => !!t.url && newtabUrls.includes(t.url),
  );
  if (tabOutTabs.length <= 1) return;

  const keep = tabOutTabs.find((t) => t.active) || tabOutTabs[0];
  const ids = tabOutTabs
    .filter((t) => t.id !== keep.id)
    .map((t) => t.id)
    .filter((id): id is number => typeof id === 'number');

  if (ids.length > 0) await chrome.tabs.remove(ids);
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

export async function fetchMissionById(
  missionId: number | string,
): Promise<Mission | null> {
  try {
    const missions = await getMissions();
    return missions.find((m) => String(m.id) === String(missionId)) || null;
  } catch {
    return null;
  }
}
