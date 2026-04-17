// @vitest-environment jsdom
// tests/dashboard/handlers.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Coverage for extension/dashboard/src/handlers.ts — the single document-level
// click/input dispatcher. handlers.ts is the biggest user-interaction surface
// in the dashboard (12-case switch, 400+ lines) and had no tests, so a typo
// in a `case` string would silently no-op.
//
// Strategy: mock the four collaborators (api, extension-bridge, animations,
// renderers) so assertions target handler wiring rather than end-to-end
// behavior. Synthesize click/input events on data-action elements inside a
// jsdom body and verify (a) which API the handler called, (b) which DOM
// mutation it drove, and (c) the follow-up side effects (toast, counter
// refresh, deferred-column re-render).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function installDom() {
  // archiveToggle + archiveClearAll carry data-action so they route through
  // the unified dispatchClick switch alongside every other clickable surface
  // (PR follow-up I-7). The toggle fires even with inline children because
  // closest('[data-action]') walks up from whatever was clicked.
  document.body.innerHTML = `
    <div id="openTabsDomains"></div>
    <div id="tabOutDupeBanner" style="display:none"><span id="tabOutDupeCount"></span></div>
    <div id="toast"><span id="toastText"></span></div>
    <div id="statTabs"></div>
    <div id="archiveList"></div>
    <button id="archiveToggle" data-action="archive-toggle"></button>
    <div id="archiveBody"></div>
    <button id="archiveClearAll" data-action="archive-clear-all"></button>
    <input id="archiveSearch" type="text" />
  `;
}

// Each test gets a freshly built mock module graph. We only pre-populate what
// handlers.ts imports; unrelated exports from the real modules are preserved
// via vi.importActual so intra-module references (e.g. renderers using
// dom-utils) keep working.
async function loadHandlersWithMocks() {
  const apiSpies = {
    saveDefer: vi.fn().mockResolvedValue({ success: true, created: [], renewed: [] }),
    checkDeferred: vi.fn().mockResolvedValue({ success: true }),
    dismissDeferred: vi.fn().mockResolvedValue({ success: true }),
    getDeferred: vi.fn().mockResolvedValue({ active: [], archived: [] }),
    searchDeferred: vi.fn().mockResolvedValue({ results: [] }),
    deleteArchived: vi.fn().mockResolvedValue({ success: true }),
    restoreArchived: vi.fn().mockResolvedValue({ success: true, merged: false }),
    clearAllArchived: vi.fn().mockResolvedValue({ success: true, deleted: 0 }),
  };
  const bridgeSpies = {
    closeTabsByUrls: vi.fn().mockResolvedValue(undefined),
    closeDuplicates: vi.fn().mockResolvedValue(undefined),
    closeTabOutDupes: vi.fn().mockResolvedValue(undefined),
    focusTab: vi.fn().mockResolvedValue(undefined),
  };
  const animSpies = {
    animateCardOut: vi.fn(),
    playCloseSound: vi.fn(),
    shootConfetti: vi.fn(),
    showToast: vi.fn(),
  };
  const renderSpies = {
    checkAndShowEmptyState: vi.fn(),
    refreshOpenTabsCounters: vi.fn(),
    renderArchiveItem: vi.fn(() => document.createElement('div')),
    renderDeferredColumn: vi.fn().mockResolvedValue(undefined),
  };
  const settingsSpies = {
    setSettings: vi.fn().mockResolvedValue({ theme: 'dark', clock: { format: '24h' } }),
    // Default: no pins, no hides. Tests that exercise shortcut-pin /
    // shortcut-hide override this via settingsSpies.getSettings.mockResolvedValueOnce.
    getSettings: vi.fn().mockResolvedValue({
      theme: 'system',
      clock: { format: '24h' },
      layout: 'masonry',
      shortcutPins: [],
      shortcutHides: [],
    }),
  };

  vi.doMock('../../extension/dashboard/src/api.ts', () => apiSpies);
  vi.doMock('../../extension/dashboard/src/extension-bridge.ts', () => bridgeSpies);
  vi.doMock('../../extension/dashboard/src/animations.ts', () => animSpies);
  vi.doMock('../../extension/dashboard/src/renderers.ts', async () => {
    const actual = await vi.importActual('../../extension/dashboard/src/renderers.ts');
    return { ...actual, ...renderSpies };
  });
  vi.doMock('../../extension/shared/dist/settings.js', () => settingsSpies);

  const state = await import('../../extension/dashboard/src/state.ts');
  const handlers = await import('../../extension/dashboard/src/handlers.ts');
  return {
    state, handlers,
    api: apiSpies, bridge: bridgeSpies, anim: animSpies,
    render: renderSpies, settings: settingsSpies,
  };
}

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function makeChromeTabs({ createImpl } = {}) {
  const create = vi.fn(createImpl || (async () => ({})));
  vi.stubGlobal('chrome', {
    tabs: { create },
    runtime: { id: 'EXTID' },
  });
  return { create };
}

