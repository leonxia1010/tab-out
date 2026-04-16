// tests/dashboard/refresh.test.js
//
// Phase 4 post-release v2: signature-based auto-refresh.
//
// refresh.ts owns a module-level debounce timer, so each test uses
// vi.resetModules() + dynamic import to get a clean slate. renderers.ts
// is mocked so we only assert render decisions. fetchOpenTabs runs for
// real — we drive it by controlling what chrome.tabs.query returns,
// which lets us verify the signature-dedup logic end-to-end.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const EXT_ID = 'EXTID';

function installChrome({ queryResults = [[]] } = {}) {
  const listeners = { onCreated: [], onRemoved: [], onUpdated: [], onMoved: [] };
  let queryIdx = 0;
  const query = vi.fn(async () => {
    const r = queryResults[Math.min(queryIdx, queryResults.length - 1)];
    queryIdx += 1;
    return r;
  });
  vi.stubGlobal('chrome', {
    runtime: { id: EXT_ID },
    tabs: {
      query,
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
      onMoved:   { addListener: (fn) => listeners.onMoved.push(fn) },
    },
  });
  return { listeners, query };
}

// Loads a fresh refresh.ts (after vi.resetModules) and seeds the state
// module that refresh.ts / extension-bridge.ts will share via the same
// module cache instance. PR 3 swapped refresh.ts's target from
// renderOpenTabsOnly to applyOpenTabsDiff, so we mock diff.ts instead.
async function loadRefresh({ renderSpy, initialTabs = [] }) {
  vi.doMock('../../extension/dashboard/src/diff.ts', () => ({
    applyOpenTabsDiff: renderSpy,
  }));
  const state = await import('../../extension/dashboard/src/state.ts');
  state.setOpenTabs(initialTabs);
  return await import('../../extension/dashboard/src/refresh.ts');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../../extension/dashboard/src/diff.ts');
  vi.restoreAllMocks();
});

