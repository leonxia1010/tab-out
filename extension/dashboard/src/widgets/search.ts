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

import { el } from '../dom-utils.js';

export interface SearchHandle {
  destroy(): void;
}

export function mountSearch(container: HTMLElement): SearchHandle {
  const input = el('input', {
    type: 'search',
    className: 'search-widget-input',
    placeholder: 'Search the web',
    'aria-label': 'Search the web',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;

  const form = el('form', {
    className: 'search-widget',
    role: 'search',
  }, [input]) as HTMLFormElement;

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

  // Autofocus matches Chrome's default new-tab behavior. `input.focus()`
  // over the `autofocus` attribute because the attribute only fires
  // once per document load and loses to later imperative focus calls.
  input.focus();

  return {
    destroy(): void {
      form.removeEventListener('submit', onSubmit);
      form.remove();
    },
  };
}
