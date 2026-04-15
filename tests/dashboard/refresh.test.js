// tests/dashboard/refresh.test.js
//
// Phase 4 post-release: auto-refresh wiring.
//
// refresh.ts owns a module-level debounce timer, so each test uses
// vi.resetModules() + dynamic import to get a clean slate. renderers.ts
// is mocked so we only assert scheduling behavior, not DOM rendering.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const EXT_ID = 'EXTID';
const SELF_URL = `chrome-extension://${EXT_ID}/dashboard/index.html`;

// Capture listener callbacks so tests can invoke them directly.
function installChrome({ extId = EXT_ID } = {}) {
  const listeners = {
    onCreated: [],
    onRemoved: [],
    onUpdated: [],
  };
  vi.stubGlobal('chrome', {
    runtime: extId ? { id: extId } : undefined,
    tabs: {
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
    },
  });
  return listeners;
}

async function loadRefreshModule(renderSpy) {
  vi.doMock('../../extension/dashboard/src/renderers.ts', () => ({
    renderStaticDashboard: renderSpy,
  }));
  return await import('../../extension/dashboard/src/refresh.ts');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../../extension/dashboard/src/renderers.ts');
  vi.restoreAllMocks();
});

describe('scheduleRefresh', () => {
  it('debounces multiple calls into a single render after 500ms', async () => {
    installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefreshModule(renderSpy);

    scheduleRefresh();
    scheduleRefresh();
    scheduleRefresh();

    vi.advanceTimersByTime(499);
    expect(renderSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the timer so late calls push the render out further', async () => {
    installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefreshModule(renderSpy);

    scheduleRefresh();
    vi.advanceTimersByTime(400);
    // Late call inside the debounce window should reset the timer.
    scheduleRefresh();
    vi.advanceTimersByTime(400);
    expect(renderSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});

describe('attachTabsListeners', () => {
  it('triggers refresh when a new external tab is created', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    expect(listeners.onCreated).toHaveLength(1);

    listeners.onCreated[0]({ id: 123, url: 'https://example.com' });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores onCreated for the Tab Out dashboard tab itself (url)', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    listeners.onCreated[0]({ id: 999, url: SELF_URL });
    vi.advanceTimersByTime(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('ignores onCreated for Tab Out based on pendingUrl', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    listeners.onCreated[0]({ id: 999, url: '', pendingUrl: 'chrome://newtab/' });
    vi.advanceTimersByTime(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('triggers refresh when any tab is removed (no URL available)', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    listeners.onRemoved[0](123, {});
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('onUpdated filters churn: favicon / status=loading / pinned do NOT schedule', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    const onUpdated = listeners.onUpdated[0];
    const extTab = { id: 1, url: 'https://example.com' };

    onUpdated(1, { favIconUrl: 'https://x.com/favicon.ico' }, extTab);
    onUpdated(1, { status: 'loading' }, extTab);
    onUpdated(1, { pinned: true }, extTab);
    onUpdated(1, { audible: false }, extTab);

    vi.advanceTimersByTime(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('onUpdated schedules on url / title / status=complete for external tabs', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    const onUpdated = listeners.onUpdated[0];
    const extTab = { id: 1, url: 'https://example.com' };

    onUpdated(1, { url: 'https://new.com' }, extTab);
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    onUpdated(2, { title: 'New Title' }, extTab);
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(2);

    onUpdated(3, { status: 'complete' }, extTab);
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(3);
  });

  it('onUpdated ignores status=complete for the dashboard tab itself', async () => {
    // This is the double-render bug: on page load the dashboard's own
    // status=complete event fires AFTER renderDashboard() has already
    // rendered once, causing a redundant re-render 500ms later.
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    const onUpdated = listeners.onUpdated[0];
    const selfTab = { id: 42, url: SELF_URL };

    onUpdated(42, { status: 'complete' }, selfTab);
    onUpdated(42, { url: SELF_URL }, selfTab);
    onUpdated(42, { title: 'Tab Out' }, selfTab);

    vi.advanceTimersByTime(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('no-ops silently when chrome.tabs is unavailable', async () => {
    vi.stubGlobal('chrome', undefined);
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    expect(() => attachTabsListeners()).not.toThrow();
  });
});
