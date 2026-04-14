// Tab Out dashboard — event delegation handlers (Phase 2 PR F).
//
// Single document-level click + input listeners, dispatched to one of 14
// data-action handlers. Mission-based actions (archive/dismiss/focus/
// close-uncat) are kept verbatim from app.js for backward compatibility
// with old DOM that still emits them; phase 3 may delete the mission API
// surface entirely, at which point those branches go.
//
// Lifecycle: src/index.ts calls attachListeners() exactly once on module
// load. attachListeners is idempotent so accidental re-imports do not
// double-fire handlers.

import { el, mount } from './dom-utils.js';
import { friendlyDomain } from './utils.js';
import {
  getDomainGroups,
  getOpenTabs,
  setDomainGroups,
} from './state.js';
import {
  closeTabsByUrls,
  fetchMissionById,
  fetchOpenTabs,
  focusTabsByUrls,
  sendToExtension,
} from './extension-bridge.js';
import type { Mission } from './extension-bridge.js';
import {
  animateCardOut as animateCardOutRaw,
  playCloseSound,
  shootConfetti,
  showToast,
} from './animations.js';
import {
  checkAndShowEmptyState,
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
  await sendToExtension('closeTabOutDupes');
  await fetchOpenTabs();
  playCloseSound();
  const banner = document.getElementById('tabOutDupeBanner');
  if (banner) {
    banner.style.transition = 'opacity 0.4s';
    banner.style.opacity = '0';
    setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
  }
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
    await sendToExtension('focusTab', { url: tabUrl });
  }
}

async function handleCloseSingleTab(e: Event, actionEl: HTMLElement): Promise<void> {
  e.stopPropagation();
  const tabUrl = actionEl.dataset.tabUrl;
  if (!tabUrl) return;

  await sendToExtension('closeTabs', { urls: [tabUrl] });
  playCloseSound();
  await fetchOpenTabs();

  const chip = actionEl.closest<HTMLElement>('.page-chip');
  if (chip) {
    const rect = chip.getBoundingClientRect();
    shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    chip.style.transition = 'opacity 0.2s, transform 0.2s';
    chip.style.opacity = '0';
    chip.style.transform = 'scale(0.8)';
    setTimeout(() => {
      chip.remove();
      const cardEmpty = document.querySelector<HTMLElement>('.mission-card:has(.mission-pages:empty)');
      if (cardEmpty) {
        animateCardOut(cardEmpty);
      }
      document.querySelectorAll<HTMLElement>('.mission-card').forEach(c => {
        const remainingTabs = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
        if (remainingTabs.length === 0) {
          animateCardOut(c);
        }
      });
    }, 200);
  }

  showToast('Tab closed');
}

async function handleDeferSingleTab(e: Event, actionEl: HTMLElement): Promise<void> {
  e.stopPropagation();
  const tabUrl   = actionEl.dataset.tabUrl;
  const tabTitle = actionEl.dataset.tabTitle || tabUrl;
  if (!tabUrl) return;

  try {
    await fetch('/api/defer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabs: [{ url: tabUrl, title: tabTitle }] }),
    });
  } catch (err) {
    console.error('[tab-out] Failed to defer tab:', err);
    showToast('Failed to save tab');
    return;
  }

  await sendToExtension('closeTabs', { urls: [tabUrl] });
  await fetchOpenTabs();

  const chip = actionEl.closest<HTMLElement>('.page-chip');
  if (chip) {
    chip.style.transition = 'opacity 0.2s, transform 0.2s';
    chip.style.opacity = '0';
    chip.style.transform = 'scale(0.8)';
    setTimeout(() => chip.remove(), 200);
  }

  showToast('Saved for later');
  await renderDeferredColumn();
}

async function handleCheckDeferred(actionEl: HTMLElement): Promise<void> {
  const id = actionEl.dataset.deferredId;
  if (!id) return;
  try {
    await fetch(`/api/deferred/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checked: true }),
    });
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
    await fetch(`/api/deferred/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissed: true }),
    });
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
  await sendToExtension('closeTabs', { urls, exact: useExact });
  await fetchOpenTabs();

  if (card) {
    playCloseSound();
    animateCardOut(card);
  }

  setDomainGroups(groups.filter(g => g !== group));

  const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : friendlyDomain(group.domain);
  showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = String(getOpenTabs().length);
}

async function handleDedupKeepOne(actionEl: HTMLElement, card: HTMLElement | null): Promise<void> {
  const urlsEncoded = actionEl.dataset.dupeUrls || '';
  const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
  if (urls.length === 0) return;

  await sendToExtension('closeDuplicates', { urls, keepOne: true });
  playCloseSound();
  await fetchOpenTabs();

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

  showToast('Closed duplicates, kept one copy each');
}

