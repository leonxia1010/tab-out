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
// Favicon source: Chrome's native `_favicon/` API via chrome.runtime
// .getURL (needs the "favicon" manifest permission, Chrome 104+). Zero
// network requests, zero third-party exposure — Chrome serves the same
// cached icon the address bar uses. sz=64 lets us render a crisp 28px
// favicon on retina. If the image 404s we let the broken-image glyph
// show — simpler than a lettermark fallback and lets the user hide the
// tile themselves.
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

import { anchorPopoverTo, el, iconNode } from '../../../shared/dist/dom-utils.js';
import { faviconUrl } from '../favicon.js';
import { canonicalUrl, extractHostname } from '../../../shared/dist/url.js';
import type { ToutSettings, ShortcutPin } from '../../../shared/dist/settings.js';

const MAX_TILES = 10;
const FAVICON_SIZE = 64;

// Heroicons v2 — ellipsis-vertical (solid mini) for the corner trigger
// so three filled dots read clearly at 14px. Chrome NTP uses the same
// three-dot glyph; matching it keeps the interaction recognizable.
const SVG_MENU = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" data-icon="menu"><path fill-rule="evenodd" d="M10 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" clip-rule="evenodd"/></svg>`;
// Heroicons v2 star (solid mini) — filled pentagon glyph reads cleanly
// at small sizes and matches the "favorited" visual convention across
// Chrome / Notion / Figma etc.
const SVG_PIN_BADGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" data-icon="star"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd"/></svg>`;

export interface ShortcutsHandle {
  destroy(): void;
  applySettings(next: ToutSettings): void;
}

interface TopSite {
  url: string;
  title: string;
}

function hostOf(rawUrl: string): string {
  return extractHostname(rawUrl) ?? '';
}

// Loopback/local-dev hosts — filtered out of topSites at the source so
// a week of `npm run dev` doesn't take over the shortcut bar. A user
// who *wants* localhost in their bar can still pin it explicitly
// (pins are stored separately and never pass through this filter).
// Scope kept narrow on purpose: strict loopback only, NOT every .local
// or LAN IP, since those can legitimately be a home-lab user's
// intranet services they'd expect to see.
function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (host === '::1' || host === '[::1]') return true;
  // Strict IPv4 127.0.0.0/8 — four octets anchored end-to-end. Old regex
  // `/^127\./` would misclassify `127.example.com` (legal DNS label) as
  // loopback, filtering a real user's topSites entry by accident.
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
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
      .filter((s) => !isLoopbackHost(hostOf(s.url)))
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
  // Dedup by canonical URL: pins stored from chrome.tabs may omit the
  // trailing "/" while chrome.topSites fills it in (and vice versa).
  // Byte-compare would let both variants occupy tiles; canonicalUrl
  // collapses them through the WHATWG URL parser.
  const hideSet = new Set(hides.map(canonicalUrl));
  const pinSet = new Set(pins.map((p) => canonicalUrl(p.url)));
  const filler = topSites
    .filter((s) => {
      const c = canonicalUrl(s.url);
      return !pinSet.has(c) && !hideSet.has(c);
    })
    .map((s) => ({ url: s.url, title: s.title }));
  return [...pins, ...filler].slice(0, MAX_TILES);
}

// Per-tile popover id counter. Each popover needs a unique id because
// the native popover API uses popovertarget="<id>" to wire trigger →
// popover. Counter is module-local so it survives re-renders; we never
// collide across widget mounts because the widget is mounted once.
let popoverCounter = 0;

function renderTile(entry: ShortcutPin, isPinned: boolean): HTMLElement {
  const host = hostOf(entry.url);
  const label = entry.title || host || entry.url;
  const src = faviconUrl(entry.url, FAVICON_SIZE);
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

  // Link wraps favicon + pin badge. Clicks on the corner 3-dot button
  // don't navigate because the button is a sibling of the link.
  const linkChildren: (Node | null)[] = [faviconImg];
  if (isPinned) {
    const badge = el('span', {
      className: 'shortcut-pin-badge',
      'aria-hidden': 'true',
      title: 'Pinned',
    }, [iconNode(SVG_PIN_BADGE)]);
    linkChildren.push(badge);
  }
  const link = el('a', {
    className: 'shortcut-link',
    href: entry.url,
    title: label,
    'aria-label': isPinned ? `${label} (pinned)` : label,
  }, linkChildren.filter((n): n is Node => n !== null));

  const menuTrigger = el('button', {
    type: 'button',
    className: 'shortcut-menu-trigger',
    popovertarget: popoverId,
    'aria-label': `Options for ${label}`,
    title: 'Options',
  }, [iconNode(SVG_MENU)]) as HTMLButtonElement;

  // Symmetric toggle logic:
  //   pinned      → [Remove pin]
  //   not pinned  → [Pin, Hide]
  // Different data-actions so handlers.ts stays explicit; no combined
  // "shortcut-toggle-pin" that hides branching inside the handler.
  const menuItems: HTMLElement[] = [];
  if (isPinned) {
    const unpinItem = el('button', {
      type: 'button',
      className: 'shortcut-menu-item',
      role: 'menuitem',
      'data-action': 'shortcut-unpin',
      'data-url': entry.url,
      popovertarget: popoverId,
      popovertargetaction: 'hide',
    }, ['Remove pin']) as HTMLElement;
    menuItems.push(unpinItem);
  } else {
    const pinItem = el('button', {
      type: 'button',
      className: 'shortcut-menu-item',
      role: 'menuitem',
      'data-action': 'shortcut-pin',
      'data-url': entry.url,
      'data-title': entry.title,
      popovertarget: popoverId,
      popovertargetaction: 'hide',
    }, ['Pin']) as HTMLElement;
    const hideItem = el('button', {
      type: 'button',
      className: 'shortcut-menu-item',
      role: 'menuitem',
      'data-action': 'shortcut-hide',
      'data-url': entry.url,
      popovertarget: popoverId,
      popovertargetaction: 'hide',
    }, ['Hide']) as HTMLElement;
    menuItems.push(pinItem, hideItem);
  }

  const popover = el('div', {
    id: popoverId,
    className: 'shortcut-menu',
    popover: 'auto',
    role: 'menu',
  }, menuItems) as HTMLElement;

  // Native popover lives in the top layer at origin (0,0); anchor it
  // under the trigger on open and dismiss on scroll/resize so it never
  // floats detached from its anchor. Shared with widgets/theme.ts.
  anchorPopoverTo(menuTrigger, popover, 4);

  const tile = el('div', {
    className: isPinned ? 'shortcut-tile is-pinned' : 'shortcut-tile',
    role: 'listitem',
    'data-url': entry.url,
  }, [link, menuTrigger, popover]);

  return tile;
}

function renderInto(bar: HTMLElement, list: ShortcutPin[], pins: ShortcutPin[]): void {
  // Force-close any open popover before replaceChildren tears the DOM
  // down. The popover's `toggle → closed` handler is what removes the
  // window scroll/resize listeners; removing the popover node directly
  // (without hidePopover first) skips that cleanup path and the
  // listeners stay attached to window forever. Real trigger: user opens
  // a tile menu, then options page pin/hide fires onSettingsChange →
  // applySettings → renderInto.
  bar.querySelectorAll<HTMLElement>('.shortcut-menu').forEach((p) => {
    if (typeof p.hidePopover === 'function' && p.matches(':popover-open')) {
      p.hidePopover();
    }
  });

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

// Exposed for unit tests — pure functions with no DOM or chrome API.
export const __internal = { buildList, isLoopbackHost };
