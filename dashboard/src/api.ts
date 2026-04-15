// dashboard/src/api.ts
//
// Phase 3 — Tab Out API client.
//
// PR H: All 10 functions internally call `fetch('/api/...')` against the
// existing localhost:3456 server. Behavior identical to the inline fetches
// they will replace in PR I.
//
// PR I: handlers / renderers / index / extension-bridge swap their inline
// fetch for these helpers (no behavioral change).
//
// PR J: Internal implementation swaps from fetch to chrome.storage.local
// after PR K moves the dashboard into extension context.
//
// All functions throw on HTTP error. Callers handle (matches the existing
// try/catch style across handlers).

// ─── Types (mirror server/routes.js + server/db.js shapes) ──────────────────

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

// ─── HTTP helpers ───────────────────────────────────────────────────────────

const API_BASE = '/api';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

// ─── Mission endpoints ──────────────────────────────────────────────────────

export function getMissions(): Promise<Mission[]> {
  return getJson<Mission[]>('/missions');
}

export function dismissMission(id: string): Promise<{ success: true }> {
  return postJson<{ success: true }>(
    `/missions/${encodeURIComponent(id)}/dismiss`,
  );
}

export function archiveMission(id: string): Promise<{ success: true }> {
  return postJson<{ success: true }>(
    `/missions/${encodeURIComponent(id)}/archive`,
  );
}

// ─── Stats / update ─────────────────────────────────────────────────────────

export function getStats(): Promise<Stats> {
  return getJson<Stats>('/stats');
}

export function getUpdateStatus(): Promise<UpdateStatus> {
  return getJson<UpdateStatus>('/update-status');
}

// ─── Deferred-tabs endpoints ────────────────────────────────────────────────

export function saveDefer(tabs: DeferInput[]): Promise<SaveDeferResult> {
  return postJson<SaveDeferResult>('/defer', { tabs });
}

export function getDeferred(): Promise<DeferredListResult> {
  return getJson<DeferredListResult>('/deferred');
}

export function searchDeferred(q: string): Promise<SearchDeferredResult> {
  return getJson<SearchDeferredResult>(
    `/deferred/search?q=${encodeURIComponent(q)}`,
  );
}

export function checkDeferred(id: number | string): Promise<{ success: true }> {
  return patchJson<{ success: true }>(
    `/deferred/${encodeURIComponent(String(id))}`,
    { checked: true },
  );
}

export function dismissDeferred(
  id: number | string,
): Promise<{ success: true }> {
  return patchJson<{ success: true }>(
    `/deferred/${encodeURIComponent(String(id))}`,
    { dismissed: true },
  );
}
