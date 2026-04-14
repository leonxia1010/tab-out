// Tab Out dashboard — module-level state extracted from app.js (Phase 2 PR C).
//
// All previously global `let` variables now live here behind getter/setter
// pairs so every write to shared state goes through a single call site.
// Consumed by app.js via the window.state bridge (see src/index.ts) until
// PR G deletes app.js.

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
export function getOpenTabs(): Tab[] {
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

// --- domainGroups: populated by renderStaticDashboard(); consumed by card actions ---
let domainGroups: DomainGroup[] = [];
export function getDomainGroups(): DomainGroup[] {
  return domainGroups;
}
export function setDomainGroups(groups: DomainGroup[]): void {
  domainGroups = groups;
}

// --- duplicateTabs: legacy slot, currently unwritten; preserved for parity ---
let duplicateTabs: Tab[] = [];
export function getDuplicateTabs(): Tab[] {
  return duplicateTabs;
}
export function setDuplicateTabs(tabs: Tab[]): void {
  duplicateTabs = tabs;
}
