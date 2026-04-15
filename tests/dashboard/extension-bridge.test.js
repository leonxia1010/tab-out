// tests/dashboard/extension-bridge.test.js
//
// Phase 3 PR J — extension-bridge.ts now talks to chrome.tabs/windows
// directly instead of going through the deleted newtab.js postMessage shim.
//
// We stub chrome.* with vi.stubGlobal and assert each public function
// dispatches the right calls. The handler logic moved from newtab.js
// (hostname matching, file:// exact, isTabOut detection, "prefer other
// window" focus rule) is verified inline here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchOpenTabs,
  closeTabsByUrls,
  focusTab,
  closeDuplicates,
  closeTabOutDupes,
} from '../../extension/dashboard/src/extension-bridge.ts';
import {
  getOpenTabs,
  getExtensionAvailable,
  setOpenTabs,
  setExtensionAvailable,
} from '../../extension/dashboard/src/state.ts';

const EXT_ID = 'EXTID';
const NEWTAB_URL = `chrome-extension://${EXT_ID}/dashboard/index.html`;

// runtimeId === null means "no chrome.runtime object at all" (simulates the
// runtime being unavailable). Default uses the standard EXT_ID.
function installChrome({ tabs = [], currentWindowId = 1, runtimeId } = {}) {
  const tabsApi = {
    query: vi.fn(async () => tabs),
    remove: vi.fn(async () => {}),
    update: vi.fn(async () => ({})),
  };
  const windowsApi = {
    update: vi.fn(async () => ({})),
    getCurrent: vi.fn(async () => ({ id: currentWindowId })),
  };
  vi.stubGlobal('chrome', {
    tabs: tabsApi,
    windows: windowsApi,
    runtime: runtimeId === null ? undefined : { id: runtimeId ?? EXT_ID },
  });
  return { tabsApi, windowsApi };
}

beforeEach(() => {
  // Clear module-level state between tests so leaks don't mask bugs.
  setOpenTabs([]);
  setExtensionAvailable(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── chrome unavailable (dev / vitest baseline) ─────────────────────────────

describe('when chrome.tabs is unavailable', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
  });

  it('fetchOpenTabs sets [] + extensionAvailable=false instead of throwing', async () => {
    setOpenTabs([{ url: 'stale' }]);
    setExtensionAvailable(true);
    await fetchOpenTabs();
    expect(getOpenTabs()).toEqual([]);
    expect(getExtensionAvailable()).toBe(false);
  });

  it('mutating helpers no-op silently', async () => {
    await expect(closeTabsByUrls(['https://x'])).resolves.toBeUndefined();
    await expect(focusTab('https://x')).resolves.toBeUndefined();
    await expect(closeDuplicates(['https://x'])).resolves.toBeUndefined();
    await expect(closeTabOutDupes()).resolves.toBeUndefined();
  });
});

// ─── fetchOpenTabs ──────────────────────────────────────────────────────────

describe('fetchOpenTabs', () => {
  it('maps Chrome tabs into the dashboard Tab shape and marks isTabOut', async () => {
    installChrome({
      tabs: [
        { id: 1, url: 'https://github.com', title: 'GH', windowId: 10, active: true },
        { id: 2, url: NEWTAB_URL, title: 'Tab Out', windowId: 10, active: false },
        { id: 3, url: 'chrome://newtab/', title: 'Tab Out', windowId: 11, active: false },
        { id: 4, url: 'https://example.com', title: 'EX', windowId: 11, active: false },
      ],
    });

    await fetchOpenTabs();
    const tabs = getOpenTabs();

    expect(tabs.map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(tabs.map((t) => t.isTabOut)).toEqual([false, true, true, false]);
    expect(tabs[0]).toMatchObject({ url: 'https://github.com', title: 'GH', windowId: 10, active: true });
    expect(getExtensionAvailable()).toBe(true);
  });

  it('falls back to chrome://newtab/ only when chrome.runtime.id is missing', async () => {
    installChrome({ tabs: [{ id: 1, url: NEWTAB_URL }], runtimeId: null });
    await fetchOpenTabs();
    // Without runtime id we can't build the chrome-extension:// URL, so the
    // dashboard tab is no longer flagged.
    expect(getOpenTabs()[0].isTabOut).toBe(false);
  });
});

// ─── closeTabsByUrls (default: hostname match) ──────────────────────────────

describe('closeTabsByUrls (hostname mode)', () => {
  it('removes every tab whose hostname matches one of the given urls', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'https://twitter.com/a' },
        { id: 2, url: 'https://twitter.com/b' },
        { id: 3, url: 'https://example.com/c' },
      ],
    });
    await closeTabsByUrls(['https://twitter.com/whatever']);
    expect(tabsApi.remove).toHaveBeenCalledTimes(1);
    expect(tabsApi.remove).toHaveBeenCalledWith([1, 2]);
  });

  it('matches file:// urls by exact URL (no hostname)', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'file:///Users/me/notes.md' },
        { id: 2, url: 'file:///Users/me/other.md' },
      ],
    });
    await closeTabsByUrls(['file:///Users/me/notes.md']);
    expect(tabsApi.remove).toHaveBeenCalledWith([1]);
  });

  it('skips invalid urls without throwing', async () => {
    const { tabsApi } = installChrome({
      tabs: [{ id: 1, url: 'https://github.com' }],
    });
    await closeTabsByUrls(['not a url']);
    expect(tabsApi.remove).not.toHaveBeenCalled();
  });

  it('refreshes the tab list after closing', async () => {
    const { tabsApi } = installChrome({
      tabs: [{ id: 1, url: 'https://x.test' }],
    });
    await closeTabsByUrls(['https://x.test']);
    // Once for the close pass, once for fetchOpenTabs at the end.
    expect(tabsApi.query).toHaveBeenCalledTimes(2);
  });

  it('early-returns on empty url list (no chrome calls)', async () => {
    const { tabsApi } = installChrome({ tabs: [] });
    await closeTabsByUrls([]);
    expect(tabsApi.query).not.toHaveBeenCalled();
    expect(tabsApi.remove).not.toHaveBeenCalled();
  });
});

