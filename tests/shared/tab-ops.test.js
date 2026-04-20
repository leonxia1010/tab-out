// tests/shared/tab-ops.test.js
//
// v2.7.0 — shared tab operations used by both dashboard + popup.
// Migrated from tests/dashboard/extension-bridge.test.js when the
// implementations moved to shared/src/tab-ops.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  closeAllExceptTabout,
  closeDuplicates,
  closeTabOutDupes,
  countCloseable,
  countDuplicates,
  countOrganizeMoves,
  organizeTabs,
  undoOrganizeTabs,
} from '../../extension/shared/src/tab-ops.ts';

const EXT_ID = 'EXTID';
const NEWTAB_URL = `chrome-extension://${EXT_ID}/dashboard/index.html`;

// runtimeId === null means "no chrome.runtime object at all" (simulates
// the runtime being unavailable). Default uses the standard EXT_ID.
function installChrome({ tabs = [], currentWindowId = 1, runtimeId } = {}) {
  const tabsApi = {
    // shared/tab-ops respects { currentWindow: true }. Mock filters by
    // currentWindowId so cross-window fixture tabs don't leak into
    // per-window call sites.
    query: vi.fn(async (q) => {
      if (q && q.currentWindow === true) {
        return tabs.filter((t) => t.windowId == null || t.windowId === currentWindowId);
      }
      return tabs;
    }),
    remove: vi.fn(async () => {}),
    update: vi.fn(async () => ({})),
    move: vi.fn(async () => ({})),
    create: vi.fn(async () => ({ id: 999 })),
  };
  vi.stubGlobal('chrome', {
    tabs: tabsApi,
    runtime: runtimeId === null ? undefined : { id: runtimeId ?? EXT_ID },
  });
  return { tabsApi };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── closeDuplicates ───────────────────────────────────────────────────────

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

  // v2.7.0 — pinned-tab protection. Before this, a pinned duplicate could
  // be closed if the active copy lived elsewhere. Uniform across every
  // caller (dashboard + popup) now.
  it('v2.7.0: prefers pinned > active > first when picking the keeper', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'https://x.test', active: false, pinned: false },
        { id: 2, url: 'https://x.test', active: true,  pinned: false },
        { id: 3, url: 'https://x.test', active: false, pinned: true  },
      ],
    });
    await closeDuplicates(['https://x.test']);
    // Keeper = pinned (id 3). Both non-pinned copies close.
    expect(tabsApi.remove).toHaveBeenCalledWith([1, 2]);
  });

  it('v2.7.0: never closes a pinned duplicate even if another pinned copy is kept', async () => {
    const { tabsApi } = installChrome({
      tabs: [
        { id: 1, url: 'https://x.test', pinned: true,  active: false },
        { id: 2, url: 'https://x.test', pinned: true,  active: true  },
        { id: 3, url: 'https://x.test', pinned: false, active: false },
      ],
    });
    await closeDuplicates(['https://x.test']);
    // Keeper = first pinned (id 1). Only the non-pinned dup (id 3) closes;
    // id 2 is still pinned and must not be removed.
    expect(tabsApi.remove).toHaveBeenCalledWith([3]);
  });
});

// ─── closeTabOutDupes ──────────────────────────────────────────────────────

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
    const { tabsApi } = installChrome({
      currentWindowId: 2,
      tabs: [
        { id: 1, url: NEWTAB_URL, active: true, windowId: 1 },
        { id: 2, url: NEWTAB_URL, active: true, windowId: 2 },
        { id: 3, url: NEWTAB_URL, active: false, windowId: 2 },
      ],
    });
    await closeTabOutDupes();
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

// ─── organizeTabs ──────────────────────────────────────────────────────────

