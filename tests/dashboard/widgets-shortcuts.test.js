// @vitest-environment jsdom
// tests/dashboard/widgets-shortcuts.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/shortcuts.ts — the
// middle-section shortcut bar. Covers the pure merge/filter logic via
// __internal.buildList and the render/interaction surface via mount.
// chrome.topSites.get is stubbed per-test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountShortcuts, __internal } from '../../extension/dashboard/src/widgets/shortcuts.ts';

function installTopSites(sites) {
  const get = vi.fn().mockResolvedValue(sites);
  vi.stubGlobal('chrome', { topSites: { get } });
  return get;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildList — merge semantics', () => {
  const { buildList } = __internal;

  it('pins come first, topSites fills the remainder', () => {
    const pins = [{ url: 'https://pin1/', title: 'P1' }];
    const topSites = [
      { url: 'https://a/', title: 'A' },
      { url: 'https://b/', title: 'B' },
    ];
    expect(buildList(pins, topSites, [])).toEqual([
      { url: 'https://pin1/', title: 'P1' },
      { url: 'https://a/', title: 'A' },
      { url: 'https://b/', title: 'B' },
    ]);
  });

  it('filters hidden urls from topSites', () => {
    const topSites = [
      { url: 'https://a/', title: 'A' },
      { url: 'https://b/', title: 'B' },
    ];
    expect(buildList([], topSites, ['https://b/'])).toEqual([
      { url: 'https://a/', title: 'A' },
    ]);
  });

  it('hidden URL inside pins is NOT filtered — pins override hides', () => {
    const pins = [{ url: 'https://b/', title: 'B' }];
    const topSites = [{ url: 'https://a/', title: 'A' }];
    const hides = ['https://b/'];
    expect(buildList(pins, topSites, hides)).toEqual([
      { url: 'https://b/', title: 'B' },
      { url: 'https://a/', title: 'A' },
    ]);
  });

  it('deduplicates topSites that are also pinned', () => {
    const pins = [{ url: 'https://dup/', title: 'P' }];
    const topSites = [
      { url: 'https://dup/', title: 'T' },
      { url: 'https://x/', title: 'X' },
    ];
    const merged = buildList(pins, topSites, []);
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe('P');
    expect(merged[1].url).toBe('https://x/');
  });

  it('caps the list at 10 entries', () => {
    const topSites = Array.from({ length: 20 }, (_, i) => ({
      url: `https://site${i}/`,
      title: `S${i}`,
    }));
    expect(buildList([], topSites, [])).toHaveLength(10);
  });

  it('pins beyond 10 push topSites out of the visible slice', () => {
    const pins = Array.from({ length: 12 }, (_, i) => ({
      url: `https://pin${i}/`,
      title: `P${i}`,
    }));
    const topSites = [{ url: 'https://a/', title: 'A' }];
    const merged = buildList(pins, topSites, []);
    expect(merged).toHaveLength(10);
    expect(merged.every((e) => e.url.startsWith('https://pin'))).toBe(true);
  });
});

