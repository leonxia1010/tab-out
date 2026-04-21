// Dashboard module-level state. Every mutable slice goes through
// getter/setter pairs so every write flows through a single call site;
// getters return ReadonlyArray to block in-place mutation from the outside.

import type { DomainGroup, Tab } from '../../shared/dist/tab-types.js';
import { DEFAULT_PRIORITY_HOSTNAMES } from '../../shared/dist/domain-grouping.js';
export type { DomainGroup, Tab };

// --- openTabs: list of currently open browser tabs (populated by fetchOpenTabs) ---
let openTabs: Tab[] = [];
export function getOpenTabs(): ReadonlyArray<Tab> {
  return openTabs;
}
export function setOpenTabs(tabs: Tab[]): void {
  openTabs = tabs;
}

// --- extensionAvailable: true once a successful extension round-trip happens ---
let extensionAvailable = false;
export function getExtensionAvailable(): boolean {
  return extensionAvailable;
}
export function setExtensionAvailable(value: boolean): void {
  extensionAvailable = value;
}

// --- priorityHostnames: live set consulted by groupTabsByDomain -----------
// Seeded with defaults so the bootstrap race (renderDashboard and
// bootstrapSettings both run fire-and-forget in index.ts) can't paint an
// unsorted first frame when render resolves before settings load.
// bootstrapSettings overwrites with the stored list; onSettingsChange
// refreshes live.
let priorityHostnames: ReadonlySet<string> = new Set(DEFAULT_PRIORITY_HOSTNAMES);
export function getPriorityHostnames(): ReadonlySet<string> {
  return priorityHostnames;
}
export function setPriorityHostnames(next: ReadonlySet<string>): void {
  priorityHostnames = next;
}

// --- domainGroups: populated by the dashboard bootstrap; consumed by card actions ---
let domainGroups: DomainGroup[] = [];
export function getDomainGroups(): ReadonlyArray<DomainGroup> {
  return domainGroups;
}
export function setDomainGroups(groups: DomainGroup[]): void {
  domainGroups = groups;
}

// --- undoSnapshot: v2.5.0 "Organize tabs" one-shot undo buffer -------------
// In-memory only: lives for the lifetime of the dashboard tab. Closing
// the Tab Out page or navigating away discards it, matching the
// "undo while the toast is still visible" user mental model.
export interface UndoSnapshot {
  type: 'organize';
  timestamp: number;
  moves: Array<{ tabId: number; originalIndex: number }>;
}
let undoSnapshot: UndoSnapshot | null = null;
export function getUndoSnapshot(): UndoSnapshot | null {
  return undoSnapshot;
}
export function setUndoSnapshot(snap: UndoSnapshot | null): void {
  undoSnapshot = snap;
}

