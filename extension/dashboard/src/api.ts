// extension/dashboard/src/api.ts
//
// Phase 3 PR J — Tab Out data layer backed by chrome.storage.local.
//
// PR H/I introduced this module as a thin facade over the localhost server
// (10 functions matching the old REST endpoints). PR J rips out the fetch
// implementations and reads/writes chrome.storage.local directly. The public
// signatures stay byte-identical so handlers/renderers/index don't change.
//
// KV layout (4 keys total):
//   missions       Mission[]              ← legacy mission list (phase 4 decides fate)
//   archives       MissionArchive[]       ← archived mission snapshots
//   deferredTabs   DeferredTab[]          ← saved-for-later list (the active feature)
//   meta           { last_analysis: string | null }
//
// All callers already wrap us in try/catch (see handlers.ts), so we throw
// freely when chrome.storage is missing — this also surfaces dev-mode usage
// outside an extension context as a loud failure rather than silent corruption.
//
// The 30-day age-out for deferred tabs runs as a read-time side effect inside
// getDeferred(): the first call after midnight on day 31 archives the row and
// writes the result back. This mirrors server/db.js:347 which used the same
// "fix it on the next read" pattern via SQL ageOutDeferred.

// ─── Types (mirror the old server/db.js shapes) ────────────────────────────

export interface MissionUrl {
  id: number;
  mission_id: string;
  url: string;
  title: string | null;
  visit_count: number;
  last_visit: string | null;
}

export interface Mission {
  id: string;
  name: string;
  summary: string | null;
  status: 'active' | 'cooling' | 'abandoned';
  last_activity: string | null;
  created_at: string;
  updated_at: string;
  dismissed: 0 | 1;
  urls: MissionUrl[];
}

export interface MissionArchive {
  id: number;
  mission_id: string;
  mission_name: string;
  urls_json: string;
  archived_at: string;
}

export interface DeferredTab {
  id: number;
  url: string;
  title: string;
  favicon_url: string | null;
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
  source_mission: string | null;
  deferred_at: string;
}

export interface DeferInput {
  url: string;
  title: string;
  favicon_url?: string | null;
  source_mission?: string | null;
}

export interface Stats {
  totalMissions: number;
  totalUrls: number;
  abandonedMissions: number;
  lastAnalysis: string | null;
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

interface MetaShape {
  last_analysis: string | null;
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

async function readMeta(): Promise<MetaShape> {
  const result = await storage().get('meta');
  const value = (result as Record<string, unknown>).meta;
  if (value && typeof value === 'object') return value as MetaShape;
  return { last_analysis: null };
}

// ─── ID generation (replaces SQLite AUTOINCREMENT) ─────────────────────────
// Date.now()*1000 + random gives us a monotonically-increasing 64-bit-ish
// number per call. Two simultaneous saves in the same millisecond stay
// disjoint via the 0-999 random suffix. Phase 3 accepts the tiny collision
// risk (1/1000 within a single ms) since deferred-tab volume is low.

function newId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// ─── Mission endpoints ──────────────────────────────────────────────────────

const STATUS_PRIORITY: Record<Mission['status'], number> = {
  active: 1,
  cooling: 2,
  abandoned: 3,
};

export async function getMissions(): Promise<Mission[]> {
  const all = await readArray<Mission>('missions');
  return all
    .filter((m) => m.dismissed === 0)
    .sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 4;
      const pb = STATUS_PRIORITY[b.status] ?? 4;
      if (pa !== pb) return pa - pb;
      const la = a.last_activity || '';
      const lb = b.last_activity || '';
      return lb.localeCompare(la);
    });
}

export async function dismissMission(id: string): Promise<{ success: true }> {
  const all = await readArray<Mission>('missions');
  const now = new Date().toISOString();
  let changed = false;
  for (const m of all) {
    if (m.id === id && m.dismissed === 0) {
      m.dismissed = 1;
      m.updated_at = now;
      changed = true;
    }
  }
  if (changed) await writeArray('missions', all);
  return { success: true };
}

export async function archiveMission(id: string): Promise<{ success: true }> {
  const missions = await readArray<Mission>('missions');
  const target = missions.find((m) => m.id === id && m.dismissed === 0);
  if (!target) throw new Error(`mission ${id} not found`);

  const archives = await readArray<MissionArchive>('archives');
  archives.push({
    id: newId(),
    mission_id: target.id,
    mission_name: target.name,
    urls_json: JSON.stringify(target.urls || []),
    archived_at: new Date().toISOString(),
  });
  await writeArray('archives', archives);

  // Soft-delete the live mission after the archive write succeeds, matching
  // server/routes.js:128 ordering (archive first, then dismiss).
  target.dismissed = 1;
  target.updated_at = new Date().toISOString();
  await writeArray('missions', missions);

  return { success: true };
}

// ─── Stats / update ─────────────────────────────────────────────────────────

export async function getStats(): Promise<Stats> {
  const missions = await readArray<Mission>('missions');
  const active = missions.filter((m) => m.dismissed === 0);
  const totalUrls = active.reduce((sum, m) => sum + (m.urls?.length || 0), 0);
  const abandonedMissions = active.filter((m) => m.status === 'abandoned').length;
  const meta = await readMeta();

  return {
    totalMissions: active.length,
    totalUrls,
    abandonedMissions,
    lastAnalysis: meta.last_analysis,
  };
}

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
  const now = new Date().toISOString();
  let found = false;
  for (const t of all) {
    if (String(t.id) === target) {
      t.checked = 1;
      t.checked_at = now;
      t.archived = 1;
      t.archived_at = now;
      found = true;
    }
  }
  if (!found) throw new Error(`deferred ${id} not found`);
  await writeArray('deferredTabs', all);
  return { success: true };
}

export async function dismissDeferred(
  id: number | string,
): Promise<{ success: true }> {
  const target = String(id);
  const all = await readArray<DeferredTab>('deferredTabs');
  const now = new Date().toISOString();
  let found = false;
  for (const t of all) {
    if (String(t.id) === target) {
      t.dismissed = 1;
      t.archived = 1;
      t.archived_at = now;
      found = true;
    }
  }
  if (!found) throw new Error(`deferred ${id} not found`);
  await writeArray('deferredTabs', all);
  return { success: true };
}
