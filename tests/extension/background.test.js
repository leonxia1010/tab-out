// tests/extension/background.test.js
//
// Phase 3 PR M rewrote the badge to read from chrome.tabs directly.
// Phase 4 PR-B added a chrome.alarms-backed update checker. This file pins
// down both:
//   - getDomainCount dedupes by hostname and ignores non-http(s) URLs
//   - colorForCount returns the right band for each count threshold
//   - updateBadge clears text on count=0 and otherwise sets text+color
//   - chrome.tabs.query failures degrade to a cleared badge instead of throwing
//   - checkForUpdate writes updateAvailable state based on GitHub sha delta
//   - network failures in checkForUpdate are swallowed (alarm retries in 48h)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let getDomainCount, colorForCount, updateBadge, checkForUpdate;
let setBadgeText, setBadgeBgColor, queryFn;

function installChrome({ tabs = [], queryThrows = false } = {}) {
  setBadgeText = vi.fn();
  setBadgeBgColor = vi.fn();
  queryFn = queryThrows
    ? vi.fn(async () => { throw new Error('boom'); })
    : vi.fn(async () => tabs);
  vi.stubGlobal('chrome', {
    action: { setBadgeText, setBadgeBackgroundColor: setBadgeBgColor },
    tabs: {
      query: queryFn,
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    // alarms + storage are required at module load time by the update-checker
    // wiring; individual tests override .get/.set as needed.
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
  });
}

beforeEach(async () => {
  // Stub chrome BEFORE import so the SW wiring at module bottom finds it.
  // The auto-fired updateBadge() from that wiring is harmless here — we
  // clear mock state right after loading so each test starts clean.
  installChrome();
  vi.resetModules();
  ({ getDomainCount, colorForCount, updateBadge, checkForUpdate } =
    await import('../../extension/background.js'));
  // Drain the auto-fired updateBadge() promise + reset call counters.
  await Promise.resolve();
  setBadgeText.mockClear();
  setBadgeBgColor.mockClear();
  queryFn.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getDomainCount', () => {
  it('returns 0 when no tabs', () => {
    expect(getDomainCount([])).toBe(0);
  });

  it('dedupes multiple tabs from the same hostname', () => {
    expect(getDomainCount([
      { url: 'https://github.com/a' },
      { url: 'https://github.com/b' },
      { url: 'https://github.com/c' },
      { url: 'https://example.com' },
    ])).toBe(2);
  });

  it('ignores non-http(s) schemes (chrome / extension / about / file)', () => {
    expect(getDomainCount([
      { url: 'chrome://newtab/' },
      { url: 'chrome-extension://abc/page.html' },
      { url: 'about:blank' },
      { url: 'file:///Users/me/notes.md' },
      { url: 'https://example.com' },
    ])).toBe(1);
  });

  it('skips tabs with missing or empty url', () => {
    expect(getDomainCount([
      {},
      { url: '' },
      { url: null },
      { url: 'https://x.test' },
    ])).toBe(1);
  });
});

describe('colorForCount', () => {
  it.each([
    [0, '#3d7a4a'],
    [1, '#3d7a4a'],
    [3, '#3d7a4a'],
    [4, '#b8892e'],
    [6, '#b8892e'],
    [7, '#b35a5a'],
    [50, '#b35a5a'],
  ])('count=%i → %s', (count, expected) => {
    expect(colorForCount(count)).toBe(expected);
  });
});

describe('updateBadge', () => {
  it('clears text and skips color when only non-http tabs are open', async () => {
    installChrome({ tabs: [{ url: 'chrome://newtab/' }] });
    await updateBadge();
    expect(setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect(setBadgeBgColor).not.toHaveBeenCalled();
  });

  it('paints green for 1-3 domains', async () => {
    installChrome({
      tabs: [
        { url: 'https://a.test' },
        { url: 'https://b.test' },
      ],
    });
    await updateBadge();
    expect(setBadgeText).toHaveBeenCalledWith({ text: '2' });
    expect(setBadgeBgColor).toHaveBeenCalledWith({ color: '#3d7a4a' });
  });

  it('paints amber at 5 domains', async () => {
    installChrome({
      tabs: Array.from({ length: 5 }, (_, i) => ({ url: `https://d${i}.test` })),
    });
    await updateBadge();
    expect(setBadgeText).toHaveBeenCalledWith({ text: '5' });
    expect(setBadgeBgColor).toHaveBeenCalledWith({ color: '#b8892e' });
  });

  it('paints red at 8 domains', async () => {
    installChrome({
      tabs: Array.from({ length: 8 }, (_, i) => ({ url: `https://d${i}.test` })),
    });
    await updateBadge();
    expect(setBadgeText).toHaveBeenCalledWith({ text: '8' });
    expect(setBadgeBgColor).toHaveBeenCalledWith({ color: '#b35a5a' });
  });

  it('clears badge when chrome.tabs.query throws', async () => {
    installChrome({ queryThrows: true });
    await updateBadge();
    expect(setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect(setBadgeBgColor).not.toHaveBeenCalled();
  });
});

describe('checkForUpdate', () => {
  let fetchMock, storageGet, storageSet;

  beforeEach(() => {
    // installChrome() already set storage.local.{get,set} mocks in the outer
    // beforeEach, but those resolve to empty. Replace with test-controlled
    // spies so we can assert payloads.
    storageGet = vi.fn(async () => ({}));
    storageSet = vi.fn(async () => {});
    // eslint-disable-next-line no-undef
    chrome.storage.local.get = storageGet;
    // eslint-disable-next-line no-undef
    chrome.storage.local.set = storageSet;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('writes updateAvailable:true when fetched sha differs from stored currentSha', async () => {
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { currentSha: 'aaa', dismissedSha: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sha: 'bbb' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: true,
        latestSha: 'bbb',
        currentSha: 'aaa',
      }),
    });
  });

  it('writes updateAvailable:false when fetched sha matches stored currentSha', async () => {
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { currentSha: 'aaa', dismissedSha: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sha: 'aaa' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestSha: 'aaa',
        currentSha: 'aaa',
      }),
    });
  });

  it('seeds currentSha = latestSha on first run so the banner does not flash on install', async () => {
    storageGet.mockResolvedValue({}); // no prior state
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sha: 'xyz' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestSha: 'xyz',
        currentSha: 'xyz',
      }),
    });
  });

  it('does not write storage and does not throw when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(checkForUpdate()).resolves.toBeUndefined();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('does not write storage when response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    await checkForUpdate();
    expect(storageSet).not.toHaveBeenCalled();
  });
});
