// extension/dashboard/src/api.ts
//
// Phase 3 PR J — Tab Out data layer backed by chrome.storage.local.
// Phase 4 PR-A — mission surface removed; deferred-tabs is the only feature.
//
// KV layout:
//   deferredTabs   DeferredTab[]          ← saved-for-later list
//
// All callers already wrap us in try/catch (see handlers.ts), so we throw
// freely when chrome.storage is missing — this also surfaces dev-mode usage
// outside an extension context as a loud failure rather than silent corruption.
//
// The 30-day age-out for deferred tabs runs as a read-time side effect inside
// getDeferred(): the first call after midnight on day 31 archives the row and
// writes the result back. This mirrors the old SQL ageOutDeferred behaviour.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeferredTab {
  id: number;
  url: string;
  title: string;
  favicon_url: string | null;
  // v1 legacy field, preserved for backwards-read compat with existing stored rows.
  source_mission: string | null;
  deferred_at: string;
  checked: 0 | 1;
  checked_at: string | null;
  dismissed: 0 | 1;
  archived: 0 | 1;
  archived_at: string | null;
}

export interface DeferredCreated {
  id: number;
  url: string;
  title: string;
  favicon_url: string | null;
  // v1 legacy field, preserved for backwards-read compat with existing stored rows.
  source_mission: string | null;
  deferred_at: string;
}

export interface DeferInput {
  url: string;
  title: string;
  favicon_url?: string | null;
  // v1 legacy field, preserved for backwards-read compat with existing stored rows.
  source_mission?: string | null;
}

export interface UpdateStatus {
  updateAvailable: boolean;
  currentTag?: string;
  checkedAt?: string;
}

export interface SaveDeferResult {
  success: true;
  // Rows that did not exist in the active list before this call.
  created: DeferredCreated[];
  // Rows whose url already lived in the active list — we refreshed their
  // deferred_at (so the 30d age-out resets) and left the rest untouched.
  // Archived rows with the same url are ignored here; active/archive are
  // independent histories.
  renewed: DeferredCreated[];
}

export interface DeferredListResult {
  active: DeferredTab[];
  archived: DeferredTab[];
}

export interface SearchDeferredResult {
  results: DeferredTab[];
}

// ─── chrome.storage.local helpers ──────────────────────────────────────────

function storage(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local unavailable');
  }
  return chrome.storage.local;
}

async function readArray<T>(key: string): Promise<T[]> {
  const result = await storage().get(key);
  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

async function writeArray<T>(key: string, value: T[]): Promise<void> {
  await storage().set({ [key]: value });
}

// Reader used by every deferred-tabs endpoint. A previous v1 migration or a
// partial write during a service-worker kill could leave a row with null
// title/url; searchDeferred.toLowerCase() on null crashes the whole list.
// Filter at the boundary so the rest of the code can trust the shape.
// Only id/url/title are strictly required — other fields have safe
// defaults downstream (archived missing ⇒ treated as 0, archived_at
// missing ⇒ sort uses empty string fallback).
function isDeferredRow(x: unknown): x is DeferredTab {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<DeferredTab>;
  return typeof r.id === 'number'
    && typeof r.url === 'string'
    && typeof r.title === 'string';
}

async function readDeferredTabs(): Promise<DeferredTab[]> {
  const raw = await readArray<unknown>('deferredTabs');
  return raw.filter(isDeferredRow);
}

// Serialize every read-modify-write against deferredTabs. The dashboard is a
// single page but user clicks (e.g. rapid ✕ on two saved rows, or a
// concurrent age-out tick during a check) can still interleave:
//
//   click A → readDeferredTabs() → yield event loop
//   click B → readDeferredTabs() → yield event loop
//   A writes back minus row A
//   B writes back minus row B — but B's snapshot still contained row A,
//     so A just resurrected.
//
// withLock chains each write onto the previous one's completion. The failure
// path re-invokes fn on the next call (so one rejected write doesn't poison
// the chain) while still surfacing this call's own error through the
// returned promise. Reads that don't mutate (searchDeferred, getUpdateStatus)
// stay lock-free.
let pendingWrite: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = pendingWrite.then(fn, fn);
  pendingWrite = next.catch(() => {});
  return next;
}

// ─── ID generation (replaces SQLite AUTOINCREMENT) ─────────────────────────
// Date.now()*1000 + random is the *candidate* for a fresh id. We then bump
// it past the last id we handed out to guarantee strict monotonicity within
// the running module. Without this, a single saveDefer({n}) loop fires
// newId() N times in the same millisecond — birthday collisions over a 1000-
// slot space hit ~19% at N=20 and ~71% at N=50, and a colliding id would
// make checkDeferred/dismissDeferred update multiple rows at once.
// Math.max(candidate, lastId+1) handles both the in-tick bump and the
// cross-tick / cross-SW-restart case (Date.now() always wins by then).

let lastId = 0;
function newId(): number {
  const candidate = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  lastId = Math.max(candidate, lastId + 1);
  return lastId;
}

