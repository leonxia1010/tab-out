// Search widget — full-width input with an engine picker on the left.
// Engines (in menu / Tab-cycle order):
//
//   google      → https://www.google.com/search?q=…
//   baidu       → https://www.baidu.com/s?wd=…
//   xiaohongshu → https://www.xiaohongshu.com/search_result?keyword=…
//                 (same URL the official 小红书快捷搜索 extension opens
//                 from its context menu)
//   bilibili    → https://search.bilibili.com/all?keyword=…
//   x           → https://x.com/search?q=…&src=typed_query
//   googlemaps  → https://www.google.com/maps/search/…
//
// Every engine is an explicit URL (no chrome.search.query): the picker
// shows a brand icon, so the destination has to match the icon no
// matter what the browser's default engine is.
//
// Switching: click the icon button to open a menu and pick an engine,
// or press Tab inside the input to cycle to the next one (Shift+Tab
// stays native so keyboard users can still move focus out; Tab during
// IME composition is left alone).
//
// Submit: trim → no-op on empty → open the results in the CURRENT tab.
// Search sites can take a second or two to answer, and the dashboard
// stays on screen until they do, so the widget shows a busy state
// (spinner in the icon slot, query kept, input read-only) instead of
// clearing instantly and looking like nothing happened. The state is
// reset if dispatch fails or the page comes back from the bfcache.
//
// Shape matches clock.ts / theme.ts: mount(container) → Handle with
// destroy().

import { anchorPopoverTo, el, iconNode } from '../../../shared/dist/dom-utils.js';

export interface SearchHandle {
  destroy(): void;
}

export type SearchEngineId = 'google' | 'baidu' | 'xiaohongshu' | 'bilibili' | 'x' | 'googlemaps';

interface SearchEngine {
  id: SearchEngineId;
  label: string;
  placeholder: string;
  // Image path relative to dashboard/index.html.
  icon: string;
  buildUrl: (query: string) => string;
}

// Brand icons are each site's own favicon, downloaded 2026-11-06 and
// bundled under extension/icons/engines/ so they render offline and on
// first run (the browser favicon cache would show a grey globe for
// sites never visited). Trademarks belong to their owners. Paths are
// relative to dashboard/index.html.
const ICON_DIR = '../icons/engines';

// Heroicons v2 chevron-down (mini, MIT, tailwindlabs/heroicons): marks
// the icon button as a menu trigger.
const SVG_CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="search-engine-chevron"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>';

