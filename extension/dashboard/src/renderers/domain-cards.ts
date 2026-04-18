// Open-tabs domain-card rendering: page chips, per-domain cards,
// section header/body, and the pure transform that groups tabs by
// hostname before any DOM is touched.

import { el, mount, svg } from '../../../shared/dist/dom-utils.js';
import { faviconUrl } from '../favicon.js';
import {
  cleanTitle,
  friendlyDomain,
  getDisplayableTabs,
  smartTitle,
  stripTitleNoise,
} from '../utils.js';
import { getOpenTabs, setDomainGroups } from '../state.js';
import type { DomainGroup, Tab } from '../state.js';
import { checkTabOutDupes } from '../extension-bridge.js';
import { DOMAIN_ALIASES, PRIORITY_HOSTNAMES, domainIdFor, effectiveDomain } from './domain-aliases.js';

export { DOMAIN_ALIASES, PRIORITY_HOSTNAMES, domainIdFor, effectiveDomain };

const ICONS = {
  tabs:    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>',
  close:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>',
  archive: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>',
  focus:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>',
  // Heroicons outline bars-arrow-down — bars + down arrow signals "sort
  // these into this order".
  sort:    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 4.5h14.25M3 9h9.75M3 13.5h9.75m4.5-4.5v12m0 0-3.75-3.75M17.25 21 21 17.25" /></svg>',
} as const;

const CHIP_SAVE_SVG  = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>';
const CHIP_CLOSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';

const EMPTY_CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>';

export function checkAndShowEmptyState(): void {
  const domainsEl = document.getElementById('openTabsDomains');
  if (!domainsEl) return;
  const remaining = domainsEl.querySelectorAll('.domain-card:not(.closing)').length;
  if (remaining > 0) return;
  mount(domainsEl, el('div', { className: 'domains-empty-state' }, [
    el('div', { className: 'empty-checkmark' }, [svg(EMPTY_CHECK_SVG)]),
    el('div', { className: 'empty-title', textContent: 'Inbox zero, but for tabs.' }),
    el('div', { className: 'empty-subtitle', textContent: "You're free." }),
  ]));
  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

export function renderPageChip(
  tab: Tab,
  label: string,
  urlCounts: Record<string, number> = {},
): HTMLElement {
  const tabUrl = tab.url || '';
  const count = urlCounts[tabUrl] || 1;

  const faviconSrc = faviconUrl(tabUrl, 16);

  const children: Array<Node | string | null | undefined | false> = [];

  if (faviconSrc) {
    const favicon = el('img', { className: 'chip-favicon', src: faviconSrc, alt: '' });
    favicon.addEventListener('error', () => { favicon.style.display = 'none'; });
    children.push(favicon);
  }

  children.push(el('span', { className: 'chip-text', textContent: label }));

  if (count > 1) {
    children.push(el('span', { className: 'chip-dupe-badge', textContent: ` (${count}x)` }));
  }

  const saveBtn = el('button', {
    className: 'chip-action chip-save',
    title: 'Save for later',
    dataset: { action: 'defer-single-tab', tabUrl, tabTitle: label },
  }, [svg(CHIP_SAVE_SVG)]);

  const closeBtn = el('button', {
    className: 'chip-action chip-close',
    title: 'Close this tab',
    dataset: { action: 'close-single-tab', tabUrl },
  }, [svg(CHIP_CLOSE_SVG)]);

  children.push(el('div', { className: 'chip-actions' }, [saveBtn, closeBtn]));

  const chipClass = count > 1
    ? 'page-chip clickable chip-has-dupes'
    : 'page-chip clickable';

  return el('div', {
    className: chipClass,
    title: label,
    dataset: { action: 'focus-tab', tabUrl },
  }, children);
}

export function buildOverflowChips(
  hiddenTabs: Tab[],
  urlCounts: Record<string, number> = {},
): [HTMLElement, HTMLElement] {
  const overflow = el('div', {
    className: 'page-chips-overflow',
    style: 'display:none',
  }, hiddenTabs.map(tab => {
    const label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url || ''), '');
    return renderPageChip(tab, label, urlCounts);
  }));

  const trigger = el('div', {
    className: 'page-chip page-chip-overflow clickable',
    dataset: { action: 'expand-chips' },
  }, [el('span', { className: 'chip-text', textContent: `+${hiddenTabs.length} more` })]);

  return [overflow, trigger];
}

