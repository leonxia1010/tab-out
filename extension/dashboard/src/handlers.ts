// Single document-level click + input listeners, dispatched to a
// data-action handler by a switch in dispatchClick. Every new
// interactive surface adds a `data-action="..."` dataset and a case
// below — no per-button addEventListener sprawl.
//
// Lifecycle: src/index.ts calls attachListeners() exactly once on
// module load. attachListeners is idempotent so accidental re-imports
// don't double-fire handlers.

import { el, mount } from '../../shared/dist/dom-utils.js';
import { friendlyDomain } from './utils.js';
import {
  getDomainGroups,
  getOpenTabs,
  getUndoSnapshot,
  setUndoSnapshot,
} from './state.js';
import {
  closeDuplicates,
  closeTabOutDupes,
  closeTabsByUrls,
  focusTab,
  organizeTabs,
  undoOrganizeTabs,
} from './extension-bridge.js';
import {
  checkDeferred as apiCheckDeferred,
  clearAllArchived,
  deleteArchived,
  restoreArchived,
  dismissDeferred as apiDismissDeferred,
  getDeferred,
  saveDefer,
  searchDeferred,
} from './api.js';
import {
  animateCardOut as animateCardOutRaw,
  playCloseSound,
  shootConfetti,
  showActionToast,
  showToast,
} from './animations.js';
import {
  checkAndShowEmptyState,
  domainIdFor,
  refreshOpenTabsCounters,
  renderArchiveItem,
  renderDeferredColumn,
} from './renderers.js';
import { getSettings, setSettings, type ThemeMode } from '../../shared/dist/settings.js';
import { applyTheme } from './widgets/theme.js';

function animateCardOut(card: HTMLElement | null | undefined): void {
  animateCardOutRaw(card, checkAndShowEmptyState);
}

// Matches the CSS transition duration below. Named so it stays in sync
// with the inline style-duration string if the timing ever changes.
const CHIP_FADE_DURATION_MS = 200;

