// Search widget — full-width input with a small engine switcher on the
// left. Three engines:
//
//   default     → chrome.search.query, so the user's Chrome-configured
//                 default engine handles it (labelled "Google" since
//                 that's what nearly every install has; it's a visual
//                 label, not a hard-wired engine).
//   xiaohongshu → https://www.xiaohongshu.com/search_result?keyword=…
//                 (same URL the official 小红书快捷搜索 extension opens
//                 from its context menu).
//   bilibili    → https://search.bilibili.com/all?keyword=…
//
// Switching: click the engine button, or press Tab inside the input
// (Shift+Tab stays native so keyboard users can still move focus out;
// Tab during IME composition is left alone). Order cycles
// default → xiaohongshu → bilibili → default.
//
// Submit behavior: trim → no-op on empty → dispatch in the CURRENT tab
// (results replace the new-tab dashboard, matching chrome.search's
// CURRENT_TAB disposition). Input clears on submit so the widget is
// immediately reusable if the user lands back on the new tab.
//
// Shape matches clock.ts / theme.ts: mount(container[, opts]) → Handle
// with destroy(). Dashboard bootstrap never tears this down, but the
// symmetric shape keeps widget wiring uniform and lets tests assert
// cleanup without special-casing.

import { el } from '../../../shared/dist/dom-utils.js';

export interface SearchHandle {
  destroy(): void;
}

export type SearchEngineId = 'default' | 'xiaohongshu' | 'bilibili';

interface SearchEngine {
  id: SearchEngineId;
  label: string;
  placeholder: string;
  // null → route through chrome.search.query (browser default engine).
  buildUrl: ((query: string) => string) | null;
}

const ENGINES: readonly SearchEngine[] = [
  {
    id: 'default',
    label: 'Google',
    placeholder: 'Search Google...',
    buildUrl: null,
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    placeholder: 'Search Xiaohongshu...',
    buildUrl: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`,
  },
  {
    id: 'bilibili',
    label: 'B站',
    placeholder: 'Search Bilibili...',
    buildUrl: (q) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`,
  },
];

// Last-used engine lives in localStorage as its own source of truth,
// NOT in tabout:settings (unlike the theme/layout/aurora caches, which
// mirror settings). Every setSettings write broadcasts onSettingsChange
// and the shortcuts row re-fetches topSites + re-renders, so cycling
// engines with Tab would make that row flicker. localStorage is also
// synchronous, so the first paint already shows the right placeholder.
export const SEARCH_ENGINE_KEY = 'tabout:search-engine';

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
    if (id === 'default') {
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
    'aria-label': 'Search the web',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;

  // type="button" is load-bearing: inside a <form>, a bare <button>
  // defaults to type="submit" and clicking it would fire a search.
  const engineButton = el('button', {
    type: 'button',
    className: 'search-widget-engine',
  }) as HTMLButtonElement;

  const applyEngine = (): void => {
    const engine = ENGINES[engineIndex];
    engineButton.textContent = engine.label;
    engineButton.dataset.engine = engine.id;
    engineButton.title = `Searching ${engine.label}, click or press Tab to switch`;
    engineButton.setAttribute('aria-label', `Search engine: ${engine.label}. Click to switch.`);
    input.placeholder = engine.placeholder;
  };
  applyEngine();

  const cycleEngine = (): void => {
    engineIndex = (engineIndex + 1) % ENGINES.length;
    writeEngine(ENGINES[engineIndex].id);
    applyEngine();
  };

  // The engine button takes the slot the magnifying-glass icon used to
  // occupy: the label doubles as "what am I searching" and the switch.
  const field = el('div', {
    className: 'search-widget-field',
  }, [engineButton, input]) as HTMLElement;

  const form = el('form', {
    className: 'search-widget',
    role: 'search',
  }, [field]) as HTMLFormElement;

  const onEngineClick = (): void => {
    cycleEngine();
    // Hand focus back to the field so the user can type immediately.
    input.focus();
  };

  const onInputKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    cycleEngine();
  };

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    const engine = ENGINES[engineIndex];
    // chrome.* is undefined in jsdom; bail quietly so tests that skip
    // the mock still pass, and the extension never throws on a
    // malformed API shape in older Chromiums.
    const api = typeof chrome !== 'undefined' ? chrome : undefined;
    if (engine.buildUrl) {
      if (api?.tabs && typeof api.tabs.update === 'function') {
        // No tabId → Chrome updates the active tab of the current
        // window, which is this dashboard tab while the user is typing.
        api.tabs.update({ url: engine.buildUrl(query) });
      }
    } else if (api?.search && typeof api.search.query === 'function') {
      api.search.query({ text: query, disposition: 'CURRENT_TAB' });
    }
    input.value = '';
  };

  engineButton.addEventListener('click', onEngineClick);
  input.addEventListener('keydown', onInputKeydown);
  form.addEventListener('submit', onSubmit);
  container.appendChild(form);

  return {
    destroy(): void {
      engineButton.removeEventListener('click', onEngineClick);
      input.removeEventListener('keydown', onInputKeydown);
      form.removeEventListener('submit', onSubmit);
      form.remove();
    },
  };
}