// ─── closeTabsByUrls chrome://* and chrome-extension://* → exact-URL mode ───
//
// Bug 2 defense: hostname matching for privileged schemes is unreliable
// (chrome:// URLs parse with an empty or path-derived hostname depending on
// the Chrome build; chrome-extension:// URLs share hostnames across all
// pages of the same extension). The Chrome System card's "Close all N tabs"
// used to send chrome:// URLs through the hostname branch and caused Chrome
// to exit. These tests pin down the exact-URL routing.

describe('closeTabsByUrls privileged-scheme exact routing', () => {
  it('only closes chrome:// tabs whose URL exactly matches, not by hostname', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'chrome://settings/' },
        { id: 2, url: 'chrome://settings/privacy' },
        { id: 3, url: 'chrome://extensions/' },
      ],
    });
    // Hostname mode with a chrome:// URL — the old code would try to match
    // by 'settings' hostname and potentially nuke sibling pages. New
    // behaviour: URL identity only.
    await closeTabsByUrls(['chrome://settings/']);
    expect(tabsApi.remove).toHaveBeenCalledWith([1]);
  });

  it('closes the full Chrome System card set (Bug 2 regression test)', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'chrome://settings/' },
        { id: 2, url: 'chrome://extensions/' },
        { id: 3, url: 'chrome://history/' },
        { id: 4, url: 'https://github.com' },
        { id: 5, url: NEWTAB_URL }, // dashboard — must survive via skipSelf
      ],
    });
    await closeTabsByUrls([
      'chrome://settings/',
      'chrome://extensions/',
      'chrome://history/',
    ]);
    // chrome:// tabs closed exactly; github untouched; dashboard preserved.
    expect(tabsApi.remove).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('only closes chrome-extension:// tabs whose URL exactly matches', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: `chrome-extension://${EXT_ID}/options.html` },
        { id: 2, url: `chrome-extension://${EXT_ID}/popup.html` },
      ],
    });
    await closeTabsByUrls([`chrome-extension://${EXT_ID}/options.html`]);
    // Without this fix, the two pages share the same hostname (EXT_ID) and
    // the hostname branch would close both.
    expect(tabsApi.remove).toHaveBeenCalledWith([1]);
  });

  it('file:// continues to match exactly (regression guard for the existing path)', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'file:///Users/me/a.md' },
        { id: 2, url: 'file:///Users/me/b.md' },
      ],
    });
    await closeTabsByUrls(['file:///Users/me/a.md']);
    expect(tabsApi.remove).toHaveBeenCalledWith([1]);
  });
});

// ─── closeTabsByUrls (exact mode) ───────────────────────────────────────────

describe('closeTabsByUrls (exact mode)', () => {
  it('matches only the exact URL, not the whole hostname', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'https://gmail.com/inbox' },
        { id: 2, url: 'https://gmail.com/inbox/12345' },
      ],
    });
    await closeTabsByUrls(['https://gmail.com/inbox'], true);
    expect(tabsApi.remove).toHaveBeenCalledWith([1]);
  });
});

// ─── focusTab (single tab, prefer other-window) ─────────────────────────────

describe('focusTab', () => {
  it('prefers an exact-URL match over a hostname-only match', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'https://github.com/foo', windowId: 1 },
        { id: 2, url: 'https://github.com/bar', windowId: 2 },
      ],
    });
    await focusTab('https://github.com/bar');
    expect(tabsApi.update).toHaveBeenCalledWith(2, { active: true });
  });

  it('prefers a tab in a different window when multiple match', async () => {
    const { tabsApi, windowsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://x.test', windowId: 1 },
        { id: 2, url: 'https://x.test', windowId: 2 },
      ],
    });
    await focusTab('https://x.test');
    expect(tabsApi.update).toHaveBeenCalledWith(2, { active: true });
    expect(windowsApi.update).toHaveBeenCalledWith(2, { focused: true });
  });

  it('falls back to hostname match when no exact match exists', async () => {
    const { tabsApi } = installChrome({
      tabs: [{ id: 7, url: 'https://github.com/foo', windowId: 1 }],
    });
    await focusTab('https://github.com/missing-page');
    expect(tabsApi.update).toHaveBeenCalledWith(7, { active: true });
  });

  it('no-ops on empty url', async () => {
    const { tabsApi } = installChrome({ tabs: [] });
    await focusTab('');
    expect(tabsApi.query).not.toHaveBeenCalled();
  });
});