// Shared chip-disappearance animation for handleCloseSingleTab and
// handleDeferSingleTab. The two handlers had drifted into near-identical
// 20-line blocks (chip fade → 200ms timeout → remove → fly-out any card
// whose .domain-pages is now empty). Extracting the common shape keeps
// both paths in lockstep whenever the timing or the empty-card detection
// rule changes.
//
// After the chip is gone we must fly out any now-empty domain-card by
// hand — refresh.ts sees signature parity (closeTabsByUrls already
// pre-synced openTabs) and correctly skips the diff pass, so the card's
// header + "Close all N tabs" button would otherwise sit stale on
// screen. One path: scan every card for chips with
// data-action="focus-tab". The older `:has(.domain-pages:empty)` fast
// path was removed — `animateCardOut` calls shootConfetti which is
// non-idempotent, so firing the fast path AND the forEach on the same
// card produced two overlapping confetti bursts.
function fadeChipAndCleanupCards(
  chip: HTMLElement,
  opts: { confetti: boolean } = { confetti: false },
): void {
  if (opts.confetti) {
    const rect = chip.getBoundingClientRect();
    shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  chip.style.transition = 'opacity 0.2s, transform 0.2s';
  chip.style.opacity = '0';
  chip.style.transform = 'scale(0.8)';
  setTimeout(() => {
    chip.remove();
    document.querySelectorAll<HTMLElement>('.domain-card').forEach(c => {
      const remainingTabs = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
      if (remainingTabs.length === 0) animateCardOut(c);
    });
  }, CHIP_FADE_DURATION_MS);
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
  if (chip) fadeChipAndCleanupCards(chip, { confetti: true });

  refreshOpenTabsCounters();
  showToast('Tab closed');
}

async function handleDeferSingleTab(e: Event, actionEl: HTMLElement): Promise<void> {
  e.stopPropagation();
  const tabUrl = actionEl.dataset.tabUrl;
  if (!tabUrl) return;
  const tabTitle = actionEl.dataset.tabTitle || tabUrl;

  let wasRenewed = false;
  try {
    const result = await saveDefer([{ url: tabUrl, title: tabTitle }]);
    wasRenewed = result.renewed.length > 0;
  } catch (err) {
    console.error('[tab-out] Failed to defer tab:', err);
    showToast('Failed to save tab');
    return;
  }

  await closeTabsByUrls([tabUrl]);

  const chip = actionEl.closest<HTMLElement>('.page-chip');
  if (chip) fadeChipAndCleanupCards(chip);

  refreshOpenTabsCounters();
  showToast(wasRenewed ? 'Already saved. Moved to top.' : 'Saved for later');
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

async function handleRestoreArchived(actionEl: HTMLElement): Promise<void> {
  const id = actionEl.dataset.deferredId;
  if (!id) return;
  let merged = false;
  try {
    const result = await restoreArchived(id);
    merged = result.merged;
  } catch (err) {
    console.error('[tab-out] Failed to restore archived tab:', err);
    return;
  }
  const row = actionEl.closest<HTMLElement>('.archive-item');
  if (row) {
    row.classList.add('removing');
    setTimeout(() => {
      row.remove();
      void renderDeferredColumn();
    }, 200);
  } else {
    void renderDeferredColumn();
  }
  showToast(merged ? 'Already in saved for later' : 'Restored');
}

async function handleDeleteArchived(actionEl: HTMLElement): Promise<void> {
  const id = actionEl.dataset.deferredId;
  if (!id) return;
  try {
    await deleteArchived(id);
  } catch (err) {
    console.error('[tab-out] Failed to delete archived tab:', err);
    return;
  }
  const row = actionEl.closest<HTMLElement>('.archive-item');
  if (row) {
    row.classList.add('removing');
    setTimeout(() => {
      row.remove();
      void renderDeferredColumn();
    }, 200);
  } else {
    void renderDeferredColumn();
  }
  showToast('Deleted from archive');
}

async function handleOpenSaved(e: Event, actionEl: HTMLElement): Promise<void> {
  const url = actionEl.dataset.savedUrl;
  if (!url) return;
  // Take over anchor navigation. Chrome blocks <a href="chrome://..."> from
  // an extension page — the fallback used to be an accidental navigation
  // to '#' (the sanitizer's downgrade target), which resolved against this
  // dashboard URL and re-opened the dashboard itself. Routing through
  // chrome.tabs.create avoids every layer of that.
  e.preventDefault();
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    try {
      await chrome.tabs.create({ url });
    } catch (err) {
      console.warn('[tab-out] Failed to open saved tab:', err);
    }
  }
}

async function handleCloseDomainTabs(actionEl: HTMLElement, card: HTMLElement | null): Promise<void> {
  const domainId = actionEl.dataset.domainId;
  const groups = getDomainGroups();
  const group = groups.find(g => domainIdFor(g.domain) === domainId);
  if (!group) return;

  const urls = group.tabs.map(t => t.url || '').filter(Boolean);
  // Every card now represents a single hostname — hostname-mode match is
  // correct for closing all its tabs. The old Homepages card held tabs
  // across multiple hostnames and needed exact-URL match; that code path
  // is gone now.
  await closeTabsByUrls(urls);

  if (card) {
    playCloseSound();
    animateCardOut(card);
  }

  refreshOpenTabsCounters();

  showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${friendlyDomain(group.domain)}`);
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

// v2.5.0 — sum every card's dupe URLs and close them in one pass. Mirrors
// handleDedupKeepOne's per-card flow (fade out badges, refresh counters,
// toast) but aggregated across the whole open-tabs grid.
async function handleCloseAllDupesGlobal(): Promise<void> {
  const actionEls = document.querySelectorAll<HTMLElement>(
    '#openTabsDomains [data-action="dedup-keep-one"]',
  );
  const allUrls: string[] = [];
  let domainCount = 0;
  for (const el of actionEls) {
    const urls = (el.dataset.dupeUrls || '')
      .split(',')
      .map((u) => decodeURIComponent(u))
      .filter(Boolean);
    if (urls.length > 0) {
      allUrls.push(...urls);
      domainCount += 1;
    }
  }
  if (allUrls.length === 0) return;

  await closeDuplicates(allUrls);
  playCloseSound();

  // Fade per-card dedup buttons + duplicate badges so the grid visually
  // settles without a full re-mount (refreshOpenTabsCounters below
  // re-renders the header, not the cards).
  actionEls.forEach((el) => {
    el.style.transition = 'opacity 0.2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  });
  document.querySelectorAll<HTMLElement>('#openTabsDomains .chip-dupe-badge').forEach((b) => {
    b.style.transition = 'opacity 0.2s';
    b.style.opacity = '0';
    setTimeout(() => b.remove(), 200);
  });
  document.querySelectorAll<HTMLElement>('#openTabsDomains .open-tabs-badge').forEach((badge) => {
    if ((badge.textContent || '').includes('duplicate')) {
      badge.style.transition = 'opacity 0.2s';
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 200);
    }
  });

  // Remove the global button itself so the header tidies up immediately
  // instead of waiting for the refresh debounce.
  document.querySelectorAll<HTMLElement>('[data-action="close-all-dupes-global"]').forEach((btn) => {
    btn.style.transition = 'opacity 0.2s';
    btn.style.opacity = '0';
    setTimeout(() => btn.remove(), 200);
  });

  refreshOpenTabsCounters();
  const domainWord = domainCount === 1 ? 'domain' : 'domains';
  showToast(`Closed ${allUrls.length} duplicate${allUrls.length !== 1 ? 's' : ''} across ${domainCount} ${domainWord}`);
}

// v2.5.0 — reorder the current window's tab bar to match the dashboard
// domain-card order. Result snapshot is stashed in module state so the
// toast's Undo button can reverse the move for up to 60 seconds.
async function handleOrganizeTabs(): Promise<void> {
  const desiredOrder = getDomainGroups().map((g) => ({ domain: g.domain, tabs: g.tabs.slice() }));
  const { moves, movedCount } = await organizeTabs(desiredOrder);
  if (movedCount === 0) return;

  setUndoSnapshot({ type: 'organize', timestamp: Date.now(), moves });
  refreshOpenTabsCounters();

  const { dismiss } = showActionToast(
    `Organized ${movedCount} tab${movedCount !== 1 ? 's' : ''}`,
    {
      label: 'Undo',
      onClick: () => {
        void handleUndoOrganize();
        dismiss();
      },
    },
    60_000,
  );
}

async function handleUndoOrganize(): Promise<void> {
  const snap = getUndoSnapshot();
  if (!snap || snap.type !== 'organize') return;
  await undoOrganizeTabs(snap.moves);
  setUndoSnapshot(null);
  refreshOpenTabsCounters();
  showToast('Reverted');
}

async function handleArchiveClearAll(): Promise<void> {
  // Browser confirm is fine here: this is a dashboard page (not a service
  // worker) and the action is genuinely destructive + user-initiated.
  if (!window.confirm('Clear every archived tab? This cannot be undone.')) return;
  try {
    const { deleted } = await clearAllArchived();
    await renderDeferredColumn();
    showToast(`Cleared ${deleted} archived tab${deleted === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('[tab-out] Clear all archived failed:', err);
  }
}

// Apply the DOM change immediately, then persist. chrome.storage.onChanged
// will fire and the listener in index.ts re-applies — idempotent, so no
// jitter. Storage write failure logs but the visual state still holds (same
// silent-degrade pattern as the update-banner dismiss in index.ts).
async function handleSetTheme(theme: ThemeMode): Promise<void> {
  applyTheme(theme);
  try {
    await setSettings({ theme });
  } catch (err) {
    console.warn('[tab-out] Failed to save theme:', err);
  }
}

// Shortcut-bar pin: append {url,title} to shortcutPins. Dashboard
// only surfaces "Pin" on non-pinned tiles now (symmetric toggle —
// pinned tiles show "Remove pin" instead), so the already-pinned
// branch is a belt-and-braces safeguard against stale clicks.
// Re-render runs through onSettingsChange in index.ts; no DOM
// mutation here.
async function handleShortcutPin(e: MouseEvent, actionEl: HTMLElement): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const url = actionEl.dataset.url;
  const title = actionEl.dataset.title ?? '';
  if (!url) return;
  try {
    const current = await getSettings();
    if (current.shortcutPins.some((p) => p.url === url)) {
      showToast('Already pinned');
      return;
    }
    await setSettings({
      shortcutPins: [...current.shortcutPins, { url, title }],
    });
    showToast('Pinned');
  } catch (err) {
    console.warn('[tab-out] Failed to pin shortcut:', err);
  }
}

