// tests/dashboard/api.test.js
//
// api.ts is backed by chrome.storage.local. We mock chrome.storage.local with
// an in-memory Map and assert the 6 public functions read/write the right
// keys and apply the 30-day age-out side effect on getDeferred().
//
// Phase 4 PR-A dropped the mission surface (getMissions/dismissMission/
// archiveMission/getStats), leaving deferred-tabs + getUpdateStatus.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getUpdateStatus,
  dismissUpdateBanner,
  saveDefer,
  getDeferred,
  searchDeferred,
  checkDeferred,
  dismissDeferred,
  deleteArchived,
  clearAllArchived,
  restoreArchived,
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

// ─── getUpdateStatus (Phase 4 PR-B: reads background.js-written state) ─────

describe('getUpdateStatus', () => {
  it('returns updateAvailable:false when the storage key is missing', async () => {
    installChromeStorage({});
    expect(await getUpdateStatus()).toEqual({ updateAvailable: false });
  });

  it('reads updateAvailable + currentTag + checkedAt from tabout:updateStatus', async () => {
    installChromeStorage({
      'tabout:updateStatus': {
        updateAvailable: true,
        latestTag: 'v2.0.1',
        currentTag: 'v2.0.0',
        checkedAt: '2026-04-10T00:00:00.000Z',
        dismissedTag: null,
      },
    });
    expect(await getUpdateStatus()).toEqual({
      updateAvailable: true,
      currentTag: 'v2.0.0',
      checkedAt: '2026-04-10T00:00:00.000Z',
    });
  });

  it('suppresses updateAvailable when dismissedTag equals latestTag (user already dismissed this release)', async () => {
    installChromeStorage({
      'tabout:updateStatus': {
        updateAvailable: true,
        latestTag: 'v2.0.1',
        currentTag: 'v2.0.0',
        checkedAt: '2026-04-10T00:00:00.000Z',
        dismissedTag: 'v2.0.1',
      },
    });
    expect(await getUpdateStatus()).toMatchObject({ updateAvailable: false });
  });

  it('shows updateAvailable again when a newer release lands past the dismissed tag', async () => {
    installChromeStorage({
      'tabout:updateStatus': {
        updateAvailable: true,
        latestTag: 'v2.0.2',
        currentTag: 'v2.0.0',
        checkedAt: '2026-04-12T00:00:00.000Z',
        dismissedTag: 'v2.0.1',
      },
    });
    expect(await getUpdateStatus()).toMatchObject({ updateAvailable: true });
  });
});