describe('organizeTabs', () => {
  it('batches chrome.tabs.move with domain-card order + Tab Out appended', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 10, url: 'https://github.com/a', pinned: false, index: 0, windowId: 1 },
        { id: 11, url: 'https://twitter.com/x', pinned: false, index: 1, windowId: 1 },
        { id: 12, url: NEWTAB_URL, pinned: false, index: 2, windowId: 1 },
      ],
    });

    const result = await organizeTabs([
      { domain: 'twitter.com', tabs: [{ id: 11, url: 'https://twitter.com/x', title: 'X', index: 1 }] },
      { domain: 'github.com', tabs: [{ id: 10, url: 'https://github.com/a', title: 'GH', index: 0 }] },
    ]);

    expect(tabsApi.move).toHaveBeenCalledTimes(1);
    expect(tabsApi.move).toHaveBeenCalledWith([11, 10, 12], { index: 0 });
    expect(result.movedCount).toBe(3);
  });

  it('skips pinned tabs and starts index at pinnedCount', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://pin.com', pinned: true, index: 0, windowId: 1 },
        { id: 2, url: 'https://pin.com/two', pinned: true, index: 1, windowId: 1 },
        { id: 10, url: 'https://a.com', pinned: false, index: 2, windowId: 1 },
        { id: 11, url: 'https://b.com', pinned: false, index: 3, windowId: 1 },
      ],
    });

    await organizeTabs([
      { domain: 'a.com', tabs: [{ id: 10, url: 'https://a.com', index: 2 }] },
      { domain: 'b.com', tabs: [{ id: 11, url: 'https://b.com', index: 3 }] },
    ]);

    expect(tabsApi.move).toHaveBeenCalledWith([10, 11], { index: 2 });
    expect(tabsApi.move.mock.calls[0][0]).not.toContain(1);
    expect(tabsApi.move.mock.calls[0][0]).not.toContain(2);
  });

  it('captures originalIndex for every non-pinned tab so undo can restore', async () => {
    installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://pin.com', pinned: true, index: 0, windowId: 1 },
        { id: 10, url: 'https://a.com', pinned: false, index: 1, windowId: 1 },
        { id: 11, url: 'https://b.com', pinned: false, index: 2, windowId: 1 },
      ],
    });

    const { moves } = await organizeTabs([
      { domain: 'b.com', tabs: [{ id: 11, url: 'https://b.com', index: 2 }] },
      { domain: 'a.com', tabs: [{ id: 10, url: 'https://a.com', index: 1 }] },
    ]);

    expect(moves).toEqual([
      { tabId: 10, originalIndex: 1 },
      { tabId: 11, originalIndex: 2 },
    ]);
  });

  it('Tab Out tabs land at the end regardless of desired order', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 10, url: 'https://a.com', pinned: false, index: 0, windowId: 1 },
        { id: 12, url: NEWTAB_URL, pinned: false, index: 1, windowId: 1 },
        { id: 13, url: 'chrome://newtab/', pinned: false, index: 2, windowId: 1 },
        { id: 11, url: 'https://b.com', pinned: false, index: 3, windowId: 1 },
      ],
    });

    await organizeTabs([
      { domain: 'a.com', tabs: [{ id: 10, url: 'https://a.com', index: 0 }] },
      { domain: 'b.com', tabs: [{ id: 11, url: 'https://b.com', index: 3 }] },
    ]);

    const [ids] = tabsApi.move.mock.calls[0];
    for (const tabOutId of [12, 13]) {
      const d10 = ids.indexOf(10);
      const d11 = ids.indexOf(11);
      const out = ids.indexOf(tabOutId);
      expect(out).toBeGreaterThan(d10);
      expect(out).toBeGreaterThan(d11);
    }
  });

  it('returns movedCount=0 when no non-pinned tabs exist', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://pin.com', pinned: true, index: 0, windowId: 1 },
      ],
    });

    const result = await organizeTabs([]);

    expect(tabsApi.move).not.toHaveBeenCalled();
    expect(result.movedCount).toBe(0);
  });
});

// ─── undoOrganizeTabs ──────────────────────────────────────────────────────

// ─── closeAllExceptTabout (v2.7.0) ─────────────────────────────────────────

describe('closeAllExceptTabout', () => {
  it('closes every non-pinned non-TabOut tab in the current window', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: NEWTAB_URL, pinned: false },
        { id: 2, url: 'https://github.com', pinned: false },
        { id: 3, url: 'https://x.com', pinned: false },
      ],
    });
    const result = await closeAllExceptTabout();
    expect(tabsApi.remove).toHaveBeenCalledWith([2, 3]);
    expect(tabsApi.create).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: 2, createdTabOut: false });
  });

  it('preserves pinned tabs across the close', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: NEWTAB_URL, pinned: false },
        { id: 2, url: 'https://pinned.com', pinned: true },
        { id: 3, url: 'https://github.com', pinned: false },
      ],
    });
    const result = await closeAllExceptTabout();
    expect(tabsApi.remove).toHaveBeenCalledWith([3]);
    expect(result.closed).toBe(1);
  });

  it('creates a new Tab Out tab first when none exists', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: 'https://github.com', pinned: false },
        { id: 2, url: 'https://x.com', pinned: false },
      ],
    });
    const result = await closeAllExceptTabout();
    expect(tabsApi.create).toHaveBeenCalledWith({ url: 'chrome://newtab/' });
    expect(tabsApi.remove).toHaveBeenCalledWith([1, 2]);
    expect(result).toEqual({ closed: 2, createdTabOut: true });
  });

  it('skips the close path when nothing is closeable and Tab Out already exists', async () => {
    const { tabsApi } = installChrome({
      currentWindowId: 1,
      tabs: [
        { id: 1, url: NEWTAB_URL, pinned: false },
        { id: 2, url: 'https://pinned.com', pinned: true },
      ],
    });
    const result = await closeAllExceptTabout();
    expect(tabsApi.remove).not.toHaveBeenCalled();
    expect(tabsApi.create).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: 0, createdTabOut: false });
  });

  it('no-ops when chrome.tabs is unavailable', async () => {
    vi.stubGlobal('chrome', undefined);
    const result = await closeAllExceptTabout();
    expect(result).toEqual({ closed: 0, createdTabOut: false });
  });
});