// Shortcut-bar unpin: filter out the URL from shortcutPins. Surfaced
// on pinned tiles as "Remove pin" so users can unpin in place instead
// of having to walk to the options page.
async function handleShortcutUnpin(e: MouseEvent, actionEl: HTMLElement): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const url = actionEl.dataset.url;
  if (!url) return;
  try {
    const current = await getSettings();
    if (!current.shortcutPins.some((p) => p.url === url)) return;
    await setSettings({
      shortcutPins: current.shortcutPins.filter((p) => p.url !== url),
    });
    showToast('Unpinned');
  } catch (err) {
    console.warn('[tab-out] Failed to unpin shortcut:', err);
  }
}

// Shortcut-bar hide: append url to shortcutHides if not already hidden.
// Hiding a pinned URL is a no-op — pins always win (UI exposes hide
// only via hover on every tile, so defensive guard matters).
async function handleShortcutHide(e: MouseEvent, actionEl: HTMLElement): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const url = actionEl.dataset.url;
  if (!url) return;
  try {
    const current = await getSettings();
    if (current.shortcutPins.some((p) => p.url === url)) {
      showToast('Unpin first to hide');
      return;
    }
    if (current.shortcutHides.includes(url)) return;
    await setSettings({
      shortcutHides: [...current.shortcutHides, url],
    });
    showToast('Hidden');
  } catch (err) {
    console.warn('[tab-out] Failed to hide shortcut:', err);
  }
}

