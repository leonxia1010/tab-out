// Shortcut bar widget — up to 10 circular favicon tiles below the
// search widget, mirroring Chrome's native NTP "Most visited" row.
//
// Sources merge order (locked convention, see plan zazzy-puzzling-narwhal):
//   [...pins, ...topSites.filter(!pinned && !hidden)].slice(0, 10)
// Pins always come first; topSites fills the remainder. Hides apply to
// topSites only — a pinned URL is never hidden (user's explicit pin
// overrides an earlier hide). No padding when fewer than 10 available;
// blank slots would look broken.
//
// Favicon source: `https://www.google.com/s2/favicons?domain=${host}
// &sz=64`. Matches the domain-card pattern used in renderers.ts. sz=64
// lets us render a crisp 28px favicon on retina. If the image 404s we
// let the broken-image glyph show — simpler than a lettermark fallback
// and lets the user hide the tile themselves.
//
// Interaction: click tile → navigate in the same tab (no target=_blank;
// the dashboard IS the new tab, so a fresh tab would leave an empty
// dashboard behind). Hover reveals two overlay buttons with
// `data-action="shortcut-pin|shortcut-hide"` + dataset{url,title};
// handlers.ts picks them up via the single document-level dispatcher.
//
// Handle shape matches clock.ts / theme.ts / search.ts:
//   mount(container, settings) → { destroy, applySettings(next) }
// destroy tears the whole row down; applySettings re-fetches topSites
// and re-renders with the new pins/hides. Dashboard bootstrap calls
// applySettings from onSettingsChange so pin/hide actions reflect live.

import { el, svg } from '../dom-utils.js';
import type { ToutSettings, ShortcutPin } from '../../../shared/dist/settings.js';

const MAX_TILES = 10;
const FAVICON_SIZE = 64;

// Heroicons v2 outline — stroke-width 1.5 matches the dashboard icon
// family. Bookmark/pin glyph for pin; eye-slash for hide.
const SVG_BASE = 'xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"';
const SVG_PIN = `<svg ${SVG_BASE} data-icon="pin"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"/></svg>`;
const SVG_HIDE = `<svg ${SVG_BASE} data-icon="eye-slash"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"/></svg>`;

export interface ShortcutsHandle {
  destroy(): void;
  applySettings(next: ToutSettings): void;
}

interface TopSite {
  url: string;
  title: string;
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

function faviconUrl(rawUrl: string): string {
  const host = hostOf(rawUrl);
  if (!host) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${FAVICON_SIZE}`;
}

// Bridge to chrome.topSites. Returns [] if the API is missing (jsdom
// tests, older Chromiums) or throws. Callers should treat empty as
// "nothing to render besides pins".
async function fetchTopSites(): Promise<TopSite[]> {
  const api = (typeof chrome !== 'undefined' ? chrome.topSites : undefined);
  if (!api || typeof api.get !== 'function') return [];
  try {
    const sites = await api.get();
    if (!Array.isArray(sites)) return [];
    return sites
      .filter((s): s is TopSite =>
        !!s && typeof s.url === 'string' && typeof s.title === 'string')
      .map((s) => ({ url: s.url, title: s.title }));
  } catch {
    return [];
  }
}

function buildList(
  pins: ShortcutPin[],
  topSites: TopSite[],
  hides: string[],
): ShortcutPin[] {
  const hideSet = new Set(hides);
  const pinSet = new Set(pins.map((p) => p.url));
  const filler = topSites
    .filter((s) => !pinSet.has(s.url) && !hideSet.has(s.url))
    .map((s) => ({ url: s.url, title: s.title }));
  return [...pins, ...filler].slice(0, MAX_TILES);
}

function iconNode(svgString: string): Element {
  const node = svg(svgString);
  if (!node) throw new Error('shortcuts widget: failed to parse icon SVG');
  return node;
}

function renderTile(entry: ShortcutPin): HTMLElement {
  const host = hostOf(entry.url);
  const label = entry.title || host || entry.url;
  const src = faviconUrl(entry.url);

  const faviconImg = el('img', {
    className: 'shortcut-favicon',
    src,
    alt: '',
    // Width/height as attributes (not style) so the img reserves
    // space before the favicon loads and the row doesn't jitter.
    width: 28,
    height: 28,
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
  }) as HTMLImageElement;

  const pinBtn = el('button', {
    type: 'button',
    className: 'shortcut-action shortcut-action-pin',
    'data-action': 'shortcut-pin',
    'data-url': entry.url,
    'data-title': entry.title,
    'aria-label': `Pin ${label}`,
    title: 'Pin',
  }, [iconNode(SVG_PIN)]);

  const hideBtn = el('button', {
    type: 'button',
    className: 'shortcut-action shortcut-action-hide',
    'data-action': 'shortcut-hide',
    'data-url': entry.url,
    'data-title': entry.title,
    'aria-label': `Hide ${label}`,
    title: 'Hide',
  }, [iconNode(SVG_HIDE)]);

  const overlay = el('div', {
    className: 'shortcut-overlay',
    'aria-hidden': 'true',
  }, [pinBtn, hideBtn]);

  // The tile is the link — clicking anywhere outside the overlay
  // buttons navigates. Overlay buttons stopPropagation in their click
  // handler (wired in handlers.ts via data-action dispatch).
  const tile = el('a', {
    className: 'shortcut-tile',
    href: entry.url,
    title: label,
    'aria-label': label,
    'data-url': entry.url,
  }, [faviconImg, overlay]);

  return tile;
}

function renderInto(bar: HTMLElement, list: ShortcutPin[]): void {
  if (list.length === 0) {
    bar.replaceChildren();
    bar.classList.add('is-empty');
    return;
  }
  bar.classList.remove('is-empty');
  bar.replaceChildren(...list.map(renderTile));
}

export function mountShortcuts(
  container: HTMLElement,
  initial: ToutSettings,
): ShortcutsHandle {
  const bar = el('div', {
    className: 'shortcuts-bar',
    role: 'list',
    'aria-label': 'Shortcuts',
  }) as HTMLElement;

  container.appendChild(bar);

  // Latest topSites snapshot cached so pin/hide toggles re-render
  // without an extra chrome.topSites.get() round-trip — the data
  // itself didn't change, only the filter.
  let cachedTopSites: TopSite[] = [];
  let current: ToutSettings = initial;

  const render = (): void => {
    renderInto(bar, buildList(current.shortcutPins, cachedTopSites, current.shortcutHides));
  };

  void fetchTopSites().then((sites) => {
    cachedTopSites = sites;
    render();
  });

  return {
    destroy(): void {
      bar.remove();
    },
    applySettings(next: ToutSettings): void {
      current = next;
      render();
    },
  };
}

// Exposed for unit tests — pure function with no DOM or chrome API.
export const __internal = { buildList };