// ─── Update status ──────────────────────────────────────────────────────────

// Shape written by background.js checkForUpdate(). All fields optional
// because a fresh install may have no key yet. Tags (release tag_name)
// rather than commit shas so non-release pushes don't trigger the banner.
interface UpdateStatusStorage {
  updateAvailable?: boolean;
  latestTag?: string;
  currentTag?: string;
  checkedAt?: string;
  dismissedTag?: string | null;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return { updateAvailable: false };
    }
    const result = await chrome.storage.local.get('tabout:updateStatus');
    const s = (result as Record<string, UpdateStatusStorage>)['tabout:updateStatus'];
    if (!s) return { updateAvailable: false };
    // Banner stays dismissed until a *new* release comes out (dismissedTag
    // tracks the last latestTag the user dismissed against).
    const suppressedByDismiss = s.dismissedTag != null && s.dismissedTag === s.latestTag;
    return {
      updateAvailable: Boolean(s.updateAvailable) && !suppressedByDismiss,
      currentTag: s.currentTag,
      checkedAt: s.checkedAt,
    };
  } catch {
    return { updateAvailable: false };
  }
}

// ─── Deferred-tabs endpoints ────────────────────────────────────────────────

const AGE_OUT_MS = 30 * 24 * 60 * 60 * 1000;
// Archive auto-prune thresholds. chrome.storage.local is 10 MB total and
// every read pulls the whole deferredTabs array, so we cap long-term growth
// to two stacked limits: age (>90 days since archive) and count (keep only
// the freshest 500 archived rows). The 30-day age-out above still operates
// independently on *active* rows — this only trims the archive tail.
const ARCHIVE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const ARCHIVE_MAX_COUNT = 500;

export function saveDefer(
  inputs: DeferInput[],
): Promise<SaveDeferResult> {
  return withLock(async () => {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('tabs array is required');
  }

  const all = await readDeferredTabs();
  const created: DeferredCreated[] = [];
  const renewed: DeferredCreated[] = [];
  const now = new Date().toISOString();

  // Build an index of active rows once, keyed by url. Pre-existing duplicates
  // in storage (from the pre-dedup era) will collapse to the first match;
  // that's acceptable — we only need one hit to decide "already saved".
  const activeByUrl = new Map<string, DeferredTab>();
  for (const t of all) {
    if (t.archived === 0 && !activeByUrl.has(t.url)) activeByUrl.set(t.url, t);
  }

  for (const tab of inputs) {
    if (!tab.url || !tab.title) continue;
    const existing = activeByUrl.get(tab.url);
    if (existing) {
      // Refresh timestamp only. Leaving title/favicon alone avoids a fresh
      // save-action (which may carry stale dataset attrs) from clobbering
      // better data the row already holds.
      existing.deferred_at = now;
      renewed.push({
        id: existing.id,
        url: existing.url,
        title: existing.title,
        favicon_url: existing.favicon_url,
        source_mission: existing.source_mission,
        deferred_at: existing.deferred_at,
      });
      continue;
    }
    const id = newId();
    const row: DeferredTab = {
      id,
      url: tab.url,
      title: tab.title,
      favicon_url: tab.favicon_url ?? null,
      source_mission: tab.source_mission ?? null,
      deferred_at: now,
      checked: 0,
      checked_at: null,
      dismissed: 0,
      archived: 0,
      archived_at: null,
    };
    all.push(row);
    // Register so a repeated url within the same inputs batch dedupes too.
    activeByUrl.set(row.url, row);
    created.push({
      id,
      url: row.url,
      title: row.title,
      favicon_url: row.favicon_url,
      source_mission: row.source_mission,
      deferred_at: row.deferred_at,
    });
  }

  await writeArray('deferredTabs', all);
  return { success: true, created, renewed };
  });
}

export function getDeferred(): Promise<DeferredListResult> {
  return withLock(async () => {
  const now = Date.now();
  const all = await readDeferredTabs();
  const ageOutCutoff = now - AGE_OUT_MS;
  const archivedAt = new Date(now).toISOString();
  let changed = false;

  // 1) Age-out: active rows untouched for 30d become archived.
  for (const t of all) {
    if (
      t.archived === 0 &&
      t.checked === 0 &&
      t.dismissed === 0 &&
      new Date(t.deferred_at).getTime() < ageOutCutoff
    ) {
      t.archived = 1;
      t.archived_at = archivedAt;
      changed = true;
    }
  }

  // 2) Archive auto-prune: drop rows older than ARCHIVE_MAX_AGE_MS, then
  // trim the remainder by keeping only the freshest ARCHIVE_MAX_COUNT.
  // Both passes run on the live `all` array so we never re-walk storage.
  const archiveCutoff = now - ARCHIVE_MAX_AGE_MS;
  const dropIds = new Set<number>();
  for (const t of all) {
    if (t.archived !== 1) continue;
    const at = t.archived_at ? new Date(t.archived_at).getTime() : now;
    if (at < archiveCutoff) dropIds.add(t.id);
  }
  if (dropIds.size > 0) changed = true;

  const remainingArchived = all
    .filter((t) => t.archived === 1 && !dropIds.has(t.id))
    .sort((a, b) => (a.archived_at || '').localeCompare(b.archived_at || ''));
  if (remainingArchived.length > ARCHIVE_MAX_COUNT) {
    const excess = remainingArchived.length - ARCHIVE_MAX_COUNT;
    for (let i = 0; i < excess; i++) dropIds.add(remainingArchived[i].id);
    changed = true;
  }

  const kept = dropIds.size > 0
    ? all.filter((t) => !dropIds.has(t.id))
    : all;

  if (changed) await writeArray('deferredTabs', kept);

  // Server ordered active by deferred_at DESC and archived by archived_at DESC.
  const active = kept
    .filter((t) => t.archived === 0)
    .sort((a, b) => b.deferred_at.localeCompare(a.deferred_at));
  const archived = kept
    .filter((t) => t.archived === 1)
    .sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));

  return { active, archived };
  });
}