// Track every listener attachListeners() registers so afterEach can strip
// them. Without this, document-level click listeners accumulate across
// tests (jsdom reuses the same document, handlers.ts's module-level
// `attached` flag resets with vi.resetModules), and stale listeners from
// previous tests' modules try to dispatch with their own now-unmocked
// imports — producing noisy stderr but not breaking assertions. We patch
// document.addEventListener once, remember everything, and roll back.
const installedListeners = [];
const origAddEventListener = document.addEventListener.bind(document);
document.addEventListener = (type, handler, opts) => {
  installedListeners.push({ type, handler, opts });
  origAddEventListener(type, handler, opts);
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  installDom();
});

afterEach(() => {
  for (const { type, handler, opts } of installedListeners) {
    document.removeEventListener(type, handler, opts);
  }
  installedListeners.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../../extension/dashboard/src/api.ts');
  vi.doUnmock('../../extension/dashboard/src/extension-bridge.ts');
  vi.doUnmock('../../extension/dashboard/src/animations.ts');
  vi.doUnmock('../../extension/dashboard/src/renderers.ts');
  vi.doUnmock('../../extension/shared/dist/settings.js');
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

describe('attachListeners — idempotency', () => {
  it('wires listeners exactly once even if called twice', async () => {
    const { handlers, bridge } = await loadHandlersWithMocks();
    handlers.attachListeners();
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'focus-tab';
    btn.dataset.tabUrl = 'https://a.com/';
    document.body.appendChild(btn);
    click(btn);
    await vi.runAllTimersAsync();

    expect(bridge.focusTab).toHaveBeenCalledTimes(1);
  });

  it('no-ops on unknown data-action (typo protection)', async () => {
    const { handlers, bridge, api } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'not-a-real-action';
    document.body.appendChild(btn);
    click(btn);
    await vi.runAllTimersAsync();

    expect(bridge.closeTabsByUrls).not.toHaveBeenCalled();
    expect(bridge.focusTab).not.toHaveBeenCalled();
    expect(api.saveDefer).not.toHaveBeenCalled();
  });
});

describe('handleCloseSingleTab', () => {
  it('calls closeTabsByUrls with the chip url, plays sound, shows toast', async () => {
    const { handlers, bridge, anim } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const chip = document.createElement('div');
    chip.className = 'page-chip';
    const closeBtn = document.createElement('button');
    closeBtn.dataset.action = 'close-single-tab';
    closeBtn.dataset.tabUrl = 'https://a.com/page';
    chip.appendChild(closeBtn);
    document.getElementById('openTabsDomains').appendChild(chip);

    click(closeBtn);
    await vi.runAllTimersAsync();

    expect(bridge.closeTabsByUrls).toHaveBeenCalledWith(['https://a.com/page']);
    expect(anim.playCloseSound).toHaveBeenCalledTimes(1);
    expect(anim.showToast).toHaveBeenCalledWith('Tab closed');
  });
});

describe('handleDeferSingleTab', () => {
  it('saves to deferred, closes tab, re-renders column, shows "Saved for later"', async () => {
    const { handlers, api, bridge, anim, render } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const chip = document.createElement('div');
    chip.className = 'page-chip';
    const saveBtn = document.createElement('button');
    saveBtn.dataset.action = 'defer-single-tab';
    saveBtn.dataset.tabUrl = 'https://b.com/x';
    saveBtn.dataset.tabTitle = 'B Page';
    chip.appendChild(saveBtn);
    document.getElementById('openTabsDomains').appendChild(chip);

    click(saveBtn);
    await vi.runAllTimersAsync();

    expect(api.saveDefer).toHaveBeenCalledWith([{ url: 'https://b.com/x', title: 'B Page' }]);
    expect(bridge.closeTabsByUrls).toHaveBeenCalledWith(['https://b.com/x']);
    expect(render.renderDeferredColumn).toHaveBeenCalledTimes(1);
    expect(anim.showToast).toHaveBeenCalledWith('Saved for later');
  });

  it('shows "Moved to top" toast when saveDefer reports a renewal', async () => {
    const { handlers, api, anim } = await loadHandlersWithMocks();
    api.saveDefer.mockResolvedValueOnce({
      success: true,
      created: [],
      renewed: [{ id: 1, url: 'https://b.com/x', title: 'B', favicon_url: null, source_mission: null, deferred_at: '' }],
    });
    handlers.attachListeners();

    const chip = document.createElement('div');
    chip.className = 'page-chip';
    const saveBtn = document.createElement('button');
    saveBtn.dataset.action = 'defer-single-tab';
    saveBtn.dataset.tabUrl = 'https://b.com/x';
    saveBtn.dataset.tabTitle = 'B';
    chip.appendChild(saveBtn);
    document.getElementById('openTabsDomains').appendChild(chip);

    click(saveBtn);
    await vi.runAllTimersAsync();

    expect(anim.showToast).toHaveBeenCalledWith('Already saved. Moved to top.');
  });

  it('shows "Failed to save tab" and skips close when saveDefer rejects', async () => {
    const { handlers, api, bridge, anim, render } = await loadHandlersWithMocks();
    api.saveDefer.mockRejectedValueOnce(new Error('boom'));
    handlers.attachListeners();

    const chip = document.createElement('div');
    chip.className = 'page-chip';
    const saveBtn = document.createElement('button');
    saveBtn.dataset.action = 'defer-single-tab';
    saveBtn.dataset.tabUrl = 'https://b.com/x';
    saveBtn.dataset.tabTitle = 'B';
    chip.appendChild(saveBtn);
    document.getElementById('openTabsDomains').appendChild(chip);

    // Swallow the expected console.error from the handler's catch.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    click(saveBtn);
    await vi.runAllTimersAsync();

    expect(bridge.closeTabsByUrls).not.toHaveBeenCalled();
    expect(render.renderDeferredColumn).not.toHaveBeenCalled();
    expect(anim.showToast).toHaveBeenCalledWith('Failed to save tab');

    err.mockRestore();
  });
});

describe('handleCheckDeferred / handleDismissDeferred', () => {
  it('handleCheckDeferred calls api.checkDeferred with the row id', async () => {
    const { handlers, api } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const row = document.createElement('div');
    row.className = 'deferred-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.action = 'check-deferred';
    cb.dataset.deferredId = '42';
    row.appendChild(cb);
    document.body.appendChild(row);

    click(cb);
    await vi.runAllTimersAsync();

    expect(api.checkDeferred).toHaveBeenCalledWith('42');
  });

  it('handleDismissDeferred calls api.dismissDeferred and re-renders column', async () => {
    const { handlers, api, render } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const row = document.createElement('div');
    row.className = 'deferred-item';
    const x = document.createElement('button');
    x.dataset.action = 'dismiss-deferred';
    x.dataset.deferredId = '7';
    row.appendChild(x);
    document.body.appendChild(row);

    click(x);
    await vi.runAllTimersAsync();

    expect(api.dismissDeferred).toHaveBeenCalledWith('7');
    expect(render.renderDeferredColumn).toHaveBeenCalled();
  });
});

describe('handleRestoreArchived — v2.2.0 archive → active round-trip', () => {
  function buildArchiveRow(id) {
    const row = document.createElement('div');
    row.className = 'archive-item';
    const btn = document.createElement('button');
    btn.dataset.action = 'restore-archived';
    btn.dataset.deferredId = String(id);
    row.appendChild(btn);
    document.body.appendChild(row);
    return { row, btn };
  }

  it('calls api.restoreArchived, removes the row, re-renders, and shows "Restored" toast on clean restore', async () => {
    const { handlers, api, anim, render } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const { btn } = buildArchiveRow(42);
    click(btn);
    await vi.runAllTimersAsync();

    expect(api.restoreArchived).toHaveBeenCalledWith('42');
    expect(render.renderDeferredColumn).toHaveBeenCalled();
    expect(anim.showToast).toHaveBeenCalledWith('Restored');
  });

  it('shows "Already in saved for later" toast when the API reports a merge', async () => {
    const { handlers, api, anim } = await loadHandlersWithMocks();
    api.restoreArchived.mockResolvedValueOnce({ success: true, merged: true });
    handlers.attachListeners();

    const { btn } = buildArchiveRow(7);
    click(btn);
    await vi.runAllTimersAsync();

    expect(anim.showToast).toHaveBeenCalledWith('Already in saved for later');
  });

  it('no-ops when data-deferred-id is missing', async () => {
    const { handlers, api } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'restore-archived';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(api.restoreArchived).not.toHaveBeenCalled();
  });
});

describe('handleOpenSaved — saved chrome:// urls route through chrome.tabs.create', () => {
  it('intercepts anchor click and calls chrome.tabs.create', async () => {
    const chrome = makeChromeTabs();
    const { handlers } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const a = document.createElement('a');
    a.href = '#';
    a.dataset.action = 'open-saved';
    a.dataset.savedUrl = 'chrome://extensions/';
    document.body.appendChild(a);

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(evt);
    await vi.runAllTimersAsync();

    expect(evt.defaultPrevented).toBe(true);
    expect(chrome.create).toHaveBeenCalledWith({ url: 'chrome://extensions/' });
  });

  it('no-ops cleanly when data-saved-url is missing', async () => {
    const chrome = makeChromeTabs();
    const { handlers } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const a = document.createElement('a');
    a.href = '#';
    a.dataset.action = 'open-saved';
    document.body.appendChild(a);

    click(a);
    await vi.runAllTimersAsync();

    expect(chrome.create).not.toHaveBeenCalled();
  });
});

describe('handleCloseAllOpenTabs — never closes the dashboard tab', () => {
  it('filters out isTabOut entries before calling closeTabsByUrls', async () => {
    const { state, handlers, bridge } = await loadHandlersWithMocks();
    state.setOpenTabs([
      { url: 'https://a.com/', title: 'A' },
      { url: 'chrome-extension://EXTID/dashboard/index.html', title: 'Tab Out', isTabOut: true },
      { url: 'https://b.com/', title: 'B' },
    ]);
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'close-all-open-tabs';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    const [urls, exact] = bridge.closeTabsByUrls.mock.calls[0];
    expect(urls).toEqual(['https://a.com/', 'https://b.com/']);
    expect(urls).not.toContain('chrome-extension://EXTID/dashboard/index.html');
    expect(exact).toBe(true);
  });

  it('returns early when only Tab Out tabs are open (no closeTabsByUrls call)', async () => {
    const { state, handlers, bridge } = await loadHandlersWithMocks();
    state.setOpenTabs([
      { url: 'chrome-extension://EXTID/dashboard/index.html', title: 'Tab Out', isTabOut: true },
    ]);
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'close-all-open-tabs';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(bridge.closeTabsByUrls).not.toHaveBeenCalled();
  });
});

describe('handleCloseDomainTabs — matches card by domainId slug', () => {
  it('closes every url in the matched group and animates the card out', async () => {
    const { state, handlers, bridge, anim } = await loadHandlersWithMocks();
    state.setDomainGroups([
      {
        domain: 'example.com',
        tabs: [
          { url: 'https://example.com/a', title: 'A' },
          { url: 'https://example.com/b', title: 'B' },
        ],
      },
    ]);
    handlers.attachListeners();

    const card = document.createElement('div');
    card.className = 'domain-card';
    const btn = document.createElement('button');
    btn.dataset.action = 'close-domain-tabs';
    btn.dataset.domainId = 'domain-example-com';
    card.appendChild(btn);
    document.getElementById('openTabsDomains').appendChild(card);

    click(btn);
    await vi.runAllTimersAsync();

    expect(bridge.closeTabsByUrls).toHaveBeenCalledWith([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(anim.animateCardOut).toHaveBeenCalledWith(card, expect.any(Function));
  });
});

describe('handleFocusTab', () => {
  it('delegates to bridge.focusTab with the chip url', async () => {
    const { handlers, bridge } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const chip = document.createElement('div');
    chip.dataset.action = 'focus-tab';
    chip.dataset.tabUrl = 'https://c.com/';
    document.body.appendChild(chip);

    click(chip);
    await vi.runAllTimersAsync();

    expect(bridge.focusTab).toHaveBeenCalledWith('https://c.com/');
  });
});

describe('dispatchArchiveToggle + archiveSearch', () => {
  it('clicking archiveToggle flips .open on both the button and #archiveBody', async () => {
    const { handlers } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const toggle = document.getElementById('archiveToggle');
    const body = document.getElementById('archiveBody');

    click(toggle);
    expect(toggle.classList.contains('open')).toBe(true);
    expect(body.classList.contains('open')).toBe(true);

    click(toggle);
    expect(toggle.classList.contains('open')).toBe(false);
    expect(body.classList.contains('open')).toBe(false);
  });

  it('archiveSearch with ≥2 chars calls searchDeferred and mounts renderArchiveItem output', async () => {
    const { handlers, api, render } = await loadHandlersWithMocks();
    api.searchDeferred.mockResolvedValueOnce({
      results: [
        {
          id: 1,
          url: 'https://a.com',
          title: 'A',
          favicon_url: null,
          source_mission: null,
          deferred_at: '',
          checked: 0,
          checked_at: null,
          dismissed: 0,
          archived: 1,
          archived_at: null,
        },
      ],
    });
    handlers.attachListeners();

    const input = document.getElementById('archiveSearch');
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.runAllTimersAsync();

    expect(api.searchDeferred).toHaveBeenCalledWith('abc');
    expect(render.renderArchiveItem).toHaveBeenCalledTimes(1);
  });

  it('archiveSearch with <2 chars falls back to getDeferred (no search call)', async () => {
    const { handlers, api } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const input = document.getElementById('archiveSearch');
    input.value = 'a';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.runAllTimersAsync();

    expect(api.searchDeferred).not.toHaveBeenCalled();
    expect(api.getDeferred).toHaveBeenCalledTimes(1);
  });

  it('archiveSearch swallows getDeferred rejection (bare catch path)', async () => {
    // The short-query branch has `try { ... } catch {}` — empty catch by
    // design (UI already shows whatever was on screen). This test pins
    // "swallow, don't crash the listener chain" as the documented
    // contract.
    const { handlers, api } = await loadHandlersWithMocks();
    api.getDeferred.mockRejectedValueOnce(new Error('storage unavailable'));
    handlers.attachListeners();

    const input = document.getElementById('archiveSearch');
    input.value = 'a';
    const fire = () => input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fire).not.toThrow();
    await vi.runAllTimersAsync();

    // searchDeferred still not called (query too short); getDeferred got
    // a chance to reject, and we observed no escalation.
    expect(api.searchDeferred).not.toHaveBeenCalled();
    expect(api.getDeferred).toHaveBeenCalledTimes(1);
  });
});

describe('handleArchiveClearAll — confirm gate + clear + toast', () => {
  it('skips the API call when window.confirm returns false', async () => {
    const { handlers, api } = await loadHandlersWithMocks();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    handlers.attachListeners();

    click(document.getElementById('archiveClearAll'));
    await vi.runAllTimersAsync();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(api.clearAllArchived).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('clears and toasts when confirmed', async () => {
    const { handlers, api, anim, render } = await loadHandlersWithMocks();
    api.clearAllArchived.mockResolvedValueOnce({ success: true, deleted: 3 });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    handlers.attachListeners();

    click(document.getElementById('archiveClearAll'));
    await vi.runAllTimersAsync();

    expect(api.clearAllArchived).toHaveBeenCalledTimes(1);
    expect(render.renderDeferredColumn).toHaveBeenCalled();
    expect(anim.showToast).toHaveBeenCalledWith('Cleared 3 archived tabs');
    confirmSpy.mockRestore();
  });
});

describe('handleCloseTabOutDupes — hides banner and refreshes counters', () => {
  it('calls bridge.closeTabOutDupes + hides the banner via opacity transition', async () => {
    const { handlers, bridge, render } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const banner = document.getElementById('tabOutDupeBanner');
    banner.style.display = 'flex';
    const trigger = document.createElement('button');
    trigger.dataset.action = 'close-tabout-dupes';
    banner.appendChild(trigger);

    click(trigger);
    await vi.runAllTimersAsync();

    expect(bridge.closeTabOutDupes).toHaveBeenCalledTimes(1);
    expect(banner.style.display).toBe('none');
    expect(render.refreshOpenTabsCounters).toHaveBeenCalled();
  });
});

describe('handleSetTheme — header popover + options page radios', () => {
  // applyTheme is the real module (a pure DOM mutation — no need to mock
  // to assert html[data-theme]). Only setSettings is stubbed because the
  // real one hits chrome.storage.local.
  it('set-theme-dark sets data-theme="dark" + calls setSettings', async () => {
    const { handlers, settings } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'set-theme-dark';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(settings.setSettings).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('set-theme-light sets data-theme="light" + calls setSettings', async () => {
    const { handlers, settings } = await loadHandlersWithMocks();
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'set-theme-light';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(settings.setSettings).toHaveBeenCalledWith({ theme: 'light' });
  });

  it('shortcut-pin appends to shortcutPins and toasts', async () => {
    const { handlers, settings, anim } = await loadHandlersWithMocks();
    settings.getSettings.mockResolvedValueOnce({
      theme: 'system', clock: { format: '24h' }, layout: 'masonry',
      shortcutPins: [], shortcutHides: [],
    });
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'shortcut-pin';
    btn.dataset.url = 'https://foo.test/';
    btn.dataset.title = 'Foo';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(settings.setSettings).toHaveBeenCalledWith({
      shortcutPins: [{ url: 'https://foo.test/', title: 'Foo' }],
    });
    expect(anim.showToast).toHaveBeenCalledWith('Pinned');
  });

  it('shortcut-pin is a no-op + toast when already pinned', async () => {
    const { handlers, settings, anim } = await loadHandlersWithMocks();
    settings.getSettings.mockResolvedValueOnce({
      theme: 'system', clock: { format: '24h' }, layout: 'masonry',
      shortcutPins: [{ url: 'https://foo.test/', title: 'Foo' }], shortcutHides: [],
    });
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'shortcut-pin';
    btn.dataset.url = 'https://foo.test/';
    btn.dataset.title = 'Foo';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(settings.setSettings).not.toHaveBeenCalled();
    expect(anim.showToast).toHaveBeenCalledWith('Already pinned');
  });

  it('shortcut-unpin filters the URL out of shortcutPins and toasts', async () => {
    const { handlers, settings, anim } = await loadHandlersWithMocks();
    settings.getSettings.mockResolvedValueOnce({
      theme: 'system', clock: { format: '24h' }, layout: 'masonry',
      shortcutPins: [
        { url: 'https://foo.test/', title: 'Foo' },
        { url: 'https://bar.test/', title: 'Bar' },
      ],
      shortcutHides: [],
    });
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'shortcut-unpin';
    btn.dataset.url = 'https://foo.test/';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(settings.setSettings).toHaveBeenCalledWith({
      shortcutPins: [{ url: 'https://bar.test/', title: 'Bar' }],
    });
    expect(anim.showToast).toHaveBeenCalledWith('Unpinned');
  });

  it('shortcut-unpin is a silent no-op when URL is not pinned', async () => {
    const { handlers, settings, anim } = await loadHandlersWithMocks();
    settings.getSettings.mockResolvedValueOnce({
      theme: 'system', clock: { format: '24h' }, layout: 'masonry',
      shortcutPins: [], shortcutHides: [],
    });
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'shortcut-unpin';
    btn.dataset.url = 'https://missing.test/';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(settings.setSettings).not.toHaveBeenCalled();
    expect(anim.showToast).not.toHaveBeenCalled();
  });

  it('shortcut-hide appends to shortcutHides and toasts', async () => {
    const { handlers, settings, anim } = await loadHandlersWithMocks();
    settings.getSettings.mockResolvedValueOnce({
      theme: 'system', clock: { format: '24h' }, layout: 'masonry',
      shortcutPins: [], shortcutHides: [],
    });
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'shortcut-hide';
    btn.dataset.url = 'https://bar.test/';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(settings.setSettings).toHaveBeenCalledWith({
      shortcutHides: ['https://bar.test/'],
    });
    expect(anim.showToast).toHaveBeenCalledWith('Hidden');
  });

  it('shortcut-hide refuses to hide a pinned URL', async () => {
    const { handlers, settings, anim } = await loadHandlersWithMocks();
    settings.getSettings.mockResolvedValueOnce({
      theme: 'system', clock: { format: '24h' }, layout: 'masonry',
      shortcutPins: [{ url: 'https://foo.test/', title: 'Foo' }], shortcutHides: [],
    });
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'shortcut-hide';
    btn.dataset.url = 'https://foo.test/';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(settings.setSettings).not.toHaveBeenCalled();
    expect(anim.showToast).toHaveBeenCalledWith('Unpin first to hide');
  });

  it('set-theme-system removes data-theme + calls setSettings', async () => {
    const { handlers, settings } = await loadHandlersWithMocks();
    handlers.attachListeners();

    // Pre-populate with an explicit theme to make sure the handler clears it.
    document.documentElement.dataset.theme = 'dark';

    const btn = document.createElement('button');
    btn.dataset.action = 'set-theme-system';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(settings.setSettings).toHaveBeenCalledWith({ theme: 'system' });
  });

  it('keeps visual theme even when setSettings rejects (silent degrade)', async () => {
    const { handlers, settings } = await loadHandlersWithMocks();
    settings.setSettings.mockRejectedValueOnce(new Error('storage down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handlers.attachListeners();

    const btn = document.createElement('button');
    btn.dataset.action = 'set-theme-dark';
    document.body.appendChild(btn);

    click(btn);
    await vi.runAllTimersAsync();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(settings.setSettings).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});
