// Tab Out dashboard — event delegation handlers (Phase 2 PR F).
//
// Single document-level click + input listeners, dispatched to one of 10
// data-action handlers.
//
// Lifecycle: src/index.ts calls attachListeners() exactly once on module
// load. attachListeners is idempotent so accidental re-imports do not
// double-fire handlers.

import { el, mount } from './dom-utils.js';
import { friendlyDomain } from './utils.js';
import {
  getDomainGroups,
  getOpenTabs,
} from './state.js';
import {
  closeDuplicates,
  closeTabOutDupes,
  closeTabsByUrls,
  focusTab,
} from './extension-bridge.js';
import {
  checkDeferred as apiCheckDeferred,
  dismissDeferred as apiDismissDeferred,
  getDeferred,
  saveDefer,
  searchDeferred,
} from './api.js';
import {
  animateCardOut as animateCardOutRaw,
  playCloseSound,
  shootConfetti,
  showToast,
} from './animations.js';
import {
  checkAndShowEmptyState,
  refreshOpenTabsCounters,
  renderArchiveItem,
  renderDeferredColumn,
} from './renderers.js';

function animateCardOut(card: HTMLElement | null | undefined): void {
  animateCardOutRaw(card, checkAndShowEmptyState);
}

// ──────────────────────────────────────────────────────────────────────────
// Click handlers (one per data-action)
// ──────────────────────────────────────────────────────────────────────────

async function handleCloseTabOutDupes(): Promise<void> {
  await closeTabOutDupes();
  playCloseSound();
  const banner = document.getElementById('tabOutDupeBanner');
  if (banner) {
    banner.style.transition = 'opacity 0.4s';
    banner.style.opacity = '0';
    setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
  }
  refreshOpenTabsCounters();
  showToast('Closed extra Tab Out tabs');
}

function handleExpandChips(actionEl: HTMLElement): void {
  const overflowContainer = actionEl.parentElement?.querySelector<HTMLElement>('.page-chips-overflow');
  if (overflowContainer) {
    overflowContainer.style.display = 'contents';
    actionEl.remove();
  }
}

async function handleFocusTab(actionEl: HTMLElement): Promise<void> {
  const tabUrl = actionEl.dataset.tabUrl;
  if (tabUrl) {
    await focusTab(tabUrl);
  }
}

async function handleCloseSingleTab(e: Event, actionEl: HTMLElement): Promise<void> {
  e.stopPropagation();
  const tabUrl = actionEl.dataset.tabUrl;
  if (!tabUrl) return;

  await closeTabsByUrls([tabUrl]);
  playCloseSound();

  const chip = actionEl.closest<HTMLElement>('.page-chip');
  if (chip) {
    const rect = chip.getBoundingClientRect();
    shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    chip.style.transition = 'opacity 0.2s, transform 0.2s';
    chip.style.opacity = '0';
    chip.style.transform = 'scale(0.8)';
    setTimeout(() => {
      chip.remove();
      const cardEmpty = document.querySelector<HTMLElement>('.domain-card:has(.domain-pages:empty)');
      if (cardEmpty) {
        animateCardOut(cardEmpty);
      }
      document.querySelectorAll<HTMLElement>('.domain-card').forEach(c => {
        const remainingTabs = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
        if (remainingTabs.length === 0) {
          animateCardOut(c);
        }
      });
    }, 200);
  }

  refreshOpenTabsCounters();
  showToast('Tab closed');
}

async function handleDeferSingleTab(e: Event, actionEl: HTMLElement): Promise<void> {
  e.stopPropagation();
  const tabUrl = actionEl.dataset.tabUrl;
  if (!tabUrl) return;
  const tabTitle = actionEl.dataset.tabTitle || tabUrl;

  try {
    await saveDefer([{ url: tabUrl, title: tabTitle }]);
  } catch (err) {
    console.error('[tab-out] Failed to defer tab:', err);
    showToast('Failed to save tab');
    return;
  }

  await closeTabsByUrls([tabUrl]);

  const chip = actionEl.closest<HTMLElement>('.page-chip');
  if (chip) {
    chip.style.transition = 'opacity 0.2s, transform 0.2s';
    chip.style.opacity = '0';
    chip.style.transform = 'scale(0.8)';
    setTimeout(() => chip.remove(), 200);
  }

  refreshOpenTabsCounters();
  showToast('Saved for later');
  await renderDeferredColumn();
}

async function handleCheckDeferred(actionEl: HTMLElement): Promise<void> {
  const id = actionEl.dataset.deferredId;
  if (!id) return;
  try {
    await apiCheckDeferred(id);
  } catch (err) {
    console.error('[tab-out] Failed to check deferred tab:', err);
    return;
  }
  const item = actionEl.closest<HTMLElement>('.deferred-item');
  if (item) {
    item.classList.add('checked');
    setTimeout(() => {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        void renderDeferredColumn();
      }, 300);
    }, 800);
  }
}

async function handleDismissDeferred(actionEl: HTMLElement): Promise<void> {
  const id = actionEl.dataset.deferredId;
  if (!id) return;
  try {
    await apiDismissDeferred(id);
  } catch (err) {
    console.error('[tab-out] Failed to dismiss deferred tab:', err);
    return;
  }
  const item = actionEl.closest<HTMLElement>('.deferred-item');
  if (item) {
    item.classList.add('removing');
    setTimeout(() => {
      item.remove();
      void renderDeferredColumn();
    }, 300);
  }
}

