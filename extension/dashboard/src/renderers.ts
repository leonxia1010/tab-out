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
// Heroicons v2 outline — arrow-uturn-left. Matches the dashboard's icon family.
const ARCHIVE_RESTORE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>';

// Hostnames whose card stays pinned above non-priority cards regardless of
// open-order. User-facing rationale: these are the "always-available"
// entry points (mail, social, code host) that a user treats as ambient
// and expects on the left. Currently hardcoded; FUTURE: expose via the
// options page so each user picks their own priority set (see ROADMAP.md).
const PRIORITY_HOSTNAMES = new Set<string>([
  'mail.google.com',
  'x.com',
  'twitter.com',
  'www.linkedin.com',
  'github.com',
]);

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
  // official name). Both twitter.com and x.com are in PRIORITY_HOSTNAMES so
  // either way a tab on them pins above normal cards.
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

// Stable DOM key for each domain card. diff.ts (set-diff lookup) and
// handlers.ts (close-domain action) rebuild the same slug; exporting
// keeps the three call sites locked together — if the sanitization rule
// ever changes, no silent drift.
export function domainIdFor(domain: string): string {
  return 'domain-' + domain.replace(/[^a-z0-9]/g, '-');
}

export function checkAndShowEmptyState(): void {
  const domainsEl = document.getElementById('openTabsDomains');
  if (!domainsEl) return;
  const remaining = domainsEl.querySelectorAll('.domain-card:not(.closing)').length;
  if (remaining > 0) return;
  // Developer-authored static SVG, no user data — innerHTML is safe.
  domainsEl.innerHTML = `
    <div class="domains-empty-state">
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
  if (countEl) countEl.textContent = '0 domains';
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

  // Waterfall fade-in: each card staggers 0.05s after the one before it,
  // starting at 0.25s. Set inline so the effect survives past the 4th card
  // — the previous CSS hard-coded nth-child(1..4) only and left card 5+
  // popping in instantly.
  card.style.animationDelay = `${(0.25 + groupIndex * 0.05).toFixed(2)}s`;

  return card;
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

  // data-action + data-saved-url let handlers.ts intercept the click and
  // go through chrome.tabs.create — chrome blocks anchor navigation to
  // chrome:// / chrome-extension:// from an extension page, so relying on
  // target="_blank" alone made those saved entries silently no-op (or
  // worse, resolve href='#' back to this dashboard URL when a stale
  // sanitizer was still in place). href stays the real URL so hover
  // tooltip + right-click "copy link address" still show the right thing.
  const link = el('a', {
    href: item.url,
    target: '_blank',
    rel: 'noopener',
    className: 'deferred-title',
    title: item.title || '',
    dataset: { action: 'open-saved', savedUrl: item.url },
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
    dataset: { action: 'open-saved', savedUrl: item.url },
  });

  const restoreBtn = el('button', {
    className: 'archive-item-restore',
    'aria-label': 'Restore to saved for later',
    title: 'Restore',
    dataset: { action: 'restore-archived', deferredId: item.id },
  }, [svg(ARCHIVE_RESTORE_SVG)]);

  const deleteBtn = el('button', {
    className: 'archive-item-delete',
    'aria-label': 'Delete from archive',
    title: 'Delete',
    dataset: { action: 'delete-archived', deferredId: item.id },
  }, [svg(DEFERRED_DISMISS_SVG)]);

  // Two-line layout: title + action buttons share row 1; timestamp drops to
  // row 2 so the first line isn't crowded on a narrow sidebar column.
  const actions = el('div', { className: 'archive-item-actions' }, [
    restoreBtn,
    deleteBtn,
  ]);

  const main = el('div', { className: 'archive-item-main' }, [link, actions]);

  return el('div', {
    className: 'archive-item',
    dataset: { deferredId: item.id },
  }, [
    main,
    el('span', { className: 'archive-item-date', textContent: ago }),
  ]);
}

// Force-restart a CSS animation on an element that's already in the DOM.
// Needed because `.deferred-empty` / `.deferred-archive` are static HTML
// nodes whose `display:none → block` switch does NOT re-trigger their
// CSS animation in Chrome. Clearing inline `animation`, forcing a reflow,
// then re-clearing it lets the stylesheet rule kick back in from frame 0.
// (`.deferred-item` doesn't need this because mount() replaces those
// nodes — a fresh DOM insertion triggers animation naturally.)
function restartAnim(elem: HTMLElement | null): void {
  if (!elem) return;
  elem.style.animation = 'none';
  void elem.offsetHeight; // force reflow
  elem.style.animation = '';
}

// Waterfall on page-load only. Event-driven re-renders (save / check /
// dismiss / delete / clear all) must NOT stagger — the column would flash
// each time. Callers opt in via { waterfall: true } and the list has a
// single .animate-in class that scopes the CSS keyframes + nth-child delays.
export async function renderDeferredColumn(
  options: { waterfall?: boolean } = {},
): Promise<void> {
  const column    = document.getElementById('deferredColumn');
  const list      = document.getElementById('deferredList');
  const empty     = document.getElementById('deferredEmpty');
  const countEl   = document.getElementById('deferredCount');
  const archiveEl = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');
  const archiveClearEl = document.getElementById('archiveClearAll');

  if (!column) return;

  // Column + Archive header stay mounted even when both lists are empty so
  // the layout doesn't collapse on a fresh install / after Clear all. Empty
  // states fill the inner slots instead. Keep display manipulation here
  // but never replay the entrance animation — CSS covers page-load.
  column.style.display = 'block';
  if (archiveEl) archiveEl.style.display = 'block';

  try {
    const data = await getDeferred();

    const active   = data.active   || [];
    const archived = data.archived || [];

    if (active.length > 0 && list && empty && countEl) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      // Toggle the waterfall class BEFORE mount so the new DOM nodes pick
      // up the keyframes on first paint. Without waterfall we clear it so
      // a save-after-load doesn't re-fire the stagger.
      list.classList.toggle('animate-in', Boolean(options.waterfall));
      mount(list, active.map(renderDeferredItem));
      list.style.display = 'block';
      empty.style.display = 'none';
    } else if (list && empty && countEl) {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
      restartAnim(empty);
    }

    if (archiveCountEl && archiveList) {
      if (archived.length > 0) {
        archiveCountEl.textContent = `(${archived.length})`;
        mount(archiveList, archived.map(renderArchiveItem));
        if (archiveClearEl) archiveClearEl.style.display = '';
      } else {
        archiveCountEl.textContent = '';
        // Empty state placeholder — shown inside the expandable body so the
        // toggle still works and users see a clear "there's nothing here yet"
        // rather than an invisible void.
        mount(archiveList, el('div', {
          className: 'archive-empty',
          textContent: 'No archived tabs yet.',
        }));
        if (archiveClearEl) archiveClearEl.style.display = 'none';
      }
    }
    // Do NOT restart the archive container animation here. Every save /
    // check / dismiss triggers renderDeferredColumn; replaying the outer
    // fadeUp each time makes the right column flash on every mutation.
    // The page-load entrance is covered by the CSS rule on .deferred-archive.
  } catch (err) {
    console.warn('[tab-out] Could not load deferred tabs:', err);
    // Leave the column visible; swallowing state on storage errors is what
    // the caller already does for getUpdateStatus, and hiding the whole
    // saved-for-later surface would lose the user's affordance to re-try.
  }
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
    // FUTURE: insert user-configured priority set here (ROADMAP.md).
    const aIsPriority = PRIORITY_HOSTNAMES.has(a.domain);
    const bIsPriority = PRIORITY_HOSTNAMES.has(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
    // FUTURE: drag-to-reorder lands here — read user-custom order from
    // chrome.storage.local['tabout:cardOrder'] and sort matched domains
    // by their index in it, falling through to first-seen for the rest.
    // See ROADMAP.md "Drag-to-reorder domain cards".
    //
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
  mount(openTabsSectionCount, [
    document.createTextNode(`${sortedGroups.length} domain${sortedGroups.length !== 1 ? 's' : ''}\u00a0\u00b7\u00a0`),
    closeAllBtn,
  ]);
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
