/**
 * Legacy IIFE mirror of dashboard/src/renderers.ts (Phase 2 PR E).
 *
 * The browser loads the ESM build from dist/renderers.js (via dist/index.js).
 * This file exists ONLY so tests/dashboard/render.test.js can inject it into
 * a JSDOM window via <script> string injection — same dual-load pattern used
 * for dom-utils.js / utils.js / state.js / extension-bridge.js / animations.js.
 * PR G deletes all legacy mirrors in one pass.
 *
 * Contract: keep byte-level parity with src/renderers.ts. parity.test.js
 * enforces window.renderers exports == src exports (function keys).
 */
(function () {
  'use strict';

  var domUtils = window.domUtils;
  var utils    = window.utils;
  var state    = window.state;
  var bridge   = window.extensionBridge;
  var el = domUtils.el, svg = domUtils.svg, mount = domUtils.mount;

  var ICONS = {
    tabs:    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>',
    close:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>',
    archive: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>',
    focus:   '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>'
  };

  var CHIP_SAVE_SVG  = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>';
  var CHIP_CLOSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';
  var DEFERRED_DISMISS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';

  var LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: function (_p, h) {
        return !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/');
      }},
    { hostname: 'x.com',            pathExact: ['/home'] },
    { hostname: 'www.linkedin.com', pathExact: ['/'] },
    { hostname: 'github.com',       pathExact: ['/'] },
    { hostname: 'www.youtube.com',  pathExact: ['/'] }
  ];

  function isLandingPage(url) {
    try {
      var parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(function (p) {
        if (parsed.hostname !== p.hostname) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch (e) { return false; }
  }

  function checkAndShowEmptyState() {
    var missionsEl = document.getElementById('openTabsMissions');
    if (!missionsEl) return;
    var remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
    if (remaining > 0) return;
    missionsEl.innerHTML =
      '<div class="missions-empty-state">' +
      '<div class="empty-checkmark">' +
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />' +
      '</svg></div>' +
      '<div class="empty-title">Inbox zero, but for tabs.</div>' +
      '<div class="empty-subtitle">You\'re free.</div></div>';
    var countEl = document.getElementById('openTabsSectionCount');
    if (countEl) countEl.textContent = '0 missions';
  }

  function renderPageChip(tab, label, urlCounts) {
    urlCounts = urlCounts || {};
    var tabUrl = tab.url || '';
    var count = urlCounts[tabUrl] || 1;

    var domain = '';
    try { domain = new URL(tabUrl).hostname; } catch (e) {}
    var faviconUrl = domain ? 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=16' : '';

    var children = [];

    if (faviconUrl) {
      var favicon = el('img', { className: 'chip-favicon', src: faviconUrl, alt: '' });
      favicon.addEventListener('error', function () { favicon.style.display = 'none'; });
      children.push(favicon);
    }

    children.push(el('span', { className: 'chip-text', textContent: label }));

    if (count > 1) {
      children.push(el('span', { className: 'chip-dupe-badge', textContent: ' (' + count + 'x)' }));
    }

    var saveBtn = el('button', {
      className: 'chip-action chip-save',
      title: 'Save for later',
      dataset: { action: 'defer-single-tab', tabUrl: tabUrl, tabTitle: label }
    }, [svg(CHIP_SAVE_SVG)]);

    var closeBtn = el('button', {
      className: 'chip-action chip-close',
      title: 'Close this tab',
      dataset: { action: 'close-single-tab', tabUrl: tabUrl }
    }, [svg(CHIP_CLOSE_SVG)]);

    children.push(el('div', { className: 'chip-actions' }, [saveBtn, closeBtn]));

    var chipClass = count > 1
      ? 'page-chip clickable chip-has-dupes'
      : 'page-chip clickable';

    return el('div', {
      className: chipClass,
      title: label,
      dataset: { action: 'focus-tab', tabUrl: tabUrl }
    }, children);
  }

  function buildOverflowChips(hiddenTabs, urlCounts) {
    urlCounts = urlCounts || {};
    var overflow = el('div', {
      className: 'page-chips-overflow',
      style: 'display:none'
    }, hiddenTabs.map(function (tab) {
      var label = utils.cleanTitle(utils.smartTitle(utils.stripTitleNoise(tab.title || ''), tab.url || ''), '');
      return renderPageChip(tab, label, urlCounts);
    }));

    var trigger = el('div', {
      className: 'page-chip page-chip-overflow clickable',
      dataset: { action: 'expand-chips' }
    }, [el('span', { className: 'chip-text', textContent: '+' + hiddenTabs.length + ' more' })]);

    return [overflow, trigger];
  }

  function renderDomainCard(group, _groupIndex) {
    var tabs      = group.tabs || [];
    var tabCount  = tabs.length;
    var isLanding = group.domain === '__landing-pages__';
    var stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

    var urlCounts = {};
    for (var i = 0; i < tabs.length; i++) {
      var u = tabs[i].url || '';
      urlCounts[u] = (urlCounts[u] || 0) + 1;
    }
    var dupeUrls = Object.entries(urlCounts).filter(function (e) { return e[1] > 1; });
    var hasDupes = dupeUrls.length > 0;
    var totalExtras = dupeUrls.reduce(function (s, e) { return s + e[1] - 1; }, 0);

    var tabBadge = el('span', { className: 'open-tabs-badge' }, [
      svg(ICONS.tabs),
      ' ' + tabCount + ' tab' + (tabCount !== 1 ? 's' : '') + ' open'
    ]);

    var dupeBadge = hasDupes
      ? el('span', {
          className: 'open-tabs-badge',
          style: 'color: var(--accent-amber); background: rgba(200, 113, 58, 0.08);',
          textContent: totalExtras + ' duplicate' + (totalExtras !== 1 ? 's' : '')
        })
      : null;

    var seen = new Set();
    var uniqueTabs = [];
    for (var j = 0; j < tabs.length; j++) {
      var uu = tabs[j].url || '';
      if (!seen.has(uu)) {
        seen.add(uu);
        uniqueTabs.push(tabs[j]);
      }
    }
    var visibleTabs = uniqueTabs.slice(0, 8);
    var extraCount  = uniqueTabs.length - visibleTabs.length;

    var chipNodes = visibleTabs.map(function (tab) {
      var label = utils.cleanTitle(utils.smartTitle(utils.stripTitleNoise(tab.title || ''), tab.url || ''), group.domain);
      try {
        var parsed = new URL(tab.url || '');
        if (parsed.hostname === 'localhost' && parsed.port) {
          label = parsed.port + ' ' + label;
        }
      } catch (e) {}
      return renderPageChip(tab, label, urlCounts);
    });

    if (extraCount > 0) {
      chipNodes.push.apply(chipNodes, buildOverflowChips(uniqueTabs.slice(8), urlCounts));
    }

    var actionsChildren = [
      el('button', {
        className: 'action-btn close-tabs',
        dataset: { action: 'close-domain-tabs', domainId: stableId }
      }, [svg(ICONS.close), ' Close all ' + tabCount + ' tab' + (tabCount !== 1 ? 's' : '')])
    ];

    if (hasDupes) {
      var dupeUrlsEncoded = dupeUrls.map(function (e) { return encodeURIComponent(e[0]); }).join(',');
      actionsChildren.push(el('button', {
        className: 'action-btn',
        dataset: { action: 'dedup-keep-one', dupeUrls: dupeUrlsEncoded },
        textContent: 'Close ' + totalExtras + ' duplicate' + (totalExtras !== 1 ? 's' : '')
      }));
    }

    var statusBar = el('div', {
      className: 'status-bar',
      style: hasDupes ? 'background: var(--accent-amber);' : undefined
    });

    var missionTopChildren = [
      el('span', {
        className: 'mission-name',
        textContent: isLanding ? 'Homepages' : utils.friendlyDomain(group.domain)
      }),
      tabBadge
    ];
    if (dupeBadge) missionTopChildren.push(dupeBadge);

    var missionContent = el('div', { className: 'mission-content' }, [
      el('div', { className: 'mission-top' }, missionTopChildren),
      el('div', { className: 'mission-pages' }, chipNodes),
      el('div', { className: 'actions' }, actionsChildren)
    ]);

    var missionMeta = el('div', { className: 'mission-meta' }, [
      el('div', { className: 'mission-page-count', textContent: String(tabCount) }),
      el('div', { className: 'mission-page-label', textContent: 'tabs' })
    ]);

    return el('div', {
      className: 'mission-card domain-card ' + (hasDupes ? 'has-amber-bar' : 'has-neutral-bar'),
      dataset: { domainId: stableId }
    }, [statusBar, missionContent, missionMeta]);
  }

  function renderDeferredItem(item) {
    var domain = '';
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch (e) {}
    var faviconUrl = 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=16';
    var ago = utils.timeAgo(item.deferred_at);
    var titleText = item.title || item.url;

    var checkbox = el('input', {
      type: 'checkbox',
      className: 'deferred-checkbox',
      dataset: { action: 'check-deferred', deferredId: item.id }
    });

    var favicon = el('img', {
      src: faviconUrl,
      alt: '',
      style: 'width:14px;height:14px;vertical-align:-2px;margin-right:4px'
    });
    favicon.addEventListener('error', function () { favicon.style.display = 'none'; });

    var link = el('a', {
      href: item.url,
      target: '_blank',
      rel: 'noopener',
      className: 'deferred-title',
      title: item.title || ''
    }, [favicon, titleText]);

    var meta = el('div', { className: 'deferred-meta' }, [
      el('span', { textContent: domain }),
      el('span', { textContent: ago })
    ]);

    var dismiss = el('button', {
      className: 'deferred-dismiss',
      title: 'Dismiss',
      dataset: { action: 'dismiss-deferred', deferredId: item.id }
    }, [svg(DEFERRED_DISMISS_SVG)]);

    return el('div', {
      className: 'deferred-item',
      dataset: { deferredId: item.id }
    }, [checkbox, el('div', { className: 'deferred-info' }, [link, meta]), dismiss]);
  }

  function renderArchiveItem(item) {
    var ago = item.archived_at ? utils.timeAgo(item.archived_at) : '';
    var titleText = item.title || item.url;

    var link = el('a', {
      href: item.url,
      target: '_blank',
      rel: 'noopener',
      className: 'archive-item-title',
      title: item.title || '',
      textContent: titleText
    });

    return el('div', { className: 'archive-item' }, [
      link,
      el('span', { className: 'archive-item-date', textContent: ago })
    ]);
  }

  async function renderDeferredColumn() {
    var column    = document.getElementById('deferredColumn');
    var list      = document.getElementById('deferredList');
    var empty     = document.getElementById('deferredEmpty');
    var countEl   = document.getElementById('deferredCount');
    var archiveEl = document.getElementById('deferredArchive');
    var archiveCountEl = document.getElementById('archiveCount');
    var archiveList    = document.getElementById('archiveList');

    if (!column) return;

    try {
      var res = await fetch('/api/deferred');
      if (!res.ok) throw new Error('Failed to fetch deferred tabs');
      var data = await res.json();

      var active   = data.active   || [];
      var archived = data.archived || [];

      if (active.length === 0 && archived.length === 0) {
        column.style.display = 'none';
        return;
      }

      column.style.display = 'block';

      if (active.length > 0 && list && empty && countEl) {
        countEl.textContent = active.length + ' item' + (active.length !== 1 ? 's' : '');
        mount(list, active.map(renderDeferredItem));
        list.style.display = 'block';
        empty.style.display = 'none';
      } else if (list && empty && countEl) {
        list.style.display = 'none';
        countEl.textContent = '';
        empty.style.display = 'block';
      }

      if (archived.length > 0 && archiveEl && archiveCountEl && archiveList) {
        archiveCountEl.textContent = '(' + archived.length + ')';
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

  function groupTabsByDomain(realTabs) {
    var groupMap = {};
    var landingTabs = [];

    for (var i = 0; i < realTabs.length; i++) {
      var tab = realTabs[i];
      try {
        if (isLandingPage(tab.url || '')) {
          landingTabs.push(tab);
          continue;
        }
        var hostname;
        if (tab.url && tab.url.startsWith('file://')) {
          hostname = 'local-files';
        } else {
          hostname = new URL(tab.url || '').hostname;
        }
        if (!hostname) continue;
        if (!groupMap[hostname]) {
          groupMap[hostname] = { domain: hostname, tabs: [] };
        }
        groupMap[hostname].tabs.push(tab);
      } catch (e) {
        // Skip malformed URLs
      }
    }

    if (landingTabs.length > 0) {
      groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
    }

    var landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(function (p) { return p.hostname; }));
    return Object.values(groupMap).sort(function (a, b) {
      var aIsLanding = a.domain === '__landing-pages__';
      var bIsLanding = b.domain === '__landing-pages__';
      if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;
      var aIsPriority = landingHostnames.has(a.domain);
      var bIsPriority = landingHostnames.has(b.domain);
      if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
      return b.tabs.length - a.tabs.length;
    });
  }

  function renderOpenTabsSection(sortedGroups, realTabsCount) {
    var openTabsSection      = document.getElementById('openTabsSection');
    var openTabsMissionsEl   = document.getElementById('openTabsMissions');
    var openTabsSectionCount = document.getElementById('openTabsSectionCount');
    var openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

    if (sortedGroups.length > 0 && openTabsSection) {
      if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
      var closeAllBtn = el('button', {
        className: 'action-btn close-tabs',
        style: 'font-size:11px;padding:3px 10px;',
        dataset: { action: 'close-all-open-tabs' }
      }, [svg(ICONS.close), ' Close all ' + realTabsCount + ' tabs']);
      if (openTabsSectionCount) {
        mount(openTabsSectionCount, [
          document.createTextNode(sortedGroups.length + ' domain' + (sortedGroups.length !== 1 ? 's' : '') + '\u00a0\u00b7\u00a0'),
          closeAllBtn
        ]);
      }
      if (openTabsMissionsEl) {
        mount(openTabsMissionsEl, sortedGroups.map(function (g, idx) { return renderDomainCard(g, idx); }));
      }
      openTabsSection.style.display = 'block';
    } else if (openTabsSection) {
      openTabsSection.style.display = 'none';
    }
  }

  async function renderStaticDashboard() {
    var greetingEl = document.getElementById('greeting');
    var dateEl     = document.getElementById('dateDisplay');
    if (greetingEl) greetingEl.textContent = utils.getGreeting();
    if (dateEl)     dateEl.textContent     = utils.getDateDisplay();

    await bridge.fetchOpenTabs();
    var realTabs = utils.getRealTabs(state.getOpenTabs());
    var sortedGroups = groupTabsByDomain(realTabs);
    state.setDomainGroups(sortedGroups);
    renderOpenTabsSection(sortedGroups, realTabs.length);

    var statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = String(state.getOpenTabs().length);

    bridge.checkTabOutDupes();
    await renderDeferredColumn();
  }

  async function renderDashboard() {
    await renderStaticDashboard();
  }

  window.renderers = {
    checkAndShowEmptyState: checkAndShowEmptyState,
    renderPageChip: renderPageChip,
    buildOverflowChips: buildOverflowChips,
    renderDomainCard: renderDomainCard,
    renderDeferredItem: renderDeferredItem,
    renderArchiveItem: renderArchiveItem,
    renderDeferredColumn: renderDeferredColumn,
    groupTabsByDomain: groupTabsByDomain,
    renderOpenTabsSection: renderOpenTabsSection,
    renderStaticDashboard: renderStaticDashboard,
    renderDashboard: renderDashboard
  };
})();