describe('dismissUpdateBanner', () => {
  it('stamps dismissedTag = latestTag so getUpdateStatus suppresses the banner', async () => {
    const { store } = installChromeStorage({
      'tabout:updateStatus': {
        updateAvailable: true,
        latestTag: 'v2.0.1',
        currentTag: 'v2.0.0',
        checkedAt: '2026-04-10T00:00:00.000Z',
        dismissedTag: null,
      },
    });
    await dismissUpdateBanner();
    expect(store.get('tabout:updateStatus').dismissedTag).toBe('v2.0.1');
    // Round-trip through getUpdateStatus confirms suppression.
    expect(await getUpdateStatus()).toMatchObject({ updateAvailable: false });
  });

  it('is a noop when no update record exists', async () => {
    const { store } = installChromeStorage({});
    await dismissUpdateBanner();
    expect(store.has('tabout:updateStatus')).toBe(false);
  });

  it('is a noop when latestTag is missing (nothing to dismiss against)', async () => {
    const { store } = installChromeStorage({
      'tabout:updateStatus': { updateAvailable: true, currentTag: 'v2.0.0' },
    });
    await dismissUpdateBanner();
    const saved = store.get('tabout:updateStatus');
    expect(saved.dismissedTag).toBeUndefined();
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
    expect(result.created).toHaveLength(2);
    expect(result.renewed).toHaveLength(0);
    expect(result.created[0].url).toBe('https://a.test');
    expect(typeof result.created[0].id).toBe('number');
    expect(result.created[0].id).not.toBe(result.created[1].id);

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

  it('assigns unique ids to 50 items saved in the same tick (no birthday collisions)', async () => {
    // Regression for the old Date.now()*1000 + rand%1000 scheme: at N=50,
    // the birthday-problem collision rate over a 1000-slot space hits ~71%.
    // The monotonic newId() should give us 50 distinct ids regardless.
    installChromeStorage({});
    const inputs = Array.from({ length: 50 }, (_, i) => ({
      url: `https://t${i}.test`,
      title: `T${i}`,
    }));
    const result = await saveDefer(inputs);
    const ids = result.created.map((d) => d.id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  });

  it('honors a cross-instance localStorage watermark for id monotonicity', async () => {
    // Simulates a second NTP tab that already handed out a very high id
    // (localStorage is per-origin and shared across tabs). The new
    // saveDefer here must bump past the stored watermark instead of
    // restarting from Date.now()*1000, otherwise a same-ms collision
    // across instances could hand out duplicate ids.
    const bag = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (bag.has(k) ? bag.get(k) : null),
      setItem: (k, v) => bag.set(k, String(v)),
      removeItem: (k) => bag.delete(k),
    });
    const high = Date.now() * 1000 + 5_000_000;
    bag.set('tabout:lastId', String(high));
    installChromeStorage({});
    const result = await saveDefer([{ url: 'https://h.test', title: 'H' }]);
    expect(result.created[0].id).toBeGreaterThan(high);
    // Watermark must advance to the newly issued id so future calls
    // keep climbing.
    expect(Number(bag.get('tabout:lastId'))).toBeGreaterThan(high);
    vi.unstubAllGlobals();
  });

  it('renews deferred_at when the url is already active, does not add a new row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T00:00:00Z'));
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'https://x.test', title: 'X', favicon_url: null, source_mission: null, deferred_at: '2026-04-01T00:00:00Z', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });

    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    const result = await saveDefer([{ url: 'https://x.test', title: 'X updated' }]);

    expect(result.created).toHaveLength(0);
    expect(result.renewed).toHaveLength(1);
    expect(result.renewed[0].id).toBe(1);

    const stored = store.get('deferredTabs');
    expect(stored).toHaveLength(1);
    expect(stored[0].deferred_at).toBe('2026-04-10T12:00:00.000Z');
    // Title is left alone — stale dataset must not clobber good stored data.
    expect(stored[0].title).toBe('X');
  });

  it('treats archived rows as independent history — new save creates a fresh active row', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'https://y.test', title: 'Y-old', favicon_url: null, source_mission: null, deferred_at: '2026-03-01T00:00:00Z', checked: 1, checked_at: '2026-03-02T00:00:00Z', dismissed: 0, archived: 1, archived_at: '2026-03-02T00:00:00Z' },
      ],
    });

    const result = await saveDefer([{ url: 'https://y.test', title: 'Y-new' }]);

    expect(result.created).toHaveLength(1);
    expect(result.renewed).toHaveLength(0);

    const stored = store.get('deferredTabs');
    expect(stored).toHaveLength(2);
    // Archive row untouched.
    const archived = stored.find((r) => r.archived === 1);
    expect(archived.title).toBe('Y-old');
    const active = stored.find((r) => r.archived === 0);
    expect(active.title).toBe('Y-new');
  });

  it('dedupes duplicates within the same inputs batch', async () => {
    const { store } = installChromeStorage({});

    const result = await saveDefer([
      { url: 'https://dup.test', title: 'First' },
      { url: 'https://dup.test', title: 'Second' },
      { url: 'https://other.test', title: 'Other' },
    ]);

    expect(result.created).toHaveLength(2);
    expect(result.renewed).toHaveLength(1);
    expect(store.get('deferredTabs')).toHaveLength(2);
    // First instance wins — title from the first occurrence.
    const dupRow = store.get('deferredTabs').find((r) => r.url === 'https://dup.test');
    expect(dupRow.title).toBe('First');
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

  it('E2E: save now → jump 31 days → getDeferred archives it → searchDeferred finds it', async () => {
    // End-to-end for the 30d archive flow: goes through the real save
    // path (newId + writeArray) rather than seeding storage directly, so
    // a regression anywhere in the pipeline surfaces here.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:00Z'));
    installChromeStorage({});

    const { created } = await saveDefer([{ url: 'https://x.com/old', title: 'Old Read' }]);
    expect(created).toHaveLength(1);

    // Advance past the 30-day cutoff (AGE_OUT_MS = 30 * 24h).
    vi.setSystemTime(new Date('2026-05-02T00:00:00Z'));

    const { active, archived } = await getDeferred();
    expect(active).toHaveLength(0);
    expect(archived).toHaveLength(1);
    expect(archived[0].title).toBe('Old Read');
    expect(archived[0].archived).toBe(1);
    expect(archived[0].archived_at).toBe('2026-05-02T00:00:00.000Z');

    // And the archive is searchable at that point.
    const hit = await searchDeferred('Old');
    expect(hit.results.map((r) => r.title)).toEqual(['Old Read']);
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

  it('updates only the first matching row when duplicate ids exist (defensive)', async () => {
    // newId() should never produce duplicates, but if it ever did, we don't
    // want check/dismiss to silently mass-update unrelated rows. find()-based
    // lookup limits the blast radius to one row.
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 7, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        { id: 7, url: 'b', title: 'B', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await checkDeferred(7);
    const stored = store.get('deferredTabs');
    expect(stored.filter((t) => t.checked === 1)).toHaveLength(1);
    expect(stored.filter((t) => t.checked === 0)).toHaveLength(1);
  });
});

describe('dismissDeferred', () => {
  it('removes the row outright (no archive trail)', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 5, url: 'u', title: 'u', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        { id: 6, url: 'v', title: 'v', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await dismissDeferred(5);
    const stored = store.get('deferredTabs');
    expect(stored).toHaveLength(1);
    expect(stored.find((r) => r.id === 5)).toBeUndefined();
    expect(stored.find((r) => r.id === 6)).toBeDefined();
  });

  it('throws when the id does not exist', async () => {
    installChromeStorage({ deferredTabs: [] });
    await expect(dismissDeferred(1)).rejects.toThrow(/not found/);
  });
});

// ─── deleteArchived / clearAllArchived ──────────────────────────────────────
//
// Bug 3 fix: the archive used to be append-only once a row hit archived=1.
// With chrome.storage.local capped at 10MB and every row read pulling the
// whole array, unbounded growth was a long-term risk. These two functions
// are the user-facing purge paths; getDeferred's auto-prune below is the
// background safety net.

describe('deleteArchived', () => {
  it('removes exactly the matching archived row', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 0, archived: 1, archived_at: '2026-04-02' },
        { id: 2, url: 'b', title: 'B', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 1, archived: 1, archived_at: '2026-04-03' },
      ],
    });
    await deleteArchived(1);
    const rows = store.get('deferredTabs');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(2);
  });

  it('accepts numeric and string ids interchangeably', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 42, url: 'u', title: 'u', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 0, archived: 1, archived_at: '2026-04-02' },
      ],
    });
    await deleteArchived('42');
    expect(store.get('deferredTabs')).toHaveLength(0);
  });

  it('throws when the id does not exist', async () => {
    installChromeStorage({ deferredTabs: [] });
    await expect(deleteArchived(999)).rejects.toThrow(/not found/);
  });

  it('refuses to delete an active (non-archived) row — callers must dismiss first', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 7, url: 'u', title: 'u', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await expect(deleteArchived(7)).rejects.toThrow(/not found/);
    // The row is still there — active rows are not silently repurposed.
    expect(store.get('deferredTabs')).toHaveLength(1);
  });
});

