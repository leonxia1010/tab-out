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
    // v2.5.0: dashboard queries with { currentWindow: true }. Mock respects
    // that filter so cross-window tabs in the test fixture don't leak into
    // per-window call sites.
    query: vi.fn(async (q) => {
      if (q && q.currentWindow === true) {
        return tabs.filter((t) => t.windowId == null || t.windowId === currentWindowId);
      }
      return tabs;
    }),
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
    // v2.5.0 per-window scope: query only returns current-window tabs. All
    // fixture tabs share windowId=10 and currentWindowId=10 matches, so
    // every tab flows through.
    installChrome({
      currentWindowId: 10,
      tabs: [
        { id: 1, url: 'https://github.com', title: 'GH', windowId: 10, active: true },
        { id: 2, url: NEWTAB_URL, title: 'Tab Out', windowId: 10, active: false },
        { id: 3, url: 'chrome://newtab/', title: 'Tab Out', windowId: 10, active: false },
        { id: 4, url: 'https://example.com', title: 'EX', windowId: 10, active: false },
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

  it('v2.5.0: ignores Tab Out tabs in other windows (per-window scope)', async () => {
    // Pre-v2.5.0 this function saw Tab Out tabs globally and tried to
    // prefer the current-window active one. With per-window query, the
    // other-window Tab Out never enters the picture — only the current
    // window's duplicates are candidates for close.
    const { tabsApi } = installChrome({
      currentWindowId: 2,
      tabs: [
        { id: 1, url: NEWTAB_URL, active: true, windowId: 1 },
        { id: 2, url: NEWTAB_URL, active: true, windowId: 2 },
        { id: 3, url: NEWTAB_URL, active: false, windowId: 2 },
      ],
    });
    await closeTabOutDupes();
    // Window 1's Tab Out (id 1) is invisible to this call. Among window 2's
    // tabs, id 2 is active → keep it, close id 3.
    expect(tabsApi.remove).toHaveBeenCalledWith([3]);
  });

  it('does nothing when the current window has only one Tab Out (even if another window has more)', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 2,
      tabs: [
        { id: 1, url: NEWTAB_URL, active: true, windowId: 1 },
        { id: 2, url: NEWTAB_URL, active: false, windowId: 1 },
        { id: 3, url: NEWTAB_URL, active: false, windowId: 2 },
      ],
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

// ─── organizeTabs (v2.5.0) ─────────────────────────────────────────────────

describe('organizeTabs', () => {
  // Import lazily inside each test so the mock install happens BEFORE
  // the module under test resolves chrome.
  async function loadOrganize() {
    const mod = await import('../../extension/dashboard/src/extension-bridge.ts');
    return mod.organizeTabs;
  }

  function withMoveMock(opts) {
    const { tabsApi } = installChrome(opts);
    tabsApi.move = vi.fn(async () => ({}));
    return tabsApi;
  }

  it('batches chrome.tabs.move with domain-card order + Tab Out appended', async () => {
    const tabsApi = withMoveMock({
      currentWindowId: 1,
      tabs: [
        { id: 10, url: 'https://github.com/a', pinned: false, index: 0, windowId: 1 },
        { id: 11, url: 'https://twitter.com/x', pinned: false, index: 1, windowId: 1 },
        { id: 12, url: NEWTAB_URL, pinned: false, index: 2, windowId: 1 },
      ],
    });
    const organizeTabs = await loadOrganize();

    const result = await organizeTabs([
      { domain: 'twitter.com', tabs: [{ id: 11, url: 'https://twitter.com/x', title: 'X', index: 1 }] },
      { domain: 'github.com', tabs: [{ id: 10, url: 'https://github.com/a', title: 'GH', index: 0 }] },
    ]);

    expect(tabsApi.move).toHaveBeenCalledTimes(1);
    // Twitter first (from desired order), GitHub second, Tab Out last.
    expect(tabsApi.move).toHaveBeenCalledWith([11, 10, 12], { index: 0 });
    expect(result.movedCount).toBe(3);
  });

  it('skips pinned tabs and starts index at pinnedCount', async () => {
    const tabsApi = withMoveMock({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://pin.com', pinned: true, index: 0, windowId: 1 },
        { id: 2, url: 'https://pin.com/two', pinned: true, index: 1, windowId: 1 },
        { id: 10, url: 'https://a.com', pinned: false, index: 2, windowId: 1 },
        { id: 11, url: 'https://b.com', pinned: false, index: 3, windowId: 1 },
      ],
    });
    const organizeTabs = await loadOrganize();

    await organizeTabs([
      { domain: 'a.com', tabs: [{ id: 10, url: 'https://a.com', index: 2 }] },
      { domain: 'b.com', tabs: [{ id: 11, url: 'https://b.com', index: 3 }] },
    ]);

    expect(tabsApi.move).toHaveBeenCalledWith([10, 11], { index: 2 });
    expect(tabsApi.move.mock.calls[0][0]).not.toContain(1);
    expect(tabsApi.move.mock.calls[0][0]).not.toContain(2);
  });

  it('captures originalIndex for every non-pinned tab so undo can restore', async () => {
    withMoveMock({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://pin.com', pinned: true, index: 0, windowId: 1 },
        { id: 10, url: 'https://a.com', pinned: false, index: 1, windowId: 1 },
        { id: 11, url: 'https://b.com', pinned: false, index: 2, windowId: 1 },
      ],
    });
    const organizeTabs = await loadOrganize();

    const { moves } = await organizeTabs([
      { domain: 'b.com', tabs: [{ id: 11, url: 'https://b.com', index: 2 }] },
      { domain: 'a.com', tabs: [{ id: 10, url: 'https://a.com', index: 1 }] },
    ]);

    // Pinned tab (id 1) excluded; non-pinned tabs captured with their pre-move index.
    expect(moves).toEqual([
      { tabId: 10, originalIndex: 1 },
      { tabId: 11, originalIndex: 2 },
    ]);
  });

  it('Tab Out tabs land at the end regardless of desired order', async () => {
    const tabsApi = withMoveMock({
      currentWindowId: 1,
      tabs: [
        { id: 10, url: 'https://a.com', pinned: false, index: 0, windowId: 1 },
        { id: 12, url: NEWTAB_URL, pinned: false, index: 1, windowId: 1 },
        { id: 13, url: 'chrome://newtab/', pinned: false, index: 2, windowId: 1 },
        { id: 11, url: 'https://b.com', pinned: false, index: 3, windowId: 1 },
      ],
    });
    const organizeTabs = await loadOrganize();

    await organizeTabs([
      { domain: 'a.com', tabs: [{ id: 10, url: 'https://a.com', index: 0 }] },
      { domain: 'b.com', tabs: [{ id: 11, url: 'https://b.com', index: 3 }] },
    ]);

    const [ids] = tabsApi.move.mock.calls[0];
    const tabOutIds = [12, 13];
    // Tab Out ids come after every domain id.
    for (const tabOutId of tabOutIds) {
      const domainId10Idx = ids.indexOf(10);
      const domainId11Idx = ids.indexOf(11);
      const tabOutIdx = ids.indexOf(tabOutId);
      expect(tabOutIdx).toBeGreaterThan(domainId10Idx);
      expect(tabOutIdx).toBeGreaterThan(domainId11Idx);
    }
  });

  it('returns movedCount=0 when no non-pinned tabs exist', async () => {
    const tabsApi = withMoveMock({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://pin.com', pinned: true, index: 0, windowId: 1 },
      ],
    });
    const organizeTabs = await loadOrganize();

    const result = await organizeTabs([]);

    expect(tabsApi.move).not.toHaveBeenCalled();
    expect(result.movedCount).toBe(0);
  });
});

describe('undoOrganizeTabs', () => {
  async function loadUndo() {
    const mod = await import('../../extension/dashboard/src/extension-bridge.ts');
    return mod.undoOrganizeTabs;
  }

  it('replays moves in ascending originalIndex order', async () => {
    const { tabsApi } = installChrome({ tabs: [] });
    tabsApi.move = vi.fn(async () => ({}));
    const undoOrganizeTabs = await loadUndo();

    await undoOrganizeTabs([
      { tabId: 11, originalIndex: 2 },
      { tabId: 10, originalIndex: 1 },
      { tabId: 12, originalIndex: 3 },
    ]);

    expect(tabsApi.move).toHaveBeenCalledTimes(3);
    expect(tabsApi.move.mock.calls[0]).toEqual([10, { index: 1 }]);
    expect(tabsApi.move.mock.calls[1]).toEqual([11, { index: 2 }]);
    expect(tabsApi.move.mock.calls[2]).toEqual([12, { index: 3 }]);
  });

  it('no-ops on empty move list', async () => {
    const { tabsApi } = installChrome({ tabs: [] });
    tabsApi.move = vi.fn(async () => ({}));
    const undoOrganizeTabs = await loadUndo();

    await undoOrganizeTabs([]);

    expect(tabsApi.move).not.toHaveBeenCalled();
  });

  it('swallows move rejections for tabs that were closed mid-undo', async () => {
    const { tabsApi } = installChrome({ tabs: [] });
    tabsApi.move = vi.fn(async (id) => {
      if (id === 11) throw new Error('No tab with id: 11');
      return {};
    });
    const undoOrganizeTabs = await loadUndo();

    await expect(undoOrganizeTabs([
      { tabId: 10, originalIndex: 0 },
      { tabId: 11, originalIndex: 1 },
      { tabId: 12, originalIndex: 2 },
    ])).resolves.toBeUndefined();

    // All three attempted; rejection on 11 didn't block 12.
    expect(tabsApi.move).toHaveBeenCalledTimes(3);
  });
});