export async function searchDeferred(q: string): Promise<SearchDeferredResult> {
  if (!q || q.length < 2) return { results: [] };

  const needle = q.toLowerCase();
  const all = await readDeferredTabs();
  const results = all
    .filter((t) => t.archived === 1)
    .filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        t.url.toLowerCase().includes(needle),
    )
    .sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''))
    .slice(0, 50);

  return { results };
}

export function checkDeferred(
  id: number | string,
): Promise<{ success: true }> {
  return withLock(async () => {
    const target = String(id);
    const all = await readDeferredTabs();
    const t = all.find((row) => String(row.id) === target);
    if (!t) throw new Error(`deferred ${id} not found`);
    const now = new Date().toISOString();
    t.checked = 1;
    t.checked_at = now;
    t.archived = 1;
    t.archived_at = now;
    await writeArray('deferredTabs', all);
    return { success: true };
  });
}

// ✕ button on active rows — permanent deletion, no archive trail.
// Archive population paths: (1) checkbox via checkDeferred, (2) 30-day age-out
// in getDeferred. v2.2.0 adds a third path back: restoreArchived moves a row
// from archived to active, so archive semantics widened from "completed" to
// "completed, reviewed, or paused".
export function dismissDeferred(
  id: number | string,
): Promise<{ success: true }> {
  return withLock(async () => {
    const target = String(id);
    const all = await readDeferredTabs();
    const idx = all.findIndex((row) => String(row.id) === target);
    if (idx === -1) throw new Error(`deferred ${id} not found`);
    all.splice(idx, 1);
    await writeArray('deferredTabs', all);
    return { success: true };
  });
}

// Permanent deletion of a single archived row.
export function deleteArchived(
  id: number | string,
): Promise<{ success: true }> {
  return withLock(async () => {
    const target = String(id);
    const all = await readDeferredTabs();
    const idx = all.findIndex(
      (row) => String(row.id) === target && row.archived === 1,
    );
    if (idx === -1) throw new Error(`archived ${id} not found`);
    all.splice(idx, 1);
    await writeArray('deferredTabs', all);
    return { success: true };
  });
}

// Move an archived row back to active. If an active row with the same URL
// already exists, merge by refreshing that row's deferred_at and dropping
// the archived entry; otherwise clear archive/check flags and reset
// deferred_at to now (so getDeferred's 30-day age-out doesn't immediately
// re-archive it).
export function restoreArchived(
  id: number | string,
): Promise<{ success: true; merged: boolean }> {
  return withLock(async () => {
    const target = String(id);
    const all = await readDeferredTabs();
    const archivedIdx = all.findIndex(
      (row) => String(row.id) === target && row.archived === 1,
    );
    if (archivedIdx === -1) throw new Error(`archived ${id} not found`);
    const row = all[archivedIdx];
    const now = new Date().toISOString();

    const activeDupe = all.find(
      (r) => r.url === row.url && r.archived === 0,
    );
    if (activeDupe) {
      activeDupe.deferred_at = now;
      all.splice(archivedIdx, 1);
      await writeArray('deferredTabs', all);
      return { success: true, merged: true };
    }

    row.archived = 0;
    row.archived_at = null;
    row.checked = 0;
    row.checked_at = null;
    row.deferred_at = now;
    await writeArray('deferredTabs', all);
    return { success: true, merged: false };
  });
}

// Bulk-delete every archived row. Active rows are preserved. Returns the
// deleted count so callers can surface "Cleared N archived tab(s)" toast.
export function clearAllArchived(): Promise<{
  success: true;
  deleted: number;
}> {
  return withLock(async () => {
    const all = await readDeferredTabs();
    const remaining = all.filter((t) => t.archived === 0);
    const deleted = all.length - remaining.length;
    if (deleted > 0) await writeArray('deferredTabs', remaining);
    return { success: true, deleted };
  });
}