describe('clearAllArchived', () => {
  it('drops every archived row and keeps every active row', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        { id: 2, url: 'b', title: 'B', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 0, archived: 1, archived_at: '2026-04-02' },
        { id: 3, url: 'c', title: 'C', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 0, checked_at: null, dismissed: 1, archived: 1, archived_at: '2026-04-03' },
      ],
    });
    const { deleted } = await clearAllArchived();
    expect(deleted).toBe(2);
    const rows = store.get('deferredTabs');
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it('returns deleted:0 and does not write storage when the archive is already empty', async () => {
    const { local } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    const result = await clearAllArchived();
    expect(result).toEqual({ success: true, deleted: 0 });
    expect(local.set).not.toHaveBeenCalled();
  });
});

// ─── restoreArchived (v2.2.0) ───────────────────────────────────────────────
//
// Restore moves an archived row back to active. Flags reset to the "fresh
// save" shape (archived=0, archived_at=null, checked=0, checked_at=null,
// deferred_at=now) so getDeferred's 30-day age-out doesn't immediately
// re-archive it. URL collision with an active row folds into that row
// (refresh deferred_at) and drops the archive entry — preserving the
// activeByUrl invariant saveDefer relies on.

describe('restoreArchived', () => {
  it('resets flags + refreshes deferred_at when no active dupe exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
    const expected = new Date('2026-04-18T12:00:00Z').toISOString();

    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'https://a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 0, archived: 1, archived_at: '2026-04-02' },
      ],
    });
    const result = await restoreArchived(1);
    expect(result).toEqual({ success: true, merged: false });
    const rows = store.get('deferredTabs');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.archived).toBe(0);
    expect(row.archived_at).toBeNull();
    expect(row.checked).toBe(0);
    expect(row.checked_at).toBeNull();
    // Fake timers lock deferred_at to the frozen system time — no more
    // wall-clock [before, after] window that a slow CI / debugger break
    // could escape (matches the discipline used in the auto-prune tests
    // further down; this was the last Date.now() holdout in this file).
    expect(row.deferred_at).toBe(expected);
    vi.useRealTimers();
  });

  it('merges into the active dupe when one exists — archived row is dropped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
    const expected = new Date('2026-04-18T12:00:00Z').toISOString();

    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'https://dupe', title: 'old title', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 0, archived: 1, archived_at: '2026-04-02' },
        { id: 2, url: 'https://dupe', title: 'live title', favicon_url: null, source_mission: null, deferred_at: '2026-03-01', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    const result = await restoreArchived(1);
    expect(result).toEqual({ success: true, merged: true });
    const rows = store.get('deferredTabs');
    expect(rows).toHaveLength(1);
    const kept = rows[0];
    expect(kept.id).toBe(2);
    expect(kept.title).toBe('live title');
    expect(kept.deferred_at).toBe(expected);
    vi.useRealTimers();
  });

  it('throws when the id does not exist', async () => {
    installChromeStorage({ deferredTabs: [] });
    await expect(restoreArchived(999)).rejects.toThrow(/not found/);
  });

  it('resets dismissed=0 alongside archived/checked flags (v1-data safety)', async () => {
    // v1 SQLite allowed dismissed=1 rows; if a user migrated one sitting
    // in the archive (archived=1 && dismissed=1), restoreArchived without
    // this reset would produce archived=0 && dismissed=1 — a ghost
    // active row filtered out by getDeferred's dismissed===0 check.
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 9, url: 'https://ghost', title: 'Ghost', favicon_url: null, source_mission: null, deferred_at: '2026-04-01', checked: 1, checked_at: '2026-04-02', dismissed: 1, archived: 1, archived_at: '2026-04-02' },
      ],
    });
    await restoreArchived(9);
    const row = store.get('deferredTabs')[0];
    expect(row.dismissed).toBe(0);
    expect(row.archived).toBe(0);
    expect(row.checked).toBe(0);
  });

  it('refuses to restore an active (non-archived) row', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 7, url: 'https://u', title: 'u', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });
    await expect(restoreArchived(7)).rejects.toThrow(/not found/);
    // The row is unchanged — active rows are not silently repurposed.
    const rows = store.get('deferredTabs');
    expect(rows).toHaveLength(1);
    expect(rows[0].archived).toBe(0);
  });
});

