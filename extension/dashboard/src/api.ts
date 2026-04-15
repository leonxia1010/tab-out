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
  currentCommit?: string;
  checkedAt?: string;
}

export interface SaveDeferResult {
  success: true;
  deferred: DeferredCreated[];
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

export function getUpdateStatus(): Promise<UpdateStatus> {
  // Stub for phase 4. The old server/updater.js polled GitHub every 48h; phase 4
  // decides whether to delete the feature, move it to background.js, or run it
  // from the dashboard on load. Until then, never show the update banner.
  return Promise.resolve({ updateAvailable: false });
}

// ─── Deferred-tabs endpoints ────────────────────────────────────────────────

const AGE_OUT_MS = 30 * 24 * 60 * 60 * 1000;

export async function saveDefer(
  inputs: DeferInput[],
): Promise<SaveDeferResult> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('tabs array is required');
  }

  const all = await readArray<DeferredTab>('deferredTabs');
  const created: DeferredCreated[] = [];
  const now = new Date().toISOString();

  for (const tab of inputs) {
    if (!tab.url || !tab.title) continue;
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
  return { success: true, deferred: created };
}

export async function getDeferred(): Promise<DeferredListResult> {
  const all = await readArray<DeferredTab>('deferredTabs');
  const cutoff = Date.now() - AGE_OUT_MS;
  const archivedAt = new Date().toISOString();
  let changed = false;

  for (const t of all) {
    if (
      t.archived === 0 &&
      t.checked === 0 &&
      t.dismissed === 0 &&
      new Date(t.deferred_at).getTime() < cutoff
    ) {
      t.archived = 1;
      t.archived_at = archivedAt;
      changed = true;
    }
  }

  if (changed) await writeArray('deferredTabs', all);

  // Server ordered active by deferred_at DESC and archived by archived_at DESC.
  const active = all
    .filter((t) => t.archived === 0)
    .sort((a, b) => b.deferred_at.localeCompare(a.deferred_at));
  const archived = all
    .filter((t) => t.archived === 1)
    .sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));

  return { active, archived };
}

export async function searchDeferred(q: string): Promise<SearchDeferredResult> {
  if (!q || q.length < 2) return { results: [] };

  const needle = q.toLowerCase();
  const all = await readArray<DeferredTab>('deferredTabs');
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

export async function checkDeferred(
  id: number | string,
): Promise<{ success: true }> {
  const target = String(id);
  const all = await readArray<DeferredTab>('deferredTabs');
  const t = all.find((row) => String(row.id) === target);
  if (!t) throw new Error(`deferred ${id} not found`);
  const now = new Date().toISOString();
  t.checked = 1;
  t.checked_at = now;
  t.archived = 1;
  t.archived_at = now;
  await writeArray('deferredTabs', all);
  return { success: true };
}

export async function dismissDeferred(
  id: number | string,
): Promise<{ success: true }> {
  const target = String(id);
  const all = await readArray<DeferredTab>('deferredTabs');
  const t = all.find((row) => String(row.id) === target);
  if (!t) throw new Error(`deferred ${id} not found`);
  const now = new Date().toISOString();
  t.dismissed = 1;
  t.archived = 1;
  t.archived_at = now;
  await writeArray('deferredTabs', all);
  return { success: true };
}
