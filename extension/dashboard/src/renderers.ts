// Dashboard rendering surface.
//
// Barrel over the two rendering domains:
//   - renderers/domain-cards.ts — open-tabs grid + page chips + section
//     header/body, plus the pure transform that groups tabs by hostname
//     before any DOM is touched.
//   - renderers/deferred.ts — saved-for-later active/archive rows + the
//     coordinator that repaints the column on each deferredTabs change.
//   - renderers/domain-aliases.ts — DOMAIN_ALIASES lookup table,
//     re-exported through domain-cards for one import path.
//
// `renderStaticDashboard` / `renderDashboard` live in this file because
// they compose both sub-domains (greeting + date header, then open-tabs
// grid, then deferred column) — they'd have to reach across the two
// submodules either way, so keeping the coordinator in the barrel avoids
// an arbitrary coordinator.ts file.

import { fetchOpenTabs } from './extension-bridge.js';
import { getDateDisplay, getGreeting } from './utils.js';
import { renderOpenTabsOnly } from './renderers/domain-cards.js';
import { renderDeferredColumn } from './renderers/deferred.js';

export {
  DOMAIN_ALIASES,
  buildOverflowChips,
  checkAndShowEmptyState,
  domainIdFor,
  effectiveDomain,
  groupTabsByDomain,
  refreshOpenTabsCounters,
  renderDomainCard,
  renderOpenTabsHeader,
  renderOpenTabsOnly,
  renderOpenTabsSection,
  renderPageChip,
  signatureForDomainCard,
} from './renderers/domain-cards.js';

export {
  renderArchiveItem,
  renderDeferredColumn,
  renderDeferredItem,
} from './renderers/deferred.js';

export async function renderStaticDashboard(): Promise<void> {
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  await fetchOpenTabs();
  await renderOpenTabsOnly();
  // Page-load entry — this is the only path that opts into the right-column
  // waterfall. Handler-driven re-renders call renderDeferredColumn() directly
  // without options, so they stay silent.
  await renderDeferredColumn({ waterfall: true });
}

export async function renderDashboard(): Promise<void> {
  await renderStaticDashboard();
}
