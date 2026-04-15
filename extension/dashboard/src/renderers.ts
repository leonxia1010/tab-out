// Tab Out dashboard — DOM renderers (Phase 2 PR E).
//
// All view code that builds DOM trees lives here. The 128-line
// renderStaticDashboard god-function is split into three pieces:
//   - groupTabsByDomain(): pure transform, no DOM
//   - renderOpenTabsSection(): paints the open-tabs grid
//   - renderStaticDashboard(): coordinator that fetches state then calls both
//
// checkAndShowEmptyState lives here too because it owns the empty-state DOM.
// app.js wraps animations.animateCardOut() to inject this callback so the
// animations slice stays renderer-free. PR G removes both the wrapper and
// the window.renderers bridge in one shot.

import { el, mount, svg } from './dom-utils.js';
import {
  cleanTitle,
  friendlyDomain,
  getDateDisplay,
  getGreeting,
  getDisplayableTabs,
  smartTitle,
  stripTitleNoise,
  timeAgo,
} from './utils.js';
import { getOpenTabs, setDomainGroups } from './state.js';
import type { DomainGroup, Tab } from './state.js';
import { checkTabOutDupes, fetchOpenTabs } from './extension-bridge.js';
import { getDeferred, type DeferredTab } from './api.js';

const ICONS = {
  tabs:    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>',
  close:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>',
  archive: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>',
  focus:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>',
} as const;

const CHIP_SAVE_SVG  = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>';
const CHIP_CLOSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';
const DEFERRED_DISMISS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';

interface LandingPagePattern {
  hostname: string;
  test?: (pathname: string, fullUrl: string) => boolean;
  pathPrefix?: string;
  pathExact?: string[];
}

const LANDING_PAGE_PATTERNS: LandingPagePattern[] = [
  { hostname: 'mail.google.com', test: (_p, h) =>
      !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
  { hostname: 'x.com',            pathExact: ['/home'] },
  { hostname: 'twitter.com',      pathExact: ['/home'] },
  { hostname: 'www.linkedin.com', pathExact: ['/'] },
  { hostname: 'github.com',       pathExact: ['/'] },
];

function isLandingPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LANDING_PAGE_PATTERNS.some(p => {
      if (parsed.hostname !== p.hostname) return false;
      if (p.test)       return p.test(parsed.pathname, url);
      if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
      if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
      return parsed.pathname === '/';
    });
  } catch { return false; }
}

// Explicit hostname → card-key aliases. Replaces the old endsWith('.' + root)
// logic for two reasons: (1) cross-TLD short links like b23.tv aren't
// subdomains of bilibili.com, so endsWith never matched them; (2) endsWith
// without a dot prefix risks fakebilibili.com getting folded into bilibili.
// Laying out each hostname by hand is the Linus-esque "dumb but clear" fix —
// new subdomains get one line each, no clever matching required.
// Don't add google.com aliases — Gmail / Docs / Drive stay separate cards on
// purpose via FRIENDLY_DOMAINS.
const DOMAIN_ALIASES: Record<string, string> = {
  // Bilibili — subdomains + b23.tv share shortlink
  'www.bilibili.com':    'bilibili.com',
  'search.bilibili.com': 'bilibili.com',
  'm.bilibili.com':      'bilibili.com',
  'live.bilibili.com':   'bilibili.com',
  't.bilibili.com':      'bilibili.com',
  'space.bilibili.com':  'bilibili.com',
  'b23.tv':              'bilibili.com',

  // YouTube — www / mobile / youtu.be share shortlink.
  // music.youtube.com stays separate on purpose (FRIENDLY_DOMAINS → "YouTube Music").
  'www.youtube.com':     'youtube.com',
  'm.youtube.com':       'youtube.com',
  'youtu.be':            'youtube.com',

  // Twitter / X — Musk rename left both domains live; collapse to x.com (current
  // official name). twitter.com/home still lands in Homepages via LANDING_PAGE_PATTERNS.
  'www.x.com':           'x.com',
  'twitter.com':         'x.com',
  'www.twitter.com':     'x.com',

  // Taobao + Tmall — same Alibaba commerce; users treat "逛淘宝/逛天猫" as one shopping card.
  'www.taobao.com':      'taobao.com',
  's.taobao.com':        'taobao.com',
  'item.taobao.com':     'taobao.com',
  'tmall.com':           'taobao.com',
  'www.tmall.com':       'taobao.com',
  'detail.tmall.com':    'taobao.com',

  // JD — legacy 360buy + regional jd.hk fold into jd.com.
  'www.jd.com':          'jd.com',
  'item.jd.com':         'jd.com',
  'jd.hk':               'jd.com',
  '360buy.com':          'jd.com',

  // Amazon — regional storefronts (.co.jp / .de / .fr / …) fold into amazon.com.
  // Trade-off: loses "which region" visibility; user opted for brand-level grouping.
  'www.amazon.com':      'amazon.com',
  'amazon.co.jp':        'amazon.com',
  'amazon.co.uk':        'amazon.com',
  'amazon.de':           'amazon.com',
  'amazon.fr':           'amazon.com',
  'amazon.cn':           'amazon.com',

  // Meta — vanity shortlinks fb.com / fb.me redirect to facebook.com.
  'www.facebook.com':    'facebook.com',
  'm.facebook.com':      'facebook.com',
  'fb.com':              'facebook.com',
  'fb.me':               'facebook.com',
};