// ─── closeDuplicates ────────────────────────────────────────────────────────

describe('closeDuplicates', () => {
  it('keeps the active copy, closes the others', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'https://x.test/page', active: false },
        { id: 2, url: 'https://x.test/page', active: true },
        { id: 3, url: 'https://x.test/page', active: false },
      ],
    });
    await closeDuplicates(['https://x.test/page']);
    expect(tabsApi.remove).toHaveBeenCalledWith([1, 3]);
  });

  it('keeps the first copy when none is active', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 10, url: 'https://x.test', active: false },
        { id: 11, url: 'https://x.test', active: false },
      ],
    });
    await closeDuplicates(['https://x.test']);
    expect(tabsApi.remove).toHaveBeenCalledWith([11]);
  });

  it('does nothing when no duplicates exist', async () => {
    const { tabsApi } = installChrome({
      tabs: [{ id: 1, url: 'https://x.test', active: true }],
    });
    await closeDuplicates(['https://x.test']);
    expect(tabsApi.remove).not.toHaveBeenCalled();
  });
});

// ─── closeTabOutDupes ───────────────────────────────────────────────────────

describe('closeTabOutDupes', () => {
  it('keeps the active dashboard tab, closes the other Tab Out pages', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: NEWTAB_URL, active: true },
        { id: 2, url: NEWTAB_URL, active: false },
        { id: 3, url: 'chrome://newtab/', active: false },
        { id: 4, url: 'https://github.com', active: false },
      ],
    });
    await closeTabOutDupes();
    expect(tabsApi.remove).toHaveBeenCalledWith([2, 3]);
  });

  it('does nothing when only one Tab Out tab is open', async () => {
    const { tabsApi } = installChrome({
      tabs: [{ id: 1, url: NEWTAB_URL, active: true }],
    });
    await closeTabOutDupes();
    expect(tabsApi.remove).not.toHaveBeenCalled();
  });
});

// ─── closeTabsByUrls skipSelf guard ─────────────────────────────────────────
//
// Bug 1 / Bug 2 defense: any bulk close path must preserve the Tab Out
// dashboard tab itself — otherwise closing it pulls the user's new-tab entry
// point out from under them, and if it's the last remaining tab it can
// trigger Chrome to exit. `skipSelf` defaults to true, so all existing
// callers inherit the guard without a signature change.

describe('closeTabsByUrls skipSelf guard', () => {
  it('skips the dashboard tab even when its URL is in the input list (exact mode)', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: NEWTAB_URL },
        { id: 2, url: 'https://github.com' },
      ],
    });
    await closeTabsByUrls([NEWTAB_URL, 'https://github.com'], /* exact */ true);
    expect(tabsApi.remove).toHaveBeenCalledWith([2]);
  });

  it('skips the dashboard tab in hostname mode when its hostname would otherwise match', async () => {
    // If a caller ever passed a chrome-extension:// URL in hostname mode, the
    // hostname would be the extension id — same as the dashboard's hostname.
    // skipSelf must still drop the dashboard tab id from the remove call.
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: NEWTAB_URL },
        { id: 2, url: `chrome-extension://${EXT_ID}/other.html` },
      ],
    });
    await closeTabsByUrls([`chrome-extension://${EXT_ID}/other.html`]);
    // Only id 2 gets closed — id 1 (the dashboard) is protected.
    expect(tabsApi.remove).toHaveBeenCalledWith([2]);
  });

  it('also protects chrome://newtab/ which Chrome may surface for the dashboard', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'chrome://newtab/' },
        { id: 2, url: 'https://example.com' },
      ],
    });
    await closeTabsByUrls(['chrome://newtab/', 'https://example.com'], true);
    expect(tabsApi.remove).toHaveBeenCalledWith([2]);
  });

  it('skipSelf=false lets callers opt out (e.g. closeTabOutDupes collapsing duplicate dashboards)', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: NEWTAB_URL },
        { id: 2, url: 'https://github.com' },
      ],
    });
    await closeTabsByUrls([NEWTAB_URL], true, /* skipSelf */ false);
    expect(tabsApi.remove).toHaveBeenCalledWith([1]);
  });

  it('skipSelf drops the only matching tab → no chrome.tabs.remove call at all', async () => {
    const { tabsApi } = installChrome({
      tabs: [{ id: 1, url: NEWTAB_URL }],
    });
    await closeTabsByUrls([NEWTAB_URL], true);
    expect(tabsApi.remove).not.toHaveBeenCalled();
  });
});
