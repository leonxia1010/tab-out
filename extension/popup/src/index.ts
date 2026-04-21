// Tab Out toolbar popup — three quick-action buttons reachable from any
// page. Per-window scope mirrors the dashboard's v2.5.0 semantics. Popup
// closes on every action click (window.close()) so no undo affordance is
// offered; undo stays a dashboard-only flow.

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

export async function renderCounts(): Promise<void> {
  const tabs = await queryTabs();
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

export async function dispatchAction(action: Action): Promise<void> {
  switch (action) {
    case 'close-all':
      await closeAllExceptTabout();
      return;
    case 'close-dupes': {
      const tabs = await queryTabs();
      // closeDuplicates is URL-driven. Feed every URL with ≥2 copies (the
      // function itself re-counts and keeps the pinned/active/first tab).
      const urlCounts: Record<string, number> = {};
      for (const t of tabs) {
        if (!t.url) continue;
        urlCounts[t.url] = (urlCounts[t.url] ?? 0) + 1;
      }
      const dupeUrls = Object.entries(urlCounts)
        .filter(([, c]) => c > 1)
        .map(([u]) => u);
      if (dupeUrls.length > 0) await closeDuplicates(dupeUrls);
      return;
    }
    case 'organize': {
      const [tabs, settings] = await Promise.all([queryTabs(), getSettings()]);
      // chrome.tabs.Tab is structurally compatible with our shared Tab
      // (Tab's index signature accepts any field). Cast via unknown to
      // satisfy strict mode without loosening Tab.
      const priority = new Set(settings.priorityHostnames);
      const groups = groupTabsByDomain(
        tabs as unknown as Parameters<typeof groupTabsByDomain>[0],
        priority,
      );
      await organizeTabs(groups);
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
  // Run the action, then close the popup. Popup context dies synchronously
  // on window.close(); any in-flight chrome.* calls continue in the
  // service worker / browser process, so the close + fire-and-forget
  // pattern is safe here.
  void dispatchAction(action).finally(() => window.close());
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