function handleArchiveToggle(toggle: HTMLElement): void {
  // actionEl comes from closest('[data-action]'), so the clearAll vs toggle
  // disambiguation the old id-based dispatcher needed is a non-issue now —
  // each button carries its own data-action and gets routed here directly.
  const open = toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) body.classList.toggle('open', open);
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatchers (single listener per event type, action lookup, then forward)
// ──────────────────────────────────────────────────────────────────────────

async function dispatchClick(e: MouseEvent): Promise<void> {
  const target = e.target as HTMLElement | null;
  const actionEl = target?.closest<HTMLElement>('[data-action]') ?? null;
  if (!actionEl) return;

  // `.domain-card` lookup is only needed for two branches; compute it
  // lazily so the other ~20 actions don't pay for an unused ancestor
  // walk on every click.
  const card = (): HTMLElement | null => actionEl.closest<HTMLElement>('.domain-card');

  switch (actionEl.dataset.action) {
    case 'close-tabout-dupes': return handleCloseTabOutDupes();
    case 'expand-chips':       return handleExpandChips(actionEl);
    case 'focus-tab':          return handleFocusTab(actionEl);
    case 'close-single-tab':   return handleCloseSingleTab(e, actionEl);
    case 'defer-single-tab':   return handleDeferSingleTab(e, actionEl);
    case 'check-deferred':     return handleCheckDeferred(actionEl);
    case 'dismiss-deferred':   return handleDismissDeferred(actionEl);
    case 'open-saved':         return handleOpenSaved(e, actionEl);
    case 'close-domain-tabs':  return handleCloseDomainTabs(actionEl, card());
    case 'dedup-keep-one':     return handleDedupKeepOne(actionEl, card());
    case 'close-all-open-tabs':return handleCloseAllOpenTabs();
    case 'close-all-dupes-global': return handleCloseAllDupesGlobal();
    case 'organize-tabs':      return handleOrganizeTabs();
    case 'delete-archived':    return handleDeleteArchived(actionEl);
    case 'restore-archived':   return handleRestoreArchived(actionEl);
    case 'archive-toggle':     return handleArchiveToggle(actionEl);
    case 'archive-clear-all':  return handleArchiveClearAll();
    case 'set-theme-system':   return handleSetTheme('system');
    case 'set-theme-light':    return handleSetTheme('light');
    case 'set-theme-dark':     return handleSetTheme('dark');
    case 'shortcut-pin':       return handleShortcutPin(e, actionEl);
    case 'shortcut-unpin':     return handleShortcutUnpin(e, actionEl);
    case 'shortcut-hide':      return handleShortcutHide(e, actionEl);
    default:                   return;
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
  // One click listener, one input listener. Every clickable surface routes
  // through dispatchClick via its data-action attribute (including archive
  // toggle + clear-all, which used to carry their own listeners).
  document.addEventListener('click', dispatchClick);
  document.addEventListener('input', dispatchArchiveSearch);
}

