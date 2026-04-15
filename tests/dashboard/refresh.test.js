// tests/dashboard/refresh.test.js
//
// Phase 4 post-release: auto-refresh wiring.
//
// refresh.ts owns a module-level debounce timer, so each test uses
// vi.resetModules() + dynamic import to get a clean slate. renderers.ts
// is mocked so we only assert scheduling behavior, not DOM rendering.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture listener callbacks so tests can invoke them directly.
function installChrome() {
  const listeners = {
    onCreated: [],
    onRemoved: [],
    onUpdated: [],
  };
  vi.stubGlobal('chrome', {
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
  it('triggers refresh when a new tab is created', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    expect(listeners.onCreated).toHaveLength(1);

    listeners.onCreated[0]({ id: 123 });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('triggers refresh when a tab is removed', async () => {
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

    onUpdated(1, { favIconUrl: 'https://x.com/favicon.ico' });
    onUpdated(1, { status: 'loading' });
    onUpdated(1, { pinned: true });
    onUpdated(1, { audible: false });

    vi.advanceTimersByTime(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('onUpdated schedules on url / title / status=complete', async () => {
    const listeners = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    attachTabsListeners();
    const onUpdated = listeners.onUpdated[0];

    onUpdated(1, { url: 'https://new.com' });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    onUpdated(2, { title: 'New Title' });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(2);

    onUpdated(3, { status: 'complete' });
    vi.advanceTimersByTime(500);
    expect(renderSpy).toHaveBeenCalledTimes(3);
  });

  it('no-ops silently when chrome.tabs is unavailable', async () => {
    vi.stubGlobal('chrome', undefined);
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefreshModule(renderSpy);

    expect(() => attachTabsListeners()).not.toThrow();
  });
});
