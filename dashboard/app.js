/* ================================================================
   Tab Out — Dashboard App

   This file is the brain of the dashboard. It:
   1. Talks to the Chrome extension (to read/close actual browser tabs)
   2. Groups open tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus)
   ================================================================ */

'use strict';

// Safe DOM construction helpers — see dashboard/src/dom-utils.ts.
// Exposed on window.domUtils by dist/index.js (ES module, loaded before app.js).
const { el, svg, mount } = window.domUtils;

// Pure helpers extracted to dashboard/src/utils.ts (Phase 2 PR B).
// Exposed on window.utils by dist/index.js; app.js destructures at load time.
// PR G removes this bridge when app.js itself is deleted.
const {
  timeAgo,
  getGreeting,
  getDateDisplay,
  capitalize,
  friendlyDomain,
  stripTitleNoise,
  cleanTitle,
  smartTitle,
  getRealTabs,
  getOpenTabsForMission,
  countOpenTabsForMission,
} = window.utils;

// Shared module-level state extracted to dashboard/src/state.ts (Phase 2 PR C).
const {
  getOpenTabs,
  setOpenTabs,
  getExtensionAvailable,
  setExtensionAvailable,
  getDomainGroups,
  setDomainGroups,
} = window.state;

// Chrome extension postMessage bridge — dashboard/src/extension-bridge.ts (Phase 2 PR C).
const {
  sendToExtension,
  fetchOpenTabs,
  closeTabsByUrls,
  focusTabsByUrls,
  checkTabOutDupes,
  fetchMissionById,
} = window.extensionBridge;

// Presentational side-effects — dashboard/src/animations.ts (Phase 2 PR D).
// animateCardOut accepts an onComplete callback so this module stays free of
// the renderer slice; callers pass checkAndShowEmptyState.
const {
  playCloseSound,
  shootConfetti,
  animateCardOut: animateCardOutRaw,
  showToast,
} = window.animations;

// DOM renderers + empty-state UI extracted to dashboard/src/renderers.ts
// (Phase 2 PR E). Only the four symbols app.js still calls directly are
// destructured; PR G removes this bridge along with app.js itself.
const {
  checkAndShowEmptyState,
  renderDeferredColumn,
  renderArchiveItem,
  renderDashboard,
} = window.renderers;

// Thin wrapper: animations.ts has no view dependencies, so callers inject
// the empty-state callback. PR G deletes this wrapper when handlers move
// into ESM and call animations.animateCardOut(card, renderers.checkAndShowEmptyState) directly.
function animateCardOut(card) {
  animateCardOutRaw(card, checkAndShowEmptyState);
}


