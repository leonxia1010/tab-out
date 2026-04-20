// @vitest-environment jsdom
//
// v2.7.0 — toolbar popup surface. Exercises the full mount flow: DOM
// hydrate → count query → button label + disabled state → click →
// shared tab-ops invocation + window.close().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EXT_ID = 'EXTID';
const NEWTAB_URL = `chrome-extension://${EXT_ID}/dashboard/index.html`;

const POPUP_HTML = `
  <main class="popup">
    <button type="button" class="popup-btn" id="popup-close-all" data-action="close-all" disabled>Loading…</button>
    <button type="button" class="popup-btn" id="popup-close-dupes" data-action="close-dupes" disabled>Loading…</button>
    <button type="button" class="popup-btn" id="popup-organize" data-action="organize" disabled>Loading…</button>
  </main>
`;

function installChrome({ tabs = [], currentWindowId = 1 } = {}) {
  const tabsApi = {
    query: vi.fn(async (q) => {
      if (q && q.currentWindow === true) {
        return tabs.filter((t) => t.windowId == null || t.windowId === currentWindowId);
      }
      return tabs;
    }),
    remove: vi.fn(async () => {}),
    move: vi.fn(async () => ({})),
    create: vi.fn(async () => ({ id: 999 })),
  };
  vi.stubGlobal('chrome', {
    tabs: tabsApi,
    runtime: { id: EXT_ID },
  });
  return { tabsApi };
}

// Flush all pending microtasks + one macrotask cycle so the dispatch
// chain (query → action → window.close) fully settles before assertions.
async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Import the popup module once. Re-importing via resetModules stacks
// auto-boot listeners across tests; the module's body-dataset guard
// already prevents auto-boot on subsequent mounts, so we call init()
// manually per test instead.
let popup;

beforeEach(async () => {
  document.body.innerHTML = POPUP_HTML;
  vi.spyOn(window, 'close').mockImplementation(() => {});
  if (!popup) {
    popup = await import('../../extension/popup/src/index.ts');
  }
});

afterEach(() => {
  document.removeEventListener('click', popup.handleClick);
  // Wipe dataset marker so auto-boot doesn't fight us if a test imports
  // fresh. Harmless no-op when not set.
  if (document.body) {
    delete document.body.dataset.popupAutoBooted;
    document.body.innerHTML = '';
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountPopup(tabs, currentWindowId = 1) {
  const apis = installChrome({ tabs, currentWindowId });
  await popup.init();
  return apis;
}

describe('popup mount', () => {
  it('renders close-all count + enables button when non-pinned tabs exist', async () => {
    await mountPopup([
      { id: 1, url: NEWTAB_URL, pinned: false },
      { id: 2, url: 'https://github.com', pinned: false },
      { id: 3, url: 'https://x.com', pinned: false },
    ]);
    const btn = document.getElementById('popup-close-all');
    expect(btn.textContent).toBe('Close all 2 tabs (keep Tab Out)');
    expect(btn.disabled).toBe(false);
  });

  it('disables close-all when only Tab Out + pinned remain', async () => {
    await mountPopup([
      { id: 1, url: NEWTAB_URL, pinned: false },
      { id: 2, url: 'https://pinned.com', pinned: true },
    ]);
    const btn = document.getElementById('popup-close-all');
    expect(btn.textContent).toBe('Close all 0 tabs (keep Tab Out)');
    expect(btn.disabled).toBe(true);
  });

  it('singularizes "tab" when count is 1', async () => {
    await mountPopup([
      { id: 1, url: NEWTAB_URL, pinned: false },
      { id: 2, url: 'https://github.com', pinned: false },
    ]);
    const btn = document.getElementById('popup-close-all');
    expect(btn.textContent).toBe('Close all 1 tab (keep Tab Out)');
  });

  it('renders duplicate count reflecting pinned-preservation', async () => {
    await mountPopup([
      { id: 1, url: 'https://a.test', pinned: true },
      { id: 2, url: 'https://a.test', pinned: true },
      { id: 3, url: 'https://a.test', pinned: false },
      { id: 4, url: 'https://b.test', pinned: false },
      { id: 5, url: 'https://b.test', pinned: false },
    ]);
    const btn = document.getElementById('popup-close-dupes');
    // a.test: 2 pinned survive, 1 non-pinned closes = 1. b.test: 2-1 = 1. Total = 2.
    expect(btn.textContent).toBe('Close all 2 duplicates');
    expect(btn.disabled).toBe(false);
  });

  it('renders organize count covering non-pinned tabs with URLs', async () => {
    await mountPopup([
      { id: 1, url: 'https://a.test', pinned: false },
      { id: 2, url: 'https://b.test', pinned: true },
      { id: 3, url: 'https://c.test', pinned: false },
      { id: 4, url: NEWTAB_URL, pinned: false },
    ]);
    const btn = document.getElementById('popup-organize');
    // Includes Tab Out tab (organize appends it at the end).
    expect(btn.textContent).toBe('Organize 3 tabs');
    expect(btn.disabled).toBe(false);
  });
});

describe('popup actions', () => {
  it('close-all click creates Tab Out first if absent, then removes non-pinned non-TabOut, closes window', async () => {
    const { tabsApi } = await mountPopup([
      { id: 1, url: 'https://github.com', pinned: false },
      { id: 2, url: 'https://x.com', pinned: false },
    ]);
    document.getElementById('popup-close-all').click();
    await flushAsync();
    expect(tabsApi.create).toHaveBeenCalledWith({ url: 'chrome://newtab/' });
    expect(tabsApi.remove).toHaveBeenCalledWith([1, 2]);
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('close-dupes click forwards duplicate URLs to closeDuplicates, closes window', async () => {
    const { tabsApi } = await mountPopup([
      { id: 1, url: 'https://a.test', pinned: false },
      { id: 2, url: 'https://a.test', pinned: false },
      { id: 3, url: 'https://b.test', pinned: false },
    ]);
    document.getElementById('popup-close-dupes').click();
    await flushAsync();
    // closeDuplicates closes tab id 2 (the non-active / non-pinned dup).
    expect(tabsApi.remove).toHaveBeenCalledWith([2]);
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('organize click moves non-pinned tabs with Tab Out appended, closes window', async () => {
    const { tabsApi } = await mountPopup([
      { id: 10, url: 'https://github.com/a', pinned: false, index: 0, windowId: 1 },
      { id: 11, url: 'https://twitter.com/x', pinned: false, index: 1, windowId: 1 },
      { id: 12, url: NEWTAB_URL, pinned: false, index: 2, windowId: 1 },
    ]);
    document.getElementById('popup-organize').click();
    await flushAsync();
    expect(tabsApi.move).toHaveBeenCalledTimes(1);
    const [ids] = tabsApi.move.mock.calls[0];
    expect(ids).toContain(10);
    expect(ids).toContain(11);
    expect(ids).toContain(12);
    expect(ids.indexOf(12)).toBeGreaterThan(ids.indexOf(10));
    expect(ids.indexOf(12)).toBeGreaterThan(ids.indexOf(11));
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('disabled button swallows click without triggering chrome actions or close', async () => {
    const { tabsApi } = await mountPopup([
      { id: 1, url: NEWTAB_URL, pinned: false },
      { id: 2, url: 'https://pinned.com', pinned: true },
    ]);
    const btn = document.getElementById('popup-close-all');
    expect(btn.disabled).toBe(true);
    btn.click();
    await flushAsync();
    expect(tabsApi.remove).not.toHaveBeenCalled();
    expect(tabsApi.create).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });
});