// ─── count helpers (v2.7.0 popup labels) ───────────────────────────────────

describe('countCloseable', () => {
  it('counts non-pinned non-TabOut tabs', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: NEWTAB_URL, pinned: false },
      { id: 2, url: 'https://github.com', pinned: false },
      { id: 3, url: 'https://x.com', pinned: true },
      { id: 4, url: 'https://reddit.com', pinned: false },
    ];
    expect(countCloseable(tabs)).toBe(2);
  });

  it('returns 0 when only Tab Out + pinned tabs are open', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: NEWTAB_URL, pinned: false },
      { id: 2, url: 'https://pinned.com', pinned: true },
    ];
    expect(countCloseable(tabs)).toBe(0);
  });
});

describe('countDuplicates', () => {
  it('counts extras per URL including Tab Out duplicates', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: 'https://a.test', pinned: false },
      { id: 2, url: 'https://a.test', pinned: false },
      { id: 3, url: 'https://a.test', pinned: false },
      { id: 4, url: 'https://b.test', pinned: false },
      { id: 5, url: 'https://b.test', pinned: false },
      { id: 6, url: NEWTAB_URL, pinned: false },
      { id: 7, url: NEWTAB_URL, pinned: false },
    ];
    // a has 2 extras (3-1), b has 1 extra (2-1), Tab Out has 1 extra (2-1) = 4
    expect(countDuplicates(tabs)).toBe(4);
  });

  it('v2.7: counts Tab Out-only duplicates so the popup button can enable', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: NEWTAB_URL, pinned: false },
      { id: 2, url: NEWTAB_URL, pinned: false },
    ];
    expect(countDuplicates(tabs)).toBe(1);
  });

  it('excludes pinned copies from the closable count (keeper + other pinned survive)', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: 'https://a.test', pinned: true },
      { id: 2, url: 'https://a.test', pinned: true },
      { id: 3, url: 'https://a.test', pinned: false },
    ];
    // Keeper = first pinned; other pinned survives; only 1 non-pinned closes.
    expect(countDuplicates(tabs)).toBe(1);
  });

  it('returns 0 when no duplicates exist', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: 'https://a.test', pinned: false },
      { id: 2, url: 'https://b.test', pinned: false },
    ];
    expect(countDuplicates(tabs)).toBe(0);
  });
});

describe('countOrganizeMoves', () => {
  it('counts non-pinned tabs with a URL', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: 'https://a.test', pinned: false },
      { id: 2, url: 'https://b.test', pinned: true },
      { id: 3, url: 'https://c.test', pinned: false },
      { id: 4, url: '', pinned: false },
    ];
    expect(countOrganizeMoves(tabs)).toBe(2);
  });

  it('returns 0 when only pinned tabs exist', () => {
    installChrome({});
    const tabs = [
      { id: 1, url: 'https://a.test', pinned: true },
      { id: 2, url: 'https://b.test', pinned: true },
    ];
    expect(countOrganizeMoves(tabs)).toBe(0);
  });
});

describe('undoOrganizeTabs', () => {
  it('replays moves in ascending originalIndex order', async () => {
    const { tabsApi } = installChrome({ tabs: [] });

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

    await undoOrganizeTabs([]);

    expect(tabsApi.move).not.toHaveBeenCalled();
  });

  it('swallows move rejections for tabs that were closed mid-undo', async () => {
    const { tabsApi } = installChrome({ tabs: [] });
    tabsApi.move.mockImplementation(async (id) => {
      if (id === 11) throw new Error('No tab with id: 11');
      return {};
    });

    await expect(undoOrganizeTabs([
      { tabId: 10, originalIndex: 0 },
      { tabId: 11, originalIndex: 1 },
      { tabId: 12, originalIndex: 2 },
    ])).resolves.toBeUndefined();

    expect(tabsApi.move).toHaveBeenCalledTimes(3);
  });
});