function effectiveDomain(hostname: string): string {
  return DOMAIN_ALIASES[hostname] ?? hostname;
}

export function checkAndShowEmptyState(): void {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;
  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;
  // Developer-authored static SVG, no user data — innerHTML is safe.
  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;
  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 missions';
}

export function renderPageChip(
  tab: Tab,
  label: string,
  urlCounts: Record<string, number> = {},
): HTMLElement {
  const tabUrl = tab.url || '';
  const count = urlCounts[tabUrl] || 1;

  let domain = '';
  try { domain = new URL(tabUrl).hostname; } catch {}
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';

  const children: Array<Node | string | null | undefined | false> = [];

  if (faviconUrl) {
    const favicon = el('img', { className: 'chip-favicon', src: faviconUrl, alt: '' });
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

export function renderDomainCard(group: DomainGroup, _groupIndex: number): HTMLElement {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

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

  const missionTopChildren: Array<Node | string | null | false | undefined> = [
    el('span', {
      className: 'mission-name',
      textContent: isLanding ? 'Homepages' : friendlyDomain(group.domain),
    }),
    tabBadge,
  ];
  if (dupeBadge) missionTopChildren.push(dupeBadge);

  const missionContent = el('div', { className: 'mission-content' }, [
    el('div', { className: 'mission-top' }, missionTopChildren),
    el('div', { className: 'mission-pages' }, chipNodes),
    el('div', { className: 'actions' }, actionsChildren),
  ]);

  const missionMeta = el('div', { className: 'mission-meta' }, [
    el('div', { className: 'mission-page-count', textContent: String(tabCount) }),
    el('div', { className: 'mission-page-label', textContent: 'tabs' }),
  ]);

  return el('div', {
    className: `mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}`,
    dataset: { domainId: stableId },
  }, [statusBar, missionContent, missionMeta]);
}

export function renderDeferredItem(item: DeferredTab): HTMLElement {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.deferred_at);
  const titleText = item.title || item.url;

  const checkbox = el('input', {
    type: 'checkbox',
    className: 'deferred-checkbox',
    dataset: { action: 'check-deferred', deferredId: item.id },
  });

  const favicon = el('img', {
    src: faviconUrl,
    alt: '',
    style: 'width:14px;height:14px;vertical-align:-2px;margin-right:4px',
  });
  favicon.addEventListener('error', () => { favicon.style.display = 'none'; });

  const link = el('a', {
    href: item.url,
    target: '_blank',
    rel: 'noopener',
    className: 'deferred-title',
    title: item.title || '',
  }, [favicon, titleText]);

  const meta = el('div', { className: 'deferred-meta' }, [
    el('span', { textContent: domain }),
    el('span', { textContent: ago }),
  ]);

  const dismiss = el('button', {
    className: 'deferred-dismiss',
    title: 'Dismiss',
    dataset: { action: 'dismiss-deferred', deferredId: item.id },
  }, [svg(DEFERRED_DISMISS_SVG)]);

  return el('div', {
    className: 'deferred-item',
    dataset: { deferredId: item.id },
  }, [checkbox, el('div', { className: 'deferred-info' }, [link, meta]), dismiss]);
}

export function renderArchiveItem(item: DeferredTab): HTMLElement {
  const ago = item.archived_at ? timeAgo(item.archived_at) : '';
  const titleText = item.title || item.url;

  const link = el('a', {
    href: item.url,
    target: '_blank',
    rel: 'noopener',
    className: 'archive-item-title',
    title: item.title || '',
    textContent: titleText,
  });

  return el('div', { className: 'archive-item' }, [
    link,
    el('span', { className: 'archive-item-date', textContent: ago }),
  ]);
}

export async function renderDeferredColumn(): Promise<void> {
  const column    = document.getElementById('deferredColumn');
  const list      = document.getElementById('deferredList');
  const empty     = document.getElementById('deferredEmpty');
  const countEl   = document.getElementById('deferredCount');
  const archiveEl = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const data = await getDeferred();

    const active   = data.active   || [];
    const archived = data.archived || [];

    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    if (active.length > 0 && list && empty && countEl) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      mount(list, active.map(renderDeferredItem));
      list.style.display = 'block';
      empty.style.display = 'none';
    } else if (list && empty && countEl) {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    if (archived.length > 0 && archiveEl && archiveCountEl && archiveList) {
      archiveCountEl.textContent = `(${archived.length})`;
      mount(archiveList, archived.map(renderArchiveItem));
      archiveEl.style.display = 'block';
    } else if (archiveEl) {
      archiveEl.style.display = 'none';
    }
  } catch (err) {
    console.warn('[tab-out] Could not load deferred tabs:', err);
    column.style.display = 'none';
  }
}