async function handleCloseAllOpenTabs(): Promise<void> {
  const allUrls = getOpenTabs()
    .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
    .map(t => t.url || '');
  await closeTabsByUrls(allUrls);
  playCloseSound();

  document.querySelectorAll<HTMLElement>('#openTabsMissions .mission-card').forEach(c => {
    shootConfetti(
      c.getBoundingClientRect().left + c.offsetWidth / 2,
      c.getBoundingClientRect().top + c.offsetHeight / 2,
    );
    animateCardOut(c);
  });

  showToast('All tabs closed. Fresh start.');
}

interface MissionUrlEntry { url?: string }

function missionUrls(mission: Mission): string[] {
  const raw = mission.urls;
  const arr = Array.isArray(raw) ? raw as MissionUrlEntry[] : [];
  return arr.map(u => u?.url || '').filter(Boolean);
}

function missionName(mission: Mission): string {
  return typeof mission.name === 'string' ? mission.name : '';
}

async function handleArchiveMission(missionId: string | undefined, card: HTMLElement | null): Promise<void> {
  if (!missionId) return;
  const mission = await fetchMissionById(missionId);
  if (!mission) return;

  const urls = missionUrls(mission);
  await closeTabsByUrls(urls);

  try {
    await fetch(`/api/missions/${missionId}/archive`, { method: 'POST' });
  } catch (err) {
    console.warn('[tab-out] Could not archive mission:', err);
  }

  if (card) {
    playCloseSound();
    animateCardOut(card);
  }

  showToast(`Archived "${missionName(mission)}"`);
}

async function handleDismissMission(missionId: string | undefined, card: HTMLElement | null): Promise<void> {
  if (!missionId) return;
  const mission = await fetchMissionById(missionId);
  if (!mission) return;

  const tabCountStr = card
    ? (card.querySelector('.open-tabs-badge')?.textContent?.match(/\d+/)?.[0] || '0')
    : '0';

  if (parseInt(tabCountStr, 10) > 0) {
    await closeTabsByUrls(missionUrls(mission));
  }

  try {
    await fetch(`/api/missions/${missionId}/dismiss`, { method: 'POST' });
  } catch (err) {
    console.warn('[tab-out] Could not dismiss mission:', err);
  }

  if (card) {
    playCloseSound();
    animateCardOut(card);
  }

  showToast(`Let go of "${missionName(mission)}"`);
}

async function handleFocusMission(missionId: string | undefined): Promise<void> {
  if (!missionId) return;
  const mission = await fetchMissionById(missionId);
  if (!mission) return;
  await focusTabsByUrls(missionUrls(mission));
  showToast(`Focused on "${missionName(mission)}"`);
}

async function handleCloseUncat(actionEl: HTMLElement, card: HTMLElement | null): Promise<void> {
  const domain = actionEl.dataset.domain;
  if (!domain) return;
  const tabsToClose = getOpenTabs().filter(t => {
    try { return new URL(t.url || '').hostname === domain; }
    catch { return false; }
  });
  const urls = tabsToClose.map(t => t.url || '').filter(Boolean);
  await closeTabsByUrls(urls);

  if (card) {
    playCloseSound();
    animateCardOut(card);
  }
  showToast(`Closed ${tabsToClose.length} tab${tabsToClose.length !== 1 ? 's' : ''} from ${domain}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatchers (single listener per event type, action lookup, then forward)
// ──────────────────────────────────────────────────────────────────────────

async function dispatchClick(e: MouseEvent): Promise<void> {
  const target = e.target as HTMLElement | null;
  const actionEl = target?.closest<HTMLElement>('[data-action]') ?? null;
  if (!actionEl) return;

  const action    = actionEl.dataset.action;
  const missionId = actionEl.dataset.missionId;
  const card      = actionEl.closest<HTMLElement>('.mission-card');

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
    case 'archive':            return handleArchiveMission(missionId, card);
    case 'dismiss':            return handleDismissMission(missionId, card);
    case 'focus':              return handleFocusMission(missionId);
    case 'close-uncat':        return handleCloseUncat(actionEl, card);
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
      const res = await fetch('/api/deferred');
      if (res.ok) {
        const data = await res.json();
        mount(archiveList, (data.archived || []).map(renderArchiveItem));
      }
    } catch {}
    return;
  }

  try {
    const res = await fetch(`/api/deferred/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const data = await res.json();
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

