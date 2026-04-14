/**
 * Legacy IIFE mirror of dashboard/src/handlers.ts (Phase 2 PR F).
 *
 * The browser loads the ESM build from dist/handlers.js (via dist/index.js).
 * This file exists ONLY so tests/dashboard/parity.test.js can compare the
 * IIFE's runtime keys against the TS module's exports — same dual-load
 * pattern used for dom-utils.js / utils.js / state.js / extension-bridge.js
 * / animations.js / renderers.js. PR G deletes all legacy mirrors.
 *
 * Contract: keep byte-level parity with src/handlers.ts. parity.test.js
 * enforces window.handlers exports == src exports (function keys minus
 * tsOnly).
 */
(function () {
  'use strict';

  var domUtils = window.domUtils;
  var utils    = window.utils;
  var state    = window.state;
  var bridge   = window.extensionBridge;
  var anims    = window.animations;
  var rend     = window.renderers;
  var el = domUtils.el, mount = domUtils.mount;

  function animateCardOut(card) {
    anims.animateCardOut(card, rend.checkAndShowEmptyState);
  }

  async function handleCloseTabOutDupes() {
    await bridge.sendToExtension('closeTabOutDupes');
    await bridge.fetchOpenTabs();
    anims.playCloseSound();
    var banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(function () { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    anims.showToast('Closed extra Tab Out tabs');
  }

  function handleExpandChips(actionEl) {
    var overflowContainer = actionEl.parentElement && actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
  }

  async function handleFocusTab(actionEl) {
    var tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) {
      await bridge.sendToExtension('focusTab', { url: tabUrl });
    }
  }

  async function handleCloseSingleTab(e, actionEl) {
    e.stopPropagation();
    var tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    await bridge.sendToExtension('closeTabs', { urls: [tabUrl] });
    anims.playCloseSound();
    await bridge.fetchOpenTabs();

    var chip = actionEl.closest('.page-chip');
    if (chip) {
      var rect = chip.getBoundingClientRect();
      anims.shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(function () {
        chip.remove();
        var cardEmpty = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (cardEmpty) animateCardOut(cardEmpty);
        document.querySelectorAll('.mission-card').forEach(function (c) {
          var remainingTabs = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
          if (remainingTabs.length === 0) animateCardOut(c);
        });
      }, 200);
    }

    anims.showToast('Tab closed');
  }

  async function handleDeferSingleTab(e, actionEl) {
    e.stopPropagation();
    var tabUrl   = actionEl.dataset.tabUrl;
    var tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    try {
      await fetch('/api/defer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs: [{ url: tabUrl, title: tabTitle }] })
      });
    } catch (err) {
      console.error('[tab-out] Failed to defer tab:', err);
      anims.showToast('Failed to save tab');
      return;
    }

    await bridge.sendToExtension('closeTabs', { urls: [tabUrl] });
    await bridge.fetchOpenTabs();

    var chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(function () { chip.remove(); }, 200);
    }

    anims.showToast('Saved for later');
    await rend.renderDeferredColumn();
  }

  async function handleCheckDeferred(actionEl) {
    var id = actionEl.dataset.deferredId;
    if (!id) return;
    try {
      await fetch('/api/deferred/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: true })
      });
    } catch (err) {
      console.error('[tab-out] Failed to check deferred tab:', err);
      return;
    }
    var item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(function () {
        item.classList.add('removing');
        setTimeout(function () {
          item.remove();
          rend.renderDeferredColumn();
        }, 300);
      }, 800);
    }
  }

  async function handleDismissDeferred(actionEl) {
    var id = actionEl.dataset.deferredId;
    if (!id) return;
    try {
      await fetch('/api/deferred/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: true })
      });
    } catch (err) {
      console.error('[tab-out] Failed to dismiss deferred tab:', err);
      return;
    }
    var item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(function () {
        item.remove();
        rend.renderDeferredColumn();
      }, 300);
    }
  }

  async function handleCloseDomainTabs(actionEl, card) {
    var domainId = actionEl.dataset.domainId;
    var groups = state.getDomainGroups();
    var group = groups.find(function (g) {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    var urls = group.tabs.map(function (t) { return t.url || ''; }).filter(Boolean);
    var useExact = group.domain === '__landing-pages__';
    await bridge.sendToExtension('closeTabs', { urls: urls, exact: useExact });
    await bridge.fetchOpenTabs();

    if (card) {
      anims.playCloseSound();
      animateCardOut(card);
    }

    state.setDomainGroups(groups.filter(function (g) { return g !== group; }));

    var groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : utils.friendlyDomain(group.domain);
    anims.showToast('Closed ' + urls.length + ' tab' + (urls.length !== 1 ? 's' : '') + ' from ' + groupLabel);

    var statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = String(state.getOpenTabs().length);
  }

  async function handleDedupKeepOne(actionEl, card) {
    var urlsEncoded = actionEl.dataset.dupeUrls || '';
    var urls = urlsEncoded.split(',').map(function (u) { return decodeURIComponent(u); }).filter(Boolean);
    if (urls.length === 0) return;

    await bridge.sendToExtension('closeDuplicates', { urls: urls, keepOne: true });
    anims.playCloseSound();
    await bridge.fetchOpenTabs();

    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity = '0';
    setTimeout(function () { actionEl.remove(); }, 200);

    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(function (b) {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity = '0';
        setTimeout(function () { b.remove(); }, 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(function (badge) {
        if ((badge.textContent || '').includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity = '0';
          setTimeout(function () { badge.remove(); }, 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
      var statusBar = card.querySelector('.status-bar');
      if (statusBar) statusBar.style.background = '';
    }

    anims.showToast('Closed duplicates, kept one copy each');
  }

  async function handleCloseAllOpenTabs() {
    var allUrls = state.getOpenTabs()
      .filter(function (t) { return t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'); })
      .map(function (t) { return t.url || ''; });
    await bridge.closeTabsByUrls(allUrls);
    anims.playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(function (c) {
      anims.shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    anims.showToast('All tabs closed. Fresh start.');
  }

  function missionUrls(mission) {
    var raw = mission.urls;
    var arr = Array.isArray(raw) ? raw : [];
    return arr.map(function (u) { return (u && u.url) || ''; }).filter(Boolean);
  }

  function missionName(mission) {
    return typeof mission.name === 'string' ? mission.name : '';
  }

  async function handleArchiveMission(missionId, card) {
    if (!missionId) return;
    var mission = await bridge.fetchMissionById(missionId);
    if (!mission) return;

    await bridge.closeTabsByUrls(missionUrls(mission));

    try {
      await fetch('/api/missions/' + missionId + '/archive', { method: 'POST' });
    } catch (err) {
      console.warn('[tab-out] Could not archive mission:', err);
    }

    if (card) {
      anims.playCloseSound();
      animateCardOut(card);
    }

    anims.showToast('Archived "' + missionName(mission) + '"');
  }

  async function handleDismissMission(missionId, card) {
    if (!missionId) return;
    var mission = await bridge.fetchMissionById(missionId);
    if (!mission) return;

    var tabCountStr = card
      ? ((card.querySelector('.open-tabs-badge') && card.querySelector('.open-tabs-badge').textContent && card.querySelector('.open-tabs-badge').textContent.match(/\d+/) && card.querySelector('.open-tabs-badge').textContent.match(/\d+/)[0]) || '0')
      : '0';

    if (parseInt(tabCountStr, 10) > 0) {
      await bridge.closeTabsByUrls(missionUrls(mission));
    }

    try {
      await fetch('/api/missions/' + missionId + '/dismiss', { method: 'POST' });
    } catch (err) {
      console.warn('[tab-out] Could not dismiss mission:', err);
    }

    if (card) {
      anims.playCloseSound();
      animateCardOut(card);
    }

    anims.showToast('Let go of "' + missionName(mission) + '"');
  }

  async function handleFocusMission(missionId) {
    if (!missionId) return;
    var mission = await bridge.fetchMissionById(missionId);
    if (!mission) return;
    await bridge.focusTabsByUrls(missionUrls(mission));
    anims.showToast('Focused on "' + missionName(mission) + '"');
  }

  async function handleCloseUncat(actionEl, card) {
    var domain = actionEl.dataset.domain;
    if (!domain) return;
    var tabsToClose = state.getOpenTabs().filter(function (t) {
      try { return new URL(t.url || '').hostname === domain; }
      catch (e) { return false; }
    });
    var urls = tabsToClose.map(function (t) { return t.url || ''; }).filter(Boolean);
    await bridge.closeTabsByUrls(urls);

    if (card) {
      anims.playCloseSound();
      animateCardOut(card);
    }
    anims.showToast('Closed ' + tabsToClose.length + ' tab' + (tabsToClose.length !== 1 ? 's' : '') + ' from ' + domain);
  }

  async function dispatchClick(e) {
    var target = e.target;
    var actionEl = target && target.closest && target.closest('[data-action]');
    if (!actionEl) return;

    var action    = actionEl.dataset.action;
    var missionId = actionEl.dataset.missionId;
    var card      = actionEl.closest('.mission-card');

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

  function dispatchArchiveToggle(e) {
    var toggle = e.target && e.target.closest && e.target.closest('#archiveToggle');
    if (!toggle) return;
    toggle.classList.toggle('open');
    var body = document.getElementById('archiveBody');
    if (body) {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    }
  }

  async function dispatchArchiveSearch(e) {
    var target = e.target;
    if (!target || target.id !== 'archiveSearch') return;

    var q = target.value.trim();
    var archiveList = document.getElementById('archiveList');
    if (!archiveList) return;

    if (q.length < 2) {
      try {
        var res = await fetch('/api/deferred');
        if (res.ok) {
          var data = await res.json();
          mount(archiveList, (data.archived || []).map(rend.renderArchiveItem));
        }
      } catch (e2) {}
      return;
    }

    try {
      var res2 = await fetch('/api/deferred/search?q=' + encodeURIComponent(q));
      if (!res2.ok) return;
      var data2 = await res2.json();
      var results = data2.results || [];
      if (results.length === 0) {
        mount(archiveList, el('div', {
          style: 'font-size:12px;color:var(--muted);padding:8px 0',
          textContent: 'No results'
        }));
      } else {
        mount(archiveList, results.map(rend.renderArchiveItem));
      }
    } catch (err) {
      console.warn('[tab-out] Archive search failed:', err);
    }
  }

  var attached = false;
  function attachListeners() {
    if (attached) return;
    attached = true;
    document.addEventListener('click', dispatchClick);
    document.addEventListener('click', dispatchArchiveToggle);
    document.addEventListener('input', dispatchArchiveSearch);
  }

  window.handlers = {
    handleCloseTabOutDupes: handleCloseTabOutDupes,
    handleExpandChips: handleExpandChips,
    handleFocusTab: handleFocusTab,
    handleCloseSingleTab: handleCloseSingleTab,
    handleDeferSingleTab: handleDeferSingleTab,
    handleCheckDeferred: handleCheckDeferred,
    handleDismissDeferred: handleDismissDeferred,
    handleCloseDomainTabs: handleCloseDomainTabs,
    handleDedupKeepOne: handleDedupKeepOne,
    handleCloseAllOpenTabs: handleCloseAllOpenTabs,
    handleArchiveMission: handleArchiveMission,
    handleDismissMission: handleDismissMission,
    handleFocusMission: handleFocusMission,
    handleCloseUncat: handleCloseUncat,
    dispatchClick: dispatchClick,
    dispatchArchiveToggle: dispatchArchiveToggle,
    dispatchArchiveSearch: dispatchArchiveSearch,
    attachListeners: attachListeners
  };
})();