export function groupTabsByDomain(realTabs: Tab[]): DomainGroup[] {
  const groupMap: Record<string, DomainGroup> = {};
  const landingTabs: Tab[] = [];

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url || '')) {
        landingTabs.push(tab);
        continue;
      }
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

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname));
  return Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;
    const aIsPriority = landingHostnames.has(a.domain);
    const bIsPriority = landingHostnames.has(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
    return b.tabs.length - a.tabs.length;
  });
}

// Header = section title + "X domains · Close all N tabs". Split out so
// handlers can refresh the counters after a close action without wiping
// the missions grid (and clobbering in-flight card animations).
function renderOpenTabsHeader(sortedGroups: DomainGroup[], realTabsCount: number): void {
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
  mount(openTabsSectionCount, [
    document.createTextNode(`${sortedGroups.length} domain${sortedGroups.length !== 1 ? 's' : ''}\u00a0\u00b7\u00a0`),
    closeAllBtn,
  ]);
}

export function renderOpenTabsSection(sortedGroups: DomainGroup[], realTabsCount: number): void {
  const openTabsSection    = document.getElementById('openTabsSection');
  const openTabsMissionsEl = document.getElementById('openTabsMissions');

  if (sortedGroups.length > 0 && openTabsSection) {
    renderOpenTabsHeader(sortedGroups, realTabsCount);
    if (openTabsMissionsEl) {
      mount(openTabsMissionsEl, sortedGroups.map((g, idx) => renderDomainCard(g, idx)));
    }
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }
}

// Re-derive header counters + footer stat from the current openTabs snapshot.
// Called by close handlers after fetchOpenTabs() so the "X domains · Close all
// N tabs" badge and the footer "Open tabs" stat reflect reality without
// re-mounting the missions grid (which would yank cards mid-animation).
export function refreshOpenTabsCounters(): void {
  const realTabs = getDisplayableTabs(getOpenTabs());
  const sortedGroups = groupTabsByDomain(realTabs);
  setDomainGroups(sortedGroups);
  renderOpenTabsHeader(sortedGroups, realTabs.length);
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = String(getOpenTabs().length);
}

export async function renderStaticDashboard(): Promise<void> {
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  await fetchOpenTabs();
  const realTabs = getDisplayableTabs(getOpenTabs());
  const sortedGroups = groupTabsByDomain(realTabs);
  setDomainGroups(sortedGroups);
  renderOpenTabsSection(sortedGroups, realTabs.length);

  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = String(getOpenTabs().length);

  checkTabOutDupes();
  await renderDeferredColumn();
}

export async function renderDashboard(): Promise<void> {
  await renderStaticDashboard();
}