describe('mountShortcuts — render + API', () => {
  const baseSettings = {
    theme: 'system',
    clock: { format: '24h' },
    layout: 'masonry',
    shortcutPins: [],
    shortcutHides: [],
  };

  it('renders a .shortcuts-bar with up to 10 tiles from topSites', async () => {
    installTopSites([
      { url: 'https://a.test/', title: 'A' },
      { url: 'https://b.test/', title: 'B' },
    ]);
    const slot = document.getElementById('slot');
    mountShortcuts(slot, baseSettings);
    await vi.waitFor(() => {
      const tiles = slot.querySelectorAll('.shortcuts-bar .shortcut-tile');
      expect(tiles.length).toBe(2);
    });
  });

  it('each tile carries link + favicon + menu with pin/hide items', async () => {
    installTopSites([{ url: 'https://example.com/', title: 'Ex' }]);
    const slot = document.getElementById('slot');
    mountShortcuts(slot, baseSettings);

    let tile;
    await vi.waitFor(() => {
      tile = slot.querySelector('.shortcut-tile');
      expect(tile).not.toBeNull();
    });

    const link = tile.querySelector('a.shortcut-link');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('https://example.com/');

    const img = link.querySelector('img.shortcut-favicon');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('favicons?domain=example.com');

    const trigger = tile.querySelector('button.shortcut-menu-trigger');
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('popovertarget')).toBeTruthy();

    const pinBtn = tile.querySelector('[data-action="shortcut-pin"]');
    const hideBtn = tile.querySelector('[data-action="shortcut-hide"]');
    expect(pinBtn).not.toBeNull();
    expect(hideBtn).not.toBeNull();
    expect(pinBtn.dataset.url).toBe('https://example.com/');
    expect(pinBtn.dataset.title).toBe('Ex');
    expect(hideBtn.dataset.url).toBe('https://example.com/');
    // Both menu items hide the popover on click via popovertargetaction.
    expect(pinBtn.getAttribute('popovertargetaction')).toBe('hide');
    expect(hideBtn.getAttribute('popovertargetaction')).toBe('hide');
  });

  it('pinned tiles get .is-pinned, a pin badge, and a single "Remove pin" menu item', async () => {
    installTopSites([]);
    const slot = document.getElementById('slot');
    mountShortcuts(slot, {
      ...baseSettings,
      shortcutPins: [{ url: 'https://pin.test/', title: 'Pin' }],
    });

    let tile;
    await vi.waitFor(() => {
      tile = slot.querySelector('.shortcut-tile');
      expect(tile).not.toBeNull();
    });

    expect(tile.classList.contains('is-pinned')).toBe(true);
    // Pin badge rendered only when pinned.
    expect(tile.querySelector('.shortcut-pin-badge')).not.toBeNull();

    // Symmetric toggle: pinned → [Remove pin] only, no Pin/Hide items.
    expect(tile.querySelector('[data-action="shortcut-pin"]')).toBeNull();
    expect(tile.querySelector('[data-action="shortcut-hide"]')).toBeNull();
    const unpin = tile.querySelector('[data-action="shortcut-unpin"]');
    expect(unpin).not.toBeNull();
    expect(unpin.textContent).toBe('Remove pin');
    expect(unpin.dataset.url).toBe('https://pin.test/');
  });

  it('non-pinned tiles expose Pin + Hide but no Remove pin', async () => {
    installTopSites([{ url: 'https://top.test/', title: 'Top' }]);
    const slot = document.getElementById('slot');
    mountShortcuts(slot, baseSettings);

    let tile;
    await vi.waitFor(() => {
      tile = slot.querySelector('.shortcut-tile');
      expect(tile).not.toBeNull();
    });

    expect(tile.classList.contains('is-pinned')).toBe(false);
    expect(tile.querySelector('.shortcut-pin-badge')).toBeNull();
    expect(tile.querySelector('[data-action="shortcut-pin"]')).not.toBeNull();
    expect(tile.querySelector('[data-action="shortcut-hide"]')).not.toBeNull();
    expect(tile.querySelector('[data-action="shortcut-unpin"]')).toBeNull();
  });

  it('collapses to is-empty when no pins and no topSites', async () => {
    installTopSites([]);
    const slot = document.getElementById('slot');
    mountShortcuts(slot, baseSettings);

    await vi.waitFor(() => {
      const bar = slot.querySelector('.shortcuts-bar');
      expect(bar).not.toBeNull();
      expect(bar.classList.contains('is-empty')).toBe(true);
      expect(bar.children.length).toBe(0);
    });
  });

  it('applySettings re-renders with updated pins and hides', async () => {
    installTopSites([
      { url: 'https://a.test/', title: 'A' },
      { url: 'https://b.test/', title: 'B' },
    ]);
    const slot = document.getElementById('slot');
    const handle = mountShortcuts(slot, baseSettings);

    await vi.waitFor(() => {
      expect(slot.querySelectorAll('.shortcut-tile').length).toBe(2);
    });

    handle.applySettings({
      ...baseSettings,
      shortcutPins: [{ url: 'https://pinned.test/', title: 'Pinned' }],
      shortcutHides: ['https://a.test/'],
    });

    const tiles = slot.querySelectorAll('.shortcut-tile');
    const hrefs = Array.from(tiles)
      .map((t) => t.querySelector('a.shortcut-link')?.getAttribute('href'));
    expect(hrefs).toEqual(['https://pinned.test/', 'https://b.test/']);
  });

  it('destroy() removes the bar from the slot', async () => {
    installTopSites([{ url: 'https://a/', title: 'A' }]);
    const slot = document.getElementById('slot');
    const handle = mountShortcuts(slot, baseSettings);
    await vi.waitFor(() => {
      expect(slot.querySelector('.shortcuts-bar')).not.toBeNull();
    });

    handle.destroy();
    expect(slot.querySelector('.shortcuts-bar')).toBeNull();
  });

  it('handles missing chrome.topSites gracefully (empty render)', async () => {
    // No chrome global at all.
    const slot = document.getElementById('slot');
    mountShortcuts(slot, baseSettings);
    await vi.waitFor(() => {
      const bar = slot.querySelector('.shortcuts-bar');
      expect(bar).not.toBeNull();
      expect(bar.classList.contains('is-empty')).toBe(true);
    });
  });
});