describe('scheduleRefresh — signature-based dedup', () => {
  it('debounces multiple calls into a single decision after 500ms', async () => {
    installChrome({ queryResults: [[
      { id: 1, url: 'https://a.com', title: 'A' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [{ url: 'https://a.com', title: 'A' }],
    });

    scheduleRefresh();
    scheduleRefresh();
    scheduleRefresh();

    await vi.advanceTimersByTimeAsync(499);
    expect(renderSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // Signature identical (state matches fetch result) — no render.
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('skips render when displayable signature is unchanged (local close path)', async () => {
    // Simulates the aftermath of a local close: closeTabsByUrls already
    // ran fetchOpenTabs(), so state matches chrome.tabs reality. The
    // onRemoved event chrome fires next triggers schedule → fetch returns
    // the same set → skip render → animation not interrupted.
    installChrome({ queryResults: [[
      { id: 1, url: 'https://a.com', title: 'A' },
      { id: 2, url: 'https://b.com', title: 'B' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [
        { url: 'https://a.com', title: 'A' },
        { url: 'https://b.com', title: 'B' },
      ],
    });
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('renders exactly once when signature grows (external tab opened)', async () => {
    installChrome({ queryResults: [[
      { id: 1, url: 'https://a.com', title: 'A' },
      { id: 2, url: 'https://b.com', title: 'B' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [{ url: 'https://a.com', title: 'A' }],
    });
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('renders exactly once when signature shrinks (external tab closed)', async () => {
    installChrome({ queryResults: [[
      { id: 1, url: 'https://a.com', title: 'A' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [
        { url: 'https://a.com', title: 'A' },
        { url: 'https://b.com', title: 'B' },
      ],
    });
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores isTabOut entries (chrome://newtab/ does not trigger waterfall)', async () => {
    // External fetch adds chrome://newtab/ — fetchOpenTabs marks it
    // isTabOut=true, so getDisplayableTabs drops it and signature
    // matches the initial [a] set → no render.
    installChrome({ queryResults: [[
      { id: 1, url: 'https://a.com', title: 'A' },
      { id: 2, url: 'chrome://newtab/', title: 'New tab' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [{ url: 'https://a.com', title: 'A' }],
    });
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('ignores about:/edge:/brave: internals in signature', async () => {
    installChrome({ queryResults: [[
      { id: 1, url: 'https://a.com', title: 'A' },
      { id: 2, url: 'about:blank', title: '' },
      { id: 3, url: 'edge://version', title: '' },
      { id: 4, url: 'brave://settings', title: '' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [{ url: 'https://a.com', title: 'A' }],
    });
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('renders when displayable order changes (user drags a chrome tab)', async () => {
    // PR 3 rule 4: reshuffling card order must trigger a render so the
    // diff's Phase 1 can fall back to a full mount. chrome.tabs.query
    // returns tabs sorted by (windowId, tab.index), so a drag flips the
    // order of entries in the result — and therefore the signature,
    // because we deliberately dropped .sort() to preserve this signal.
    installChrome({ queryResults: [[
      { id: 2, url: 'https://b.com', title: 'B', index: 0 },
      { id: 1, url: 'https://a.com', title: 'A', index: 1 },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [
        { url: 'https://a.com', title: 'A', index: 0 },
        { url: 'https://b.com', title: 'B', index: 1 },
      ],
    });
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('skips render on same-host URL change (i18n redirect / SPA nav)', async () => {
    // jiangren.com.au -> jiangren.com.au/en scenario. Pre-refresh state has
    // the tab on `/`, chrome.tabs.query returns `/en` on the next fetch.
    // URL-based signature would differ; hostname-based (this PR) sees both
    // as `jiangren.com.au` and skips render.
    installChrome({ queryResults: [[
      { id: 1, url: 'https://jiangren.com.au/en', title: 'JR Academy (EN)' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { scheduleRefresh } = await loadRefresh({
      renderSpy,
      initialTabs: [{ url: 'https://jiangren.com.au/', title: 'JR Academy' }],
    });
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });
});

describe('attachTabsListeners — event filter', () => {
  it('subscribes to onCreated / onRemoved / onUpdated / onMoved', async () => {
    const { listeners } = installChrome();
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefresh({ renderSpy });
    attachTabsListeners();
    expect(listeners.onCreated).toHaveLength(1);
    expect(listeners.onRemoved).toHaveLength(1);
    expect(listeners.onUpdated).toHaveLength(1);
    expect(listeners.onMoved).toHaveLength(1);
  });

  it('onCreated triggers schedule; render fires iff signature changes', async () => {
    const { listeners } = installChrome({ queryResults: [[
      { id: 99, url: 'https://new.com', title: 'NEW' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefresh({ renderSpy, initialTabs: [] });
    attachTabsListeners();

    listeners.onCreated[0]({ id: 99 });
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('onRemoved triggers schedule; render fires iff signature changes', async () => {
    const { listeners } = installChrome({ queryResults: [[]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefresh({
      renderSpy,
      initialTabs: [{ url: 'https://a.com', title: 'A' }],
    });
    attachTabsListeners();

    listeners.onRemoved[0](1, {});
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('onUpdated ignores title/status/favicon/pinned/audible', async () => {
    // If any of these accidentally scheduled a refresh, we'd see a
    // render because the fetch result differs from the initial state.
    // Zero renders proves zero schedules.
    const { listeners } = installChrome({ queryResults: [[
      { id: 1, url: 'https://a.com', title: 'A' },
      { id: 2, url: 'https://b.com', title: 'B' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefresh({
      renderSpy,
      initialTabs: [{ url: 'https://a.com', title: 'A' }],
    });
    attachTabsListeners();

    const onUpdated = listeners.onUpdated[0];
    onUpdated(1, { title: 'new title' }, { id: 1 });
    onUpdated(1, { status: 'complete' }, { id: 1 });
    onUpdated(1, { status: 'loading' }, { id: 1 });
    onUpdated(1, { favIconUrl: 'https://x/y' }, { id: 1 });
    onUpdated(1, { pinned: true }, { id: 1 });
    onUpdated(1, { audible: false }, { id: 1 });

    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('onMoved triggers schedule; render fires iff signature changes', async () => {
    const { listeners } = installChrome({ queryResults: [[
      { id: 2, url: 'https://b.com', title: 'B', index: 0 },
      { id: 1, url: 'https://a.com', title: 'A', index: 1 },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefresh({
      renderSpy,
      initialTabs: [
        { url: 'https://a.com', title: 'A', index: 0 },
        { url: 'https://b.com', title: 'B', index: 1 },
      ],
    });
    attachTabsListeners();

    // onMoved payload shape: (tabId, { windowId, fromIndex, toIndex }).
    // The handler ignores the payload and just schedules a refresh;
    // the signature diff then decides whether to render.
    listeners.onMoved[0](1, { windowId: 1, fromIndex: 0, toIndex: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('onUpdated schedules when change.url is present', async () => {
    const { listeners } = installChrome({ queryResults: [[
      { id: 1, url: 'https://new.com', title: 'NEW' },
    ]] });
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefresh({ renderSpy, initialTabs: [] });
    attachTabsListeners();

    listeners.onUpdated[0](1, { url: 'https://new.com' }, { id: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('no-ops silently when chrome.tabs is unavailable', async () => {
    vi.stubGlobal('chrome', undefined);
    const renderSpy = vi.fn().mockResolvedValue(undefined);
    const { attachTabsListeners } = await loadRefresh({ renderSpy });
    expect(() => attachTabsListeners()).not.toThrow();
  });
});