// Signature captures the url set (with duplicates) of a card. Sorted
// urls inherently encode duplicate counts — adjacent matching entries
// — so a separate counts map would be redundant. JSON.stringify over a
// plain array keeps the dataset attribute debuggable in DevTools.
//
// renderDomainCard writes this into dataset.signature; diff.ts imports
// the same helper and string-compares against the stored value to
// decide whether a kept card needs rebuilding. Single source of truth
// keeps the two sides in lockstep. Title changes are intentionally NOT
// in the signature: refresh.ts already filters change.url, so a kept
// card with a stale title is the expected trade-off (same rationale as
// PR 1's hostname-based refresh signature).
export function signatureForDomainCard(group: DomainGroup): string {
  const urls = (group.tabs || []).map((t) => t.url || '').sort();
  return JSON.stringify(urls);
}

export function renderDomainCard(group: DomainGroup, groupIndex: number): HTMLElement {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const stableId  = domainIdFor(group.domain);

  const urlCounts: Record<string, number> = {};
  for (const tab of tabs) {
    const u = tab.url || '';
    urlCounts[u] = (urlCounts[u] || 0) + 1;
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = el('span', { className: 'open-tabs-badge' }, [
    svg(ICONS.tabs),
    ` ${tabCount} tab${tabCount !== 1 ? 's' : ''} open`,
  ]);

  const dupeBadge = hasDupes
    ? el('span', {
        className: 'open-tabs-badge',
        style: 'color: var(--accent-amber); background: rgba(200, 113, 58, 0.08);',
        textContent: `${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`,
      })
    : null;

  const seen = new Set<string>();
  const uniqueTabs: Tab[] = [];
  for (const tab of tabs) {
    const u = tab.url || '';
    if (!seen.has(u)) {
      seen.add(u);
      uniqueTabs.push(tab);
    }
  }
  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const chipNodes: HTMLElement[] = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url || ''), group.domain);
    try {
      const parsed = new URL(tab.url || '');
      if (parsed.hostname === 'localhost' && parsed.port) {
        label = `${parsed.port} ${label}`;
      }
    } catch {}
    return renderPageChip(tab, label, urlCounts);
  });

  if (extraCount > 0) {
    chipNodes.push(...buildOverflowChips(uniqueTabs.slice(8), urlCounts));
  }

  const actionsChildren: HTMLElement[] = [
    el('button', {
      className: 'action-btn close-tabs',
      dataset: { action: 'close-domain-tabs', domainId: stableId },
    }, [svg(ICONS.close), ` Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}`]),
  ];

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsChildren.push(el('button', {
      className: 'action-btn',
      dataset: { action: 'dedup-keep-one', dupeUrls: dupeUrlsEncoded },
      textContent: `Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`,
    }));
  }

  const statusBar = el('div', {
    className: 'status-bar',
    style: hasDupes ? 'background: var(--accent-amber);' : undefined,
  });

  const domainTopChildren: Array<Node | string | null | false | undefined> = [
    el('span', {
      className: 'domain-name',
      textContent: friendlyDomain(group.domain),
    }),
    tabBadge,
  ];
  if (dupeBadge) domainTopChildren.push(dupeBadge);

  const domainContent = el('div', { className: 'domain-content' }, [
    el('div', { className: 'domain-top' }, domainTopChildren),
    el('div', { className: 'domain-pages' }, chipNodes),
    el('div', { className: 'actions' }, actionsChildren),
  ]);

  const domainMeta = el('div', { className: 'domain-meta' }, [
    el('div', { className: 'domain-page-count', textContent: String(tabCount) }),
    el('div', { className: 'domain-page-label', textContent: 'tabs' }),
  ]);

  const card = el('div', {
    className: `domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}`,
    dataset: {
      domainId: stableId,
      signature: signatureForDomainCard(group),
    },
  }, [statusBar, domainContent, domainMeta]);

  // Waterfall fade-in: each card staggers 0.03s after the one before it,
  // starting at 0.15s (30ms stepping — was 50ms). Set inline so the
  // effect survives past the 4th card; the previous CSS hard-coded
  // nth-child(1..4) only and left card 5+ popping in instantly.
  card.style.animationDelay = `${(0.15 + groupIndex * 0.03).toFixed(2)}s`;

  return card;
}

