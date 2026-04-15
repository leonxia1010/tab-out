// tests/dashboard/api.test.js
//
// Phase 3 PR J — api.ts is now backed by chrome.storage.local.
// We mock chrome.storage.local with an in-memory Map and assert the 10
// public functions read/write the right keys, encode the same shapes the
// old SQLite layer produced, and apply the 30-day age-out side effect on
// getDeferred() that used to live in server/db.js:347.
//
// PR H/I left a fetch-shape version of this file behind. PR J replaces it
// wholesale because there's no overlap with the new chrome.storage code path.

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

// ─── chrome.storage.local mock ──────────────────────────────────────────────
//
// The real API takes either a key string, an array of keys, an object of
// defaults, or null (return everything). All we care about for these tests
// is the string-key form (which is what api.ts uses).

function installChromeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));

  const local = {
    get: vi.fn(async (keys) => {
      if (typeof keys === 'string') {
        return store.has(keys) ? { [keys]: store.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      }
      // null / undefined → return everything
      return Object.fromEntries(store);
    }),
    set: vi.fn(async (kv) => {
      for (const [k, v] of Object.entries(kv)) store.set(k, v);
    }),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => store.clear()),
  };

  vi.stubGlobal('chrome', { storage: { local } });
  return { store, local };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── getMissions ────────────────────────────────────────────────────────────

