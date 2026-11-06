// Search widget — full-width input with an engine picker on the left.
// Engines (in menu / Tab-cycle order):
//
//   google      → https://www.google.com/search?q=…
//   baidu       → https://www.baidu.com/s?wd=…
//   xiaohongshu → https://www.xiaohongshu.com/search_result?keyword=…
//                 (same URL the official 小红书快捷搜索 extension opens
//                 from its context menu)
//   bilibili    → https://search.bilibili.com/all?keyword=…
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

export type SearchEngineId = 'google' | 'baidu' | 'xiaohongshu' | 'bilibili' | 'googlemaps';

interface SearchEngine {
  id: SearchEngineId;
  label: string;
  placeholder: string;
  icon: string;
  buildUrl: (query: string) => string;
}

// Brand glyphs from Simple Icons v16.36.0 (CC0-1.0,
// https://github.com/simple-icons/simple-icons), filled with each
// brand's hex from the same dataset. Trademarks belong to their owners.
// Xiaohongshu's glyph is its 小红书 wordmark, unreadable at 18px on its
// own, so it sits white-on-red inside a rounded tile like the app icon.
const brandSvg = (engine: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" class="search-engine-icon" data-icon="${engine}">${body}</svg>`;

const ICON_GOOGLE = brandSvg('google', '<path fill="#4285F4" d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/>');

const ICON_BAIDU = brandSvg('baidu', '<path fill="#2932E1" d="M9.154 0C7.71 0 6.54 1.658 6.54 3.707c0 2.051 1.171 3.71 2.615 3.71 1.446 0 2.614-1.659 2.614-3.71C11.768 1.658 10.6 0 9.154 0zm7.025.594C14.86.58 13.347 2.589 13.2 3.927c-.187 1.745.25 3.487 2.179 3.735 1.933.25 3.175-1.806 3.422-3.364.252-1.555-.995-3.364-2.362-3.674a1.218 1.218 0 0 0-.261-.03zM3.582 5.535a2.811 2.811 0 0 0-.156.008c-2.118.19-2.428 3.24-2.428 3.24-.287 1.41.686 4.425 3.297 3.864 2.617-.561 2.262-3.68 2.183-4.362-.125-1.018-1.292-2.773-2.896-2.75zm16.534 1.753c-2.308 0-2.617 2.119-2.617 3.616 0 1.43.121 3.425 2.988 3.362 2.867-.063 2.553-3.238 2.553-3.988 0-.745-.62-2.99-2.924-2.99zm-8.264 2.478c-1.424.014-2.708.925-3.323 1.947-1.118 1.868-2.863 3.05-3.112 3.363-.25.309-3.61 2.116-2.864 5.42.746 3.301 3.365 3.237 3.365 3.237s1.93.19 4.171-.31c2.24-.495 4.17.123 4.17.123s5.233 1.748 6.665-1.616c1.43-3.364-.808-5.109-.808-5.109s-2.99-2.306-4.736-4.798c-1.072-1.665-2.348-2.268-3.528-2.257zm-2.234 3.84l1.542.024v8.197H7.758c-1.47-.291-2.055-1.292-2.13-1.462-.072-.173-.488-.976-.268-2.343.635-2.049 2.447-2.196 2.447-2.196h1.81zm3.964 2.39v3.881c.096.413.612.488.612.488h1.614v-4.343h1.689v5.782h-3.915c-1.517-.39-1.59-1.465-1.59-1.465v-4.317zm-5.458 1.147c-.66.197-.978.708-1.05.928-.076.22-.247.78-.1 1.269.294 1.095 1.248 1.144 1.248 1.144h1.37v-3.34z"/>');

const ICON_XIAOHONGSHU = brandSvg('xiaohongshu', '<rect width="24" height="24" rx="5" fill="#FF2442"/><g transform="translate(2 2) scale(0.8333)"><path fill="#fff" d="M22.405 9.879c.002.016.01.02.07.019h.725a.797.797 0 0 0 .78-.972.794.794 0 0 0-.884-.618.795.795 0 0 0-.692.794c0 .101-.002.666.001.777zm-11.509 4.808c-.203.001-1.353.004-1.685.003a2.528 2.528 0 0 1-.766-.126.025.025 0 0 0-.03.014L7.7 16.127a.025.025 0 0 0 .01.032c.111.06.336.124.495.124.66.01 1.32.002 1.981 0 .01 0 .02-.006.023-.015l.712-1.545a.025.025 0 0 0-.024-.036zM.477 9.91c-.071 0-.076.002-.076.01a.834.834 0 0 0-.01.08c-.027.397-.038.495-.234 3.06-.012.24-.034.389-.135.607-.026.057-.033.042.003.112.046.092.681 1.523.787 1.74.008.015.011.02.017.02.008 0 .033-.026.047-.044.147-.187.268-.391.371-.606.306-.635.44-1.325.486-1.706.014-.11.021-.22.03-.33l.204-2.616.022-.293c.003-.029 0-.033-.03-.034zm7.203 3.757a1.427 1.427 0 0 1-.135-.607c-.004-.084-.031-.39-.235-3.06a.443.443 0 0 0-.01-.082c-.004-.011-.052-.008-.076-.008h-1.48c-.03.001-.034.005-.03.034l.021.293c.076.982.153 1.964.233 2.946.05.4.186 1.085.487 1.706.103.215.223.419.37.606.015.018.037.051.048.049.02-.003.742-1.642.804-1.765.036-.07.03-.055.003-.112zm3.861-.913h-.872a.126.126 0 0 1-.116-.178l1.178-2.625a.025.025 0 0 0-.023-.035l-1.318-.003a.148.148 0 0 1-.135-.21l.876-1.954a.025.025 0 0 0-.023-.035h-1.56c-.01 0-.02.006-.024.015l-.926 2.068c-.085.169-.314.634-.399.938a.534.534 0 0 0-.02.191.46.46 0 0 0 .23.378.981.981 0 0 0 .46.119h.59c.041 0-.688 1.482-.834 1.972a.53.53 0 0 0-.023.172.465.465 0 0 0 .23.398c.15.092.342.12.475.12l1.66-.001c.01 0 .02-.006.023-.015l.575-1.28a.025.025 0 0 0-.024-.035zm-6.93-4.937H3.1a.032.032 0 0 0-.034.033c0 1.048-.01 2.795-.01 6.829 0 .288-.269.262-.28.262h-.74c-.04.001-.044.004-.04.047.001.037.465 1.064.555 1.263.01.02.03.033.051.033.157.003.767.009.938-.014.153-.02.3-.06.438-.132.3-.156.49-.419.595-.765.052-.172.075-.353.075-.533.002-2.33 0-4.66-.007-6.991a.032.032 0 0 0-.032-.032zm11.784 6.896c0-.014-.01-.021-.024-.022h-1.465c-.048-.001-.049-.002-.05-.049v-4.66c0-.072-.005-.07.07-.07h.863c.08 0 .075.004.075-.074V8.393c0-.082.006-.076-.08-.076h-3.5c-.064 0-.075-.006-.075.073v1.445c0 .083-.006.077.08.077h.854c.075 0 .07-.004.07.07v4.624c0 .095.008.084-.085.084-.37 0-1.11-.002-1.304 0-.048.001-.06.03-.06.03l-.697 1.519s-.014.025-.008.036c.006.01.013.008.058.008 1.748.003 3.495.002 5.243.002.03-.001.034-.006.035-.033v-1.539zm4.177-3.43c0 .013-.007.023-.02.024-.346.006-.692.004-1.037.004-.014-.002-.022-.01-.022-.024-.005-.434-.007-.869-.01-1.303 0-.072-.006-.071.07-.07l.733-.003c.041 0 .081.002.12.015.093.025.16.107.165.204.006.431.002 1.153.001 1.153zm2.67.244a1.953 1.953 0 0 0-.883-.222h-.18c-.04-.001-.04-.003-.042-.04V10.21c0-.132-.007-.263-.025-.394a1.823 1.823 0 0 0-.153-.53 1.533 1.533 0 0 0-.677-.71 2.167 2.167 0 0 0-1-.258c-.153-.003-.567 0-.72 0-.07 0-.068.004-.068-.065V7.76c0-.031-.01-.041-.046-.039H17.93s-.016 0-.023.007c-.006.006-.008.012-.008.023v.546c-.008.036-.057.015-.082.022h-.95c-.022.002-.028.008-.03.032v1.481c0 .09-.004.082.082.082h.913c.082 0 .072.128.072.128V11.19s.003.117-.06.117h-1.482c-.068 0-.06.082-.06.082v1.445s-.01.068.064.068h1.457c.082 0 .076-.006.076.079v3.225c0 .088-.007.081.082.081h1.43c.09 0 .082.007.082-.08v-3.27c0-.029.006-.035.033-.035l2.323-.003c.098 0 .191.02.28.061a.46.46 0 0 1 .274.407c.008.395.003.79.003 1.185 0 .259-.107.367-.33.367h-1.218c-.023.002-.029.008-.028.033.184.437.374.871.57 1.303a.045.045 0 0 0 .04.026c.17.005.34.002.51.003.15-.002.517.004.666-.01a2.03 2.03 0 0 0 .408-.075c.59-.18.975-.698.976-1.313v-1.981c0-.128-.01-.254-.034-.38 0 .078-.029-.641-.724-.998z"/></g>');

const ICON_BILIBILI = brandSvg('bilibili', '<path fill="#00A1D6" d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z"/>');

const ICON_GOOGLEMAPS = brandSvg('googlemaps', '<path fill="#4285F4" d="M19.527 4.799c1.212 2.608.937 5.678-.405 8.173-1.101 2.047-2.744 3.74-4.098 5.614-.619.858-1.244 1.75-1.669 2.727-.141.325-.263.658-.383.992-.121.333-.224.673-.34 1.008-.109.314-.236.684-.627.687h-.007c-.466-.001-.579-.53-.695-.887-.284-.874-.581-1.713-1.019-2.525-.51-.944-1.145-1.817-1.79-2.671L19.527 4.799zM8.545 7.705l-3.959 4.707c.724 1.54 1.821 2.863 2.871 4.18.247.31.494.622.737.936l4.984-5.925-.029.01c-1.741.601-3.691-.291-4.392-1.987a3.377 3.377 0 0 1-.209-.716c-.063-.437-.077-.761-.004-1.198l.001-.007zM5.492 3.149l-.003.004c-1.947 2.466-2.281 5.88-1.117 8.77l4.785-5.689-.058-.05-3.607-3.035zM14.661.436l-3.838 4.563a.295.295 0 0 1 .027-.01c1.6-.551 3.403.15 4.22 1.626.176.319.323.683.377 1.045.068.446.085.773.012 1.22l-.003.016 3.836-4.561A8.382 8.382 0 0 0 14.67.439l-.009-.003zM9.466 5.868L14.162.285l-.047-.012A8.31 8.31 0 0 0 11.986 0a8.439 8.439 0 0 0-6.169 2.766l-.016.018 3.665 3.084z"/>');

// Heroicons v2 chevron-down (mini, MIT, tailwindlabs/heroicons): marks
// the icon button as a menu trigger.
const SVG_CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="search-engine-chevron"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>';

const ENGINES: readonly SearchEngine[] = [
  {
    id: 'google',
    label: 'Google',
    placeholder: 'Search Google...',
    icon: ICON_GOOGLE,
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'baidu',
    label: '百度',
    placeholder: 'Search Baidu...',
    icon: ICON_BAIDU,
    buildUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    placeholder: 'Search Xiaohongshu...',
    icon: ICON_XIAOHONGSHU,
    buildUrl: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`,
  },
  {
    id: 'bilibili',
    label: 'B站',
    placeholder: 'Search Bilibili...',
    icon: ICON_BILIBILI,
    buildUrl: (q) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`,
  },
  {
    id: 'googlemaps',
    label: 'Google Maps',
    placeholder: 'Search Google Maps...',
    icon: ICON_GOOGLEMAPS,
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
  }, [iconNode(engine.icon, `${engine.id} icon`), el('span', {}, [engine.label])]) as HTMLButtonElement);

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
    engineButton.replaceChildren(iconNode(engine.icon, `${engine.id} icon`), chevron);
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