export function groupTabsByDomain(realTabs: Tab[]): DomainGroup[] {
  const groupMap: Record<string, DomainGroup> = {};

  for (const tab of realTabs) {
    try {
      const url = tab.url || '';
      let hostname: string;
      if (url.startsWith('file://')) {
        hostname = 'local-files';
      } else if (url.startsWith('chrome://')) {
        hostname = '__chrome-internal__';
      } else if (url.startsWith('chrome-extension://')) {
        hostname = '__extensions__';
      } else {
        hostname = effectiveDomain(new URL(url).hostname);
      }
      if (!hostname) continue;
      if (!groupMap[hostname]) {
        groupMap[hostname] = { domain: hostname, tabs: [] };
      }
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  const groups = Object.values(groupMap);
  // Pre-compute first-seen indices once: sort's comparator is called
  // O(N log N) times, and firstIndex() is a linear scan over each
  // group's tabs — caching avoids the quadratic-ish O(N log N × k)
  // blow-up on users with many tabs per domain.
  const firstSeen = new Map<string, number>(
    groups.map((g) => [g.domain, firstIndex(g)]),
  );
  return groups.sort((a, b) => {
    // Priority tier: hostnames in PRIORITY_HOSTNAMES pin above the rest.
    // FUTURE: expose via the options page so each user picks their own
    // priority set (see claudedocs/ROADMAP.md).
    const aIsPriority = PRIORITY_HOSTNAMES.has(a.domain);
    const bIsPriority = PRIORITY_HOSTNAMES.has(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
    // Leaf tier: first-seen. A group's position is anchored to its
    // earliest-opened tab's chrome-tab index, so opening/closing tabs
    // on other domains doesn't reshuffle this card. This stability is
    // the precondition for PR 3's card-level diff — "order changed →
    // full re-render" (rule 4) would otherwise fire on every tab add.
    //
    // tab.index may be missing in tests/mocks or if chrome omits it;
    // Infinity pushes such groups to the end, which is harmless and
    // deterministic.
    return (firstSeen.get(a.domain) ?? Infinity) - (firstSeen.get(b.domain) ?? Infinity);
  });
}

function firstIndex(group: DomainGroup): number {
  let min = Infinity;
  for (const t of group.tabs) {
    const idx = typeof t.index === 'number' ? t.index : Infinity;
    if (idx < min) min = idx;
  }
  return min;
}

// Header = section title + "X domains · Close all N tabs". Split out so
// handlers can refresh the counters after a close action without wiping
// the domains grid (and clobbering in-flight card animations).
export function renderOpenTabsHeader(sortedGroups: DomainGroup[], realTabsCount: number): void {
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');

  if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';

  if (!openTabsSectionCount) return;
  if (sortedGroups.length === 0) {
    mount(openTabsSectionCount, []);
    return;
  }
  const closeAllBtn = el('button', {
    className: 'action-btn close-tabs',
    style: 'font-size:11px;padding:3px 10px;',
    dataset: { action: 'close-all-open-tabs' },
  }, [svg(ICONS.close), ` Close all ${realTabsCount} tabs`]);

  // v2.5.0 — cross-domain dedup button. Sums dupe counts across every
  // card so the user can clear the whole window's duplicate clutter in
  // one click instead of N per-card clicks.
  let totalDupes = 0;
  let dupeGroups = 0;
  for (const g of sortedGroups) {
    const urlCounts: Record<string, number> = {};
    for (const t of g.tabs) {
      const u = t.url || '';
      urlCounts[u] = (urlCounts[u] || 0) + 1;
    }
    const extras = Object.values(urlCounts).reduce((s, c) => s + (c > 1 ? c - 1 : 0), 0);
    if (extras > 0) {
      totalDupes += extras;
      dupeGroups += 1;
    }
  }

  const children: Node[] = [
    document.createTextNode(`${sortedGroups.length} domain${sortedGroups.length !== 1 ? 's' : ''}\u00a0\u00b7\u00a0`),
    closeAllBtn,
  ];
  if (totalDupes > 0) {
    const closeDupesBtn = el('button', {
      className: 'action-btn',
      style: 'font-size:11px;padding:3px 10px;margin-left:6px;',
      dataset: { action: 'close-all-dupes-global', totalDupes: String(totalDupes), dupeGroups: String(dupeGroups) },
    }, [svg(ICONS.close), ` Close all ${totalDupes} duplicate${totalDupes !== 1 ? 's' : ''}`]);
    children.push(closeDupesBtn);
  }
  // v2.5.0 — Organize button reorders the current window's tab bar to
  // match the card sort. Placed after Close/Dedup so the destructive
  // actions remain leftmost and the non-destructive reorder lands on
  // the right.
  const organizeBtn = el('button', {
    className: 'action-btn',
    style: 'font-size:11px;padding:3px 10px;margin-left:6px;',
    dataset: { action: 'organize-tabs' },
  }, [svg(ICONS.sort), ' Organize']);
  children.push(organizeBtn);
  mount(openTabsSectionCount, children);
}

export function renderOpenTabsSection(sortedGroups: DomainGroup[], realTabsCount: number): void {
  const openTabsSection    = document.getElementById('openTabsSection');
  const openTabsDomainsEl = document.getElementById('openTabsDomains');
  if (!openTabsSection) return;

  // Always reveal the section. When there are no domains to render we fall
  // back to the "inbox zero" empty state instead of hiding the whole column
  // — otherwise refreshing the dashboard while Tab Out is the only open tab
  // erases the affirmation the user just earned by closing everything.
  openTabsSection.style.display = 'block';

  if (sortedGroups.length > 0) {
    renderOpenTabsHeader(sortedGroups, realTabsCount);
    if (openTabsDomainsEl) {
      mount(openTabsDomainsEl, sortedGroups.map((g, idx) => renderDomainCard(g, idx)));
    }
  } else {
    if (openTabsDomainsEl) openTabsDomainsEl.replaceChildren();
    checkAndShowEmptyState();
  }
}

// Re-derive header counters + footer stat from the current openTabs snapshot.
// Called by close handlers after fetchOpenTabs() so the "X domains · Close all
// N tabs" badge and the footer "Open tabs" stat reflect reality without
// re-mounting the domains grid (which would yank cards mid-animation).
export function refreshOpenTabsCounters(): void {
  const realTabs = getDisplayableTabs(getOpenTabs());
  const sortedGroups = groupTabsByDomain(realTabs);
  setDomainGroups(sortedGroups);
  renderOpenTabsHeader(sortedGroups, realTabs.length);
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = String(getOpenTabs().length);
}

// Re-render only the open-tabs grid. Assumes openTabs is already in sync
// (refresh.ts awaits fetchOpenTabs before calling). No Save-for-later
// touch, no greeting/date rewrite — scoped to what chrome.tabs events can
// actually invalidate. Keeps external tab changes from flashing the right
// column.
export async function renderOpenTabsOnly(): Promise<void> {
  const realTabs = getDisplayableTabs(getOpenTabs());
  const sortedGroups = groupTabsByDomain(realTabs);
  setDomainGroups(sortedGroups);
  renderOpenTabsSection(sortedGroups, realTabs.length);

  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = String(getOpenTabs().length);

  checkTabOutDupes();
}