const ENGINES: readonly SearchEngine[] = [
  {
    id: 'google',
    label: 'Google',
    placeholder: 'Search Google...',
    icon: `${ICON_DIR}/google.png`,
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'baidu',
    label: '百度',
    placeholder: 'Search Baidu...',
    icon: `${ICON_DIR}/baidu.png`,
    buildUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    placeholder: 'Search RedNote...',
    icon: `${ICON_DIR}/xiaohongshu.png`,
    buildUrl: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`,
  },
  {
    id: 'bilibili',
    label: 'B站',
    placeholder: 'Search Bilibili...',
    icon: `${ICON_DIR}/bilibili.png`,
    buildUrl: (q) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`,
  },
  {
    id: 'x',
    label: 'X',
    placeholder: 'Search X...',
    icon: `${ICON_DIR}/x.png`,
    // src=typed_query is what x.com's own search box appends.
    buildUrl: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query`,
  },
  {
    id: 'googlemaps',
    label: 'Google Maps',
    placeholder: 'Search Google Maps...',
    icon: `${ICON_DIR}/googlemaps.png`,
    buildUrl: (q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
  },
];

// Last-used engine lives in localStorage as its own source of truth,
// NOT in tabout:settings (unlike the theme/layout/aurora caches, which
// mirror settings). Every setSettings write broadcasts onSettingsChange
// and the shortcuts row re-fetches topSites + re-renders, so cycling
// engines with Tab would make that row flicker. localStorage is also
// synchronous, so the first paint already shows the right engine.
// Absent key ≡ google (the first engine).
export const SEARCH_ENGINE_KEY = 'tabout:search-engine';

const MENU_ID = 'taboutSearchEngineMenu';

function engineIcon(engine: SearchEngine): HTMLImageElement {
  return el('img', {
    className: 'search-engine-icon',
    src: engine.icon,
    alt: '',
    width: '18',
    height: '18',
    draggable: 'false',
    dataset: { icon: engine.id },
  }) as HTMLImageElement;
}

function readEngineIndex(): number {
  try {
    const stored = localStorage.getItem(SEARCH_ENGINE_KEY);
    const idx = ENGINES.findIndex((e) => e.id === stored);
    return idx === -1 ? 0 : idx;
  } catch {
    return 0;
  }
}

function writeEngine(id: SearchEngineId): void {
  try {
    if (id === ENGINES[0].id) {
      localStorage.removeItem(SEARCH_ENGINE_KEY);
    } else {
      localStorage.setItem(SEARCH_ENGINE_KEY, id);
    }
  } catch {
    // localStorage disabled; the choice just won't survive a reload.
  }
}

export function mountSearch(container: HTMLElement): SearchHandle {
  let engineIndex = readEngineIndex();

  const input = el('input', {
    type: 'search',
    className: 'search-widget-input',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;

  // type="button" is load-bearing: inside a <form>, a bare <button>
  // defaults to type="submit" and clicking it would fire a search.
  // popovertarget lets the browser open/close the menu natively
  // (including Esc and click-outside dismissal).
  const engineButton = el('button', {
    type: 'button',
    className: 'search-widget-engine',
    popovertarget: MENU_ID,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  }) as HTMLButtonElement;

  const menuItems = ENGINES.map((engine, i) => el('button', {
    type: 'button',
    className: 'search-engine-option',
    role: 'menuitemradio',
    'aria-checked': 'false',
    dataset: { engine: engine.id, index: String(i) },
  }, [engineIcon(engine), el('span', {}, [engine.label])]) as HTMLButtonElement);

  const menu = el('div', {
    id: MENU_ID,
    className: 'search-engine-menu',
    popover: 'auto',
    role: 'menu',
    'aria-label': 'Search engine',
  }, menuItems) as HTMLElement;
  anchorPopoverTo(engineButton, menu, 6, 'start');

  const chevron = iconNode(SVG_CHEVRON, 'chevron');

  const applyEngine = (): void => {
    const engine = ENGINES[engineIndex];
    engineButton.replaceChildren(engineIcon(engine), chevron);
    engineButton.dataset.engine = engine.id;
    engineButton.title = `${engine.label}: click to choose an engine, or press Tab in the box to switch`;
    engineButton.setAttribute('aria-label', `Search engine: ${engine.label}. Choose engine`);
    input.placeholder = engine.placeholder;
    input.setAttribute('aria-label', engine.placeholder.replace(/\.\.\.$/, ''));
    menuItems.forEach((item, i) => {
      item.setAttribute('aria-checked', i === engineIndex ? 'true' : 'false');
    });
  };
  applyEngine();

  const selectEngine = (index: number): void => {
    engineIndex = index;
    writeEngine(ENGINES[engineIndex].id);
    applyEngine();
  };

  const hideMenu = (): void => {
    if (typeof menu.hidePopover === 'function' && menu.matches(':popover-open')) {
      menu.hidePopover();
    }
  };

  const field = el('div', {
    className: 'search-widget-field',
  }, [engineButton, input, menu]) as HTMLElement;

  const form = el('form', {
    className: 'search-widget',
    role: 'search',
  }, [field]) as HTMLFormElement;

  const setBusy = (busy: boolean): void => {
    form.classList.toggle('is-loading', busy);
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
    input.readOnly = busy;
  };

  const onMenuToggle = (ev: Event): void => {
    const open = (ev as ToggleEvent).newState === 'open';
    engineButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) menuItems[engineIndex].focus();
  };

  const onMenuClick = (e: Event): void => {
    const item = (e.target as Element | null)?.closest<HTMLElement>('.search-engine-option');
    if (!item) return;
    selectEngine(Number(item.dataset.index));
    hideMenu();
    // Hand focus back to the field so the user can type immediately.
    input.focus();
  };

  const onMenuKeydown = (e: KeyboardEvent): void => {
    const current = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (current + 1) % menuItems.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + menuItems.length) % menuItems.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = menuItems.length - 1;
    if (next === -1) return;
    e.preventDefault();
    menuItems[next].focus();
  };

  const onInputKeydown = (e: KeyboardEvent): void => {
    // Esc while busy: Chrome treats it as "stop loading", which cancels
    // the pending navigation and leaves this page in place. Drop the
    // busy state too so the field is editable and Enter works again.
    // Not preventDefault'd, so the browser still stops the load.
    if (e.key === 'Escape' && form.classList.contains('is-loading')) {
      setBusy(false);
      return;
    }
    if (e.key !== 'Tab' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    selectEngine((engineIndex + 1) % ENGINES.length);
  };

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    if (form.classList.contains('is-loading')) return;
    const query = input.value.trim();
    if (!query) return;
    const url = ENGINES[engineIndex].buildUrl(query);
    // chrome.* is undefined in jsdom; bail quietly so tests that skip
    // the mock still pass, and the extension never throws on a
    // malformed API shape in older Chromiums.
    const tabs = typeof chrome !== 'undefined' ? chrome.tabs : undefined;
    if (!tabs || typeof tabs.update !== 'function') return;
    setBusy(true);
    try {
      // No tabId → Chrome updates the active tab of the current
      // window, which is this dashboard tab while the user is typing.
      const pending = tabs.update({ url }) as unknown;
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        (pending as Promise<unknown>).catch(() => setBusy(false));
      }
    } catch {
      setBusy(false);
    }
  };

  // Back/forward cache restore: the dashboard comes back exactly as it
  // was left (busy, query in the box). Reset it to a fresh, empty field.
  const onPageShow = (e: PageTransitionEvent): void => {
    if (!e.persisted) return;
    setBusy(false);
    input.value = '';
  };

  menu.addEventListener('toggle', onMenuToggle);
  menu.addEventListener('click', onMenuClick);
  menu.addEventListener('keydown', onMenuKeydown);
  input.addEventListener('keydown', onInputKeydown);
  form.addEventListener('submit', onSubmit);
  window.addEventListener('pageshow', onPageShow);
  container.appendChild(form);

  return {
    destroy(): void {
      hideMenu();
      menu.removeEventListener('toggle', onMenuToggle);
      menu.removeEventListener('click', onMenuClick);
      menu.removeEventListener('keydown', onMenuKeydown);
      input.removeEventListener('keydown', onInputKeydown);
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('pageshow', onPageShow);
      form.remove();
    },
  };
}
