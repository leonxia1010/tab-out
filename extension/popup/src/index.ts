// Tab Out toolbar popup — three quick-action buttons reachable from any
// page. Per-window scope mirrors the dashboard's v2.5.0 semantics. Popup
// closes on every action click (window.close()) so no undo affordance is
// offered; undo stays a dashboard-only flow.
//
// Fire-and-forget dispatch (added after the v2.7.x close-all "click
// twice" bug): renderCounts pre-caches tabs + settings on mount, so
// dispatchAction is purely synchronous — it computes the work from the
// cached state and fires chrome.tabs.* IPC messages all in one tick.
// handleClick calls window.close() immediately after; the IPC messages
// are already queued in the browser process so they execute even
// though the popup's V8 context is torn down. Without this, close-all
// would await chrome.tabs.create({newtab}) before chrome.tabs.remove(),
// the new tab would steal focus, chrome would auto-close the popup, and
// the remove() call never ran — first click only created Tab Out, user
// had to click again to actually close the rest.

import {
  closeAllExceptTabout,
  closeDuplicates,
  countCloseable,
  countDuplicates,
  countOrganizeMoves,
  organizeTabs,
} from '../../shared/dist/tab-ops.js';
import { groupTabsByDomain } from '../../shared/dist/domain-grouping.js';
import { getSettings } from '../../shared/dist/settings.js';

type Settings = Awaited<ReturnType<typeof getSettings>>;

export type Action = 'close-all' | 'close-dupes' | 'organize';

interface ButtonSpec {
  id: string;
  action: Action;
  label: (count: number) => string;
}

// When count is 0 the button is disabled anyway; "Close all 0 tabs" reads
// awkwardly, so drop the "0 " in that state and keep the action name
// clean. Singular / plural switches kick in at 1+.
const BUTTONS: ButtonSpec[] = [
  {
    id: 'popup-close-all',
    action: 'close-all',
    label: (n) => (n === 0
      ? 'Close all tabs (keep Tab Out)'
      : `Close all ${n} tab${n === 1 ? '' : 's'} (keep Tab Out)`),
  },
  {
    id: 'popup-close-dupes',
    action: 'close-dupes',
    label: (n) => (n === 0
      ? 'Close duplicates'
      : `Close all ${n} duplicate${n === 1 ? '' : 's'}`),
  },
  {
    id: 'popup-organize',
    action: 'organize',
    label: (n) => (n === 0
      ? 'Organize tabs'
      : `Organize ${n} tab${n === 1 ? '' : 's'}`),
  },
];

async function queryTabs(): Promise<chrome.tabs.Tab[]> {
  if (typeof chrome === 'undefined' || !chrome?.tabs) return [];
  return chrome.tabs.query({ currentWindow: true });
}

function renderButton(id: string, label: string, enabled: boolean): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return;
  // Only rewrite the label span — the button's SVG icon is static in
  // the HTML shell and must survive each render.
  const labelEl = btn.querySelector<HTMLElement>('.popup-btn__label');
  if (labelEl) labelEl.textContent = label;
  else btn.textContent = label;
  btn.disabled = !enabled;
}

// Cache populated by renderCounts. dispatchAction reads these synchronously
// — no chrome.tabs.query / no getSettings / no awaits before the chrome.tabs.*
// IPC message dispatches. Required for fire-and-forget popup teardown.
let cachedTabs: ReadonlyArray<chrome.tabs.Tab> = [];
let cachedSettings: Settings | null = null;

export async function renderCounts(): Promise<void> {
  const [tabs, settings] = await Promise.all([queryTabs(), getSettings()]);
  cachedTabs = tabs;
  cachedSettings = settings;
  const counts: Record<Action, number> = {
    'close-all': countCloseable(tabs),
    'close-dupes': countDuplicates(tabs),
    'organize': countOrganizeMoves(tabs),
  };
  for (const spec of BUTTONS) {
    const n = counts[spec.action];
    renderButton(spec.id, spec.label(n), n > 0);
  }
}

// Sync — returns once the chrome.tabs.* IPC messages have been queued for
// the browser process. Does not await the returned promises; the popup
// will be torn down immediately after handleClick fires window.close()
// and awaits would never resolve, but the queued IPC commands execute in
// the browser process regardless.
export function dispatchAction(action: Action): void {
  if (cachedTabs.length === 0) return;
  switch (action) {
    case 'close-all':
      // closeAllExceptTabout fires create + remove in the same tick when
      // preloadedTabs is supplied. We don't await — popup is closing.
      void closeAllExceptTabout(cachedTabs);
      return;
    case 'close-dupes': {
      // closeDuplicates is URL-driven. Feed every URL with ≥2 copies (the
      // function itself re-counts and keeps the pinned/active/first tab).
      const urlCounts: Record<string, number> = {};
      for (const t of cachedTabs) {
        if (!t.url) continue;
        urlCounts[t.url] = (urlCounts[t.url] ?? 0) + 1;
      }
      const dupeUrls = Object.entries(urlCounts)
        .filter(([, c]) => c > 1)
        .map(([u]) => u);
      if (dupeUrls.length > 0) void closeDuplicates(dupeUrls, cachedTabs);
      return;
    }
    case 'organize': {
      if (!cachedSettings) return;
      // chrome.tabs.Tab is structurally compatible with our shared Tab
      // (Tab's index signature accepts any field). Cast via unknown to
      // satisfy strict mode without loosening Tab.
      const priority = new Set(cachedSettings.priorityHostnames);
      const groups = groupTabsByDomain(
        cachedTabs as unknown as Parameters<typeof groupTabsByDomain>[0],
        priority,
        cachedSettings.domainAliases,
      );
      void organizeTabs(groups, cachedTabs);
      return;
    }
  }
}

export function handleClick(e: MouseEvent): void {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const hit = target.closest<HTMLElement>('[data-action]');
  if (!hit) return;
  if (hit instanceof HTMLButtonElement && hit.disabled) return;
  const action = hit.dataset.action as Action | undefined;
  if (!action) return;
  e.preventDefault();
  // Fire chrome.tabs.* IPC, then immediately close the popup. The IPC
  // messages were queued synchronously in dispatchAction — they execute
  // in the browser process even after this V8 context dies.
  dispatchAction(action);
  window.close();
}

export async function init(): Promise<void> {
  document.addEventListener('click', handleClick);
  await renderCounts();
}

// Auto-boot on real page load. Guarded by a body dataset marker so
// repeated imports (jsdom test re-mounts) don't stack listeners.
if (typeof document !== 'undefined' && document.body) {
  if (!document.body.dataset.popupAutoBooted) {
    document.body.dataset.popupAutoBooted = '1';
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void init());
    } else {
      void init();
    }
  }
}
