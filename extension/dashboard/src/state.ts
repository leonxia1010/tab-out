// Dashboard module-level state. Every mutable slice goes through
// getter/setter pairs so every write flows through a single call site;
// getters return ReadonlyArray to block in-place mutation from the outside.

import type { Tab as UtilsTab } from './utils.js';

export interface Tab extends UtilsTab {
  id?: number;
  isTabOut?: boolean;
  windowId?: number;
  active?: boolean;
  pinned?: boolean;
}

export interface DomainGroup {
  domain: string;
  tabs: Tab[];
}

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

// --- domainGroups: populated by the dashboard bootstrap; consumed by card actions ---
let domainGroups: DomainGroup[] = [];
export function getDomainGroups(): ReadonlyArray<DomainGroup> {
  return domainGroups;
}
export function setDomainGroups(groups: DomainGroup[]): void {
  domainGroups = groups;
}

