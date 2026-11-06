// @vitest-environment jsdom
// tests/dashboard/widgets-search.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/search.ts — the
// middle-section search widget. Covers mount structure, submit →
// chrome.search.query dispatch, empty-query no-op, autofocus, engine
// switching (click + Tab), per-engine dispatch via chrome.tabs.update,
// localStorage persistence, and destroy cleanup.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountSearch, SEARCH_ENGINE_KEY } from '../../extension/dashboard/src/widgets/search.ts';

function installChromeSearch() {
  const query = vi.fn();
  vi.stubGlobal('chrome', { search: { query } });
  return query;
}

function installChrome() {
  const query = vi.fn();
  const update = vi.fn();
  vi.stubGlobal('chrome', { search: { query }, tabs: { update } });
  return { query, update };
}

function mountInSlot() {
  const slot = document.getElementById('slot');
  mountSearch(slot);
  return {
    slot,
    form: slot.querySelector('form.search-widget'),
    input: slot.querySelector('input.search-widget-input'),
    button: slot.querySelector('button.search-widget-engine'),
  };
}

function submit(form) {
  const ev = new Event('submit', { cancelable: true });
  form.dispatchEvent(ev);
  return ev;
}

function pressTab(input, init = {}) {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
  localStorage.clear();
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

    const button = field.querySelector('button.search-widget-engine');
    expect(button).not.toBeNull();
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe('Google');
    expect(button.dataset.engine).toBe('default');

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

describe('mountSearch engine switching', () => {
  it('cycles default → xiaohongshu → bilibili → default on button click', () => {
    installChrome();
    const { input, button } = mountInSlot();

    const seen = [];
    for (let i = 0; i < 3; i++) {
      button.click();
      seen.push([button.dataset.engine, button.textContent, input.placeholder]);
    }

    expect(seen).toEqual([
      ['xiaohongshu', '小红书', 'Search Xiaohongshu...'],
      ['bilibili', 'B站', 'Search Bilibili...'],
      ['default', 'Google', 'Search Google...'],
    ]);
  });

  it('clicking the engine button does NOT submit the form', () => {
    const { query, update } = installChrome();
    const { input, button } = mountInSlot();
    input.value = 'should not fire';

    button.click();

    expect(query).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(input.value).toBe('should not fire');
  });

  it('returns focus to the input after a click switch', () => {
    installChrome();
    const { input, button } = mountInSlot();

    button.click();

    expect(document.activeElement).toBe(input);
  });

  it('Tab inside the input cycles the engine and prevents default', () => {
    installChrome();
    const { input, button } = mountInSlot();

    const ev = pressTab(input);
    expect(ev.defaultPrevented).toBe(true);
    expect(button.dataset.engine).toBe('xiaohongshu');

    pressTab(input);
    expect(button.dataset.engine).toBe('bilibili');
  });

  it('Shift+Tab is left native so focus can leave the field', () => {
    installChrome();
    const { input, button } = mountInSlot();

    const ev = pressTab(input, { shiftKey: true });

    expect(ev.defaultPrevented).toBe(false);
    expect(button.dataset.engine).toBe('default');
  });

  it('Tab during IME composition is not intercepted', () => {
    installChrome();
    const { input, button } = mountInSlot();

    const ev = pressTab(input, { isComposing: true });

    expect(ev.defaultPrevented).toBe(false);
    expect(button.dataset.engine).toBe('default');
  });

  it('xiaohongshu submit opens the encoded search_result URL in the current tab', () => {
    const { query, update } = installChrome();
    const { form, input, button } = mountInSlot();
    button.click();
    input.value = '  露营装备  ';

    submit(form);

    expect(query).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      url: 'https://www.xiaohongshu.com/search_result?keyword=%E9%9C%B2%E8%90%A5%E8%A3%85%E5%A4%87',
    });
    expect(input.value).toBe('');
  });

  it('bilibili submit opens the encoded search URL in the current tab', () => {
    const { query, update } = installChrome();
    const { form, input, button } = mountInSlot();
    button.click();
    button.click();
    input.value = 'a&b 测试';

    submit(form);

    expect(query).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      url: 'https://search.bilibili.com/all?keyword=a%26b%20%E6%B5%8B%E8%AF%95',
    });
  });

  it('non-default engine swallows submit quietly when chrome is unavailable', () => {
    vi.stubGlobal('chrome', undefined);
    const { form, input, button } = mountInSlot();
    button.click();
    input.value = 'fallback';

    expect(() => submit(form)).not.toThrow();
    expect(input.value).toBe('');
  });
});

describe('mountSearch engine persistence', () => {
  it('persists the chosen engine to localStorage and clears it for default', () => {
    installChrome();
    const { button } = mountInSlot();

    button.click();
    expect(localStorage.getItem(SEARCH_ENGINE_KEY)).toBe('xiaohongshu');
    button.click();
    expect(localStorage.getItem(SEARCH_ENGINE_KEY)).toBe('bilibili');
    button.click();
    expect(localStorage.getItem(SEARCH_ENGINE_KEY)).toBeNull();
  });

  it('restores the last-used engine on mount', () => {
    installChrome();
    localStorage.setItem(SEARCH_ENGINE_KEY, 'bilibili');
    const { input, button } = mountInSlot();

    expect(button.dataset.engine).toBe('bilibili');
    expect(input.placeholder).toBe('Search Bilibili...');
  });

  it('falls back to default for an unknown stored value', () => {
    installChrome();
    localStorage.setItem(SEARCH_ENGINE_KEY, 'baidu');
    const { button } = mountInSlot();

    expect(button.dataset.engine).toBe('default');
  });

  it('survives a throwing localStorage on read and write', () => {
    installChrome();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });

    const { button } = mountInSlot();
    expect(button.dataset.engine).toBe('default');
    expect(() => button.click()).not.toThrow();
    expect(button.dataset.engine).toBe('xiaohongshu');
  });
});
