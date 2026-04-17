// Search widget — full-width input that fires chrome.search.query so
// the user's Chrome-configured default engine handles it. No per-user
// engine picker: we inherit whatever chrome://settings/search defines.
//
// Submit behavior: trim → no-op on empty → chrome.search.query with
// disposition: 'CURRENT_TAB' (results replace the new-tab dashboard;
// matches every other new-tab-override extension's default). Input
// clears on submit so the widget is immediately reusable if the user
// lands back on the new tab.
//
// Shape matches clock.ts / theme.ts: mount(container[, opts]) → Handle
// with destroy(). Dashboard bootstrap never tears this down, but the
// symmetric shape keeps widget wiring uniform and lets tests assert
// cleanup without special-casing.

import { el, svg } from '../dom-utils.js';

export interface SearchHandle {
  destroy(): void;
}

// Heroicons v2 outline magnifying-glass (MIT, tailwindlabs/heroicons),
// stroke-width 1.5 to match the rest of the dashboard icon family.
const SVG_SEARCH = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" data-icon="search"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>`;

export function mountSearch(container: HTMLElement): SearchHandle {
  const input = el('input', {
    type: 'search',
    className: 'search-widget-input',
    // Placeholder reads "Search Google..." per UI spec. Submission
    // still routes through chrome.search.query which uses the user's
    // Chrome-configured default engine — it's not actually hard-wired
    // to Google. The string is a visual label, not an engine pick.
    placeholder: 'Search Google...',
    'aria-label': 'Search the web',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;

  const iconNode = svg(SVG_SEARCH);
  const field = el('div', {
    className: 'search-widget-field',
  }, iconNode ? [iconNode, input] : [input]) as HTMLElement;

  const form = el('form', {
    className: 'search-widget',
    role: 'search',
  }, [field]) as HTMLFormElement;

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    // chrome.search is undefined in jsdom; bail quietly so tests that
    // skip the mock still pass, and the extension never throws on a
    // malformed API shape in older Chromiums.
    const api = (typeof chrome !== 'undefined' ? chrome.search : undefined);
    if (api && typeof api.query === 'function') {
      api.query({ text: query, disposition: 'CURRENT_TAB' });
    }
    input.value = '';
  };

  form.addEventListener('submit', onSubmit);
  container.appendChild(form);

  return {
    destroy(): void {
      form.removeEventListener('submit', onSubmit);
      form.remove();
    },
  };
}