describe('getMissions', () => {
  it('returns [] when storage has no missions key', async () => {
    installChromeStorage();
    expect(await getMissions()).toEqual([]);
  });

  it('hides dismissed missions and sorts active before cooling before abandoned', async () => {
    installChromeStorage({
      missions: [
        { id: 'a', name: 'A', summary: null, status: 'cooling', last_activity: '2026-04-10', created_at: '', updated_at: '', dismissed: 0, urls: [] },
        { id: 'b', name: 'B', summary: null, status: 'active', last_activity: '2026-04-12', created_at: '', updated_at: '', dismissed: 0, urls: [] },
        { id: 'c', name: 'C', summary: null, status: 'abandoned', last_activity: '2026-04-13', created_at: '', updated_at: '', dismissed: 0, urls: [] },
        { id: 'd', name: 'D', summary: null, status: 'active', last_activity: '2026-04-13', created_at: '', updated_at: '', dismissed: 1, urls: [] },
      ],
    });
    const out = await getMissions();
    expect(out.map((m) => m.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts same-status missions by last_activity DESC', async () => {
    installChromeStorage({
      missions: [
        { id: 'old', name: '', summary: null, status: 'active', last_activity: '2026-01-01', created_at: '', updated_at: '', dismissed: 0, urls: [] },
        { id: 'new', name: '', summary: null, status: 'active', last_activity: '2026-04-13', created_at: '', updated_at: '', dismissed: 0, urls: [] },
      ],
    });
    const out = await getMissions();
    expect(out.map((m) => m.id)).toEqual(['new', 'old']);
  });
});

// ─── dismissMission ─────────────────────────────────────────────────────────

describe('dismissMission', () => {
  it('flips dismissed=1 on the matching id and writes back', async () => {
    const { store } = installChromeStorage({
      missions: [
        { id: 'x', name: '', summary: null, status: 'active', last_activity: null, created_at: '', updated_at: '', dismissed: 0, urls: [] },
      ],
    });
    await dismissMission('x');
    expect(store.get('missions')[0].dismissed).toBe(1);
  });

  it('is idempotent for ids that do not exist', async () => {
    installChromeStorage({ missions: [] });
    await expect(dismissMission('nope')).resolves.toEqual({ success: true });
  });
});

// ─── archiveMission ─────────────────────────────────────────────────────────

describe('archiveMission', () => {
  it('appends an archive entry then dismisses the mission', async () => {
    const { store } = installChromeStorage({
      missions: [
        {
          id: 'm1',
          name: 'Trip planning',
          summary: null,
          status: 'active',
          last_activity: '2026-04-13',
          created_at: '',
          updated_at: '',
          dismissed: 0,
          urls: [{ id: 1, mission_id: 'm1', url: 'https://a', title: 'A', visit_count: 1, last_visit: null }],
        },
      ],
    });
    await archiveMission('m1');

    expect(store.get('missions')[0].dismissed).toBe(1);
    const archives = store.get('archives');
    expect(archives).toHaveLength(1);
    expect(archives[0].mission_name).toBe('Trip planning');
    expect(JSON.parse(archives[0].urls_json)).toHaveLength(1);
  });

  it('throws when the mission id is missing or already dismissed', async () => {
    installChromeStorage({ missions: [] });
    await expect(archiveMission('ghost')).rejects.toThrow(/not found/);
  });
});

// ─── getStats ───────────────────────────────────────────────────────────────

describe('getStats', () => {
  it('counts active missions, urls, abandoned, and reads last_analysis from meta', async () => {
    installChromeStorage({
      missions: [
        { id: 'a', name: '', summary: null, status: 'active', last_activity: null, created_at: '', updated_at: '', dismissed: 0, urls: [{ id: 1, mission_id: 'a', url: 'u1', title: null, visit_count: 1, last_visit: null }, { id: 2, mission_id: 'a', url: 'u2', title: null, visit_count: 1, last_visit: null }] },
        { id: 'b', name: '', summary: null, status: 'abandoned', last_activity: null, created_at: '', updated_at: '', dismissed: 0, urls: [] },
        { id: 'c', name: '', summary: null, status: 'active', last_activity: null, created_at: '', updated_at: '', dismissed: 1, urls: [{ id: 3, mission_id: 'c', url: 'u3', title: null, visit_count: 1, last_visit: null }] },
      ],
      meta: { last_analysis: '2026-04-13T12:00:00Z' },
    });
    const s = await getStats();
    expect(s).toEqual({
      totalMissions: 2,
      totalUrls: 2,
      abandonedMissions: 1,
      lastAnalysis: '2026-04-13T12:00:00Z',
    });
  });

  it('returns lastAnalysis: null when meta is absent', async () => {
    installChromeStorage({});
    const s = await getStats();
    expect(s.lastAnalysis).toBeNull();
    expect(s.totalMissions).toBe(0);
  });
});

// ─── getUpdateStatus (PR J stub) ────────────────────────────────────────────

describe('getUpdateStatus', () => {
  it('always returns updateAvailable: false (phase 4 decides the real impl)', async () => {
    installChromeStorage({});
    expect(await getUpdateStatus()).toEqual({ updateAvailable: false });
  });
});

// ─── saveDefer ──────────────────────────────────────────────────────────────

describe('saveDefer', () => {
  it('appends rows with auto-generated ids, returns the created list', async () => {
    const { store } = installChromeStorage({});
    const result = await saveDefer([
      { url: 'https://a.test', title: 'A' },
      { url: 'https://b.test', title: 'B', favicon_url: 'fav.png' },
    ]);

    expect(result.success).toBe(true);
    expect(result.deferred).toHaveLength(2);
    expect(result.deferred[0].url).toBe('https://a.test');
    expect(typeof result.deferred[0].id).toBe('number');
    expect(result.deferred[0].id).not.toBe(result.deferred[1].id);

    expect(store.get('deferredTabs')).toHaveLength(2);
    expect(store.get('deferredTabs')[1].favicon_url).toBe('fav.png');
  });

  it('throws when given an empty list', async () => {
    installChromeStorage({});
    await expect(saveDefer([])).rejects.toThrow(/required/);
  });

  it('skips entries without url or title (matches old server behaviour)', async () => {
    const { store } = installChromeStorage({});
    await saveDefer([
      { url: '', title: 'no url' },
      { url: 'https://ok.test', title: '' },
      { url: 'https://ok.test', title: 'good' },
    ]);
    expect(store.get('deferredTabs')).toHaveLength(1);
  });
});

// ─── getDeferred + age-out ──────────────────────────────────────────────────

describe('getDeferred', () => {
  it('partitions rows by archived flag and orders both DESC by timestamp', async () => {
    installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        { id: 2, url: 'b', title: 'B', favicon_url: null, source_mission: null, deferred_at: '2026-04-12', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        { id: 3, url: 'c', title: 'C', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 0, archived: 1, archived_at: '2026-04-02' },
        { id: 4, url: 'd', title: 'D', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 1, archived: 1, archived_at: '2026-04-05' },
      ],
    });
    const { active, archived } = await getDeferred();
    expect(active.map((t) => t.id)).toEqual([2, 1]);
    expect(archived.map((t) => t.id)).toEqual([4, 3]);
  });

  it('age-outs rows older than 30 days on read and writes them back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T00:00:00Z'));

    const { store } = installChromeStorage({
      deferredTabs: [
        // 31 days old, not handled — should age out
        { id: 1, url: 'old', title: 'old', favicon_url: null, source_mission: null, deferred_at: '2026-03-15T00:00:00Z', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        // 5 days old — stays active
        { id: 2, url: 'fresh', title: 'fresh', favicon_url: null, source_mission: null, deferred_at: '2026-04-10T00:00:00Z', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        // 31 days old but already archived — left alone
        { id: 3, url: 'kept', title: 'kept', favicon_url: null, source_mission: null, deferred_at: '2026-03-15T00:00:00Z', checked: 1, checked_at: '2026-03-16', dismissed: 0, archived: 1, archived_at: '2026-03-16' },
      ],
    });

    const { active, archived } = await getDeferred();
    expect(active.map((t) => t.id)).toEqual([2]);
    expect(archived.map((t) => t.id).sort()).toEqual([1, 3]);

    // Side effect: row 1 is now persisted with archived=1
    const persisted = store.get('deferredTabs').find((t) => t.id === 1);
    expect(persisted.archived).toBe(1);
    expect(persisted.archived_at).toBe('2026-04-15T00:00:00.000Z');
  });

  it('does not write back when no row needs aging out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T00:00:00Z'));

    const { local } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'fresh', title: 'fresh', favicon_url: null, source_mission: null, deferred_at: '2026-04-10T00:00:00Z', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await getDeferred();
    expect(local.set).not.toHaveBeenCalled();
  });
});

