// tests/dashboard/api.test.js
//
// Unit tests for extension/dashboard/src/api.ts (Phase 3 PR H).
//
// Mocks globalThis.fetch and asserts each of the 10 endpoint helpers builds
// the right HTTP method + path + body, then unwraps the JSON response.
//
// Phase 3 PR J will rewrite api.ts internals to chrome.storage.local; these
// fetch-shape tests will be replaced/extended at that point.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getMissions,
  dismissMission,
  archiveMission,
  getStats,
  getUpdateStatus,
  saveDefer,
  getDeferred,
  searchDeferred,
  checkDeferred,
  dismissDeferred,
} from '../../extension/dashboard/src/api.ts';

// ─── fetch mocking helpers ──────────────────────────────────────────────────

function mockFetchOk(body) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchError(status = 500) {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: 'boom' }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── GET /api/missions ──────────────────────────────────────────────────────

describe('getMissions', () => {
  it('GETs /api/missions and returns the array', async () => {
    const missions = [
      { id: 'abc', name: 'Trip', status: 'active', urls: [] },
    ];
    const fetchFn = mockFetchOk(missions);

    const result = await getMissions();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('/api/missions');
    expect(result).toEqual(missions);
  });

  it('throws when the server returns non-2xx', async () => {
    mockFetchError(500);
    await expect(getMissions()).rejects.toThrow(/GET \/missions failed: 500/);
  });
});

// ─── POST /api/missions/:id/dismiss ─────────────────────────────────────────

describe('dismissMission', () => {
  it('POSTs to /api/missions/:id/dismiss with no body', async () => {
    const fetchFn = mockFetchOk({ success: true });

    const result = await dismissMission('abc123');

    expect(fetchFn).toHaveBeenCalledWith('/api/missions/abc123/dismiss', {
      method: 'POST',
    });
    expect(result).toEqual({ success: true });
  });

  it('URL-encodes mission ids with reserved characters', async () => {
    const fetchFn = mockFetchOk({ success: true });
    await dismissMission('a/b c');
    expect(fetchFn).toHaveBeenCalledWith('/api/missions/a%2Fb%20c/dismiss', {
      method: 'POST',
    });
  });
});

// ─── POST /api/missions/:id/archive ─────────────────────────────────────────

describe('archiveMission', () => {
  it('POSTs to /api/missions/:id/archive', async () => {
    const fetchFn = mockFetchOk({ success: true });
    const result = await archiveMission('xyz');
    expect(fetchFn).toHaveBeenCalledWith('/api/missions/xyz/archive', {
      method: 'POST',
    });
    expect(result).toEqual({ success: true });
  });

  it('throws on 404', async () => {
    mockFetchError(404);
    await expect(archiveMission('missing')).rejects.toThrow(/404/);
  });
});

// ─── GET /api/stats ─────────────────────────────────────────────────────────

describe('getStats', () => {
  it('GETs /api/stats and returns the stats object', async () => {
    const stats = {
      totalMissions: 5,
      totalUrls: 20,
      abandonedMissions: 1,
      lastAnalysis: '2026-04-14T10:00:00Z',
    };
    const fetchFn = mockFetchOk(stats);
    const result = await getStats();
    expect(fetchFn).toHaveBeenCalledWith('/api/stats');
    expect(result).toEqual(stats);
  });
});

// ─── GET /api/update-status ─────────────────────────────────────────────────

describe('getUpdateStatus', () => {
  it('GETs /api/update-status and returns the boolean payload', async () => {
    const fetchFn = mockFetchOk({ updateAvailable: false });
    const result = await getUpdateStatus();
    expect(fetchFn).toHaveBeenCalledWith('/api/update-status');
    expect(result).toEqual({ updateAvailable: false });
  });
});

// ─── POST /api/defer ────────────────────────────────────────────────────────

