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

// Heroicons v2 — ellipsis-vertical (solid mini) for the corner trigger
// so three filled dots read clearly at 14px. Chrome NTP uses the same
// three-dot glyph; matching it keeps the interaction recognizable.
const SVG_MENU = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" data-icon="menu"><path fill-rule="evenodd" d="M10 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" clip-rule="evenodd"/></svg>`;

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

// Per-tile popover id counter. Each popover needs a unique id because
// the native popover API uses popovertarget="<id>" to wire trigger →
// popover. Counter is module-local so it survives re-renders; we never
// collide across widget mounts because the widget is mounted once.
let popoverCounter = 0;

function renderTile(entry: ShortcutPin, isPinned: boolean): HTMLElement {
  const host = hostOf(entry.url);
  const label = entry.title || host || entry.url;
  const src = faviconUrl(entry.url);
  const popoverId = `taboutShortcutMenu-${popoverCounter++}`;

  const faviconImg = el('img', {
    className: 'shortcut-favicon',
    src,
    alt: '',
    // Width/height as attributes (not style) so the img reserves
    // space before the favicon loads and the row doesn't jitter.
    width: 24,
    height: 24,
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
  }) as HTMLImageElement;

  // Link wraps just the favicon so clicks on the corner 3-dot button
  // don't navigate. Corner button is a sibling inside the tile wrapper.
  const link = el('a', {
    className: 'shortcut-link',
    href: entry.url,
    title: label,
    'aria-label': label,
  }, [faviconImg]);

  const menuTrigger = el('button', {
    type: 'button',
    className: 'shortcut-menu-trigger',
    popovertarget: popoverId,
    'aria-label': `Options for ${label}`,
    title: 'Options',
  }, [iconNode(SVG_MENU)]) as HTMLButtonElement;

  // Pin / unpin label flips with state; second item is always Hide
  // (handler refuses to hide a pinned URL, so the option stays even
  // when pinned — consistent surface, explicit no-op via toast).
  const pinItem = el('button', {
    type: 'button',
    className: 'shortcut-menu-item',
    'data-action': 'shortcut-pin',
    'data-url': entry.url,
    'data-title': entry.title,
    popovertarget: popoverId,
    popovertargetaction: 'hide',
  }, [isPinned ? 'Already pinned' : 'Pin']);

  const hideItem = el('button', {
    type: 'button',
    className: 'shortcut-menu-item',
    'data-action': 'shortcut-hide',
    'data-url': entry.url,
    'data-title': entry.title,
    popovertarget: popoverId,
    popovertargetaction: 'hide',
  }, ['Hide']);

  const popover = el('div', {
    id: popoverId,
    className: 'shortcut-menu',
    popover: 'auto',
    role: 'menu',
  }, [pinItem, hideItem]) as HTMLElement;

  // Position the popover under the trigger on every open (same pattern
  // as widgets/theme.ts). Native popover lives in the top layer at
  // origin (0,0) by default; we set fixed coords off the trigger's
  // bounding rect. Scroll / resize closes the menu to match the
  // theme popover's behavior.
  const dismiss = (): void => {
    if (typeof popover.hidePopover === 'function') popover.hidePopover();
  };
  popover.addEventListener('toggle', (ev) => {
    const e = ev as ToggleEvent;
    if (e.newState === 'open') {
      const tr = menuTrigger.getBoundingClientRect();
      const pw = popover.offsetWidth;
      const vw = window.innerWidth;
      let left = tr.right - pw;
      if (left < 8) left = 8;
      if (left + pw > vw - 8) left = vw - pw - 8;
      popover.style.top = `${tr.bottom + 4}px`;
      popover.style.left = `${left}px`;
      window.addEventListener('scroll', dismiss, { capture: true, passive: true });
      window.addEventListener('resize', dismiss, { passive: true });
    } else {
      window.removeEventListener('scroll', dismiss, { capture: true });
      window.removeEventListener('resize', dismiss);
    }
  });

  const tile = el('div', {
    className: isPinned ? 'shortcut-tile is-pinned' : 'shortcut-tile',
    'data-url': entry.url,
  }, [link, menuTrigger, popover]);

  return tile;
}

function renderInto(bar: HTMLElement, list: ShortcutPin[], pins: ShortcutPin[]): void {
  if (list.length === 0) {
    bar.replaceChildren();
    bar.classList.add('is-empty');
    return;
  }
  bar.classList.remove('is-empty');
  const pinSet = new Set(pins.map((p) => p.url));
  bar.replaceChildren(...list.map((entry) => renderTile(entry, pinSet.has(entry.url))));
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
    const list = buildList(current.shortcutPins, cachedTopSites, current.shortcutHides);
    renderInto(bar, list, current.shortcutPins);
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