// ─── searchDeferred ─────────────────────────────────────────────────────────

describe('searchDeferred', () => {
  it('matches archived rows by title or url, case-insensitive', async () => {
    installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'https://github.com/foo', title: 'GitHub Actions docs', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 0, archived: 1, archived_at: '2026-04-02' },
        { id: 2, url: 'https://other.com', title: 'unrelated', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 1, archived: 1, archived_at: '2026-04-03' },
        { id: 3, url: 'https://github.com/bar', title: 'still active', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    const { results } = await searchDeferred('github');
    expect(results.map((r) => r.id)).toEqual([1]);
  });

  it('returns [] for queries shorter than 2 characters', async () => {
    installChromeStorage({});
    expect((await searchDeferred('g')).results).toEqual([]);
    expect((await searchDeferred('')).results).toEqual([]);
  });

  it('caps results at 50', async () => {
    const tabs = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      url: `https://hit.test/${i}`,
      title: `hit ${i}`,
      favicon_url: null,
      source_mission: null,
      deferred_at: '2026-04-01',
      checked: 1,
      checked_at: '2026-04-02',
      dismissed: 0,
      archived: 1,
      archived_at: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
    }));
    installChromeStorage({ deferredTabs: tabs });
    const { results } = await searchDeferred('hit');
    expect(results).toHaveLength(50);
  });
});

// ─── checkDeferred / dismissDeferred ────────────────────────────────────────

describe('checkDeferred', () => {
  it('marks the row checked + archived with timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T10:00:00Z'));
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 7, url: 'u', title: 'u', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await checkDeferred(7);
    const row = store.get('deferredTabs')[0];
    expect(row.checked).toBe(1);
    expect(row.archived).toBe(1);
    expect(row.checked_at).toBe('2026-04-15T10:00:00.000Z');
    expect(row.archived_at).toBe('2026-04-15T10:00:00.000Z');
  });

  it('accepts both numeric and string ids', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 99, url: 'u', title: 'u', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await checkDeferred('99');
    expect(store.get('deferredTabs')[0].checked).toBe(1);
  });

  it('throws when the id does not exist', async () => {
    installChromeStorage({ deferredTabs: [] });
    await expect(checkDeferred(123)).rejects.toThrow(/not found/);
  });
});

describe('dismissDeferred', () => {
  it('marks the row dismissed + archived', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 5, url: 'u', title: 'u', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await dismissDeferred(5);
    const row = store.get('deferredTabs')[0];
    expect(row.dismissed).toBe(1);
    expect(row.archived).toBe(1);
  });

  it('throws when the id does not exist', async () => {
    installChromeStorage({ deferredTabs: [] });
    await expect(dismissDeferred(1)).rejects.toThrow(/not found/);
  });
});

// ─── chrome.storage unavailable ─────────────────────────────────────────────

describe('chrome.storage missing', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
  });
  it('throws a clear error from any function (caller wraps in try/catch)', async () => {
    await expect(getMissions()).rejects.toThrow(/unavailable/);
    await expect(saveDefer([{ url: 'u', title: 't' }])).rejects.toThrow(
      /unavailable/,
    );
  });
});