// ─── getDeferred auto-prune (Bug 3 background safety net) ──────────────────
//
// Two thresholds stacked on top of the existing 30-day active age-out:
//   • archived rows older than ARCHIVE_MAX_AGE_MS (90 days) → dropped
//   • remaining archived count > ARCHIVE_MAX_COUNT (500) → drop oldest until cap

describe('getDeferred auto-prune', () => {
  it('drops archived rows older than 90 days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));

    const { store } = installChromeStorage({
      deferredTabs: [
        // 95 days old — should drop
        { id: 1, url: 'old', title: 'old', favicon_url: null, source_mission: null, deferred_at: '2026-04-20', checked: 1, checked_at: '2026-04-28', dismissed: 0, archived: 1, archived_at: '2026-04-28T00:00:00Z' },
        // 20 days old — keeps
        { id: 2, url: 'fresh', title: 'fresh', favicon_url: null, source_mission: null, deferred_at: '2026-07-10', checked: 1, checked_at: '2026-07-12', dismissed: 0, archived: 1, archived_at: '2026-07-12T00:00:00Z' },
      ],
    });

    const { archived } = await getDeferred();
    expect(archived.map((t) => t.id)).toEqual([2]);
    // Persisted — id 1 is gone from storage too
    expect(store.get('deferredTabs').map((t) => t.id)).toEqual([2]);
  });

  it('trims archived count down to ARCHIVE_MAX_COUNT (500) when exceeded, keeping the freshest', async () => {
    // 502 archived rows with sequential archived_at; freshest 500 must survive.
    const rows = Array.from({ length: 502 }, (_, i) => ({
      id: i + 1,
      url: `https://t${i}.test`,
      title: `T${i}`,
      favicon_url: null,
      source_mission: null,
      deferred_at: '2026-07-01',
      checked: 1,
      checked_at: '2026-07-02',
      dismissed: 0,
      archived: 1,
      // i=0 oldest; i=501 newest. Use padded number so string compare works.
      archived_at: `2026-07-02T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
    }));
    const { store } = installChromeStorage({ deferredTabs: rows });

    const { archived } = await getDeferred();
    expect(archived).toHaveLength(500);
    // The two oldest (i=0, i=1) are the ones gone
    const survivingIds = new Set(store.get('deferredTabs').map((r) => r.id));
    expect(survivingIds.has(1)).toBe(false);
    expect(survivingIds.has(2)).toBe(false);
    expect(survivingIds.has(3)).toBe(true);
    expect(survivingIds.has(502)).toBe(true);
  });

  it('does not write storage when the archive is within both thresholds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T00:00:00Z'));

    const { local } = installChromeStorage({
      deferredTabs: [
        // 10 archived rows, all fresh (< 90d), under the 500 cap — no prune expected
        ...Array.from({ length: 10 }, (_, i) => ({
          id: i + 1,
          url: `u${i}`,
          title: `u${i}`,
          favicon_url: null,
          source_mission: null,
          deferred_at: '2026-04-01',
          checked: 1,
          checked_at: '2026-04-02',
          dismissed: 0,
          archived: 1,
          archived_at: `2026-04-02T0${i}:00:00Z`,
        })),
      ],
    });

    await getDeferred();
    expect(local.set).not.toHaveBeenCalled();
  });
});

// ─── withLock — concurrent writes must not resurrect or lose rows ──────────
//
// Every public write goes through a module-level promise chain in api.ts.
// Without it, `Promise.all([dismissDeferred(1), dismissDeferred(2)])` would
// interleave: both calls read the same pre-write snapshot ([1,2,3]) and
// each writes back its own mutation ([2,3] and [1,3]), so the "last
// writer wins" leaves behind one of the rows we tried to drop.
//
// We don't assert the internal chain — that's an implementation detail.
// We assert the observable invariant: the final storage state matches
// what a serial execution would produce.

describe('serialized writes (withLock) — concurrent clicks do not race', () => {
  it('two rapid dismissDeferred calls both take effect', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        { id: 2, url: 'b', title: 'B', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
        { id: 3, url: 'c', title: 'C', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });

    // Fire both before awaiting — the classic RMW race pattern.
    await Promise.all([dismissDeferred(1), dismissDeferred(2)]);

    const rows = store.get('deferredTabs');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(3);
  });

  it('saveDefer concurrent with dismissDeferred: both effects land', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });

    const [, saveResult] = await Promise.all([
      dismissDeferred(1),
      saveDefer([{ url: 'b', title: 'B' }]),
    ]);

    expect(saveResult.created).toHaveLength(1);
    const rows = store.get('deferredTabs');
    expect(rows.find((r) => r.id === 1)).toBeUndefined();
    expect(rows.find((r) => r.url === 'b')).toBeDefined();
  });

  it('a rejected write does not poison later ones (chain recovers)', async () => {
    const { store } = installChromeStorage({
      deferredTabs: [
        { id: 1, url: 'a', title: 'A', favicon_url: null, source_mission: null, deferred_at: '2026-04-10', checked: 0, checked_at: null, dismissed: 0, archived: 0, archived_at: null },
      ],
    });

    // First call throws (id 99 doesn't exist); second call on a real id
    // must still succeed and mutate storage, proving the chain head
    // cleared the rejection.
    const results = await Promise.allSettled([
      dismissDeferred(99),
      dismissDeferred(1),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(store.get('deferredTabs')).toHaveLength(0);
  });
});

// ─── chrome.storage unavailable ─────────────────────────────────────────────

describe('chrome.storage missing', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
  });
  it('throws a clear error from any function (caller wraps in try/catch)', async () => {
    await expect(getDeferred()).rejects.toThrow(/unavailable/);
    await expect(saveDefer([{ url: 'u', title: 't' }])).rejects.toThrow(
      /unavailable/,
    );
  });
});
