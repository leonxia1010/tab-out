// @vitest-environment jsdom
// tests/dashboard/widgets-search.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/search.ts — the
// middle-section search widget. Covers mount structure, submit →
// chrome.search.query dispatch, empty-query no-op, autofocus, and
// destroy cleanup.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountSearch } from '../../extension/dashboard/src/widgets/search.ts';

function installChromeSearch() {
  const query = vi.fn();
  vi.stubGlobal('chrome', { search: { query } });
  return query;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mountSearch', () => {
  it('appends a search form + input to the slot', () => {
    installChromeSearch();
    const slot = document.getElementById('slot');
    mountSearch(slot);

    const form = slot.querySelector('form.search-widget');
    expect(form).not.toBeNull();
    expect(form.getAttribute('role')).toBe('search');

    const field = form.querySelector('.search-widget-field');
    expect(field).not.toBeNull();

    const icon = field.querySelector('svg[data-icon="search"]');
    expect(icon).not.toBeNull();

    const input = field.querySelector('input.search-widget-input');
    expect(input).not.toBeNull();
    expect(input.getAttribute('type')).toBe('search');
    expect(input.getAttribute('placeholder')).toBe('Search Google...');
  });

  it('does NOT steal focus on mount', () => {
    // Per v2.3.0 UX decision: the search widget is opt-in, so it must
    // not grab focus when the new tab opens. Keyboard caret stays
    // wherever the browser put it (typically <body>).
    installChromeSearch();
    const slot = document.getElementById('slot');
    mountSearch(slot);

    const input = slot.querySelector('input.search-widget-input');
    expect(document.activeElement).not.toBe(input);
  });

  it('dispatches chrome.search.query with trimmed value + CURRENT_TAB on submit', () => {
    const query = installChromeSearch();
    const slot = document.getElementById('slot');
    mountSearch(slot);

    const form = slot.querySelector('form.search-widget');
    const input = form.querySelector('input.search-widget-input');
    input.value = '  typescript monads  ';

    form.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ text: 'typescript monads', disposition: 'CURRENT_TAB' });
  });

  it('clears the input after a successful submit', () => {
    installChromeSearch();
    const slot = document.getElementById('slot');
    mountSearch(slot);

    const form = slot.querySelector('form.search-widget');
    const input = form.querySelector('input.search-widget-input');
    input.value = 'foo';

    form.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(input.value).toBe('');
  });

  it('is a no-op when the input is empty or whitespace-only', () => {
    const query = installChromeSearch();
    const slot = document.getElementById('slot');
    mountSearch(slot);

    const form = slot.querySelector('form.search-widget');
    const input = form.querySelector('input.search-widget-input');

    input.value = '';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    input.value = '   ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(query).not.toHaveBeenCalled();
  });

  it('prevents default so the form never navigates', () => {
    installChromeSearch();
    const slot = document.getElementById('slot');
    mountSearch(slot);

    const form = slot.querySelector('form.search-widget');
    const input = form.querySelector('input.search-widget-input');
    input.value = 'anything';

    const ev = new Event('submit', { cancelable: true });
    form.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
  });

  it('swallows submit quietly when chrome.search is unavailable', () => {
    // No chrome global at all — matches older Chromium / jsdom default.
    vi.stubGlobal('chrome', undefined);
    const slot = document.getElementById('slot');
    mountSearch(slot);

    const form = slot.querySelector('form.search-widget');
    const input = form.querySelector('input.search-widget-input');
    input.value = 'fallback';

    expect(() => form.dispatchEvent(new Event('submit', { cancelable: true }))).not.toThrow();
    expect(input.value).toBe('');
  });

  it('destroy() removes the form from the slot', () => {
    installChromeSearch();
    const slot = document.getElementById('slot');
    const handle = mountSearch(slot);

    expect(slot.querySelector('form.search-widget')).not.toBeNull();
    handle.destroy();
    expect(slot.querySelector('form.search-widget')).toBeNull();
  });
});
