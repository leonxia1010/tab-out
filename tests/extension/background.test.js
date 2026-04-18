// tests/extension/background.test.js
//
// v2.5.0 retired the domain-count action badge (dashboard went per-window,
// a global hostname count on the icon stopped matching any single
// dashboard). This file now only covers the update-check alarm path:
//   - checkForUpdate writes updateAvailable state based on GitHub tag delta
//   - network/404 failures are swallowed (alarm retries in 48h)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let checkForUpdate;

function installChrome() {
  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: vi.fn() },
    },
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
  installChrome();
  vi.resetModules();
  ({ checkForUpdate } = await import('../../extension/background.js'));
  await Promise.resolve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkForUpdate', () => {
  let fetchMock, storageGet, storageSet;

  beforeEach(() => {
    storageGet = vi.fn(async () => ({}));
    storageSet = vi.fn(async () => {});
    // eslint-disable-next-line no-undef
    chrome.storage.local.get = storageGet;
    // eslint-disable-next-line no-undef
    chrome.storage.local.set = storageSet;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('writes updateAvailable:true when fetched tag differs from stored currentTag', async () => {
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { currentTag: 'v2.0.0', dismissedTag: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.1' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: true,
        latestTag: 'v2.0.1',
        currentTag: 'v2.0.0',
      }),
    });
  });

  it('writes updateAvailable:false when fetched tag matches stored currentTag', async () => {
    storageGet.mockResolvedValue({
      'tabout:updateStatus': { currentTag: 'v2.0.0', dismissedTag: null },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestTag: 'v2.0.0',
        currentTag: 'v2.0.0',
      }),
    });
  });

  it('seeds currentTag = latestTag on first run so the banner does not flash on install', async () => {
    storageGet.mockResolvedValue({});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.0' }),
    });
    await checkForUpdate();
    expect(storageSet).toHaveBeenCalledWith({
      'tabout:updateStatus': expect.objectContaining({
        updateAvailable: false,
        latestTag: 'v2.0.0',
        currentTag: 'v2.0.0',
      }),
    });
  });

  it('does not write storage and does not throw when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(checkForUpdate()).resolves.toBeUndefined();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('does not write storage when response is 404 (no release published yet)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await checkForUpdate();
    expect(storageSet).not.toHaveBeenCalled();
  });
});