/* ----------------------------------------------------------------
   EVENT HANDLERS (using event delegation)

   Instead of attaching a listener to every button, we attach ONE
   listener to the whole document and check what was clicked.
   This is more efficient and works even after we re-render cards.

   Think of it like one security guard watching the whole building
   instead of one guard per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM from the clicked element to find the nearest
  // element with a data-action attribute
  const actionEl = e.target.closest('[data-action]');

  if (!actionEl) return; // click wasn't on an action button

  const action    = actionEl.dataset.action;
  const missionId = actionEl.dataset.missionId;

  // --- Close duplicate Tab Out tabs ---
  if (action === 'close-tabout-dupes') {
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
    return;
  }

  // Find the card element so we can animate it
  const card = actionEl.closest('.mission-card');

  // ---- expand-chips: show the hidden tabs in a card ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- focus-tab: switch to a specific open tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) {
      await sendToExtension('focusTab', { url: tabUrl });
    }
    return;
  }

  // ---- close-single-tab: close one specific tab by URL ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger the parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    await sendToExtension('closeTabs', { urls: [tabUrl] });
    playCloseSound();
    await fetchOpenTabs();

    // Remove the chip from the DOM with confetti
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If this was the last tab in the card, remove the whole card
        const card = document.querySelector(`.mission-card:has(.mission-pages:empty)`);
        if (card) {
          animateCardOut(card);
        }
        // Also check for cards where only overflow/non-tab chips remain
        document.querySelectorAll('.mission-card').forEach(c => {
          const remainingTabs = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
          if (remainingTabs.length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    showToast('Tab closed');
    return;
  }

  // ---- defer-single-tab: save one tab for later, then close it ----
  if (action === 'defer-single-tab') {
    e.stopPropagation(); // don't trigger the parent chip's focus-tab
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to the deferred list on the server
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

    // Close the tab in the browser
    await sendToExtension('closeTabs', { urls: [tabUrl] });
    await fetchOpenTabs();

    // Animate the chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    // Refresh the deferred column to show the new item
    await renderDeferredColumn();
    return;
  }

  // ---- check-deferred: check off a deferred tab (mark as read) ----
  if (action === 'check-deferred') {
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

    // Animate the item: add strikethrough, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh to update counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- dismiss-deferred: dismiss a deferred tab without reading ----
  if (action === 'dismiss-deferred') {
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

    // Animate the item out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn(); // refresh counts and archive
      }, 300);
    }
    return;
  }

  // ---- close-domain-tabs: close all tabs in a static domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    // Find the group by its stable ID
    const groups = getDomainGroups();
    const group = groups.find(g => {
      const id = 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-');
      return id === domainId;
    });
    if (!group) return;

    const urls = group.tabs.map(t => t.url);
    // Use exact URL matching for landing pages (share domains with content tabs)
    const useExact = group.domain === '__landing-pages__';
    await sendToExtension('closeTabs', { urls, exact: useExact });
    await fetchOpenTabs();

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory domain groups
    setDomainGroups(groups.filter(g => g !== group));

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : friendlyDomain(group.domain);
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    // Update footer tab count
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = getOpenTabs().length;
    return;
  }

  // ---- close-all-dupes: close every duplicate tab ----

  // ---- dedup-keep-one: close extras but keep one copy of each ----
  if (action === 'dedup-keep-one') {
    // URLs come from the button's data attribute (per-mission duplicates)
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await sendToExtension('closeDuplicates', { urls, keepOne: true });
    playCloseSound();
    await fetchOpenTabs();

    // Remove the dupe button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove all (2x) badges and the "N duplicates" header badge from this card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity = '0';
        setTimeout(() => b.remove(), 200);
      });
      // Remove the amber "N duplicates" badge from the card header
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      // Remove amber highlight from the card border
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
      const statusBar = card.querySelector('.status-bar');
      if (statusBar) statusBar.style.background = '';
    }

    showToast(`Closed duplicates, kept one copy each`);
    return;
  }

  // ---- close-all-open-tabs: close every open tab ----
  if (action === 'close-all-open-tabs') {
    // Use the actual openTabs list from the extension — works regardless of
    // close all domain-grouped tabs
    const allUrls = getOpenTabs()
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    // Animate all cards out
    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }

  // ---- archive: close tabs + mark mission as archived, then remove card ----
  else if (action === 'archive') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Tell the server to archive this mission
    try {
      await fetch(`/api/missions/${missionId}/archive`, { method: 'POST' });
    } catch (err) {
      console.warn('[tab-out] Could not archive mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Archived "${mission.name}"`);

  }

  // ---- dismiss: close tabs (if any), mark as dismissed, remove card ----
  else if (action === 'dismiss') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    // If tabs are open, close them first
    const tabCount = card
      ? (card.querySelector('.open-tabs-badge')?.textContent.match(/\d+/)?.[0] || 0)
      : 0;

    if (parseInt(tabCount) > 0) {
      const urls = (mission.urls || []).map(u => u.url);
      await closeTabsByUrls(urls);
    }

    // Tell the server this mission is dismissed
    try {
      await fetch(`/api/missions/${missionId}/dismiss`, { method: 'POST' });
    } catch (err) {
      console.warn('[tab-out] Could not dismiss mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Let go of "${mission.name}"`);

  }

  // ---- focus: bring the mission's tabs to the front ----
  else if (action === 'focus') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await focusTabsByUrls(urls);
    showToast(`Focused on "${mission.name}"`);
  }

  // ---- close-uncat: close uncategorized tabs by domain ----
  else if (action === 'close-uncat') {
    const domain = actionEl.dataset.domain;
    if (!domain) return;

    // Find all open tabs matching this domain and close them
    const tabsToClose = getOpenTabs().filter(t => {
      try { return new URL(t.url).hostname === domain; }
      catch { return false; }
    });
    const urls = tabsToClose.map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate card removal
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }
    showToast(`Closed ${tabsToClose.length} tab${tabsToClose.length !== 1 ? 's' : ''} from ${domain}`);

  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  if (q.length < 2) {
    // Reset archive list to show all archived items without re-rendering the whole column
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
});


/* ----------------------------------------------------------------
   UPDATE NOTIFICATION (read-only, no code execution)
   ---------------------------------------------------------------- */
async function checkForUpdates() {
  try {
    const res = await fetch('/api/update-status');
    if (!res.ok) return;
    const { updateAvailable } = await res.json();
    if (!updateAvailable) return;

    // Show a simple text notification in the footer
    const footer = document.querySelector('footer');
    if (!footer) return;
    const notice = document.createElement('div');
    notice.style.cssText = 'text-align:center; padding:8px; font-size:12px; color:var(--muted);';
    // Developer-authored static string, no user data. innerHTML is safe here.
    notice.innerHTML = 'A new version of Tab Out is available. Run <code style="background:var(--warm-gray);padding:2px 6px;border-radius:3px;font-size:11px;user-select:all;cursor:pointer;" title="Click to select">git pull https://github.com/leonxia1010/tab-out</code> to update.';
    footer.after(notice);
  } catch {}
}

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
checkForUpdates();