async function handleCloseDomainTabs(actionEl: HTMLElement, card: HTMLElement | null): Promise<void> {
  const domainId = actionEl.dataset.domainId;
  const groups = getDomainGroups();
  const group = groups.find(g => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId);
  if (!group) return;

  const urls = group.tabs.map(t => t.url || '').filter(Boolean);
  const useExact = group.domain === '__landing-pages__';
  await closeTabsByUrls(urls, useExact);

  if (card) {
    playCloseSound();
    animateCardOut(card);
  }

  refreshOpenTabsCounters();

  const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : friendlyDomain(group.domain);
  showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);
}

async function handleDedupKeepOne(actionEl: HTMLElement, card: HTMLElement | null): Promise<void> {
  const urlsEncoded = actionEl.dataset.dupeUrls || '';
  const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
  if (urls.length === 0) return;

  await closeDuplicates(urls);
  playCloseSound();

  actionEl.style.transition = 'opacity 0.2s';
  actionEl.style.opacity = '0';
  setTimeout(() => actionEl.remove(), 200);

  if (card) {
    card.querySelectorAll<HTMLElement>('.chip-dupe-badge').forEach(b => {
      b.style.transition = 'opacity 0.2s';
      b.style.opacity = '0';
      setTimeout(() => b.remove(), 200);
    });
    card.querySelectorAll<HTMLElement>('.open-tabs-badge').forEach(badge => {
      if ((badge.textContent || '').includes('duplicate')) {
        badge.style.transition = 'opacity 0.2s';
        badge.style.opacity = '0';
        setTimeout(() => badge.remove(), 200);
      }
    });
    card.classList.remove('has-amber-bar');
    card.classList.add('has-neutral-bar');
    const statusBar = card.querySelector<HTMLElement>('.status-bar');
    if (statusBar) statusBar.style.background = '';
  }

  refreshOpenTabsCounters();
  showToast('Closed duplicates, kept one copy each');
}

async function handleCloseAllOpenTabs(): Promise<void> {
  // Close every non-Tab-Out tab (including chrome:// system pages).
  // isTabOut filter + closeTabsByUrls's skipSelf=true guard together ensure
  // the dashboard itself survives, so the user never loses their entry point
  // (and we don't risk Chrome quitting when the last tab closes).
  const allUrls = getOpenTabs()
    .filter(t => !!t.url && !t.isTabOut)
    .map(t => t.url || '');
  if (allUrls.length === 0) return;

  await closeTabsByUrls(allUrls, /* exact */ true);
  playCloseSound();

  document.querySelectorAll<HTMLElement>('#openTabsDomains .domain-card').forEach(c => {
    shootConfetti(
      c.getBoundingClientRect().left + c.offsetWidth / 2,
      c.getBoundingClientRect().top + c.offsetHeight / 2,
    );
    animateCardOut(c);
  });

  refreshOpenTabsCounters();
  showToast('All tabs closed. Fresh start.');
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatchers (single listener per event type, action lookup, then forward)
// ──────────────────────────────────────────────────────────────────────────

async function dispatchClick(e: MouseEvent): Promise<void> {
  const target = e.target as HTMLElement | null;
  const actionEl = target?.closest<HTMLElement>('[data-action]') ?? null;
  if (!actionEl) return;

  const action = actionEl.dataset.action;
  const card   = actionEl.closest<HTMLElement>('.domain-card');

  switch (action) {
    case 'close-tabout-dupes': return handleCloseTabOutDupes();
    case 'expand-chips':       return handleExpandChips(actionEl);
    case 'focus-tab':          return handleFocusTab(actionEl);
    case 'close-single-tab':   return handleCloseSingleTab(e, actionEl);
    case 'defer-single-tab':   return handleDeferSingleTab(e, actionEl);
    case 'check-deferred':     return handleCheckDeferred(actionEl);
    case 'dismiss-deferred':   return handleDismissDeferred(actionEl);
    case 'close-domain-tabs':  return handleCloseDomainTabs(actionEl, card);
    case 'dedup-keep-one':     return handleDedupKeepOne(actionEl, card);
    case 'close-all-open-tabs':return handleCloseAllOpenTabs();
    default:                   return;
  }
}

function dispatchArchiveToggle(e: MouseEvent): void {
  const toggle = (e.target as HTMLElement | null)?.closest('#archiveToggle');
  if (!toggle) return;
  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
}

async function dispatchArchiveSearch(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement | null;
  if (!target || target.id !== 'archiveSearch') return;

  const q = target.value.trim();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  if (q.length < 2) {
    try {
      const data = await getDeferred();
      mount(archiveList, (data.archived || []).map(renderArchiveItem));
    } catch {}
    return;
  }

  try {
    const data = await searchDeferred(q);
    const results = data.results || [];
    if (results.length === 0) {
      mount(archiveList, el('div', {
        style: 'font-size:12px;color:var(--muted);padding:8px 0',
        textContent: 'No results',
      }));
    } else {
      mount(archiveList, results.map(renderArchiveItem));
    }
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle: idempotent listener attach. index.ts calls this exactly once.
// ──────────────────────────────────────────────────────────────────────────

let attached = false;
export function attachListeners(): void {
  if (attached) return;
  attached = true;
  document.addEventListener('click', dispatchClick);
  document.addEventListener('click', dispatchArchiveToggle);
  document.addEventListener('input', dispatchArchiveSearch);
}