describe('saveDefer', () => {
  it('POSTs /api/defer with { tabs } body', async () => {
    const fetchFn = mockFetchOk({ success: true, deferred: [] });
    const tabs = [
      { url: 'https://a.test/x', title: 'A' },
      { url: 'https://b.test/y', title: 'B' },
    ];

    await saveDefer(tabs);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/defer');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ tabs });
  });

  it('returns the deferred-created list from the response', async () => {
    const created = [
      {
        id: 1,
        url: 'https://a.test',
        title: 'A',
        favicon_url: null,
        source_mission: null,
        deferred_at: '2026-04-14T10:00:00Z',
      },
    ];
    mockFetchOk({ success: true, deferred: created });
    const result = await saveDefer([{ url: 'https://a.test', title: 'A' }]);
    expect(result.deferred).toEqual(created);
  });

  it('throws on 400 when server rejects an empty tabs array', async () => {
    mockFetchError(400);
    await expect(saveDefer([])).rejects.toThrow(/POST \/defer failed: 400/);
  });
});

// ─── GET /api/deferred ──────────────────────────────────────────────────────

describe('getDeferred', () => {
  it('GETs /api/deferred and returns { active, archived }', async () => {
    const payload = {
      active: [{ id: 1, url: 'a', title: 'A', archived: 0 }],
      archived: [{ id: 2, url: 'b', title: 'B', archived: 1 }],
    };
    const fetchFn = mockFetchOk(payload);
    const result = await getDeferred();
    expect(fetchFn).toHaveBeenCalledWith('/api/deferred');
    expect(result).toEqual(payload);
  });
});

// ─── GET /api/deferred/search?q= ────────────────────────────────────────────

describe('searchDeferred', () => {
  it('GETs /api/deferred/search with the query encoded', async () => {
    const fetchFn = mockFetchOk({ results: [] });
    await searchDeferred('hello world');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/deferred/search?q=hello%20world',
    );
  });

  it('encodes special characters that would break URLs', async () => {
    const fetchFn = mockFetchOk({ results: [] });
    await searchDeferred('a&b=c?d');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/deferred/search?q=a%26b%3Dc%3Fd',
    );
  });

  it('returns the results array from the response', async () => {
    const results = [
      { id: 5, url: 'https://x', title: 'hit', archived: 1 },
    ];
    mockFetchOk({ results });
    const out = await searchDeferred('hit');
    expect(out.results).toEqual(results);
  });
});

// ─── PATCH /api/deferred/:id (checked) ──────────────────────────────────────

describe('checkDeferred', () => {
  it('PATCHes /api/deferred/:id with { checked: true }', async () => {
    const fetchFn = mockFetchOk({ success: true });
    await checkDeferred(42);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/deferred/42');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ checked: true });
  });

  it('accepts a string id (e.g. from a dataset attribute)', async () => {
    const fetchFn = mockFetchOk({ success: true });
    await checkDeferred('99');
    expect(fetchFn.mock.calls[0][0]).toBe('/api/deferred/99');
  });

  it('URL-encodes ids with reserved characters (future UUID safety)', async () => {
    const fetchFn = mockFetchOk({ success: true });
    await checkDeferred('a/b c');
    expect(fetchFn.mock.calls[0][0]).toBe('/api/deferred/a%2Fb%20c');
  });
});

// ─── PATCH /api/deferred/:id (dismissed) ────────────────────────────────────

describe('dismissDeferred', () => {
  it('PATCHes /api/deferred/:id with { dismissed: true }', async () => {
    const fetchFn = mockFetchOk({ success: true });
    await dismissDeferred(7);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/deferred/7');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ dismissed: true });
  });

  it('throws on server error', async () => {
    mockFetchError(500);
    await expect(dismissDeferred(1)).rejects.toThrow(/PATCH/);
  });

  it('URL-encodes ids with reserved characters', async () => {
    const fetchFn = mockFetchOk({ success: true });
    await dismissDeferred('x?y=z');
    expect(fetchFn.mock.calls[0][0]).toBe('/api/deferred/x%3Fy%3Dz');
  });
});
